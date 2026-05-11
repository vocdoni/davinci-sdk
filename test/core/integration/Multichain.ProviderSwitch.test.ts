import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig } from '../../../src';
import { VocdoniSequencerService } from '../../../src/sequencer';
import { getApiUrls } from '../../helpers/integrationRuntime';
import { getOptionalEnv, getRequiredEnv } from '../../helpers/integrationEnv';

const { sequencerUrl, censusUrl } = getApiUrls();

function randomHex(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes * 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return `0x${hex}`;
}

function extractProcessIdVersion(processIdHex: string): string {
  const hex = processIdHex.startsWith('0x') ? processIdHex.slice(2) : processIdHex;
  if (hex.length !== 62) {
    throw new Error(`invalid process ID hex length ${hex.length}, want 62`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('invalid process ID hex string');
  }
  return `0x${hex.slice(40, 48).toLowerCase()}`;
}

function normalizeProcessId(processId: string): string {
  return processId.toLowerCase().replace(/^0x/, '');
}

function createProcessConfig(tag: string): ProcessConfig {
  const censusRoot = randomHex(32);
  const censusSize = 10;

  return {
    title: `Multichain Process ${tag}`,
    description: `Integration test for multichain provider switch (${tag})`,
    census: {
      type: CensusOrigin.OffchainStatic,
      root: censusRoot,
      size: censusSize,
      uri: `ipfs://multichain-${tag}-${Date.now()}`,
    },
    maxVoters: censusSize,
    ballot: {
      numFields: 1,
      maxValue: '1',
      minValue: '0',
      uniqueValues: false,
      costExponent: 1,
      maxValueSum: '1',
      minValueSum: '0',
    },
    timing: {
      duration: 3600,
    },
    questions: [
      {
        title: `Question ${tag}`,
        choices: [
          { title: 'Yes', value: 0 },
          { title: 'No', value: 1 },
        ],
      },
    ],
  };
}

async function waitForProcessInList(
  sdk: DavinciSDK,
  chainId: number,
  processId: string,
  timeoutMs = 30_000
): Promise<string[]> {
  const target = normalizeProcessId(processId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const list = await sdk.listProcesses(chainId);
    if (list.some(id => normalizeProcessId(id) === target)) {
      return list;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  return await sdk.listProcesses(chainId);
}

describe('Multichain Provider Switch Integration', () => {
  let shouldRun = false;
  let skipReason = '';
  let rpcA = '';
  let rpcB = '';
  let chainA = 0;
  let chainB = 0;
  let versionByChain = new Map<number, string>();

  beforeAll(async () => {
    const rpcEnvA = getOptionalEnv('MULTICHAIN_RPC_A');
    const rpcEnvB = getOptionalEnv('MULTICHAIN_RPC_B');

    let rpcUrls: string[] = [];
    if (rpcEnvA && rpcEnvB) {
      rpcUrls = [rpcEnvA.trim(), rpcEnvB.trim()].filter(Boolean);
    } else {
      // Backward fallback: allow combined env var.
      const rpcRaw = getOptionalEnv('MULTICHAIN_RPCS') || getOptionalEnv('RPC_URL');
      if (!rpcRaw) {
        skipReason =
          'Set MULTICHAIN_RPC_A and MULTICHAIN_RPC_B (recommended), or MULTICHAIN_RPCS, or RPC_URL';
        return;
      }
      rpcUrls = rpcRaw
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
    }

    if (rpcUrls.length !== 2) {
      skipReason =
        `expected exactly 2 RPC URLs. Use MULTICHAIN_RPC_A + MULTICHAIN_RPC_B, ` +
        `or a combined var with two comma-separated values. Got ${rpcUrls.length}`;
      return;
    }

    const sequencer = new VocdoniSequencerService(sequencerUrl);
    const info = await sequencer.getInfo();
    const networks = Object.values(info.networks);

    if (networks.length !== 2) {
      skipReason = `sequencer /info does not expose exactly 2 networks (got ${networks.length})`;
      return;
    }

    rpcA = rpcUrls[0];
    rpcB = rpcUrls[1];
    chainA = Number((await new JsonRpcProvider(rpcA).getNetwork()).chainId);
    chainB = Number((await new JsonRpcProvider(rpcB).getNetwork()).chainId);

    const envChainSet = new Set([chainA, chainB]);
    const infoChainSet = new Set(networks.map(n => Number(n.chainID)));
    const exactMatch =
      envChainSet.size === infoChainSet.size &&
      [...envChainSet].every(id => infoChainSet.has(id));

    if (!exactMatch) {
      skipReason =
        `RPC chain IDs [${[...envChainSet].join(',')}] do not exactly match /info chain IDs ` +
        `[${[...infoChainSet].join(',')}]`;
      return;
    }

    versionByChain = new Map(networks.map(n => [Number(n.chainID), n.processIDVersion.toLowerCase()]));
    shouldRun = true;
  }, 60_000);

  it(
    'creates processes on two chains and validates processIDVersion + getProcess with provider switch',
    async () => {
      if (!shouldRun) {
        console.warn(`Skipping multichain integration test: ${skipReason}`);
        return;
      }

      const privateKey = getRequiredEnv('PRIVATE_KEY');
      const providerA = new JsonRpcProvider(rpcA);
      const providerB = new JsonRpcProvider(rpcB);
      const walletA = new Wallet(privateKey, providerA);
      const walletB = new Wallet(privateKey, providerB);

      const sdkA = new DavinciSDK({
        signer: walletA,
        sequencerUrl,
        censusUrl,
      });
      const sdkB = new DavinciSDK({
        signer: walletB,
        sequencerUrl,
        censusUrl,
      });

      await sdkA.init();
      await sdkB.init();

      // Create one process per chain
      const createdA = await sdkA.createProcess(createProcessConfig('A'));
      const createdB = await sdkB.createProcess(createProcessConfig('B'));

      // Version in processId should match sequencer /info network mapping
      const versionA = extractProcessIdVersion(createdA.processId);
      const versionB = extractProcessIdVersion(createdB.processId);
      const expectedVersionA = versionByChain.get(chainA);
      const expectedVersionB = versionByChain.get(chainB);
      expect(versionA).toBe(expectedVersionA);
      expect(versionB).toBe(expectedVersionB);

      // getProcess should work for each process with its own chain provider
      const processA = await sdkA.getProcess(createdA.processId);
      const processB = await sdkB.getProcess(createdB.processId);

      expect(processA.processId.toLowerCase()).toBe(createdA.processId.toLowerCase());
      expect(processB.processId.toLowerCase()).toBe(createdB.processId.toLowerCase());

      // listProcesses should also work with explicit chain filters
      const listA = await waitForProcessInList(sdkA, chainA, createdA.processId);
      const listB = await waitForProcessInList(sdkB, chainB, createdB.processId);
      expect(Array.isArray(listA)).toBe(true);
      expect(Array.isArray(listB)).toBe(true);

      // If sequencer returns IDs for a chain, they must match that chain's processIDVersion.
      listA.slice(0, 20).forEach(id => {
        expect(extractProcessIdVersion(id)).toBe(expectedVersionA);
      });
      listB.slice(0, 20).forEach(id => {
        expect(extractProcessIdVersion(id)).toBe(expectedVersionB);
      });
    },
    300_000
  );
});
