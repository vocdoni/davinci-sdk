/**
 * @fileoverview Input validation of the node's API (docs/api.md, "Wire format"
 * and "Errors"): malformed requests must get a 4xx with a stable code, never a
 * 5xx or a hang, and no stack trace or file path in the body.
 *
 * Two bases: `dup`, a vote the node already took (a body that decodes reaches
 * the duplicate check and answers 40901, so 40901 means "decoded", 40001 means
 * "refused by the decoder"), and `fresh`, a valid vote never sent, for mutations
 * that decode and must fail a protocol check (40002).
 */

import { BJJ_B8 } from '../../../src/crypto/babyjubjub';
import { BN254_FR } from '../../../src/crypto/field';
import { SECP_N, clone, type Draft } from './ballots';
import type { Ledger } from './ledger';
import type { Live } from './live';

type Body = Record<string, unknown>;
type Pt = { x: string; y: string };
type Ct = { c1: Pt; c2: Pt };

/** One case: a body (object, string or bytes), headers, and the codes that conform. */
interface Case {
  name: string;
  base: 'dup' | 'fresh' | 'none';
  body?: (b: Body) => Body | string | Uint8Array;
  headers?: Record<string, string>;
  /** Codes that conform; the first is what the docs say. */
  want: number[];
}

const set = (path: (string | number)[], value: unknown) => (b: Body) => {
  const c = clone(b);
  let o = c as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[path[path.length - 1]] = value;
  return c;
};
const drop = (key: string) => (b: Body) => {
  const c = clone(b);
  delete c[key];
  return c;
};
const raw = (f: (json: string) => string) => (b: Body) => f(JSON.stringify(b));
const upperHex = (s: string) => `0x${s.slice(2).toUpperCase()}`;
const noPrefix = (s: string) => s.slice(2);

function cases(dup: Body, fresh: Body): Case[] {
  const dupStr = (k: string) => dup[k] as string;
  const cp = dup.censusProof as Body;
  return [
    // Not JSON, or not an object
    { name: 'invalid JSON', base: 'none', body: () => '{', want: [40001] },
    { name: 'empty body', base: 'none', body: () => '', want: [40001] },
    { name: 'a JSON array', base: 'none', body: () => '[]', want: [40001] },
    { name: 'JSON null', base: 'none', body: () => 'null', want: [40001] },
    { name: 'a JSON string', base: 'none', body: () => '"vote"', want: [40001] },
    { name: 'trailing garbage', base: 'dup', body: raw(j => `${j}x`), want: [40001] },
    { name: 'a second JSON value', base: 'dup', body: raw(j => `${j}{}`), want: [40001] },
    {
      name: 'trailing whitespace (allowed)',
      base: 'dup',
      body: raw(j => `${j} \n\t`),
      want: [40901],
    },
    // Wrong types
    { name: 'processId as a number', base: 'dup', body: set(['processId'], 123), want: [40001] },
    { name: 'ballot as an object', base: 'dup', body: set(['ballot'], {}), want: [40001] },
    { name: 'weight as a JSON number', base: 'dup', body: set(['weight'], 1), want: [40001] },
    { name: 'voteId as a JSON number', base: 'dup', body: set(['voteId'], 1), want: [40001] },
    { name: 'signature as an array', base: 'dup', body: set(['signature'], [1, 2]), want: [40001] },
    {
      name: 'censusProof.index as a string',
      base: 'dup',
      body: set(['censusProof', 'index'], '1'),
      want: [40001],
    },
    {
      name: 'censusProof.index as a float',
      base: 'dup',
      body: set(['censusProof', 'index'], 1.5),
      want: [40001],
    },
    {
      name: 'censusProof.recid as a string',
      base: 'dup',
      body: set(['censusProof', 'recid'], '0'),
      want: [40001],
    },
    {
      name: 'a coordinate as a JSON number',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'x'], 1),
      want: [40001],
    },
    // Decimal vs 0x hex
    { name: 'weight as 0x hex', base: 'dup', body: set(['weight'], '0x1'), want: [40001] },
    {
      name: 'a coordinate as 0x hex',
      base: 'dup',
      body: b =>
        set(['ballot', 0, 'c1', 'x'], `0x${BigInt((b.ballot as Ct[])[0].c1.x).toString(16)}`)(b),
      want: [40001],
    },
    {
      name: 'voteId as a decimal string',
      base: 'dup',
      body: b => set(['voteId'], BigInt(b.voteId as string).toString())(b),
      want: [40001],
    },
    {
      name: 'processId without 0x',
      base: 'dup',
      body: set(['processId'], noPrefix(dupStr('processId'))),
      want: [40001],
    },
    {
      name: 'address without 0x',
      base: 'dup',
      body: set(['address'], noPrefix(dupStr('address'))),
      want: [40001],
    },
    {
      name: 'voteId without 0x',
      base: 'dup',
      body: set(['voteId'], noPrefix(dupStr('voteId'))),
      want: [40001],
    },
    {
      name: 'signature without 0x',
      base: 'dup',
      body: set(['signature'], noPrefix(dupStr('signature'))),
      want: [40001],
    },
    {
      name: 'processId with a 0X prefix',
      base: 'dup',
      body: set(['processId'], `0X${noPrefix(dupStr('processId'))}`),
      want: [40001],
    },
    // Upper-case hex (read in either case)
    {
      name: 'processId upper-case hex',
      base: 'dup',
      body: set(['processId'], upperHex(dupStr('processId'))),
      want: [40901],
    },
    {
      name: 'address upper-case hex',
      base: 'dup',
      body: set(['address'], upperHex(dupStr('address'))),
      want: [40901],
    },
    {
      name: 'voteId upper-case hex',
      base: 'dup',
      body: set(['voteId'], upperHex(dupStr('voteId'))),
      want: [40901],
    },
    {
      name: 'signature upper-case hex',
      base: 'dup',
      body: set(['signature'], upperHex(dupStr('signature'))),
      want: [40901],
    },
    {
      name: 'censusProof.r upper-case hex',
      base: 'dup',
      body: set(['censusProof', 'r'], upperHex(cp.r as string)),
      want: [40901],
    },
    // Leading zeros and other decimal spellings
    {
      name: 'weight with a leading zero',
      base: 'dup',
      body: b => set(['weight'], `0${b.weight as string}`)(b),
      want: [40901, 40001],
    },
    {
      name: 'a coordinate with leading zeros',
      base: 'dup',
      body: b => set(['ballot', 0, 'c1', 'x'], `000${(b.ballot as Ct[])[0].c1.x}`)(b),
      want: [40901, 40001],
    },
    { name: 'weight empty', base: 'dup', body: set(['weight'], ''), want: [40001] },
    {
      name: 'weight with a space',
      base: 'dup',
      body: b => set(['weight'], ` ${b.weight as string}`)(b),
      want: [40001],
    },
    {
      name: 'weight with a plus sign',
      base: 'dup',
      body: b => set(['weight'], `+${b.weight as string}`)(b),
      want: [40001],
    },
    { name: 'weight in exponent form', base: 'dup', body: set(['weight'], '1e0'), want: [40001] },
    // Missing and extra fields
    { name: 'missing ballotProof', base: 'dup', body: drop('ballotProof'), want: [40001] },
    { name: 'missing signature', base: 'dup', body: drop('signature'), want: [40001] },
    { name: 'missing weight', base: 'dup', body: drop('weight'), want: [40001] },
    { name: 'missing address', base: 'dup', body: drop('address'), want: [40001] },
    { name: 'missing voteId', base: 'dup', body: drop('voteId'), want: [40001] },
    { name: 'missing processId', base: 'dup', body: drop('processId'), want: [40001] },
    { name: 'missing censusProof (CSP)', base: 'dup', body: drop('censusProof'), want: [40001] },
    {
      name: 'censusProof null (CSP)',
      base: 'dup',
      body: set(['censusProof'], null),
      want: [40001],
    },
    {
      name: 'extra top-level ballotInputsHash',
      base: 'dup',
      body: set(['ballotInputsHash'], '1'),
      want: [40001],
    },
    {
      name: 'extra field in ballotProof (publicSignals)',
      base: 'dup',
      body: set(['ballotProof', 'publicSignals'], ['1']),
      want: [40001],
    },
    {
      name: 'extra field in a point',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'z'], '1'),
      want: [40001],
    },
    {
      name: 'extra field in a ciphertext',
      base: 'dup',
      body: set(['ballot', 0, 'c3'], {}),
      want: [40001],
    },
    {
      name: 'extra field in censusProof',
      base: 'dup',
      body: set(['censusProof', 'address'], dupStr('address')),
      want: [40001],
    },
    {
      name: 'a Merkle censusProof on a CSP process',
      base: 'dup',
      body: set(['censusProof'], {
        type: 'merkle',
        root: `0x${'11'.repeat(32)}`,
        leaf: `0x${'00'.repeat(31)}01`,
        pathBits: 0,
        siblings: [],
      }),
      want: [40001],
    },
    {
      name: 'censusProof of an unknown type',
      base: 'dup',
      body: set(['censusProof', 'type'], 'eddsa'),
      want: [40001],
    },
    // Duplicate keys
    {
      name: 'duplicate key, same value',
      base: 'dup',
      body: raw(j => `{"processId":${JSON.stringify(dupStr('processId'))},${j.slice(1)}`),
      want: [40001],
    },
    {
      name: 'duplicate key, other value first',
      base: 'dup',
      body: raw(j => `{"weight":"999",${j.slice(1)}`),
      want: [40001],
    },
    // Numbers out of range
    {
      name: 'weight 2^128',
      base: 'dup',
      body: set(['weight'], (1n << 128n).toString()),
      want: [40001],
    },
    {
      name: 'weight 2^256',
      base: 'dup',
      body: set(['weight'], (1n << 256n).toString()),
      want: [40001],
    },
    {
      name: 'a coordinate equal to the field modulus',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'x'], BN254_FR.toString()),
      want: [40001],
    },
    {
      name: 'a coordinate 2^256',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'x'], (1n << 256n).toString()),
      want: [40001],
    },
    {
      name: 'a coordinate of 100 digits',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'x'], '9'.repeat(100)),
      want: [40001],
    },
    {
      name: 'censusProof.index 2^64',
      base: 'dup',
      body: raw(j => j.replace(/"index":\d+/, '"index":18446744073709551616')),
      want: [40001],
    },
    {
      name: 'censusProof.recid 256',
      base: 'dup',
      body: set(['censusProof', 'recid'], 256),
      want: [40001],
    },
    // Negatives
    { name: 'weight -1', base: 'dup', body: set(['weight'], '-1'), want: [40001] },
    {
      name: 'a coordinate -1',
      base: 'dup',
      body: set(['ballot', 0, 'c1', 'x'], '-1'),
      want: [40001],
    },
    {
      name: 'censusProof.index -1',
      base: 'dup',
      body: set(['censusProof', 'index'], -1),
      want: [40001],
    },
    {
      name: 'censusProof.recid -1',
      base: 'dup',
      body: set(['censusProof', 'recid'], -1),
      want: [40001],
    },
    // Empty arrays and wrong counts
    { name: 'ballot []', base: 'dup', body: set(['ballot'], []), want: [40001] },
    {
      name: 'ballot of 15 ciphertexts',
      base: 'dup',
      body: b => set(['ballot'], (b.ballot as Ct[]).slice(0, 15))(b),
      want: [40001],
    },
    {
      name: 'ballot of 17 ciphertexts',
      base: 'dup',
      body: b => set(['ballot'], [...(b.ballot as Ct[]), (b.ballot as Ct[])[0]])(b),
      want: [40001],
    },
    { name: 'pi_a []', base: 'dup', body: set(['ballotProof', 'pi_a'], []), want: [40001] },
    {
      name: 'pi_a of 2 elements',
      base: 'dup',
      body: b =>
        set(['ballotProof', 'pi_a'], ((b.ballotProof as Body).pi_a as string[]).slice(0, 2))(b),
      want: [40001],
    },
    {
      name: 'pi_b of 2 rows',
      base: 'dup',
      body: b =>
        set(['ballotProof', 'pi_b'], ((b.ballotProof as Body).pi_b as string[][]).slice(0, 2))(b),
      want: [40001],
    },
    {
      name: 'pi_b row of 3 elements',
      base: 'dup',
      body: set(['ballotProof', 'pi_b', 0], ['1', '2', '3']),
      want: [40001],
    },
    {
      name: 'a point not on the curve',
      base: 'dup',
      body: set(['ballot', 0, 'c1'], { x: '1', y: '1' }),
      want: [40001],
    },
    // Vote id range
    {
      name: 'voteId 2^63 - 1',
      base: 'dup',
      body: set(['voteId'], '0x7fffffffffffffff'),
      want: [40001],
    },
    { name: 'voteId 0', base: 'dup', body: set(['voteId'], '0x0000000000000000'), want: [40001] },
    {
      name: 'voteId 2^64 (17 hex digits)',
      base: 'dup',
      body: set(['voteId'], '0x10000000000000000'),
      want: [40001],
    },
    {
      name: 'voteId of 15 hex digits',
      base: 'dup',
      body: set(['voteId'], '0x800000000000000'),
      want: [40001],
    },
    // Lengths
    {
      name: 'signature of 64 bytes',
      base: 'dup',
      body: b => set(['signature'], (b.signature as string).slice(0, -2))(b),
      want: [40001],
    },
    {
      name: 'signature of 66 bytes',
      base: 'dup',
      body: b => set(['signature'], `${b.signature as string}00`)(b),
      want: [40001],
    },
    {
      name: 'address of 19 bytes',
      base: 'dup',
      body: b => set(['address'], (b.address as string).slice(0, -2))(b),
      want: [40001],
    },
    {
      name: 'processId of 32 bytes',
      base: 'dup',
      body: b => set(['processId'], `${b.processId as string}00`)(b),
      want: [40001],
    },
    {
      name: 'censusProof.r of 31 bytes',
      base: 'dup',
      body: b => set(['censusProof', 'r'], (cp.r as string).slice(0, -2))(b),
      want: [40001],
    },
    // Content-Type
    {
      name: 'Content-Type text/plain',
      base: 'dup',
      headers: { 'Content-Type': 'text/plain' },
      want: [40001],
    },
    {
      name: 'Content-Type form',
      base: 'dup',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      want: [40001],
    },
    {
      name: 'no Content-Type',
      base: 'dup',
      body: b => new TextEncoder().encode(JSON.stringify(b)),
      headers: {},
      want: [40001],
    },
    {
      name: 'Content-Type with charset',
      base: 'dup',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      want: [40901],
    },
    {
      name: 'Content-Type +json',
      base: 'dup',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      want: [40901],
    },
    {
      name: 'Content-Type upper-case',
      base: 'dup',
      headers: { 'Content-Type': 'APPLICATION/JSON' },
      want: [40901],
    },
    // Decodes, then fails a protocol check (fresh vote)
    {
      name: 'fresh: an identity point in an active field',
      base: 'fresh',
      body: set(['ballot', 0, 'c1'], { x: '0', y: '1' }),
      want: [40002],
    },
    {
      name: 'fresh: a curve point outside the ballot (B8)',
      base: 'fresh',
      body: set(['ballot', 0, 'c2'], { x: BJJ_B8.x.toString(), y: BJJ_B8.y.toString() }),
      want: [40002],
    },
    {
      name: 'fresh: voteId 2^64 - 1 (in range, not the proof)',
      base: 'fresh',
      body: set(['voteId'], '0xffffffffffffffff'),
      want: [40002],
    },
    {
      name: 'fresh: signature v = 2',
      base: 'fresh',
      body: b => set(['signature'], `${(b.signature as string).slice(0, -2)}02`)(b),
      want: [40002],
    },
    {
      name: 'fresh: signature r = 0',
      base: 'fresh',
      body: b => set(['signature'], `0x${'00'.repeat(32)}${(b.signature as string).slice(66)}`)(b),
      want: [40002],
    },
    {
      name: 'fresh: signature s = n',
      base: 'fresh',
      body: b =>
        set(
          ['signature'],
          `${(b.signature as string).slice(0, 66)}${SECP_N.toString(16)}${(b.signature as string).slice(-2)}`
        )(b),
      want: [40002],
    },
    {
      name: 'fresh: CSP recid 2',
      base: 'fresh',
      body: set(['censusProof', 'recid'], 2),
      want: [40002],
    },
    {
      name: 'fresh: CSP r = 0',
      base: 'fresh',
      body: set(['censusProof', 'r'], `0x${'00'.repeat(32)}`),
      want: [40002],
    },
    {
      name: 'fresh: CSP index 2^53',
      base: 'fresh',
      body: set(['censusProof', 'index'], 2 ** 53),
      want: [40002],
    },
    {
      name: 'fresh: address zero',
      base: 'fresh',
      body: set(['address'], `0x${'00'.repeat(20)}`),
      want: [40002],
    },
    {
      name: 'fresh: pi_a element 2^256',
      base: 'fresh',
      body: set(['ballotProof', 'pi_a', 0], (1n << 256n).toString()),
      want: [40002, 40001],
    },
    {
      name: 'fresh: pi_a element not a number',
      base: 'fresh',
      body: set(['ballotProof', 'pi_a', 0], 'abc'),
      want: [40002, 40001],
    },
    {
      name: 'fresh: weight 2 (proof for 1)',
      base: 'fresh',
      body: set(['weight'], '2'),
      want: [40002],
    },
    // Last: harmless if taken, the vote is then admitted and later ones are duplicates.
    {
      name: 'fresh: ballotProof.protocol "plonk"',
      base: 'fresh',
      body: set(['ballotProof', 'protocol'], 'plonk'),
      want: [40001, 40002, 200],
    },
    {
      name: 'fresh: ballotProof.curve "bls12381"',
      base: 'fresh',
      body: set(['ballotProof', 'curve'], 'bls12381'),
      want: [40001, 40002, 200, 40901],
    },
  ];
  void fresh;
}

/** GETs and methods with malformed or unknown paths. */
function pathCases(
  pid: string,
  vid: string,
  unknownPid: string
): [string, string, string, number[]][] {
  const up = `0x${pid.slice(2).toUpperCase()}`;
  return [
    ['GET', `/processes/0x1234`, 'short process id', [40001]],
    ['GET', `/processes/${pid}aa`, 'long process id', [40001]],
    ['GET', `/processes/0x${'zz'.repeat(31)}`, 'non-hex process id', [40001]],
    ['GET', `/processes/${unknownPid}`, 'unknown process id', [40402]],
    ['GET', `/processes/%ff%fe`, 'invalid UTF-8 path', [40001]],
    ['GET', `/processes/${up}`, 'upper-case process id', [200]],
    ['GET', `/processes/${pid.slice(2)}`, 'process id without 0x', [40001]],
    ['GET', `/votes/0x1234/voteId/${vid}`, 'vote status, short process id', [40001]],
    ['GET', `/votes/${pid}/voteId/0x1234`, 'vote status, short vote id', [40001]],
    ['GET', `/votes/${pid}/voteId/0x7fffffffffffffff`, 'vote status, vote id below 2^63', [40001]],
    ['GET', `/votes/${pid}/voteId/0xzzzzzzzzzzzzzzzz`, 'vote status, non-hex vote id', [40001]],
    ['GET', `/votes/${pid}/voteId/0x8000000000000001`, 'vote status, unknown vote id', [40401]],
    ['GET', `/votes/${pid}/voteId/${vid.slice(2)}`, 'vote status, vote id without 0x', [40001]],
    [
      'GET',
      `/votes/${pid}/voteId/${vid.toUpperCase().replace('0X', '0x')}`,
      'vote status, upper-case vote id',
      [200],
    ],
    ['GET', `/votes/${unknownPid}/voteId/${vid}`, 'vote status, unknown process', [40402]],
    ['GET', `/votes/${pid}/voteId/${vid}/proof`, 'tracker proof of a pending vote', [40401]],
    ['GET', `/votes/${pid}/address/0x1234`, 'ballot, short address', [40001]],
    ['GET', `/votes/${pid}/address/0x${'zz'.repeat(20)}`, 'ballot, non-hex address', [40001]],
    ['GET', `/votes/${pid}/address/0x${'00'.repeat(20)}`, 'ballot, unknown address', [40401]],
    ['GET', `/votes/${pid}/address/${'00'.repeat(20)}`, 'ballot, address without 0x', [40001]],
    [
      'GET',
      `/processes/${pid}/participants/0x${'11'.repeat(20)}`,
      'participant of a CSP census',
      [40401],
    ],
    ['GET', `/processes/${pid}/participants/0x12`, 'participant, short address', [40001]],
    ['GET', `/processes/${pid}/transitions/abc/blobs`, 'blobs, non-integer index', [40001]],
    ['GET', `/processes/${pid}/transitions/-1/blobs`, 'blobs, negative index', [40001]],
    [
      'GET',
      `/processes/${pid}/transitions/99999999999999999999999/blobs`,
      'blobs, index over u64',
      [40001],
    ],
    ['GET', `/processes/${pid}/transitions/0/blobs`, 'blobs of a missing transition', [40401]],
    ['GET', `/processes/${unknownPid}/transitions`, 'transitions, unknown process', [40402]],
    ['GET', `/nonexistent`, 'unknown route', [40401]],
    ['GET', `/votes`, 'GET on a POST route', [40501]],
    ['DELETE', `/votes`, 'DELETE /votes', [40501]],
    ['PUT', `/processes/keys`, 'PUT /processes/keys', [40501]],
    ['POST', `/processes/${pid}`, 'POST on a GET route', [40501]],
  ];
}

const KIB = 1024;

/**
 * Runs the battery against `ledger`'s process. `dup` must be a vote the node took;
 * `fresh` a valid vote never sent. Returns nothing; every answer is a check.
 */
export async function inputBattery(
  live: Live,
  ledger: Ledger,
  dup: Draft,
  fresh: Draft
): Promise<void> {
  const { ev, node } = live;
  const pid = ledger.e.processId;
  const label = (n: string) => `${ledger.e.label} input: ${n}`;
  for (const c of cases(dup.body, fresh.body)) {
    const d = c.base === 'fresh' ? fresh : dup;
    const body = c.body ? c.body(clone(d.body)) : d.body;
    const headers = c.headers ?? { 'Content-Type': 'application/json' };
    const a =
      body instanceof Uint8Array
        ? await nodePostBytes(live, '/votes', body, headers)
        : await node.post(
            '/votes',
            typeof body === 'string' ? body : JSON.stringify(body),
            headers
          );
    const code = a.status === 200 ? 200 : a.code;
    if (c.base !== 'none') ledger.record({ ...d, label: label(c.name) }, a);
    ev.check(
      label(`${c.name} -> ${c.want.join(' or ')}`),
      code !== undefined && c.want.includes(code),
      {
        status: a.status,
        code: a.code,
        error: a.error?.slice(0, 200),
      }
    );
  }

  // Bodies near and over the 256 KiB cap.
  const near = JSON.stringify(dup.body);
  const pad = ' '.repeat(256 * KIB - near.length - 16);
  const a1 = await node.post('/votes', near + pad);
  ev.check(label(`a body just under 256 KiB -> 40901`), a1.code === 40901, {
    status: a1.status,
    code: a1.code,
    size: near.length + pad.length,
  });
  live.throttle.reserveOversize('256 KiB + 1 with Content-Length');
  const over = near + ' '.repeat(256 * KIB - near.length + 1);
  const a2 = await node.post('/votes', over);
  ev.check(label('a body of 256 KiB + 1 -> 41301'), a2.code === 41301, {
    status: a2.status,
    code: a2.code,
    size: over.length,
  });
  live.throttle.reserveOversize('chunked, no Content-Length');
  const a3 = await nodePostStream(live, '/votes', new TextEncoder().encode(over));
  ev.check(label('a chunked body over 256 KiB, no Content-Length -> 41301'), a3.code === 41301, {
    status: a3.status,
    code: a3.code,
  });

  for (const [method, path, name, want] of pathCases(pid, dup.voteId, `0x${'ab'.repeat(31)}`)) {
    const a = await node.method(method, path);
    const code = a.status === 200 ? 200 : a.code;
    ev.check(
      label(`${method} ${name} -> ${want.join(' or ')}`),
      code !== undefined && want.includes(code),
      {
        path: path.slice(0, 120),
        status: a.status,
        code: a.code,
        error: a.error?.slice(0, 200),
      }
    );
  }
}

// A body sent as bytes (fetch sets no Content-Type for them).
async function nodePostBytes(
  live: Live,
  path: string,
  body: Uint8Array,
  headers: Record<string, string>
) {
  return live.node.raw('POST', path, { body, headers });
}

// A body streamed without Content-Length (chunked).
async function nodePostStream(live: Live, path: string, bytes: Uint8Array) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 16 * KIB)
        controller.enqueue(bytes.slice(i, i + 16 * KIB));
      controller.close();
    },
  });
  return live.node.raw('POST', path, {
    body: stream,
    headers: { 'Content-Type': 'application/json' },
    duplex: 'half',
  } as RequestInit);
}
