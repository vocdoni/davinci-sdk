import { concat, sha256, toUtf8Bytes } from 'ethers';
import { parseHexBytes } from '../crypto/field';

/**
 * The order in which a voter tries the nodes for a process: sorted by
 * `sha256(voter20 || processId31 || url)`, the URL as UTF-8 exactly as
 * configured (davinci-sequencer `voter::pick_node`). Send to the first
 * reachable node and fail over down the list: every ballot of one voter then
 * goes through one node, whose slot queue keeps revotes in order.
 *
 * @param voter - Voter address (20 bytes of hex)
 * @param processId - Process id (31 bytes of hex)
 * @param nodes - Node base URLs
 * @returns The URLs in order; equal URLs keep their relative order
 *
 * @example
 * ```typescript
 * const [first, ...fallbacks] = pickNode(voter, processId, urls);
 * ```
 */
export function pickNode(voter: string, processId: string, nodes: readonly string[]): string[] {
  const prefix = concat([
    parseHexBytes(voter, 20, 'voter address'),
    parseHexBytes(processId, 31, 'process id'),
  ]);
  return nodes
    .map((url, i) => ({ url, i, key: sha256(concat([prefix, toUtf8Bytes(url)])) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(n => n.url);
}
