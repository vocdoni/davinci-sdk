/**
 * @fileoverview The live suite's `prepare` phase (`DAVINCI_SDK_E2E=prepare`),
 * offline: draws the voter keys of the file-based censuses into the private
 * directory (once; later runs reuse them), writes the public census files and
 * metadata documents into `test/e2e/fixtures/`, and proves every planned
 * ballot against a stand-in election with the real circuit, so a plan the
 * circuit refuses is caught before anything is created on chain. Commit and
 * push the fixtures, then run the `run` phase against that commit.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { bjjMulBase, BJJ_SUBGROUP_ORDER } from '../../src/crypto/babyjubjub';
import { buildBallot } from '../../src/crypto/ballot';
import { checkBallot } from '../../src/crypto/ballotChecker';
import { randomBallotSecret } from '../../src/crypto/encryption';
import { computeProcessId, GNOSIS, processIdPrefix } from '../../src/networks';
import { BALLOT_VK_HASH } from '../../src/protocol/release';
import { BallotProver } from '../../src/prover/BallotProver';
import { DirArtifactCache } from './artifactCache';
import { artifactsDir, FIXTURES_DIR, phase, privateDir, say } from './env';
import { fixtureDiff, readFixtures } from './hosting';
import { fileHash, fixtureFiles, plannedBallots, VOTER_GROUPS, votersOf } from './spec';
import { ensureVoterKeys } from './voters';

describe.skipIf(phase() !== 'prepare')('live e2e: prepare', () => {
  afterAll(async () => {
    await BallotProver.terminate();
  });

  it('writes the voter keys and the public files', () => {
    const dir = privateDir();
    const voters = votersOf(ensureVoterKeys(dir, VOTER_GROUPS));
    say(`voter keys in ${dir}`);

    const files = fixtureFiles(voters);
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const before = readFixtures(FIXTURES_DIR);
    for (const name of readdirSync(FIXTURES_DIR)) {
      if (!files.has(name)) rmSync(join(FIXTURES_DIR, name));
    }
    for (const [name, bytes] of files) writeFileSync(join(FIXTURES_DIR, name), bytes);

    const changed = fixtureDiff(files, before).map(d =>
      d
        .replace(/ is missing$/, ' (new)')
        .replace(/ differs$/, ' (changed)')
        .replace(/ is not expected$/, ' (removed)')
    );
    for (const [name, bytes] of files) say(`${fileHash(bytes).slice(2, 18)}  fixtures/${name}`);
    say(
      changed.length === 0
        ? `${files.size} files, unchanged`
        : `${files.size} files; commit and push: ${changed.join(', ')}`
    );
    expect(fixtureDiff(files, readFixtures(FIXTURES_DIR))).toEqual([]);
  });

  it('proves every planned ballot with the real circuit', async () => {
    const prover = new BallotProver({ artifacts: { cache: new DirArtifactCache(artifactsDir()) } });
    // A stand-in election: an id of the Gnosis registry and a random key.
    const processId = computeProcessId(
      Wallet.createRandom().address,
      processIdPrefix(GNOSIS.chainId, GNOSIS.processRegistry),
      0
    );
    const encryptionKey = bjjMulBase((randomBallotSecret() % (BJJ_SUBGROUP_ORDER - 1n)) + 1n);
    const plan = plannedBallots();
    for (const [i, entry] of plan.entries()) {
      const check = checkBallot(entry.choices, entry.mode, entry.weight);
      expect(check, `${entry.scenario} ballot ${i}`).toMatchObject({ valid: true });
      const built = await buildBallot({
        processId,
        address: Wallet.createRandom().address,
        encryptionKey,
        ballotMode: entry.mode,
        fields: entry.choices,
        weight: entry.weight,
        k: randomBallotSecret(),
      });
      const { publicSignals } = await prover.prove(built, BALLOT_VK_HASH);
      expect(publicSignals).toEqual(built.publicSignals.map(String));
    }
    say(`${plan.length} planned ballots prove and verify`);
  }, 600_000);
});
