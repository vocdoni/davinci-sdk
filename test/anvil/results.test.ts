import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { ProcessResultError } from '../../src/contracts/errors';
import { KeyMode } from '../../src/contracts/types';
import { ResultsError } from '../../src/core/vote/errors';
import type { ResultsState } from '../../src/core/vote/results';
import {
  ANVIL_GRACE,
  addresses,
  connect,
  election,
  mineAt,
  startNode,
  streamError,
  type MockNode,
} from './harness';

const ACCOUNT = 7;

describe('the way to the results', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let census: OffchainCensus;

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
    census = new OffchainCensus();
    census.add(addresses(2));
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('follows a sequencer-key process from voting to its key holder', async () => {
    const { processId } = await sdk.createProcess(
      election(census, { timing: { duration: 100 }, grace: ANVIL_GRACE.graceFloor })
    );
    const p = await sdk.registry.getProcess(processId);
    const end = p.startTime + p.duration;
    const graceEnd = end + BigInt(ANVIL_GRACE.graceFloor);

    const at = async (t: bigint): Promise<ResultsState> => {
      await mineAt(t);
      const status = await sdk.getResultsStatus(processId);
      expect(status).toMatchObject({ processId, keyMode: KeyMode.Sequencer });
      expect(status.graceEnd?.getTime()).toBe(Number(graceEnd) * 1000);
      expect(status.chainTime.getTime()).toBe(Number(t) * 1000);
      return status.state;
    };
    expect(await at(end - 1n)).toBe('voting');
    expect(await at(end)).toBe('grace');
    expect(await at(graceEnd - 1n)).toBe('grace');
    expect(await at(graceEnd)).toBe('awaiting-key-holder');

    const seen: ResultsState[] = [];
    const err = await sdk
      .waitForResults(processId, {
        timeoutMs: 300,
        pollIntervalMs: 50,
        onStatus: s => seen.push(s.state),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResultsError);
    expect(err).toMatchObject({ reason: 'timeout', status: { state: 'awaiting-key-holder' } });
    expect((err as Error).message).toMatch(/only the node that issued the election key/);
    expect(seen).toEqual(['awaiting-key-holder']);

    // A sequencer-key tally is not the committee's to finalize.
    const finalize = await streamError(sdk.finalizeResultsStream(processId));
    expect(finalize).toBeInstanceOf(ProcessResultError);
    expect(finalize).toMatchObject({ revertName: 'InvalidKeyMode' });
  });

  it('reads an ended process through the grace window', async () => {
    const { processId } = await sdk.createProcess(election(census));
    await sdk.endProcess(processId);
    expect((await sdk.getResultsStatus(processId)).state).toBe('grace');
    const graceEnd = await sdk.registry.getProcessGraceEnd(processId);
    await mineAt(graceEnd);
    expect((await sdk.getResultsStatus(processId)).state).toBe('awaiting-key-holder');
    expect((await sdk.getProcess(processId)).phase).toBe('ended');
  });

  it('tells a canceled process has no results', async () => {
    const { processId } = await sdk.createProcess(election(census));
    await sdk.cancelProcess(processId);
    expect((await sdk.getResultsStatus(processId)).state).toBe('canceled');
    const err = await sdk
      .waitForResults(processId, { pollIntervalMs: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResultsError);
    expect(err).toMatchObject({ reason: 'canceled' });
  });
});
