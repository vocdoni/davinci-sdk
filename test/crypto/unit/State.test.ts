import { CensusOrigin } from '../../../src/census/types';
import { calculateInitialStateRoot, formatStateRoot } from '../../../src/crypto/State';

describe('Crypto Unit: Initial State Root', () => {
  it('matches example 1', async () => {
    const root = await calculateInitialStateRoot({
      processId: 'a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000054',
      censusOrigin: CensusOrigin.OffchainStatic,
      ballotMode: {
        numFields: 2,
        uniqueValues: false,
        maxValue: '3',
        minValue: '0',
        maxValueSum: '6',
        minValueSum: '0',
        costExponent: 1,
        costFromWeight: false,
      },
      encryptionKey: {
        x: '16933062402632635736496659348042530570269601638203711496225900074829366889921',
        y: '11508164083883461513547825430852413119776037873858767460423492545044648001105',
      },
    });

    expect(formatStateRoot(root)).toBe(
      '0x2bfe7c9d72c0ba31fb9b98380a853988512cfd370cbdd0e612a2200021e3d2a8'
    );
  });

  it('matches example 2', async () => {
    const root = await calculateInitialStateRoot({
      processId: 'a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000052',
      censusOrigin: CensusOrigin.OffchainStatic,
      ballotMode: {
        numFields: 8,
        uniqueValues: false,
        maxValue: '3',
        minValue: '0',
        maxValueSum: '6',
        minValueSum: '0',
        costExponent: 1,
        costFromWeight: false,
      },
      encryptionKey: {
        x: '1492682040326512594284755973658780253462029564060776960680900314510687633597',
        y: '7637432446709144246823592048956657247103456391796340456316224306151082192247',
      },
    });

    expect(formatStateRoot(root)).toBe(
      '0x24ca8ee12a764bb75106acbd42c57807804694ef5347d15b51a77a6b51ea8d28'
    );
  });
});
