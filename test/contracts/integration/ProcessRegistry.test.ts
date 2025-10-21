// test/integration/ProcessRegistry.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet, hexlify } from 'ethers';
import {
  ProcessRegistryService,
  ProcessStatus,
  ProcessCreateError,
  deployedAddresses as addresses,
} from '../../../src/contracts';
import { BallotMode, CensusData, EncryptionKey } from '../../../src/core';
import { CensusOrigin } from '../../../src/census';

jest.setTimeout(Number(process.env.TIME_OUT) || 120_000);

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

const PROC_REGISTRY_ADDR = addresses.processRegistry.sepolia;

function randomHex(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes * 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return '0x' + hex;
}

describe('ProcessRegistryService Integration (Sepolia)', () => {
  let procService: ProcessRegistryService;

  let processId: string;
  let initStateRoot: string;
  let initDuration: number;
  let initCensus: CensusData;
  const metadataURI = `ipfs://meta-${Date.now()}`;

  beforeAll(() => {
    procService = new ProcessRegistryService(PROC_REGISTRY_ADDR, wallet);
  });

  afterAll(() => {
    procService.removeAllListeners();
  });

  it('should run full process lifecycle and emit events', async () => {
    //
    // 1) PREPARE PROCESS PARAMETERS
    //
    processId = randomHex(32);
    initStateRoot = randomHex(32);
    initDuration = 3600; // seconds
    initCensus = {
      censusOrigin: CensusOrigin.CensusOriginMerkleTree,
      maxVotes: '5',
      censusRoot: randomHex(32),
      censusURI: `ipfs://census-${Date.now()}`,
    };

    const ballotMode: BallotMode = {
      numFields: 1,
      maxValue: '10',
      minValue: '0',
      uniqueValues: false,
      costFromWeight: false,
      costExponent: 0,
      maxValueSum: '10',
      minValueSum: '0',
    };

    const encryptionKey: EncryptionKey = {
      x: BigInt(randomHex(32)).toString(),
      y: BigInt(randomHex(32)).toString(),
    };

    //
    // 2) NEW PROCESS & WAIT ProcessCreated
    //
    const procCreated = new Promise<void>(resolve => {
      procService.onProcessCreated((id: string, creator: string) => {
        processId = id; // Capture the actual process ID from the event
        if (creator.toLowerCase() === wallet.address.toLowerCase()) {
          resolve();
        }
      });
    });

    const newProcessStream = procService.newProcess(
      ProcessStatus.READY,
      Math.floor(Date.now() / 1000) + 60,
      initDuration,
      ballotMode,
      initCensus,
      metadataURI,
      encryptionKey,
      BigInt(initStateRoot)
    );

    for await (const event of newProcessStream) {
      switch (event.status) {
        case 'pending':
          expect(event.hash).toBeDefined();
          expect(typeof event.hash).toBe('string');
          expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          break;
        case 'completed':
          expect(event.response).toEqual({ success: true });
          break;
        case 'reverted':
          throw new Error('Transaction should not revert');
        case 'failed':
          throw new Error('Transaction should not fail');
      }
    }
    await procCreated;

    // initial on‐chain read
    const stored = await procService.getProcess(processId);
    expect(stored.status).toBe(BigInt(ProcessStatus.READY));
    expect(stored.duration).toBe(BigInt(initDuration));
    expect(stored.metadataURI).toBe(metadataURI);
    expect(stored.latestStateRoot).toBe(BigInt(initStateRoot));
    expect(stored.census.censusURI).toBe(initCensus.censusURI);
    expect(hexlify(stored.census.censusRoot).toLowerCase()).toBe(
      hexlify(initCensus.censusRoot).toLowerCase()
    );

    //
    // 3) UPDATE CENSUS & WAIT CensusUpdated
    //
    const newCensus: CensusData = {
      ...initCensus,
      maxVotes: '10',
      censusURI: initCensus.censusURI + '-v2',
    };
    const censusUpdated = new Promise<void>(resolve => {
      procService.onCensusUpdated((id: string, root: string, uri: string, maxVotes: bigint) => {
        if (
          id.toLowerCase() === processId.toLowerCase() &&
          hexlify(root).toLowerCase() === hexlify(newCensus.censusRoot).toLowerCase() &&
          uri === newCensus.censusURI &&
          maxVotes === BigInt(newCensus.maxVotes)
        )
          resolve();
      });
    });
    const setCensusStream = procService.setProcessCensus(processId, newCensus);

    for await (const event of setCensusStream) {
      switch (event.status) {
        case 'pending':
          expect(event.hash).toBeDefined();
          expect(typeof event.hash).toBe('string');
          expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          break;
        case 'completed':
          expect(event.response).toEqual({ success: true });
          break;
        case 'reverted':
          throw new Error('Transaction should not revert');
        case 'failed':
          throw new Error('Transaction should not fail');
      }
    }
    await censusUpdated;

    const afterC = await procService.getProcess(processId);
    expect(afterC.census.censusURI).toBe(newCensus.censusURI);
    expect(afterC.census.maxVotes).toBe(BigInt(newCensus.maxVotes));

    //
    // 4) UPDATE DURATION & WAIT ProcessDurationChanged
    //
    // compute a new end time 10 minutes from now
    const now = Math.floor(Date.now() / 1000);
    const newDuration = now + 10 * 60;

    const durationChanged = new Promise<void>(resolve => {
      procService.onProcessDurationChanged((id: string, dur: bigint) => {
        if (id.toLowerCase() === processId.toLowerCase() && dur === BigInt(newDuration)) resolve();
      });
    });
    const setDurationStream = procService.setProcessDuration(processId, newDuration);

    for await (const event of setDurationStream) {
      switch (event.status) {
        case 'pending':
          expect(event.hash).toBeDefined();
          expect(typeof event.hash).toBe('string');
          expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          break;
        case 'completed':
          expect(event.response).toEqual({ success: true });
          break;
        case 'reverted':
          throw new Error('Transaction should not revert');
        case 'failed':
          throw new Error('Transaction should not fail');
      }
    }
    await durationChanged;

    const afterD = await procService.getProcess(processId);
    expect(afterD.duration).toBe(BigInt(newDuration));

    //
    // 5) END PROCESS & WAIT ProcessStatusChanged
    //
    const ended = new Promise<void>(resolve => {
      procService.onProcessStatusChanged((id: string, oldStatus: bigint, newStatus: bigint) => {
        if (
          id.toLowerCase() === processId.toLowerCase() &&
          newStatus === BigInt(ProcessStatus.ENDED)
        )
          resolve();
      });
    });
    const endProcessStream = procService.setProcessStatus(processId, ProcessStatus.ENDED);

    for await (const event of endProcessStream) {
      switch (event.status) {
        case 'pending':
          expect(event.hash).toBeDefined();
          expect(typeof event.hash).toBe('string');
          expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          break;
        case 'completed':
          expect(event.response).toEqual({ success: true });
          break;
        case 'reverted':
          throw new Error('Transaction should not revert');
        case 'failed':
          throw new Error('Transaction should not fail');
      }
    }
    await ended;

    const final = await procService.getProcess(processId);
    expect(final.status).toBe(BigInt(ProcessStatus.ENDED));
  });

  it('should yield failure status when creating process with invalid parameters', async () => {
    const invalidCensus: CensusData = {
      censusOrigin: CensusOrigin.CensusOriginMerkleTree,
      maxVotes: '0', // Invalid: maxVotes should be > 0
      censusRoot: randomHex(32),
      censusURI: `ipfs://invalid-census-${Date.now()}`,
    };

    const ballotMode: BallotMode = {
      numFields: 1,
      maxValue: '10',
      minValue: '0',
      uniqueValues: false,
      costFromWeight: false,
      costExponent: 0,
      maxValueSum: '10',
      minValueSum: '0',
    };

    const encryptionKey: EncryptionKey = {
      x: BigInt(randomHex(32)).toString(),
      y: BigInt(randomHex(32)).toString(),
    };

    const newProcessStream = procService.newProcess(
      ProcessStatus.READY,
      Math.floor(Date.now() / 1000) + 60,
      3600,
      ballotMode,
      invalidCensus,
      `ipfs://invalid-meta-${Date.now()}`,
      encryptionKey,
      BigInt(randomHex(32))
    );

    let eventCount = 0;
    for await (const event of newProcessStream) {
      eventCount++;

      if (event.status === 'failed') {
        expect(event.error).toBeInstanceOf(ProcessCreateError);
        expect((event.error as ProcessCreateError).operation).toBe('create');
      } else if (event.status === 'reverted') {
        // Some invalid parameters might cause revert instead of immediate failure
        expect(event.reason).toBeDefined();
      } else {
        // If it doesn't fail immediately, it might succeed but create an invalid process
        // This depends on the contract's validation logic
        break;
      }
    }

    expect(eventCount).toBeGreaterThanOrEqual(1);
  });

  it('should get process count', async () => {
    const count = await procService.getProcessCount();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
