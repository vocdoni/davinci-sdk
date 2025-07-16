import { DavinciSDK } from "../core/DavinciSDK";
import { ElectionMetadata, getElectionMetadataTemplate, BallotMode } from "../core/types";
import { ElectionConfig, ElectionChoice, ElectionResult, VoteValidationResult } from "./types";

/**
 * Abstract base class for all election types
 */
export abstract class BaseElection {
  protected sdk: DavinciSDK;
  protected config: ElectionConfig;
  protected choices: ElectionChoice[] = [];

  constructor(sdk: DavinciSDK, config: ElectionConfig) {
    this.sdk = sdk;
    this.config = config;
  }

  /**
   * Add a choice to the election
   */
  addChoice(title: string, value?: number, meta?: any): this {
    const choice: ElectionChoice = {
      title,
      value: value ?? this.choices.length,
      meta
    };
    this.choices.push(choice);
    return this;
  }

  /**
   * Set media for the election
   */
  setMedia(header?: string, logo?: string): this {
    this.config.media = { header, logo };
    return this;
  }

  /**
   * Build and create the election
   */
  async build(): Promise<ElectionResult> {
    // Validate the election configuration
    this.validate();

    // Generate metadata
    const metadata = this.generateMetadata();

    // Generate ballot mode
    const ballotMode = this.generateBallotMode();

    // Create the process using the SDK
    const result = await this.sdk.createProcess({
      title: this.config.title,
      description: this.config.description || '',
      censusRoot: this.config.censusRoot,
      maxVotes: this.config.maxVotes,
      duration: this.config.duration,
      startTime: this.config.startTime ? Math.floor(this.config.startTime.getTime() / 1000) : undefined,
      questions: [{
        title: this.config.title,
        description: this.config.description,
        choices: this.choices.map(choice => ({
          title: choice.title,
          value: choice.value!
        }))
      }],
      media: this.config.media
    });

    return {
      processId: result.processId,
      transactionHash: result.transactionHash,
      encryptionPubKey: result.encryptionPubKey,
      stateRoot: result.stateRoot,
      metadataHash: result.metadataHash,
      metadata
    };
  }

  /**
   * Validate a vote for this election type
   */
  abstract validateVote(votes: number[]): VoteValidationResult;

  /**
   * Generate the metadata for this election type
   */
  protected generateMetadata(): ElectionMetadata {
    const metadata = getElectionMetadataTemplate();
    
    metadata.title.default = this.config.title;
    metadata.description.default = this.config.description || '';
    
    if (this.config.media) {
      metadata.media.header = this.config.media.header || '';
      metadata.media.logo = this.config.media.logo || '';
    }

    metadata.questions = [{
      title: { default: this.config.title },
      description: { default: this.config.description || '' },
      meta: {},
      choices: this.choices.map(choice => ({
        title: { default: choice.title },
        value: choice.value!,
        meta: choice.meta || {}
      }))
    }];

    // Let subclasses customize the metadata
    this.customizeMetadata(metadata);

    return metadata;
  }

  /**
   * Generate the ballot mode for this election type
   */
  protected abstract generateBallotMode(): BallotMode;

  /**
   * Allow subclasses to customize metadata
   */
  protected abstract customizeMetadata(metadata: ElectionMetadata): void;

  /**
   * Validate the election configuration
   */
  protected validate(): void {
    if (!this.config.title || this.config.title.trim().length === 0) {
      throw new Error('Election title is required');
    }

    if (this.config.duration <= 0) {
      throw new Error('Election duration must be positive');
    }

    if (!this.config.censusRoot) {
      throw new Error('Census root is required');
    }

    if (!this.config.maxVotes) {
      throw new Error('Max votes is required');
    }

    if (this.choices.length === 0) {
      throw new Error('At least one choice is required');
    }

    // Let subclasses add their own validation
    this.customValidation();
  }

  /**
   * Allow subclasses to add custom validation
   */
  protected abstract customValidation(): void;

  /**
   * Get the current choices
   */
  getChoices(): ElectionChoice[] {
    return [...this.choices];
  }

  /**
   * Get the current configuration
   */
  getConfig(): ElectionConfig {
    return { ...this.config };
  }
}
