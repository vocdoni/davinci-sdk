import { SequencerUnavailableError, type UnusableNode } from '../../sequencer/errors';
import { SequencerNodes } from '../../sequencer/SequencerNodes';
import { VocdoniSequencerService } from '../../sequencer/SequencerService';
import type { BaseServiceConfig } from './BaseService';

/** The sequencer nodes of a {@link VocdoniApiService}, by role. */
export interface VocdoniApiServiceConfig {
  /** Sequencer nodes that take votes and answer reads. */
  sequencerURLs?: readonly string[];
  /**
   * The node that issues election keys. Default: the first usable node of
   * `sequencerURLs`. With no `sequencerURLs`, it is also the vote node.
   */
  keySequencerURL?: string;
  /** @deprecated A single node: use `sequencerURLs`. */
  sequencerURL?: string;
  /** Headers, `fetchImpl`, timeout and body cap of the sequencer clients. */
  sequencerConfig?: BaseServiceConfig;
  /**
   * Configured nodes not to use (down, observers) and why. They are left out
   * of both roles and named by the error of a role left without a node.
   */
  unusable?: readonly UnusableNode[];
}

/**
 * The sequencer clients of one deployment. A role left without a usable node
 * throws {@link SequencerUnavailableError} from its getter, naming the nodes
 * left out; the other role still works.
 */
export class VocdoniApiService {
  private readonly voteNodes?: SequencerNodes;
  private readonly keyNode?: VocdoniSequencerService;
  private readonly unusableVote: readonly UnusableNode[];
  private readonly unusableKey: readonly UnusableNode[];

  constructor(config: VocdoniApiServiceConfig) {
    const unusable = config.unusable ?? [];
    const usable = (url: string) => !unusable.some(n => n.url === url);
    const listed = [
      ...(config.sequencerURLs ?? []),
      ...(config.sequencerURL !== undefined ? [config.sequencerURL] : []),
    ];
    const explicitKey = config.keySequencerURL;
    const voteList = listed.length > 0 ? listed : explicitKey !== undefined ? [explicitKey] : [];
    const voteUrls = [...new Set(voteList)].filter(usable);
    const keyUrl = explicitKey ?? voteUrls[0];

    if (voteUrls.length > 0) this.voteNodes = new SequencerNodes(voteUrls, config.sequencerConfig);
    if (keyUrl !== undefined && usable(keyUrl)) {
      this.keyNode = this.voteNodes?.urls.includes(keyUrl)
        ? this.voteNodes.node(keyUrl)
        : new VocdoniSequencerService(keyUrl, config.sequencerConfig);
    }
    this.unusableVote = unusable.filter(n => voteList.includes(n.url));
    this.unusableKey =
      explicitKey !== undefined ? unusable.filter(n => n.url === explicitKey) : this.unusableVote;
  }

  /**
   * The node that issues election keys (`POST /processes/keys`).
   *
   * @throws SequencerUnavailableError when there is none, or it is down or an observer
   */
  get sequencer(): VocdoniSequencerService {
    if (!this.keyNode) throw new SequencerUnavailableError('key sequencer', this.unusableKey);
    return this.keyNode;
  }

  /**
   * Every usable node, with vote routing and failover.
   *
   * @throws SequencerUnavailableError when there is none, or every node is down or an observer
   */
  get nodes(): SequencerNodes {
    if (!this.voteNodes) throw new SequencerUnavailableError('sequencer node', this.unusableVote);
    return this.voteNodes;
  }
}
