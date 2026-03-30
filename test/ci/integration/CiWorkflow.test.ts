import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig } from '../../../src';
import { GetProcessResponse, VoteStatus } from '../../../src/sequencer/api/types';
import {
  createIntegrationProvider,
  createIntegrationWallet,
  getApiUrls,
} from '../../helpers/integrationRuntime';

const { sequencerUrl, censusUrl } = getApiUrls();
const provider: JsonRpcProvider = createIntegrationProvider();
const organizerWallet: Wallet = createIntegrationWallet().connect(provider);

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
      });
      await organizerSdk.init();

      const voterWallet = Wallet.createRandom().connect(provider);
      const voterSdk = new DavinciSDK({
        signer: voterWallet,
        sequencerUrl,
        censusUrl,
      });
      await voterSdk.init();

      const censusId = await organizerSdk.api.census.createCensus();
      await organizerSdk.api.census.addParticipants(censusId, [
        {
          key: voterWallet.address,
          weight: '1',
        },
      ]);
      const publishedCensus = await organizerSdk.api.census.publishCensus(censusId);
      const censusSize = await organizerSdk.api.census.getCensusSize(publishedCensus.root);

      const processConfig: ProcessConfig = {
        title: `CI Smoke Process ${Date.now()}`,
        description: 'CI smoke test: create -> vote -> end -> validate result',
        census: {
          type: CensusOrigin.OffchainStatic,
          root: publishedCensus.root,
          size: censusSize,
          uri: publishedCensus.uri,
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
          startDate: Math.floor(Date.now() / 1000) + 15,
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
        300_000,
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
    600_000
  );
});
