import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig } from '../../../src';
import { GetProcessResponse, VoteStatus } from '../../../src/sequencer/api/types';
import {
  createIntegrationProvider,
  createIntegrationWallet,
  getApiUrls,
} from '../../helpers/integrationRuntime';
import { getOptionalEnv } from '../../helpers/integrationEnv';

const { sequencerUrl, censusUrl } = getApiUrls();
const provider: JsonRpcProvider = createIntegrationProvider();
const organizerWallet: Wallet = createIntegrationWallet().connect(provider);
const contractAddresses = getSdkContractAddresses();
const TEST_TIMEOUT_MS = 600_000;
const VOTE_SETTLE_TIMEOUT_MS = 300_000;

function isHexAddress(value: string | undefined): value is string {
  return !!value && /^0x[0-9a-f]{40}$/i.test(value.trim());
}

function getSdkContractAddresses():
  | {
      processRegistry?: string;
      stateTransitionVerifier?: string;
      resultsVerifier?: string;
    }
  | undefined {
  const processRegistry = getOptionalEnv('PROCESS_REGISTRY');
  const stateTransitionVerifier = getOptionalEnv('STATE_TRANSITION_VERIFIER');
  const resultsVerifier = getOptionalEnv('RESULTS_VERIFIER');

  if (
    !isHexAddress(processRegistry) &&
    !isHexAddress(stateTransitionVerifier) &&
    !isHexAddress(resultsVerifier)
  ) {
    return undefined;
  }

  return {
    processRegistry: isHexAddress(processRegistry) ? processRegistry : undefined,
    stateTransitionVerifier: isHexAddress(stateTransitionVerifier)
      ? stateTransitionVerifier
      : undefined,
    resultsVerifier: isHexAddress(resultsVerifier) ? resultsVerifier : undefined,
  };
}

function shouldUseInternalCensusUri(): boolean {
  const override = process.env.CI_USE_INTERNAL_CENSUS_URI;
  if (override === 'true') return true;
  if (override === 'false') return false;

  const sequencerHost = new URL(sequencerUrl).hostname;
  const censusHost = new URL(censusUrl).hostname;
  const localHosts = new Set(['127.0.0.1', 'localhost']);

  // Local Docker stack in CI exposes host-mapped URLs to SDK, while sequencer must
  // consume the census service through the container network hostname.
  return localHosts.has(sequencerHost) && localHosts.has(censusHost);
}

function processCensusUriFromPublished(publishedUri: string): string {
  if (!shouldUseInternalCensusUri()) {
    return publishedUri;
  }

  const publishedCensusUrl = new URL(publishedUri);
  return `http://census:8080${publishedCensusUrl.pathname}${publishedCensusUrl.search}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessAcceptingVotes(
  sdk: DavinciSDK,
  processId: string,
  timeoutMs = 180_000,
  pollMs = 2_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const process = await sdk.api.sequencer.getProcess(processId);
      if (process.isAcceptingVotes) {
        return;
      }
    } catch {
      // Process may not be visible yet in sequencer index.
    }
    await sleep(pollMs);
  }

  throw new Error(`Process ${processId} did not become ready for voting within ${timeoutMs}ms`);
}

async function waitForProcessResults(
  sdk: DavinciSDK,
  processId: string,
  timeoutMs = 300_000,
  pollMs = 5_000
): Promise<GetProcessResponse> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const process = await sdk.api.sequencer.getProcess(processId);
    if (process.result && process.result.length > 0) {
      return process;
    }
    await sleep(pollMs);
  }

  throw new Error(`Process ${processId} did not publish results within ${timeoutMs}ms`);
}

describe('CI Workflow Integration', () => {
  it(
    'creates an election, casts one vote, ends process, and validates final tally',
    async () => {
      const organizerSdk = new DavinciSDK({
        signer: organizerWallet,
        sequencerUrl,
        censusUrl,
        ...(contractAddresses ? { addresses: contractAddresses } : {}),
      });
      await organizerSdk.init();

      const voterWallet = Wallet.createRandom().connect(provider);
      const voterSdk = new DavinciSDK({
        signer: voterWallet,
        sequencerUrl,
        censusUrl,
        ...(contractAddresses ? { addresses: contractAddresses } : {}),
      });
      await voterSdk.init();

      await organizerSdk.api.sequencer.ping();
      const organizerBalance = await provider.getBalance(organizerWallet.address);
      if (organizerBalance === 0n) {
        throw new Error(
          `Organizer wallet ${organizerWallet.address} has zero balance. ` +
            'Run `bash test/ci/write-test-env.sh` before running local CI integration tests.'
        );
      }

      const censusId = await organizerSdk.api.census.createCensus();
      await organizerSdk.api.census.addParticipants(censusId, [
        {
          key: voterWallet.address,
          weight: '1',
        },
      ]);
      const publishedCensus = await organizerSdk.api.census.publishCensus(censusId);
      const censusSize = await organizerSdk.api.census.getCensusSize(publishedCensus.root);
      const processCensusUri = processCensusUriFromPublished(publishedCensus.uri);

      const processConfig: ProcessConfig = {
        title: `CI Smoke Process ${Date.now()}`,
        description: 'CI smoke test: create -> vote -> end -> validate result',
        census: {
          type: CensusOrigin.OffchainStatic,
          root: publishedCensus.root,
          size: censusSize,
          uri: processCensusUri,
        },
        maxVoters: censusSize,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          // Let SDK apply its default start time offset to avoid racey past-start reverts.
          duration: 600,
        },
        questions: [
          {
            title: 'Approve?',
            choices: [
              { title: 'No', value: 0 },
              { title: 'Yes', value: 1 },
            ],
          },
        ],
      };

      const created = await organizerSdk.createProcess(processConfig);
      const processId = created.processId;

      await waitForProcessAcceptingVotes(organizerSdk, processId);

      const submittedVote = await voterSdk.submitVote({
        processId,
        choices: [1],
      });

      await voterSdk.waitForVoteStatus(
        processId,
        submittedVote.voteId,
        VoteStatus.Settled,
        VOTE_SETTLE_TIMEOUT_MS,
        5_000
      );

      await organizerSdk.endProcess(processId);

      const finalProcess = await waitForProcessResults(organizerSdk, processId);
      const results = finalProcess.result ?? [];

      expect(results.length).toBeGreaterThan(0);
      expect(BigInt(results[0])).toBe(1n);
      expect(results.reduce((acc, value) => acc + BigInt(value), 0n)).toBe(1n);
      expect([1, 4]).toContain(finalProcess.status);
    },
    TEST_TIMEOUT_MS
  );
});
