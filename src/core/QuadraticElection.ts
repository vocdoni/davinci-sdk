import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";
import { ElectionTypeMetadata, QuadraticElectionConfig } from "./types/electionTypes";

/**
 * Quadratic election for credit distribution with quadratic cost
 * Example: You have 12 credits to distribute among 5 options
 */
export class QuadraticElection extends BaseElection {
  private totalCredits?: number;
  private useCensusWeightAsBudget?: boolean;
  private minStep?: number;
  private forceFullBudget?: boolean;

  /**
   * Set the total number of credits available for distribution
   */
  setTotalCredits(credits: number): this {
    if (credits < 0) {
      throw new Error('Total credits cannot be negative');
    }
    this.totalCredits = credits;
    return this;
  }

  /**
   * Use census weight as the budget for each voter
   */
  enableCensusWeightAsBudget(): this {
    this.useCensusWeightAsBudget = true;
    return this;
  }

  /**
   * Use a fixed budget for all voters
   */
  useFixedBudget(credits: number): this {
    this.useCensusWeightAsBudget = false;
    this.totalCredits = credits;
    return this;
  }

  /**
   * Set the minimum step size for vote values
   */
  setMinStep(step: number): this {
    if (step <= 0) {
      throw new Error('Minimum step must be positive');
    }
    this.minStep = step;
    return this;
  }

  /**
   * Require voters to spend all their credits
   */
  requireFullBudget(): this {
    this.forceFullBudget = true;
    return this;
  }

  /**
   * Allow voters to spend less than their full budget
   */
  allowPartialBudget(): this {
    this.forceFullBudget = false;
    return this;
  }

  /**
   * Calculate the quadratic cost of a set of votes
   */
  private calculateQuadraticCost(votes: number[]): number {
    return votes.reduce((totalCost, vote) => {
      return totalCost + (vote * vote);
    }, 0);
  }

  /**
   * Validate a vote for quadratic elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Must have exactly as many votes as choices
    if (votes.length !== this.choices.length) {
      errors.push(`Quadratic elections require exactly ${this.choices.length} votes (one for each choice)`);
    }

    const minStep = this.minStep ?? 1;
    const totalCredits = this.totalCredits ?? 12;
    const forceFullBudget = this.forceFullBudget ?? false;

    // Check that all votes are valid multiples of minStep and non-negative
    for (let i = 0; i < votes.length; i++) {
      const vote = votes[i];
      
      // Check for negative votes
      if (vote < 0) {
        errors.push(`Vote ${i + 1} cannot be negative, got ${vote}`);
        continue; // Skip other validations for this vote
      }
      
      if (vote % minStep !== 0) {
        errors.push(`Vote ${i + 1} must be a multiple of ${minStep}, got ${vote}`);
      }
    }

    // Calculate quadratic cost
    if (votes.length === this.choices.length) {
      const quadraticCost = this.calculateQuadraticCost(votes);
      
      if (forceFullBudget) {
        // Must spend exactly all credits
        if (quadraticCost !== totalCredits) {
          errors.push(`Must spend exactly ${totalCredits} credits, spent ${quadraticCost}`);
        }
      } else {
        // Must not exceed total credits
        if (quadraticCost > totalCredits) {
          errors.push(`Cannot spend more than ${totalCredits} credits, tried to spend ${quadraticCost}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for quadratic elections
   */
  protected generateBallotMode(): BallotMode {
    const totalCredits = this.totalCredits ?? 12;
    const useCensusWeightAsBudget = this.useCensusWeightAsBudget ?? false;
    const forceFullBudget = this.forceFullBudget ?? false;
    
    // Calculate maximum possible vote value per choice
    // For quadratic voting, if we have C credits and want to spend all on one choice,
    // the maximum vote would be sqrt(C)
    const maxVoteValue = Math.floor(Math.sqrt(totalCredits));
    
    return {
      maxCount: this.choices.length,
      maxValue: maxVoteValue.toString(),
      minValue: "0", // Only allow non-negative votes
      forceUniqueness: false,
      costFromWeight: useCensusWeightAsBudget,
      costExponent: 2, // Quadratic cost
      maxTotalCost: totalCredits.toString(),
      minTotalCost: forceFullBudget ? totalCredits.toString() : "0"
    };
  }

  /**
   * Customize metadata for quadratic elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    const totalCredits = this.totalCredits ?? 12;
    const useCensusWeightAsBudget = this.useCensusWeightAsBudget ?? false;
    const minStep = this.minStep ?? 1;
    const forceFullBudget = this.forceFullBudget ?? false;
    
    metadata.type = {
      name: ElectionResultsTypeNames.QUADRATIC,
      properties: {
        useCensusWeightAsBudget,
        maxBudget: totalCredits,
        minStep,
        forceFullBudget,
        quadraticCost: 2
      }
    };

    // Store election type information for reconstruction
    if (!metadata.meta) {
      metadata.meta = {};
    }
    
    const electionTypeInfo: ElectionTypeMetadata = {
      type: 'quadratic',
      version: '1.0',
      config: {
        totalCredits: this.totalCredits,
        useCensusWeightAsBudget: this.useCensusWeightAsBudget,
        minStep: this.minStep,
        forceFullBudget: this.forceFullBudget
      } as QuadraticElectionConfig
    };
    
    metadata.meta.electionType = electionTypeInfo;

    // Keep legacy metadata for backward compatibility
    metadata.meta.quadraticElection = {
      totalCredits,
      useCensusWeightAsBudget,
      minStep,
      forceFullBudget,
      maxVotePerChoice: Math.floor(Math.sqrt(totalCredits))
    };
  }

  /**
   * Custom validation for quadratic elections
   */
  protected customValidation(): void {
    if (this.choices.length < 1) {
      throw new Error('Quadratic elections must have at least 1 choice');
    }

    const totalCredits = this.totalCredits ?? 12;
    const minStep = this.minStep ?? 1;
    const forceFullBudget = this.forceFullBudget ?? false;

    if (totalCredits <= 0) {
      throw new Error('Total credits must be positive');
    }

    if (minStep <= 0) {
      throw new Error('Minimum step must be positive');
    }

    // Check if it's possible to spend credits with the given constraints
    if (forceFullBudget) {
      // With quadratic cost, we need to check if totalCredits can be achieved
      // The minimum cost to cast any vote is minStep^2
      const minCostPerVote = minStep * minStep;
      if (totalCredits < minCostPerVote) {
        throw new Error(`Cannot spend ${totalCredits} credits with minimum step ${minStep} (minimum cost per vote is ${minCostPerVote})`);
      }
    }
  }

  /**
   * Get the current quadratic voting configuration
   */
  getQuadraticConfig(): {
    totalCredits: number | undefined;
    useCensusWeightAsBudget: boolean | undefined;
    minStep: number | undefined;
    forceFullBudget: boolean | undefined;
    maxVotePerChoice: number;
  } {
    const totalCredits = this.totalCredits ?? 12;
    return {
      totalCredits: this.totalCredits,
      useCensusWeightAsBudget: this.useCensusWeightAsBudget,
      minStep: this.minStep,
      forceFullBudget: this.forceFullBudget,
      maxVotePerChoice: Math.floor(Math.sqrt(totalCredits))
    };
  }

  /**
   * Calculate the cost of a specific vote value
   */
  calculateVoteCost(voteValue: number): number {
    return voteValue * voteValue;
  }

  /**
   * Calculate the maximum vote value for a given cost
   */
  calculateMaxVoteForCost(cost: number): number {
    return Math.floor(Math.sqrt(cost));
  }

  /**
   * Get the total credits available
   */
  getTotalCredits(): number | undefined {
    return this.totalCredits;
  }

  /**
   * Check if census weight is used as budget
   */
  isUsingCensusWeightAsBudget(): boolean {
    return this.useCensusWeightAsBudget ?? false;
  }

  /**
   * Check if full budget is required
   */
  isFullBudgetRequired(): boolean {
    return this.forceFullBudget ?? false;
  }

  /**
   * Get the minimum step size
   */
  getMinStep(): number {
    return this.minStep ?? 1;
  }
}
