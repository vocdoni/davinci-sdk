import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";

/**
 * Basic election for simple yes/no or single choice voting
 */
export class BasicElection extends BaseElection {
  private isYesNo: boolean = false;

  /**
   * Configure this as a yes/no election
   */
  asYesNo(): this {
    this.isYesNo = true;
    this.choices = [
      { title: "Yes", value: 0 },
      { title: "No", value: 1 }
    ];
    return this;
  }

  /**
   * Override addChoice to prevent modification of yes/no elections
   */
  addChoice(title: string, value?: number, meta?: any): this {
    if (this.isYesNo) {
      throw new Error('Cannot add choices to a yes/no election. Use asYesNo() or create a regular single choice election.');
    }
    return super.addChoice(title, value, meta);
  }

  /**
   * Validate a vote for basic elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Must have exactly one vote
    if (votes.length !== 1) {
      errors.push('Basic elections require exactly one choice');
    }

    // Vote must be within valid range
    if (votes.length > 0) {
      const vote = votes[0];
      const maxValue = this.choices.length - 1;
      if (vote < 0 || vote > maxValue) {
        errors.push(`Vote value must be between 0 and ${maxValue}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for basic elections
   */
  protected generateBallotMode(): BallotMode {
    return {
      maxCount: 1,
      maxValue: (this.choices.length - 1).toString(),
      minValue: "0",
      forceUniqueness: true,
      costFromWeight: false,
      costExponent: 1,
      maxTotalCost: "1",
      minTotalCost: "0"
    };
  }

  /**
   * Customize metadata for basic elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    metadata.type = {
      name: ElectionResultsTypeNames.SINGLE_CHOICE_MULTIQUESTION,
      properties: {}
    };
  }

  /**
   * Custom validation for basic elections
   */
  protected customValidation(): void {
    if (!this.isYesNo && this.choices.length < 2) {
      throw new Error('Single choice elections must have at least 2 choices');
    }

    if (this.isYesNo && this.choices.length !== 2) {
      throw new Error('Yes/No elections must have exactly 2 choices');
    }
  }

  /**
   * Check if this is a yes/no election
   */
  isYesNoElection(): boolean {
    return this.isYesNo;
  }
}
