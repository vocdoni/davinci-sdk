import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateDir } from '../env';
import { VOTERS_FILE, ensureVoterKeys, loadVoterKeys, walletsOf } from '../voters';

describe('the voter keys', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdk-e2e-voters-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('are drawn once into a private directory, then reused', () => {
    const dir = join(root, 'private');
    const first = ensureVoterKeys(dir, { s1: 3, s2: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, VOTERS_FILE)).mode & 0o777).toBe(0o600);
    expect(first.s1).toHaveLength(3);
    expect(new Set(first.s1).size).toBe(3);

    const text = readFileSync(join(dir, VOTERS_FILE), 'utf8');
    expect(ensureVoterKeys(dir, { s1: 3, s2: 1 })).toEqual(first);
    expect(readFileSync(join(dir, VOTERS_FILE), 'utf8')).toBe(text);

    // A group that grows keeps its keys and gets new ones after them.
    const grown = ensureVoterKeys(dir, { s1: 5, s2: 1, s3: 2 });
    expect(grown.s1.slice(0, 3)).toEqual(first.s1);
    expect(grown.s1).toHaveLength(5);
    expect(loadVoterKeys(dir)).toEqual(grown);
    expect(walletsOf(grown, 's1', 2).map(w => w.privateKey)).toEqual(first.s1.slice(0, 2));
  });

  it('refuse a missing or malformed file, and too few keys', () => {
    expect(() => loadVoterKeys(root)).toThrow(/run the prepare phase/);
    writeFileSync(join(root, VOTERS_FILE), JSON.stringify({ s1: ['0x12'] }));
    expect(() => loadVoterKeys(root)).toThrow(/s1 is not a list of private keys/);
    expect(() => walletsOf({ s1: [] }, 's1', 1)).toThrow(/has 0 keys for s1/);
  });

  it('are never kept inside the repository', () => {
    const before = process.env.DAVINCI_SDK_E2E_DIR;
    try {
      process.env.DAVINCI_SDK_E2E_DIR = resolve(__dirname, '../fixtures');
      expect(() => privateDir()).toThrow(/inside the repository/);
      process.env.DAVINCI_SDK_E2E_DIR = root;
      expect(privateDir()).toBe(root);
    } finally {
      if (before === undefined) delete process.env.DAVINCI_SDK_E2E_DIR;
      else process.env.DAVINCI_SDK_E2E_DIR = before;
    }
  });
});
