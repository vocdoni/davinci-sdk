import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import {
  ProcessDurationError,
  ProcessGraceError,
  ProcessMaxVotersError,
  ProcessNotFoundError,
  ProcessStatusError,
} from '../../src/contracts/errors';
import { TxStatus } from '../../src/contracts/SmartContractService';
import { ProcessStatus } from '../../src/contracts/types';
import type { ProcessConfigWithMetadata } from '../../src/core/process';
import { computeProcessId, processIdPrefix } from '../../src/networks';
import { ANVIL_CHAIN_ID } from './env';
import {
  ANVIL_GRACE,
  acrossTheEnd,
  addresses,
  anvil,
  chainTime,
  connect,
  devWallet,
  election,
  landAt,
  mineAt,
  nextBlockAt,
  startNode,
  streamError,
  warp,
  type MockNode,
} from './harness';

const ACCOUNT = 3;
const STRANGER = 14;

describe('organizer controls', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let census: OffchainCensus;

  // A process `duration` seconds long, starting now unless `overrides` say; its id, start and end.
  async function open(
    duration = 3600,
    overrides: Partial<ProcessConfigWithMetadata> = {}
  ): Promise<{ processId: string; start: bigint; end: bigint }> {
    const { processId } = await sdk.createProcess(
      election(census, { timing: { duration }, ...overrides })
    );
    const p = await sdk.registry.getProcess(processId);
    return { processId, start: p.startTime, end: p.startTime + p.duration };
  }

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
    census = new OffchainCensus();
    census.add(addresses(3));
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  describe('end', () => {
    it('refuses to end a process before its start: cancel it instead', async () => {
      const start = (await chainTime()) + 300n;
      const { processId } = await open(600, {
        timing: { startDate: Number(start), duration: 600 },
      });
      const err = await streamError(sdk.endProcessStream(processId));
      expect(err).toBeInstanceOf(ProcessStatusError);
      expect(err).toMatchObject({ revertName: 'InvalidTimeBounds' });
      expect(err.message).toMatch(/cancel it instead/);
      const raw = await streamError(sdk.processes.setProcessStatus(processId, ProcessStatus.ENDED));
      expect(raw).toMatchObject({ revertName: 'InvalidTimeBounds' });

      // From the start on it ends, and the end moves to that block.
      await mineAt(start);
      await nextBlockAt(start);
      await sdk.endProcess(processId);
      const p = await sdk.getProcess(processId);
      expect(p).toMatchObject({ status: ProcessStatus.ENDED, duration: 0, phase: 'closing' });
    });

    it('moves the end of a running process to the block that ends it', async () => {
      const { processId, start } = await open();
      const at = (await chainTime()) + 100n;
      await nextBlockAt(at);
      await sdk.endProcess(processId);
      const p = await sdk.registry.getProcess(processId);
      expect(p.status).toBe(ProcessStatus.ENDED);
      expect(p.duration).toBe(at - start);

      for (const stream of [
        sdk.endProcessStream(processId),
        sdk.pauseProcessStream(processId),
        sdk.cancelProcessStream(processId),
        sdk.resumeProcessStream(processId),
      ]) {
        const err = await streamError(stream);
        expect(err).toBeInstanceOf(ProcessStatusError);
        expect(err).toMatchObject({ revertName: 'InvalidStatus' });
      }
      const raw = await streamError(
        sdk.processes.setProcessStatus(processId, ProcessStatus.CANCELED)
      );
      expect(raw).toMatchObject({ revertName: 'InvalidStatus' });
    });

    it('ends a process past its end without moving the end', async () => {
      const { processId, start } = await open(60);
      await warp(90);
      await sdk.endProcess(processId);
      const p = await sdk.registry.getProcess(processId);
      expect(p).toMatchObject({ status: ProcessStatus.ENDED, duration: 60n, startTime: start });
    });
  });

  describe('pause and resume', () => {
    it('pauses a READY process and resumes it', async () => {
      const { processId } = await open();
      await sdk.pauseProcess(processId);
      expect(await sdk.getProcess(processId)).toMatchObject({
        status: ProcessStatus.PAUSED,
        phase: 'paused',
      });
      const again = await streamError(sdk.pauseProcessStream(processId));
      expect(again).toMatchObject({ name: 'ProcessStatusError', revertName: 'InvalidStatus' });
      const raw = await streamError(
        sdk.processes.setProcessStatus(processId, ProcessStatus.PAUSED)
      );
      expect(raw).toMatchObject({ revertName: 'InvalidStatus' });

      await sdk.resumeProcess(processId);
      expect((await sdk.getProcess(processId)).phase).toBe('open');
      expect(await streamError(sdk.resumeProcessStream(processId))).toMatchObject({
        revertName: 'InvalidStatus',
      });
    });

    it('pauses only before the end', async () => {
      const { processId, end } = await open(200);
      await mineAt(end - 2n);
      await nextBlockAt(end - 1n);
      await sdk.pauseProcess(processId);
      await nextBlockAt(end - 1n);
      await sdk.resumeProcess(processId);

      // Checked and simulated at end - 1, mined at the end: the replay names it.
      const mined = await landAt(end, sdk.pauseProcessStream(processId));
      expect(mined.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Reverted]);
      expect(mined[1]).toMatchObject({ reason: 'InvalidTimeBounds' });

      const local = await streamError(sdk.pauseProcessStream(processId));
      expect(local).toBeInstanceOf(ProcessStatusError);
      expect(local).toMatchObject({ revertName: 'InvalidTimeBounds' });
      const raw = await streamError(
        sdk.processes.setProcessStatus(processId, ProcessStatus.PAUSED)
      );
      expect(raw).toMatchObject({ revertName: 'InvalidTimeBounds' });
    });

    it('leaves a process paused past its end to the grace window, and resumes it', async () => {
      const { processId } = await open(60);
      await sdk.pauseProcess(processId);
      await warp(61);
      expect((await sdk.getProcess(processId)).phase).toBe('closing');
      await sdk.resumeProcess(processId);
      expect(await sdk.getProcess(processId)).toMatchObject({
        status: ProcessStatus.READY,
        phase: 'closing',
      });
    });
  });

  describe('cancel', () => {
    it('cancels READY and PAUSED processes, the grace window included', async () => {
      const ready = await open(60);
      const paused = await open();
      await sdk.pauseProcess(paused.processId);
      await warp(61);
      expect((await sdk.getProcess(ready.processId)).phase).toBe('closing');
      await sdk.cancelProcess(ready.processId);
      await sdk.cancelProcess(paused.processId);
      for (const { processId } of [ready, paused]) {
        expect(await sdk.getProcess(processId)).toMatchObject({
          status: ProcessStatus.CANCELED,
          phase: 'canceled',
        });
        expect(await streamError(sdk.cancelProcessStream(processId))).toMatchObject({
          revertName: 'InvalidStatus',
        });
      }
    });
  });

  it('refuses process ids of another registry and processes that do not exist', async () => {
    const organizer = await devWallet(ACCOUNT).getAddress();
    const elsewhere = computeProcessId(
      organizer,
      processIdPrefix(ANVIL_CHAIN_ID, anvil().dkgRegistry),
      0
    );
    await expect(sdk.endProcess(elsewhere)).rejects.toThrow(/not created by the anvil registry/);
    expect(
      await streamError(sdk.processes.setProcessStatus(elsewhere, ProcessStatus.ENDED))
    ).toMatchObject({ revertName: 'UnknownProcessIdPrefix' });

    const missing = computeProcessId(organizer, sdk.network.processIdPrefix, 1_000_000);
    await expect(sdk.getProcess(missing)).rejects.toBeInstanceOf(ProcessNotFoundError);
    expect(await sdk.getGraceEnd(missing)).toBeNull();
    expect(
      await streamError(sdk.processes.setProcessStatus(missing, ProcessStatus.ENDED))
    ).toMatchObject({ revertName: 'ProcessNotFound' });
  });

  it('lets only the organizer change a process', async () => {
    const { processId } = await open();
    const stranger = await connect(STRANGER, node);
    for (const stream of [
      stranger.endProcessStream(processId),
      stranger.cancelProcessStream(processId),
      stranger.extendProcessStream(processId, 60),
      stranger.setProcessGraceStream(processId, ANVIL_GRACE.graceFloor),
      stranger.setProcessMaxVotersStream(processId, 10),
    ]) {
      expect(await streamError(stream)).toMatchObject({ revertName: 'Unauthorized' });
    }
    for (const stream of [
      stranger.processes.setProcessStatus(processId, ProcessStatus.ENDED),
      stranger.processes.setProcessGrace(processId, ANVIL_GRACE.graceFloor),
      stranger.processes.setProcessMaxVoters(processId, 10),
      stranger.processes.setProcessDuration(processId, 10_000),
    ]) {
      expect(await streamError(stream)).toMatchObject({ revertName: 'Unauthorized' });
    }
    expect((await sdk.registry.getProcess(processId)).status).toBe(ProcessStatus.READY);
  });

  describe('duration', () => {
    it('extends a process only before its end', async () => {
      const { processId, start, end } = await open(300);
      const extended = await sdk.extendProcess(processId, 600);
      expect(extended).toEqual({ success: true, duration: 900n });
      expect(await sdk.registry.getProcessEndTime(processId)).toBe(end + 600n);
      const zero = await streamError(sdk.extendProcessStream(processId, 0));
      expect(zero).toBeInstanceOf(ProcessDurationError);
      expect(zero).toMatchObject({ revertName: 'InvalidDuration' });

      // The end moves with every extension: across the new one, as acrossTheEnd does.
      const newEnd = end + 600n;
      await mineAt(newEnd - 2n);
      await nextBlockAt(newEnd - 1n);
      expect(await sdk.extendProcess(processId, 60)).toEqual({ success: true, duration: 960n });
      const last = newEnd + 60n;
      await mineAt(last - 1n);
      const mined = await landAt(last, sdk.extendProcessStream(processId, 60));
      expect(mined[1]).toMatchObject({ status: TxStatus.Reverted, reason: 'InvalidTimeBounds' });
      const local = await streamError(sdk.extendProcessStream(processId, 60));
      expect(local).toMatchObject({ revertName: 'InvalidTimeBounds' });
      const raw = await streamError(
        sdk.processes.setProcessDuration(processId, last + 60n - start)
      );
      expect(raw).toMatchObject({ revertName: 'InvalidTimeBounds' });
    });

    it('closes a process with notice', async () => {
      const { processId, start } = await open();
      const head = await chainTime();
      const { duration } = await sdk.closeProcessIn(processId, 30, { slack: 6 });
      expect(duration).toBe(head + 30n + 6n - start);
      expect(await sdk.registry.getProcessEndTime(processId)).toBe(head + 36n);

      // Asked for less than the registry's notice, it gives the notice.
      const head2 = await chainTime();
      const shorter = await sdk.closeProcessIn(processId, 1, { slack: 6 });
      expect(shorter.duration).toBe(head2 + BigInt(ANVIL_GRACE.noticeMin) + 6n - start);

      // Not later than the current end.
      const later = await streamError(sdk.closeProcessInStream(processId, 3600));
      expect(later).toBeInstanceOf(ProcessDurationError);
      expect(later.message).toMatch(/already ends by then/);
    });

    it('needs slack: the notice is checked when the transaction lands', async () => {
      const { processId, start } = await open();
      const head = await chainTime();
      const events = await landAt(head + 1n, sdk.closeProcessInStream(processId, 0, { slack: 0 }));
      expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Reverted]);
      expect(events[1]).toMatchObject({ reason: 'InvalidDuration' });

      // The registry's own checks of a shorter end.
      const now = await chainTime();
      const { duration: current } = await sdk.registry.getProcess(processId);
      for (const duration of [0n, now + 2n - start, current]) {
        const err = await streamError(sdk.processes.setProcessDuration(processId, duration));
        expect(err).toMatchObject({ revertName: 'InvalidDuration' });
      }
    });

    it('refuses to close a process before it starts', async () => {
      const start = (await chainTime()) + 1000n;
      const { processId } = await open(3600, {
        timing: { startDate: Number(start), duration: 3600 },
      });
      const err = await streamError(sdk.closeProcessInStream(processId, 10, { slack: 6 }));
      expect(err).toBeInstanceOf(ProcessDurationError);
      expect(err.message).toMatch(/cannot close before it starts/);
    });
  });

  describe('grace window', () => {
    it('sets the grace window within the registry bounds, only before the end', async () => {
      const { processId, end } = await open(300);
      await sdk.setProcessGrace(processId, ANVIL_GRACE.graceFloor);
      expect((await sdk.getProcess(processId)).grace).toBe(ANVIL_GRACE.graceFloor);
      const graceEnd = await sdk.getGraceEnd(processId);
      expect(graceEnd?.getTime()).toBe(Number(end + BigInt(ANVIL_GRACE.graceFloor)) * 1000);

      for (const grace of [ANVIL_GRACE.graceFloor - 1, ANVIL_GRACE.graceCeil + 1, 40.5]) {
        const err = await streamError(sdk.setProcessGraceStream(processId, grace));
        expect(err).toBeInstanceOf(ProcessGraceError);
        expect(err).toMatchObject({ revertName: 'InvalidGrace' });
      }
      for (const grace of [ANVIL_GRACE.graceFloor - 1, ANVIL_GRACE.graceCeil + 1]) {
        const err = await streamError(sdk.processes.setProcessGrace(processId, grace));
        expect(err).toMatchObject({ revertName: 'InvalidGrace' });
      }

      await acrossTheEnd(
        end,
        () => sdk.setProcessGraceStream(processId, ANVIL_GRACE.graceCeil),
        () => sdk.processes.setProcessGrace(processId, ANVIL_GRACE.graceCeil)
      );
    });

    it('closes the grace window after the end, then the results are awaited', async () => {
      const { processId, end } = await open(100);
      await sdk.setProcessGrace(processId, ANVIL_GRACE.graceFloor);
      const graceEnd = end + BigInt(ANVIL_GRACE.graceFloor);
      expect(await sdk.registry.getProcessGraceEnd(processId)).toBe(graceEnd);
      await mineAt(end - 1n);
      expect((await sdk.getProcess(processId)).phase).toBe('open');
      await mineAt(end);
      expect(await sdk.getProcess(processId)).toMatchObject({ phase: 'closing', timeRemaining: 0 });
      await mineAt(graceEnd - 1n);
      expect((await sdk.getProcess(processId)).phase).toBe('closing');
      await mineAt(graceEnd);
      expect((await sdk.getProcess(processId)).phase).toBe('ended');
    });
  });

  describe('max voters', () => {
    it('sets max voters within the result cap, only before the end', async () => {
      const { processId, end } = await open(300);
      await sdk.setProcessMaxVoters(processId, 50);
      expect((await sdk.getProcess(processId)).maxVoters).toBe(50);

      const zero = await streamError(sdk.setProcessMaxVotersStream(processId, 0));
      expect(zero).toBeInstanceOf(ProcessMaxVotersError);
      expect(zero).toMatchObject({ revertName: 'InvalidMaxVoters' });
      expect(await streamError(sdk.processes.setProcessMaxVoters(processId, 0))).toMatchObject({
        revertName: 'InvalidMaxVoters',
      });

      await acrossTheEnd(
        end,
        () => sdk.setProcessMaxVotersStream(processId, 60),
        () => sdk.processes.setProcessMaxVoters(processId, 60)
      );
    });

    it('keeps maxValue times max voters within the registry cap', async () => {
      const { processId } = await open(3600, {
        electionPreset: { type: 'rating', maxValue: 10 },
        maxVoters: 5,
      });
      const tooMany = 100_000_000_001;
      const err = await streamError(sdk.setProcessMaxVotersStream(processId, tooMany));
      expect(err).toMatchObject({ revertName: 'MaxPossibleResultCapExceeded' });
      expect(
        await streamError(sdk.processes.setProcessMaxVoters(processId, tooMany))
      ).toMatchObject({ revertName: 'MaxPossibleResultCapExceeded' });
      await sdk.setProcessMaxVoters(processId, tooMany - 1);
      expect((await sdk.registry.getProcess(processId)).maxVoters).toBe(BigInt(tooMany - 1));
    });
  });

  it('cancels the processes still open', async () => {
    const fresh = await connect(ACCOUNT, node);
    const a = await fresh.createProcess(election(census));
    const b = await fresh.createProcess(election(census));
    const c = await fresh.createProcess(election(census));
    await fresh.pauseProcess(b.processId);
    await fresh.endProcess(c.processId);
    const mine1 = await fresh.cancelOpenProcesses();
    expect(mine1.canceled).toEqual([a.processId, b.processId]);
    expect(mine1.failed).toEqual([]);

    // Another organizer's process fails; the rest goes on.
    const stranger = await connect(STRANGER, node);
    const theirs = await stranger.createProcess(election(census));
    const d = await fresh.createProcess(election(census));
    const mixed = await fresh.cancelOpenProcesses({ processIds: [theirs.processId, d.processId] });
    expect(mixed.canceled).toEqual([d.processId]);
    expect(mixed.failed).toHaveLength(1);
    expect(mixed.failed[0]).toMatchObject({
      processId: theirs.processId,
      error: { revertName: 'Unauthorized' },
    });
    await stranger.cancelProcess(theirs.processId);

    // Every open process of the account, found by its nonce.
    const e = await fresh.createProcess(election(census));
    const all = await (await connect(ACCOUNT, node)).cancelOpenProcesses({ all: true });
    expect(all.canceled).toContain(e.processId);
    expect(all.failed).toEqual([]);
  });
});
