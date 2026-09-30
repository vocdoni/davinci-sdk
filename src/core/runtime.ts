/** True in Node (and Node-compatible runtimes), false in browsers. */
export function isNode(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}
