import { DavinciSDK } from "../core/DavinciSDK";
import { ElectionConfig } from "./types";
import { BasicElection } from "./BasicElection";
import { MultiChoiceElection } from "./MultiChoiceElection";

/**
 * Main election builder class providing a fluent API for creating elections
 */
export class ElectionBuilder {
  private sdk: DavinciSDK;
  private config: Partial<ElectionConfig> = {};

  constructor(sdk: DavinciSDK) {
    this.sdk = sdk;
  }

  /**
   * Set the election title
   */
  title(title: string): this {
    this.config.title = title;
    return this;
  }

  /**
   * Set the election description
   */
  description(description: string): this {
    this.config.description = description;
    return this;
  }

  /**
   * Set the election duration in seconds
   */
  duration(seconds: number): this {
    this.config.duration = seconds;
    return this;
  }

  /**
   * Set the election start time
   */
  startTime(date: Date): this {
    this.config.startTime = date;
    return this;
  }

  /**
   * Set the census root hash
   */
  censusRoot(root: string): this {
    this.config.censusRoot = root;
    return this;
  }

  /**
   * Set the maximum number of votes
   */
  maxVotes(max: string): this {
    this.config.maxVotes = max;
    return this;
  }

  /**
   * Set media attachments
   */
  media(header?: string, logo?: string): this {
    this.config.media = { header, logo };
    return this;
  }

  /**
   * Create a basic single choice election
   */
  singleChoice(): BasicElection {
    return new BasicElection(this.sdk, this.getCompleteConfig());
  }

  /**
   * Create a yes/no election
   */
  yesNo(): BasicElection {
    const election = new BasicElection(this.sdk, this.getCompleteConfig());
    return election.asYesNo();
  }

  /**
   * Create a multiple choice election
   */
  multipleChoice(): MultiChoiceElection {
    return new MultiChoiceElection(this.sdk, this.getCompleteConfig());
  }

  /**
   * Get the complete configuration, filling in required fields
   */
  private getCompleteConfig(): ElectionConfig {
    // Validate required fields
    if (!this.config.title) {
      throw new Error('Election title is required');
    }
    if (!this.config.duration) {
      throw new Error('Election duration is required');
    }
    if (!this.config.censusRoot) {
      throw new Error('Census root is required');
    }
    if (!this.config.maxVotes) {
      throw new Error('Max votes is required');
    }

    return {
      title: this.config.title,
      description: this.config.description,
      duration: this.config.duration,
      startTime: this.config.startTime,
      censusRoot: this.config.censusRoot,
      maxVotes: this.config.maxVotes,
      media: this.config.media
    };
  }

  /**
   * Get the current configuration (for debugging/inspection)
   */
  getConfig(): Partial<ElectionConfig> {
    return { ...this.config };
  }
}
