import { Wallet } from 'ethers';
import { OffchainCensus } from '../../../src/census/classes/OffchainCensus';
import { OffchainDynamicCensus } from '../../../src/census/classes/OffchainDynamicCensus';
import { buildElectionMetadata, serializeMetadata } from '../../../src/core/metadata';
import { checkBallot } from '../../../src/crypto/ballotChecker';
import {
  S1_BALLOTS,
  S1_REVOTE,
  S3_FIRST,
  S3_UPDATED,
  S7,
  S7_MISMATCH,
  S7_UPDATE,
  VOTER_GROUPS,
  fileHash,
  fixtureFiles,
  metadataBytes,
  metadataOf,
  modeOf,
  plannedBallots,
  s3Census,
  s3UpdatedCensus,
  tally,
  votersOf,
  type Voters,
} from '../spec';
import type { VoterKeys } from '../voters';

function randomKeys(): VoterKeys {
  const keys: VoterKeys = {};
  for (const [group, n] of Object.entries(VOTER_GROUPS)) {
    keys[group] = Array.from({ length: n }, () => Wallet.createRandom().privateKey);
  }
  return keys;
}

describe('live suite plan', () => {
  it('fits every planned ballot to its ballot mode and weight', () => {
    const plan = plannedBallots();
    expect(plan.length).toBe(27);
    for (const [i, b] of plan.entries()) {
      expect(checkBallot(b.choices, b.mode, b.weight), `${b.scenario} ballot ${i}`).toMatchObject({
        valid: true,
      });
    }
  });

  it('spends at most the weight where the weight is the budget', () => {
    const s4 = plannedBallots().filter(b => b.scenario === 's4');
    expect(s4.every(b => b.mode.maxValueSum === 0n)).toBe(true);
    for (const b of s4) {
      const spent = b.choices.reduce((a, c) => a + BigInt(c), 0n);
      expect(spent).toBeLessThanOrEqual(b.weight);
      expect(checkBallot(b.choices, b.mode, spent - 1n).valid).toBe(false);
    }
  });

  it('counts the revote instead of the first ballot', () => {
    const counted = [...S1_BALLOTS.filter(b => b.voter !== 0), S1_REVOTE];
    expect(tally(counted).slice(0, 4)).toEqual([22n, 20n, 22n, 19n]);
    expect(
      tally(counted)
        .slice(4)
        .every(v => v === 0n)
    ).toBe(true);
    expect(tally(counted)).toHaveLength(16);
  });

  it('builds a mode for every election', () => {
    expect(modeOf(S7)).toMatchObject({ numFields: 3, maxValueSum: 2n });
  });
});

describe('live suite fixtures', () => {
  let voters: Voters;
  beforeAll(() => {
    voters = votersOf(randomKeys());
  });

  it('are the census files and metadata documents the run publishes', () => {
    const files = fixtureFiles(voters);
    expect([...files.keys()].sort()).toEqual([
      's1-census.json',
      's1-metadata.json',
      's2-metadata.json',
      's3-census-updated.json',
      's3-census.json',
      's3-metadata.json',
      's4-metadata.json',
      's5-census.json',
      's5-metadata.json',
      's6-census.json',
      's6-metadata.json',
      's7-census.json',
      's7-metadata-mismatch.json',
      's7-metadata-update.json',
      's7-metadata.json',
      's8-census.json',
      's8-metadata.json',
    ]);
    // What the SDK builds from the same content, byte for byte.
    expect(files.get('s7-metadata.json')).toEqual(
      serializeMetadata(buildElectionMetadata({ ...metadataOf(S7), media: undefined }))
    );
    expect(OffchainCensus.fromJSON(files.get('s1-census.json')).size).toBe(8);
    expect(OffchainDynamicCensus.fromJSON(files.get('s3-census.json')).size).toBe(4);
  });

  it('do not change for the same keys, and do for others', () => {
    const again = fixtureFiles(votersOf(randomKeysLike(voters)));
    expect(again).toEqual(fixtureFiles(voters));
    const other = fixtureFiles(votersOf(randomKeys()));
    expect(other.get('s1-census.json')).not.toEqual(fixtureFiles(voters).get('s1-census.json'));
    expect(other.get('s1-metadata.json')).toEqual(fixtureFiles(voters).get('s1-metadata.json'));
  });

  it('give the updated census the order the run reaches by editing the first', async () => {
    const edited = s3Census(voters);
    edited.remove(voters.s3[3].address);
    edited.add(S3_UPDATED.filter(i => !S3_FIRST.includes(i)).map(i => voters.s3[i].address));
    expect(edited.serialize()).toEqual(s3UpdatedCensus(voters).serialize());
    expect(await edited.root()).toBe(await s3UpdatedCensus(voters).root());
  });

  it('serve a tampered copy that differs from the update it claims to be', () => {
    expect(fileHash(metadataBytes(S7_MISMATCH))).not.toBe(fileHash(metadataBytes(S7_UPDATE)));
    expect(S7_UPDATE.questions[0].choices).toHaveLength(S7.questions[0].choices.length);
  });
});

// The same keys, through a fresh parse.
function randomKeysLike(v: Voters): VoterKeys {
  const keys: VoterKeys = {};
  for (const [group, wallets] of Object.entries(v)) keys[group] = wallets.map(w => w.privateKey);
  return JSON.parse(JSON.stringify(keys)) as VoterKeys;
}
