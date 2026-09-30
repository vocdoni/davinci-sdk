import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainDynamicCensus } from '../../src/census/classes/OffchainDynamicCensus';
import { ProcessStatus, type RegistryEvent } from '../../src/contracts/types';
import {
  ANVIL_GRACE,
  addresses,
  anvil,
  chainProvider,
  connect,
  election,
  registryService,
  startNode,
  warp,
  type MockNode,
} from './harness';

const ACCOUNT = 6;

// Resolves once `check` holds, polling; fails after `ms`.
async function eventually(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for an event');
    await new Promise(r => setTimeout(r, 50));
  }
}

// Makes `change` until `seen` holds (at most 20 times, a second apart): a
// listener's subscription is live once it has seen one event.
async function untilSeen(change: () => Promise<void>, seen: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !seen(); i++) {
    await change();
    await eventually(seen, 1000).catch(() => undefined);
  }
  if (!seen()) throw new Error('the listener saw none of 20 changes');
}

describe('registry events', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let processId: string;
  let fromBlock: number;
  let census: OffchainDynamicCensus;

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
    census = new OffchainDynamicCensus();
    census.add(addresses(2));

    // One process through every organizer change.
    const created = await sdk.createProcess(
      election(census, { grace: ANVIL_GRACE.graceFloor, maxVoters: 10 })
    );
    processId = created.processId;
    fromBlock = Number((await sdk.registry.getProcess(processId)).creationBlock);
    await sdk.setProcessMaxVoters(processId, 50);
    await sdk.extendProcess(processId, 60);
    census.add(addresses(1));
    await sdk.updateCensus(processId, census);
    await sdk.updateMetadata(processId, {
      title: 'Renamed',
      questions: [
        {
          title: 'Q',
          choices: [
            { title: 'A', value: 0 },
            { title: 'B', value: 1 },
          ],
        },
      ],
    });
    await sdk.pauseProcess(processId);
    await sdk.resumeProcess(processId);
    await warp(30);
    await sdk.endProcess(processId);
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('decodes every organizer event of a process, in order', async () => {
    const events = await sdk.registry.queryEvents({ processId, fromBlock });
    expect(events.map(e => e.name)).toEqual([
      'ProcessCreated',
      'ProcessMetadataUpdated',
      'ProcessGraceChanged',
      'ProcessMaxVotersChanged',
      'ProcessDurationChanged',
      'CensusUpdated',
      'ProcessMetadataUpdated',
      'ProcessStatusChanged',
      'ProcessStatusChanged',
      'ProcessDurationChanged',
      'ProcessStatusChanged',
    ]);
    const p = await sdk.registry.getProcess(processId);
    const byName = (name: RegistryEvent['name']) => events.filter(e => e.name === name);
    expect(byName('ProcessCreated')[0]).toMatchObject({ creator: p.organizationId, processId });
    expect(byName('ProcessGraceChanged')[0]).toMatchObject({ grace: ANVIL_GRACE.graceFloor });
    expect(byName('ProcessMaxVotersChanged')[0]).toMatchObject({ maxVoters: 50n });
    expect(
      byName('ProcessDurationChanged').map(e =>
        e.name === 'ProcessDurationChanged' ? e.duration : 0n
      )
    ).toEqual([3660n, p.duration]);
    expect(byName('CensusUpdated')[0]).toMatchObject({
      censusRoot: await census.root(),
      censusUri: census.censusURI,
    });
    expect(byName('ProcessMetadataUpdated')[1]).toMatchObject({
      metadataUri: p.metadataUri,
      metadataHash: p.metadataHash,
    });
    expect(
      byName('ProcessStatusChanged').map(e =>
        e.name === 'ProcessStatusChanged' ? [e.oldStatus, e.newStatus] : []
      )
    ).toEqual([
      [ProcessStatus.READY, ProcessStatus.PAUSED],
      [ProcessStatus.PAUSED, ProcessStatus.READY],
      [ProcessStatus.READY, ProcessStatus.ENDED],
    ]);
    for (const e of events) {
      expect(e.blockNumber).toBeGreaterThanOrEqual(fromBlock);
      expect(e.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('reads the same events in windows of a few blocks, newest first', async () => {
    const all = await sdk.registry.queryEvents({ processId, fromBlock });
    for (const blockRange of [1, 2, 5]) {
      const windows: RegistryEvent[][] = [];
      const head = await sdk.provider.getBlockNumber();
      for await (const events of sdk.registry.eventWindows({ processId, fromBlock, blockRange })) {
        windows.push(events);
      }
      expect(windows).toHaveLength(Math.ceil((head - fromBlock + 1) / blockRange));
      expect(windows.reverse().flat()).toEqual(all);
    }
    const first = await sdk.registry
      .eventWindows({ processId, fromBlock, blockRange: 0 })
      .next()
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RangeError);
  });

  it('keeps other processes out of a process query', async () => {
    const other = await sdk.createProcess(election(census));
    const mine = await sdk.registry.queryEvents({ processId, fromBlock });
    expect(mine.every(e => e.processId === processId)).toBe(true);
    const everything = await sdk.registry.queryEvents({ fromBlock });
    expect(everything.some(e => e.processId === other.processId)).toBe(true);
    expect(everything.filter(e => e.processId === processId)).toEqual(mine);
  });

  it('needs a start block for a registry outside the known networks', async () => {
    const registry = registryService(chainProvider());
    await expect(registry.queryEvents({ processId })).rejects.toThrow(/fromBlock is required/);
    // The network given to the SDK carries the deployment block.
    expect(sdk.network.startBlock).toBe(anvil().registryBlock);
  });

  it('calls listeners with the event arguments', async () => {
    const { processId: pid } = await sdk.createProcess(election(census));
    const { processId: marker } = await sdk.createProcess(election(census));
    const registry = sdk.processes;
    const status: [string, bigint, bigint][] = [];
    const grace: [string, bigint][] = [];
    registry.onProcessStatusChanged((id, from, to) => status.push([id, from, to]));
    registry.onProcessGraceChanged((id, seconds) => grace.push([id, seconds]));
    const of = <T extends [string, ...unknown[]]>(events: T[], id: string) =>
      events.filter(e => e[0] === id);
    try {
      // The listeners subscribe in the background: change the marker process
      // until each has seen it, so both are live before the process under test moves.
      let paused = false;
      await untilSeen(
        async () => {
          await (paused ? sdk.resumeProcess(marker) : sdk.pauseProcess(marker));
          paused = !paused;
        },
        () => of(status, marker).length > 0
      );
      let seconds: number = ANVIL_GRACE.graceFloor;
      await untilSeen(
        async () => {
          await sdk.setProcessGrace(marker, seconds);
          seconds =
            seconds === ANVIL_GRACE.graceFloor ? ANVIL_GRACE.graceCeil : ANVIL_GRACE.graceFloor;
        },
        () => of(grace, marker).length > 0
      );

      await sdk.pauseProcess(pid);
      await sdk.setProcessGrace(pid, ANVIL_GRACE.graceCeil);
      await eventually(() => of(status, pid).length > 0 && of(grace, pid).length > 0);
    } finally {
      registry.removeAllListeners();
    }
    expect(of(status, pid)).toEqual([
      [pid, BigInt(ProcessStatus.READY), BigInt(ProcessStatus.PAUSED)],
    ]);
    expect(of(grace, pid)).toEqual([[pid, BigInt(ANVIL_GRACE.graceCeil)]]);
  });
});
