import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";
import { ElectionTypeMetadata, RatingElectionConfig } from "./types/electionTypes";

/**
 * Rating election for independent rating of multiple items
 * Example: Satisfaction survey on 5 items, rated from 0 to 10 stars
 */
export class RatingElection extends BaseElection {
  private maxRating?: number;
  private minRating?: number;
  private maxTotalRating?: number;
  private minTotalRating?: number;

  /**
   * Set the maximum rating value for each item
   */
  setMaxRating(max: number): this {
    if (max < 0) {
      throw new Error('Maximum rating cannot be negative');
    }
    if (this.minRating !== undefined && max < this.minRating) {
      throw new Error('Maximum rating cannot be less than minimum rating');
    }
    this.maxRating = max;
    return this;
  }

  /**
   * Set the minimum rating value for each item
   */
  setMinRating(min: number): this {
    if (min < 0) {
      throw new Error('Minimum rating cannot be negative');
    }
    if (this.maxRating !== undefined && min > this.maxRating) {
      throw new Error('Minimum rating cannot be greater than maximum rating');
    }
    this.minRating = min;
    return this;
  }

  /**
   * Set the minimum total rating sum across all items
   */
  setMinTotalRating(min: number): this {
    if (min < 0) {
      throw new Error('Minimum total rating cannot be negative');
    }
    if (this.maxTotalRating !== undefined && min > this.maxTotalRating) {
      throw new Error('Minimum total rating cannot be greater than maximum total rating');
    }
    
    // Check if the constraint is achievable with current settings
    if (this.minRating !== undefined && this.maxRating !== undefined && this.choices.length > 0) {
      const maxPossibleTotal = this.choices.length * this.maxRating;
      if (min > maxPossibleTotal) {
        throw new Error(`Minimum total rating (${min}) is impossible to achieve with ${this.choices.length} items rated ${this.minRating}-${this.maxRating}`);
      }
    }
    
    this.minTotalRating = min;
    return this;
  }

  /**
   * Set the maximum total rating sum across all items
   */
  setMaxTotalRating(max: number): this {
    if (max < 0) {
      throw new Error('Maximum total rating cannot be negative');
    }
    if (this.minTotalRating !== undefined && max < this.minTotalRating) {
      throw new Error('Maximum total rating cannot be less than minimum total rating');
    }
    
    // Check if the constraint is achievable with current settings
    if (this.minRating !== undefined && this.maxRating !== undefined && this.choices.length > 0) {
      const minPossibleTotal = this.choices.length * this.minRating;
      if (max < minPossibleTotal) {
        throw new Error(`Maximum total rating (${max}) is impossible to achieve with ${this.choices.length} items rated ${this.minRating}-${this.maxRating}`);
      }
    }
    
    this.maxTotalRating = max;
    return this;
  }

  /**
   * Validate a vote for rating elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Must have exactly as many votes as choices
    if (votes.length !== this.choices.length) {
      errors.push(`Rating elections require exactly ${this.choices.length} ratings (one for each item)`);
    }

    // Each rating must be within the valid range
    for (let i = 0; i < votes.length; i++) {
      const rating = votes[i];
      const minRating = this.minRating ?? 0;
      const maxRating = this.maxRating ?? 10;
      
      if (rating < minRating || rating > maxRating) {
        errors.push(`Rating ${i + 1} must be between ${minRating} and ${maxRating}, got ${rating}`);
      }
    }

    // Check total rating within limits
    if (votes.length === this.choices.length) {
      const totalRating = votes.reduce((sum, rating) => sum + rating, 0);
      
      if (this.minTotalRating !== undefined && totalRating < this.minTotalRating) {
        errors.push(`Total rating must be at least ${this.minTotalRating}, got ${totalRating}`);
      }
      
      if (this.maxTotalRating !== undefined && totalRating > this.maxTotalRating) {
        errors.push(`Total rating cannot exceed ${this.maxTotalRating}, got ${totalRating}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for rating elections
   */
  protected generateBallotMode(): BallotMode {
    const maxRating = this.maxRating ?? 10;
    const minRating = this.minRating ?? 0;
    const maxTotalRating = this.maxTotalRating ?? (this.choices.length * maxRating);
    const minTotalRating = this.minTotalRating ?? (this.choices.length * minRating);

    return {
      maxCount: this.choices.length,
      maxValue: maxRating.toString(),
      minValue: minRating.toString(),
      forceUniqueness: false,
      costFromWeight: false,
      costExponent: 1,
      maxTotalCost: Math.min(maxTotalRating, this.choices.length * maxRating).toString(),
      minTotalCost: Math.max(minTotalRating, this.choices.length * minRating).toString()
    };
  }

  /**
   * Customize metadata for rating elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    metadata.type = {
      name: ElectionResultsTypeNames.MULTIPLE_CHOICE,
      properties: {
        canAbstain: false,
        abstainValues: [],
        repeatChoice: false,
        numChoices: {
          min: this.choices.length,
          max: this.choices.length
        }
      }
    };

    // Store election type information for reconstruction
    if (!metadata.meta) {
      metadata.meta = {};
    }
    
    const electionTypeInfo: ElectionTypeMetadata = {
      type: 'rating',
      version: '1.0',
      config: {
        minRating: this.minRating,
        maxRating: this.maxRating,
        minTotalRating: this.minTotalRating,
        maxTotalRating: this.maxTotalRating
      } as RatingElectionConfig
    };
    
    metadata.meta.electionType = electionTypeInfo;

    // Keep legacy metadata for backward compatibility
    metadata.meta.ratingElection = {
      minRating: this.minRating,
      maxRating: this.maxRating,
      minTotalRating: this.minTotalRating,
      maxTotalRating: this.maxTotalRating
    };
  }

  /**
   * Custom validation for rating elections
   */
  protected customValidation(): void {
    if (this.choices.length < 1) {
      throw new Error('Rating elections must have at least 1 item to rate');
    }

    if (this.minRating !== undefined && this.maxRating !== undefined && this.minRating > this.maxRating) {
      throw new Error('Minimum rating cannot be greater than maximum rating');
    }

    if (this.minTotalRating !== undefined && this.maxTotalRating !== undefined && this.minTotalRating > this.maxTotalRating) {
      throw new Error('Minimum total rating cannot be greater than maximum total rating');
    }

    // Check if the total rating constraints are achievable
    if (this.minRating !== undefined && this.maxRating !== undefined) {
      const minPossibleTotal = this.choices.length * this.minRating;
      const maxPossibleTotal = this.choices.length * this.maxRating;

      if (this.minTotalRating !== undefined && this.minTotalRating > maxPossibleTotal) {
        throw new Error(`Minimum total rating (${this.minTotalRating}) is impossible to achieve with ${this.choices.length} items rated ${this.minRating}-${this.maxRating}`);
      }

      if (this.maxTotalRating !== undefined && this.maxTotalRating < minPossibleTotal) {
        throw new Error(`Maximum total rating (${this.maxTotalRating}) is impossible to achieve with ${this.choices.length} items rated ${this.minRating}-${this.maxRating}`);
      }
    }
  }

  /**
   * Get the current rating configuration
   */
  getRatingConfig(): {
    minRating: number | undefined;
    maxRating: number | undefined;
    minTotalRating: number | undefined;
    maxTotalRating: number | undefined;
  } {
    return {
      minRating: this.minRating,
      maxRating: this.maxRating,
      minTotalRating: this.minTotalRating,
      maxTotalRating: this.maxTotalRating
    };
  }
}
