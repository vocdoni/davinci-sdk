import { concat, getBytes, sha256, toUtf8Bytes } from 'ethers';
import { pickNode } from '../../../src/sequencer';
import { readFixture } from '../../helpers/fixtures';

// Vectors: test/fixtures/sequencer/wire.json `pickNode`, the orders of
// davinci-sequencer `voter::pick_node` at cb2d39c.
interface PickCase {
  voter: string;
  processId: string;
  nodes: string[];
  order: string[];
}
const cases = (JSON.parse(readFixture('sequencer/wire.json')) as { pickNode: PickCase[] }).pickNode;

describe('pickNode', () => {
  it('orders the nodes exactly like the Rust voter', () => {
    expect(cases.length).toBe(40);
    for (const c of cases) {
      expect(pickNode(c.voter, c.processId, c.nodes), JSON.stringify(c)).toEqual(c.order);
    }
  });

  it('sorts by sha256(voter || processId || url) whatever the input order', () => {
    const nodes = ['http://a:8080', 'http://b:8080', 'http://c:8080'];
    const voter = `0x${'01'.repeat(20)}`;
    const pid = `0x${'07'.repeat(31)}`;
    const order = pickNode(voter, pid, nodes);
    expect([...order].sort()).toEqual(nodes);
    expect(pickNode(voter, pid, [...nodes].reverse())).toEqual(order);
    const key = (url: string) => sha256(concat([getBytes(voter), getBytes(pid), toUtf8Bytes(url)]));
    for (let i = 1; i < order.length; i++) {
      expect(key(order[i - 1]) < key(order[i])).toBe(true);
    }
    // Voters spread over the nodes.
    const firsts = new Set(
      Array.from({ length: 32 }, (_, v) => {
        const addr = `0x${v.toString(16).padStart(2, '0').repeat(20)}`;
        return pickNode(addr, pid, nodes)[0];
      })
    );
    expect(firsts.size).toBe(nodes.length);
  });

  it('refuses a malformed voter or process id', () => {
    expect(() => pickNode('0x01', `0x${'07'.repeat(31)}`, ['http://a'])).toThrow();
    expect(() => pickNode(`0x${'01'.repeat(20)}`, '0x07', ['http://a'])).toThrow();
  });
});
