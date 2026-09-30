import { getAddress } from 'ethers';
import {
  BALLOT_COORDS,
  BALLOT_MAX,
  BALLOT_MIN,
  BALLOT_VK_HASH,
  BATCH_PROGRAM_VK,
  GNOSIS,
  MAX_BATCH_SIZE,
  MAX_BLOBS,
  MAX_CENSUS_DEPTH,
  MAX_REFRESH,
  NETWORKS,
  NUM_FIELDS,
  REFRESH_KAPPA,
  REFRESH_MIN,
  REFRESH_TAU,
  RELEASE_PINS,
  RESULTS_PROGRAM_VK,
  ROOT_C_VADCOP_FINAL,
  SMT_LEVELS,
  STATE_KEY_BALLOT_MODE,
  STATE_KEY_BALLOT_VK,
  STATE_KEY_CENSUS_ORIGIN,
  STATE_KEY_ENCRYPTION_KEY,
  STATE_KEY_PROCESS_ID,
  STATE_KEY_RESULTS,
  TX_BLOB_CAP,
  VOTE_ID_MIN,
  ZISK_VERIFIER_CODEHASH,
  getNetwork,
  processIdPrefix,
} from '../../../src';
import { readFixture } from '../../helpers/fixtures';

// Verbatim copies of davinci-zkvm rust-sdk/src/{limits,release}.rs and davinci-sequencer
// client/src/networks.rs; the TypeScript mirrors must agree with them.

function capture(re: RegExp, src: string): string {
  const m = re.exec(src);
  if (!m) throw new Error(`${re.source} not found`);
  return m[1].trim();
}

function rustConst(src: string, name: string): string {
  const m = new RegExp(`pub const ${name}: [\\w; \\[\\]0-9]+ = ([^;]+);`, 's').exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1].trim();
}

function rustBytes32(src: string, name: string): string {
  const bytes = rustConst(src, name)
    .replace(/[[\]\s]/g, '')
    .split(',')
    .filter(Boolean)
    .map(b => b.replace(/^0x/, '').padStart(2, '0'));
  expect(bytes).toHaveLength(32);
  return `0x${bytes.join('')}`;
}

describe('protocol limits', () => {
  const src = readFixture('zkvm/limits.rs');
  const num = (name: string) => Number(rustConst(src, name).replace(/_/g, ''));

  it('mirror rust-sdk limits.rs', () => {
    expect(NUM_FIELDS).toBe(num('NUM_FIELDS'));
    expect(MAX_BATCH_SIZE).toBe(num('MAX_BATCH_SIZE'));
    expect(MAX_REFRESH).toBe(num('MAX_REFRESH'));
    expect(REFRESH_MIN).toBe(num('REFRESH_MIN'));
    expect(REFRESH_TAU).toBe(num('REFRESH_TAU'));
    expect(REFRESH_KAPPA).toBe(num('REFRESH_KAPPA'));
    expect(SMT_LEVELS).toBe(num('SMT_LEVELS'));
    expect(MAX_BLOBS).toBe(num('MAX_BLOBS'));
    expect(TX_BLOB_CAP).toBe(num('TX_BLOB_CAP'));
    expect(MAX_CENSUS_DEPTH).toBe(num('MAX_CENSUS_DEPTH'));
    expect(rustConst(src, 'BALLOT_COORDS')).toBe('NUM_FIELDS * 4');
    expect(BALLOT_COORDS).toBe(64);
    expect(rustConst(src, 'VOTE_ID_MIN')).toBe('1 << 63');
    expect(VOTE_ID_MIN).toBe(1n << 63n);
    expect(BALLOT_MIN).toBe(BigInt(rustConst(src, 'BALLOT_MIN')));
    expect(rustConst(src, 'BALLOT_MAX')).toBe('VOTE_ID_MIN - 1');
    expect(BALLOT_MAX).toBe(VOTE_ID_MIN - 1n);
    expect(STATE_KEY_PROCESS_ID).toBe(BigInt(rustConst(src, 'KEY_PROCESS_ID')));
    expect(STATE_KEY_BALLOT_MODE).toBe(BigInt(rustConst(src, 'KEY_BALLOT_MODE')));
    expect(STATE_KEY_ENCRYPTION_KEY).toBe(BigInt(rustConst(src, 'KEY_ENC_KEY')));
    expect(STATE_KEY_RESULTS).toBe(BigInt(rustConst(src, 'KEY_RESULTS')));
    expect(STATE_KEY_CENSUS_ORIGIN).toBe(BigInt(rustConst(src, 'KEY_CENSUS_ORIGIN')));
    expect(STATE_KEY_BALLOT_VK).toBe(BigInt(rustConst(src, 'KEY_BALLOT_VK')));
  });
});

describe('release pins', () => {
  const src = readFixture('zkvm/release.rs');

  it('mirror rust-sdk release.rs', () => {
    expect(BATCH_PROGRAM_VK).toBe(rustBytes32(src, 'BATCH_PROGRAM_VK'));
    expect(RESULTS_PROGRAM_VK).toBe(rustBytes32(src, 'RESULTS_PROGRAM_VK'));
    expect(ROOT_C_VADCOP_FINAL).toBe(rustBytes32(src, 'ROOT_C_VADCOP_FINAL'));
    expect(ZISK_VERIFIER_CODEHASH).toBe(rustBytes32(src, 'ZISK_VERIFIER_CODEHASH'));
  });

  it('are named by registry getter and well formed', () => {
    expect(RELEASE_PINS).toEqual({
      batchProgramVK: BATCH_PROGRAM_VK,
      resultsProgramVK: RESULTS_PROGRAM_VK,
      rootCVadcopFinal: ROOT_C_VADCOP_FINAL,
      ziskVerifierCodeHash: ZISK_VERIFIER_CODEHASH,
      ballotVKHash: BALLOT_VK_HASH,
    });
    for (const pin of Object.values(RELEASE_PINS)) expect(pin).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('networks', () => {
  const src = readFixture('sequencer/networks.rs');
  const gnosis = src.slice(src.indexOf('pub const GNOSIS'));

  it('mirror the sequencer client Gnosis preset', () => {
    const field = (name: string) => capture(new RegExp(`${name}: ([^,]+),`), gnosis);
    expect(GNOSIS.name).toBe(JSON.parse(field('name')));
    expect(GNOSIS.chainId).toBe(Number(field('chain_id')));
    expect(GNOSIS.processRegistry).toBe(
      getAddress(`0x${capture(/address!\("([0-9a-fA-F]{40})"\)/, gnosis)}`)
    );
    expect(GNOSIS.startBlock).toBe(Number(field('start_block').replace(/_/g, '')));
    expect(GNOSIS.confirmations).toBe(Number(field('confirmations')));
    const rpcs = capture(/rpc_urls: &\[([^\]]+)\]/, gnosis);
    expect(GNOSIS.rpcUrls).toEqual([...rpcs.matchAll(/"([^"]+)"/g)].map(m => m[1]));
    expect(`beacon:${GNOSIS.beaconUrls.join(',')}`).toBe(JSON.parse(field('blob_source')));
  });

  it('look presets up by name', () => {
    expect(NETWORKS).toEqual([GNOSIS]);
    expect(getNetwork(' Gnosis ')).toBe(GNOSIS);
    expect(getNetwork('custom')).toBeUndefined();
    expect(Object.isFrozen(GNOSIS)).toBe(true);
  });

  it('compute the process id prefix of a registry', () => {
    expect(processIdPrefix(GNOSIS.chainId, GNOSIS.processRegistry)).toBe('0xf5848002');
    expect(processIdPrefix(100n, GNOSIS.processRegistry.toLowerCase())).toBe('0xf5848002');
    expect(processIdPrefix(1, GNOSIS.processRegistry)).not.toBe('0xf5848002');
    expect(() => processIdPrefix(1n << 32n, GNOSIS.processRegistry)).toThrow('uint32');
  });
});
