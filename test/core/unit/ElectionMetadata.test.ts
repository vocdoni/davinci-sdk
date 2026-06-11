import { describe, expect, it } from 'vitest';
import {
  ElectionMetadataTemplate,
  getElectionMetadataTemplate,
} from '../../../src/core/types/metadata';

describe('getElectionMetadataTemplate', () => {
  it('does not set a default `type`', () => {
    const m = getElectionMetadataTemplate();
    expect(m.type).toBeUndefined();
    expect('type' in m).toBe(false);
  });

  it('returns a fresh copy on each call', () => {
    const a = getElectionMetadataTemplate();
    const b = getElectionMetadataTemplate();
    expect(a).not.toBe(b);
    a.title.default = 'mutated';
    expect(b.title.default).toBe('');
  });

  it('does not leak mutations back to the template constant', () => {
    const a = getElectionMetadataTemplate();
    a.title.default = 'mutated';
    expect(ElectionMetadataTemplate.title.default).toBe('');
  });
});
