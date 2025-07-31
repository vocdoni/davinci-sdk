import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";

/**
 * Multiple choice election allowing voters to select multiple options
 */
export class MultiChoiceElection extends BaseElection {
  private maxSelections: number = 1;
  private minSelections: number = 1;
  private abstentionAllowed: boolean = false;
  private repeatChoicesAllowed: boolean = false;

  /**
   * Set the maximum number of selections allowed
   */
  allowMultipleSelections(max: number): this {
    if (max < 1) {
      throw new Error('Maximum selections must be at least 1');
    }
    if (max < this.minSelections) {
      throw new Error('Maximum selections cannot be less than minimum selections');
    }
    this.maxSelections = max;
    return this;
  }

  /**
   * Set the minimum number of selections required
   */
  requireMinimumSelections(min: number): this {
    if (min < 0) {
      throw new Error('Minimum selections cannot be negative');
    }
    if (min > this.maxSelections) {
      throw new Error('Minimum selections cannot be greater than maximum selections');
    }
    this.minSelections = min;
    return this;
  }

  /**
   * Allow voters to abstain (not make any selection)
   */
  allowAbstention(): this {
    this.abstentionAllowed = true;
    this.minSelections = 0;
    return this;
  }

  /**
   * Allow voters to select the same choice multiple times
   */
  allowRepeatChoices(): this {
    this.repeatChoicesAllowed = true;
    return this;
  }

  /**
   * Validate a vote for multiple choice elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Check minimum selections
    if (votes.length < this.minSelections) {
      errors.push(`Must select at least ${this.minSelections} choice(s)`);
    }

    // Check maximum selections
    if (votes.length > this.maxSelections) {
      errors.push(`Cannot select more than ${this.maxSelections} choice(s)`);
    }

    // Check for valid vote values
    const maxValue = this.choices.length - 1;
    for (const vote of votes) {
      if (vote < 0 || vote > maxValue) {
        errors.push(`Vote value must be between 0 and ${maxValue}`);
        break;
      }
    }

    // Check for unique choices if repeat choices are not allowed
    if (!this.repeatChoicesAllowed && new Set(votes).size !== votes.length) {
      errors.push('Cannot select the same choice multiple times');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for multiple choice elections
   */
  protected generateBallotMode(): BallotMode {
    return {
      maxCount: this.maxSelections,
      maxValue: (this.choices.length - 1).toString(),
      minValue: "0",
      forceUniqueness: !this.repeatChoicesAllowed,
      costFromWeight: false,
      costExponent: 1,
      maxTotalCost: this.maxSelections.toString(),
      minTotalCost: this.minSelections.toString()
    };
  }

  /**
   * Customize metadata for multiple choice elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    // Add abstention choices if allowed
    const abstainValues: string[] = [];
    if (this.abstentionAllowed) {
      // Add abstention values based on the number of possible abstentions
      const numAbstainValues = this.repeatChoicesAllowed ? 1 : this.maxSelections;
      for (let i = 0; i < numAbstainValues; i++) {
        abstainValues.push((this.choices.length + i).toString());
      }
    }

    metadata.type = {
      name: ElectionResultsTypeNames.MULTIPLE_CHOICE,
      properties: {
        canAbstain: this.abstentionAllowed,
        abstainValues,
        repeatChoice: this.repeatChoicesAllowed,
        numChoices: {
          min: this.minSelections,
          max: this.maxSelections
        }
      }
    };
  }

  /**
   * Custom validation for multiple choice elections
   */
  protected customValidation(): void {
    if (this.choices.length < 2) {
      throw new Error('Multiple choice elections must have at least 2 choices');
    }

    if (this.minSelections > this.maxSelections) {
      throw new Error('Minimum selections cannot be greater than maximum selections');
    }

    if (this.maxSelections > this.choices.length && !this.repeatChoicesAllowed) {
      throw new Error('Maximum selections cannot exceed the number of choices when repeat choices are not allowed');
    }
  }

  /**
   * Get the current selection limits
   */
  getSelectionLimits(): { min: number; max: number } {
    return {
      min: this.minSelections,
      max: this.maxSelections
    };
  }

  /**
   * Check if abstention is allowed
   */
  isAbstentionAllowed(): boolean {
    return this.abstentionAllowed;
  }

  /**
   * Check if repeat choices are allowed
   */
  areRepeatChoicesAllowed(): boolean {
    return this.repeatChoicesAllowed;
  }
}
