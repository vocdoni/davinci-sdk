import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";
import { ElectionTypeMetadata, ApprovalElectionConfig } from "./types/electionTypes";

/**
 * Approval election for multiple fields with only 0-1 options
 * Example: A referendum with 5 yes/no questions
 */
export class ApprovalElection extends BaseElection {
    private minApprovals?: number;
    private maxApprovals?: number;

  /**
   * Set the minimum number of approvals required
   */
  requireMinimumApprovals(min: number): this {
    if (min < 0) {
      throw new Error('Minimum approvals cannot be negative');
    }
    if (min > this.choices.length) {
      throw new Error('Minimum approvals cannot exceed the number of choices');
    }
    this.minApprovals = min;
    return this;
  }

  /**
   * Set the maximum number of approvals allowed
   */
  limitMaximumApprovals(max: number): this {
    if (max < 0) {
      throw new Error('Maximum approvals cannot be negative');
    }
    if (max > this.choices.length) {
      throw new Error('Maximum approvals cannot exceed the number of choices');
    }
    if (this.minApprovals !== undefined && max < this.minApprovals) {
      throw new Error('Maximum approvals cannot be less than minimum approvals');
    }
    this.maxApprovals = max;
    return this;
  }

  /**
   * Validate a vote for approval elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Must have exactly as many votes as choices
    if (votes.length !== this.choices.length) {
      errors.push(`Approval elections require exactly ${this.choices.length} votes (one for each choice)`);
    }

    // Each vote must be 0 or 1
    for (let i = 0; i < votes.length; i++) {
      const vote = votes[i];
      if (vote !== 0 && vote !== 1) {
        errors.push(`Vote ${i + 1} must be either 0 (disapprove) or 1 (approve), got ${vote}`);
      }
    }

    // Check total approvals within limits
    if (votes.length === this.choices.length) {
      const totalApprovals = votes.reduce((sum, vote) => sum + vote, 0);
      
      if (this.minApprovals !== undefined && totalApprovals < this.minApprovals) {
        errors.push(`Must approve at least ${this.minApprovals} choice(s), got ${totalApprovals}`);
      }
      
      if (this.maxApprovals !== undefined && totalApprovals > this.maxApprovals) {
        errors.push(`Cannot approve more than ${this.maxApprovals} choice(s), got ${totalApprovals}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for approval elections
   */
  protected generateBallotMode(): BallotMode {
    const maxApprovals = this.maxApprovals ?? this.choices.length;
    const minApprovals = this.minApprovals ?? 0;
    
    return {
      maxCount: this.choices.length,
      maxValue: "1",
      minValue: "0",
      forceUniqueness: false,
      costFromWeight: false,
      costExponent: 1,
      maxTotalCost: Math.min(maxApprovals, this.choices.length).toString(),
      minTotalCost: minApprovals.toString()
    };
  }

  /**
   * Customize metadata for approval elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    metadata.type = {
      name: ElectionResultsTypeNames.APPROVAL,
      properties: {
        rejectValue: 0,
        acceptValue: 1
      }
    };

    // Store election type information for reconstruction
    if (!metadata.meta) {
      metadata.meta = {};
    }
    
    const electionTypeInfo: ElectionTypeMetadata = {
      type: 'approval',
      version: '1.0',
      config: {
        minApprovals: this.minApprovals,
        maxApprovals: this.maxApprovals
      } as ApprovalElectionConfig
    };
    
    metadata.meta.electionType = electionTypeInfo;
  }

  /**
   * Custom validation for approval elections
   */
  protected customValidation(): void {
    if (this.choices.length < 1) {
      throw new Error('Approval elections must have at least 1 choice');
    }

    if (this.minApprovals !== undefined && this.maxApprovals !== undefined && this.minApprovals > this.maxApprovals) {
      throw new Error('Minimum approvals cannot be greater than maximum approvals');
    }

    if (this.maxApprovals !== undefined && this.maxApprovals > this.choices.length) {
      throw new Error('Maximum approvals cannot exceed the number of choices');
    }
  }

  /**
   * Get the current approval limits
   */
  getApprovalLimits(): { min: number | undefined; max: number | undefined } {
    return {
      min: this.minApprovals,
      max: this.maxApprovals
    };
  }
}
