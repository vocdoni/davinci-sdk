import {
  NodeMismatchError,
  SequencerError,
  checkNodeInfo,
  type NodeExpectation,
  type SequencerInfo,
} from '../../../src/sequencer';

const EXPECTED: NodeExpectation = {
  chainId: 100,
  processRegistry: '0x6702e0141B6b72bCF8C1bdff20A82A35C5502E7D',
  ballotVkHash: `0x${'bf'.repeat(32)}`,
  batchProgramVk: `0x${'6c'.repeat(32)}`,
  resultsProgramVk: `0x${'7b'.repeat(32)}`,
};

const INFO: SequencerInfo = {
  sequencerAddress: '0x70dEBAc0bF6fcC5F99646fCbcfFB6d8267184dEc',
  chainId: 100,
  processRegistry: EXPECTED.processRegistry.toLowerCase(),
  ballotVkHash: EXPECTED.ballotVkHash.toUpperCase().replace('0X', '0x'),
  batchProgramVk: EXPECTED.batchProgramVk,
  resultsProgramVk: EXPECTED.resultsProgramVk,
  observer: false,
  settledBySelf: 3,
  syncedFromOthers: 1,
  lostRaces: 0,
};

describe('checkNodeInfo', () => {
  it('accepts a node of the deployment, whatever the hex case, observers too', () => {
    expect(() => checkNodeInfo(INFO, EXPECTED)).not.toThrow();
    expect(() =>
      checkNodeInfo({ ...INFO, observer: true, sequencerAddress: null }, EXPECTED)
    ).not.toThrow();
  });

  it('names the first field that differs, and the node', () => {
    const other = `0x${'99'.repeat(32)}`;
    const cases: [keyof NodeExpectation, Partial<SequencerInfo>, string][] = [
      ['chainId', { chainId: 10200 }, '10200'],
      ['processRegistry', { processRegistry: `0x${'01'.repeat(20)}` }, `0x${'01'.repeat(20)}`],
      ['ballotVkHash', { ballotVkHash: other }, other],
      ['batchProgramVk', { batchProgramVk: other }, other],
      ['resultsProgramVk', { resultsProgramVk: other }, other],
    ];
    for (const [field, change, got] of cases) {
      let err: unknown;
      try {
        checkNodeInfo({ ...INFO, ...change }, EXPECTED, 'https://node.example');
      } catch (e) {
        err = e;
      }
      expect(err, field).toBeInstanceOf(NodeMismatchError);
      expect(err).toBeInstanceOf(SequencerError);
      expect(err).toMatchObject({
        field,
        expected: String(EXPECTED[field]),
        got,
        node: 'https://node.example',
      });
      expect((err as Error).message).toBe(
        `sequencer https://node.example: ${field} is ${got}, expected ${String(EXPECTED[field])}`
      );
    }
    expect(() =>
      checkNodeInfo({ ...INFO, chainId: 1, ballotVkHash: `0x${'00'.repeat(32)}` }, EXPECTED)
    ).toThrow('chainId is 1');
  });
});
