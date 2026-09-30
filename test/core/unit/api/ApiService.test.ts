import { VocdoniApiService } from '../../../../src/core/api/ApiService';
import { SequencerUnavailableError } from '../../../../src/sequencer';

const A = 'https://a.sequencer.test';
const B = 'https://b.sequencer.test';
const C = 'https://c.sequencer.test';

describe('VocdoniApiService', () => {
  it('routes votes over the nodes and takes keys from the first by default', () => {
    const api = new VocdoniApiService({ sequencerURLs: [A, B, B] });
    expect(api.nodes.urls).toEqual([A, B]);
    expect(api.sequencer).toBe(api.nodes.node(A));
  });

  it('takes keys from the key node, a vote node or not', () => {
    const inside = new VocdoniApiService({ sequencerURLs: [A, B], keySequencerURL: B });
    expect(inside.sequencer).toBe(inside.nodes.node(B));
    const apart = new VocdoniApiService({ sequencerURLs: [A, B], keySequencerURL: C });
    expect(apart.sequencer.getBaseUrl()).toBe(C);
    expect(apart.nodes.urls).toEqual([A, B]);
    const alone = new VocdoniApiService({ keySequencerURL: C });
    expect(alone.nodes.urls).toEqual([C]);
  });

  it('adds the deprecated single node URL', () => {
    const api = new VocdoniApiService({ sequencerURLs: [A], sequencerURL: B });
    expect(api.nodes.urls).toEqual([A, B]);
    expect(new VocdoniApiService({ sequencerURL: C }).sequencer.getBaseUrl()).toBe(C);
  });

  it('leaves out unusable nodes and names them when a role has none left', () => {
    const down = { url: A, reason: 'down: fetch failed' };
    const observer = { url: B, reason: 'observer' };
    const api = new VocdoniApiService({ sequencerURLs: [A, B, C], unusable: [down, observer] });
    expect(api.nodes.urls).toEqual([C]);
    expect(api.sequencer.getBaseUrl()).toBe(C);

    const none = new VocdoniApiService({ sequencerURLs: [A, B], unusable: [down, observer] });
    const err = (() => {
      try {
        return none.nodes;
      } catch (e) {
        return e as SequencerUnavailableError;
      }
    })();
    expect(err).toBeInstanceOf(SequencerUnavailableError);
    expect(err).toMatchObject({ nodes: [down, observer] });
    expect(() => none.nodes).toThrow(
      `no usable sequencer node: ${A} (down: fetch failed), ${B} (observer)`
    );
    expect(() => none.sequencer).toThrow(`no usable key sequencer: ${A} (down: fetch failed)`);

    const keyDown = new VocdoniApiService({
      sequencerURLs: [A],
      keySequencerURL: C,
      unusable: [{ url: C, reason: 'observer' }],
    });
    expect(keyDown.nodes.urls).toEqual([A]);
    expect(() => keyDown.sequencer).toThrow(`no usable key sequencer: ${C} (observer)`);

    expect(() => new VocdoniApiService({}).nodes).toThrow('no sequencer node is configured');
    expect(() => new VocdoniApiService({}).sequencer).toThrow('no key sequencer is configured');
  });
});
