import { SequencerDecodeError } from '../../../src/sequencer/errors';
import {
  decodeBallotResponse,
  decodeBlobs,
  decodeCensusFile,
  decodeEncryptionKey,
  decodeInfo,
  decodeParticipant,
  decodeProcessList,
  decodeProcessView,
  decodeTrackerProof,
  decodeTransitions,
  decodeVoteRequest,
  decodeVoteResponse,
  decodeVoteStatus,
} from '../../../src/sequencer/api/wire';
import { readFixture } from '../../helpers/fixtures';

// Hostile JSON against every decoder: a decoder may accept or throw a
// SequencerDecodeError, nothing else (no TypeError, no hang, no prototype pollution).
type Json = unknown;
type Container = Record<string | number, unknown> | unknown[];
interface Sample {
  voteRequest: { merkle: Json; csp: Json };
  processView: { ready: Json; results: Json };
  info: { sequencer: Json; observer: Json };
  encryptionKey: Json;
  trackerProof: Json;
  participant: Json;
  ballot: Json;
  transitions: Json;
  blobs: Json;
  censusFile: Json;
}
const wire = JSON.parse(readFixture('sequencer/wire.json')) as Sample;

const HOSTILE: Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  1e308,
  2 ** 53,
  2 ** 64,
  '',
  '0x',
  '-1',
  ' 1',
  '1e3',
  '0x' + 'f'.repeat(64),
  '9'.repeat(79),
  'x'.repeat(100_000),
  [],
  [[]],
  {},
  { x: 1, y: 2 },
  { __proto__: { x: '1' } },
  JSON.parse('{"__proto__": {"x": "1"}, "constructor": 1, "toString": 2}'),
];

function* leafPaths(v: Json, prefix: (string | number)[] = []): Generator<(string | number)[]> {
  yield prefix;
  if (Array.isArray(v)) {
    // Long arrays: sample the first and the last element only.
    const idx = v.length > 3 ? [0, v.length - 1] : v.map((_, i) => i);
    for (const i of idx) yield* leafPaths(v[i], [...prefix, i]);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v))
      yield* leafPaths((v as Record<string, Json>)[k], [...prefix, k]);
  }
}

function setAt(doc: Json, path: (string | number)[], value: Json): Json {
  if (path.length === 0) return value;
  const copy = structuredClone(doc) as Container;
  let cur = copy;
  for (const k of path.slice(0, -1)) cur = (cur as Record<string | number, Container>)[k];
  (cur as Record<string | number, Json>)[path[path.length - 1]] = value;
  return copy;
}

function removeAt(doc: Json, path: (string | number)[]): Json {
  const copy = structuredClone(doc) as Container;
  let cur = copy;
  for (const k of path.slice(0, -1)) cur = (cur as Record<string | number, Container>)[k];
  delete (cur as Record<string | number, Json>)[path[path.length - 1]];
  return copy;
}

const targets: [string, Json, (j: Json) => unknown][] = [
  ['voteRequest.merkle', wire.voteRequest.merkle, decodeVoteRequest],
  ['voteRequest.csp', wire.voteRequest.csp, decodeVoteRequest],
  ['processView.ready', wire.processView.ready, decodeProcessView],
  ['processView.results', wire.processView.results, decodeProcessView],
  ['info.sequencer', wire.info.sequencer, decodeInfo],
  ['info.observer', wire.info.observer, decodeInfo],
  ['encryptionKey', wire.encryptionKey, decodeEncryptionKey],
  ['trackerProof', wire.trackerProof, decodeTrackerProof],
  ['participant', wire.participant, decodeParticipant],
  ['ballot', wire.ballot, decodeBallotResponse],
  ['transitions', wire.transitions, decodeTransitions],
  ['blobs', wire.blobs, decodeBlobs],
  ['censusFile', wire.censusFile, decodeCensusFile],
  ['voteStatus', { status: 'pending', error: 'x' }, decodeVoteStatus],
  ['voteResponse', { voteId: '0x8000000000000001' }, decodeVoteResponse],
  ['processList', { processes: [`0x${'11'.repeat(31)}`] }, decodeProcessList],
];

describe('attack: wire decoders on hostile JSON', () => {
  for (const [name, doc, decode] of targets) {
    it(`${name}: the valid sample decodes`, () => {
      expect(() => decode(doc)).not.toThrow();
    });
    it(`${name}: every hostile replacement or removal is a decode error or an accept`, () => {
      const bad: string[] = [];
      for (const path of leafPaths(doc)) {
        const variants: Json[] = HOSTILE.map(h => setAt(doc, path, h));
        if (path.length > 0) variants.push(removeAt(doc, path));
        for (const v of variants) {
          try {
            decode(v);
          } catch (err) {
            if (!(err instanceof SequencerDecodeError)) {
              bad.push(
                `${path.join('.')}: ${(err as Error).constructor.name} ${(err as Error).message}`
              );
            }
          }
        }
      }
      expect(bad.slice(0, 10)).toEqual([]);
    });
  }

  it('does not pollute Object.prototype', () => {
    for (const [, doc, decode] of targets) {
      try {
        decode(
          JSON.parse(
            '{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 1}}}'
          )
        );
      } catch {
        // refused
      }
      void doc;
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
