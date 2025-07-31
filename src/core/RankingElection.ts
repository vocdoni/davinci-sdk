import { BaseElection } from "./BaseElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { VoteValidationResult } from "./types/election";
import { ElectionTypeMetadata, RankingElectionConfig } from "./types/electionTypes";

/**
 * Ranking election for ranked choice voting with unique rankings
 * Example: Rank 5 destinations for the end-of-year school trip
 */
export class RankingElection extends BaseElection {
    private allowPartialRanking?: boolean;
    private minRankedChoices?: number;

  /**
   * Allow voters to rank only some choices (partial ranking)
   */
  enablePartialRanking(minRanked: number = 1): this {
    if (minRanked < 1) {
      throw new Error('Minimum ranked choices must be at least 1');
    }
    if (minRanked > this.choices.length) {
      throw new Error('Minimum ranked choices cannot exceed the number of choices');
    }
    this.allowPartialRanking = true;
    this.minRankedChoices = minRanked;
    return this;
  }

  /**
   * Require voters to rank all choices (full ranking)
   */
  requireFullRanking(): this {
    this.allowPartialRanking = false;
    this.minRankedChoices = 0;
    return this;
  }

  /**
   * Validate a vote for ranking elections
   */
  validateVote(votes: number[]): VoteValidationResult {
    const errors: string[] = [];

    // Must have exactly as many votes as choices
    if (votes.length !== this.choices.length) {
      errors.push(`Ranking elections require exactly ${this.choices.length} rankings (one for each choice)`);
      return { valid: false, errors };
    }

    // Count non-zero rankings (0 means unranked in partial ranking)
    const nonZeroRankings = votes.filter(vote => vote > 0);
    const uniqueRankings = new Set(nonZeroRankings);

    // Check if partial ranking is allowed
    const isPartialRanking = this.allowPartialRanking ?? false;
    const minRanked = this.minRankedChoices ?? 0;

    if (!isPartialRanking) {
      // Full ranking required - all votes must be 1 to N
      if (nonZeroRankings.length !== this.choices.length) {
        errors.push('Full ranking required - all choices must be ranked');
      }
    } else {
      // Partial ranking allowed - check minimum ranked choices
      if (nonZeroRankings.length < minRanked) {
        errors.push(`Must rank at least ${minRanked} choice(s), got ${nonZeroRankings.length}`);
      }
    }

    // Check that all rankings are within valid range
    for (let i = 0; i < votes.length; i++) {
      const rank = votes[i];
      
      if (isPartialRanking) {
        // In partial ranking, 0 means unranked, 1-N are valid ranks
        if (rank < 0 || rank > this.choices.length) {
          errors.push(`Rank ${i + 1} must be between 0 (unranked) and ${this.choices.length}, got ${rank}`);
        }
      } else {
        // In full ranking, all ranks must be 1-N
        if (rank < 1 || rank > this.choices.length) {
          errors.push(`Rank ${i + 1} must be between 1 and ${this.choices.length}, got ${rank}`);
        }
      }
    }

    // Check for unique rankings (no duplicates except 0 in partial ranking)
    if (isPartialRanking) {
      // In partial ranking, all non-zero ranks must be unique
      if (uniqueRankings.size !== nonZeroRankings.length) {
        errors.push('All non-zero rankings must be unique');
      }
      
      // Check that rankings form a consecutive sequence starting from 1
      if (nonZeroRankings.length > 0) {
        const sortedRankings = [...uniqueRankings].sort((a, b) => a - b);
        for (let i = 0; i < sortedRankings.length; i++) {
          if (sortedRankings[i] !== i + 1) {
            errors.push('Rankings must form a consecutive sequence starting from 1 (e.g., 1, 2, 3...)');
            break;
          }
        }
      }
    } else {
      // In full ranking, all ranks 1-N must be used exactly once
      if (uniqueRankings.size !== this.choices.length) {
        errors.push('All rankings must be unique');
      }
      
      // Check that all ranks from 1 to N are present
      for (let rank = 1; rank <= this.choices.length; rank++) {
        if (!uniqueRankings.has(rank)) {
          errors.push(`Ranking ${rank} is missing - all ranks from 1 to ${this.choices.length} must be used`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate ballot mode for ranking elections
   */
  protected generateBallotMode(): BallotMode {
    const isPartialRanking = this.allowPartialRanking ?? false;
    const minRanked = this.minRankedChoices ?? 0;
    
    const minValue = isPartialRanking ? "0" : "1";
    const maxValue = this.choices.length.toString();
    
    // Calculate expected sum for validation
    let minTotalCost: string;
    let maxTotalCost: string;
    
    if (isPartialRanking) {
      // Minimum sum: sum of 1 to minRankedChoices
      minTotalCost = minRanked > 0 
        ? ((minRanked * (minRanked + 1)) / 2).toString()
        : "0";
      
      // Maximum sum: sum of 1 to N (all choices ranked)
      maxTotalCost = ((this.choices.length * (this.choices.length + 1)) / 2).toString();
    } else {
      // Full ranking: sum must be exactly 1+2+...+N
      const expectedSum = (this.choices.length * (this.choices.length + 1)) / 2;
      minTotalCost = expectedSum.toString();
      maxTotalCost = expectedSum.toString();
    }

    return {
      maxCount: this.choices.length,
      maxValue,
      minValue,
      forceUniqueness: true,
      costFromWeight: false,
      costExponent: 1,
      maxTotalCost,
      minTotalCost
    };
  }

  /**
   * Customize metadata for ranking elections
   */
  protected customizeMetadata(metadata: ElectionMetadata): void {
    const isPartialRanking = this.allowPartialRanking ?? false;
    const minRanked = this.minRankedChoices ?? 0;
    
    metadata.type = {
      name: ElectionResultsTypeNames.MULTIPLE_CHOICE,
      properties: {
        canAbstain: isPartialRanking,
        abstainValues: isPartialRanking ? ["0"] : [],
        repeatChoice: false,
        numChoices: {
          min: isPartialRanking ? minRanked : this.choices.length,
          max: this.choices.length
        }
      }
    };

    // Store election type information for reconstruction
    if (!metadata.meta) {
      metadata.meta = {};
    }
    
    const electionTypeInfo: ElectionTypeMetadata = {
      type: 'ranking',
      version: '1.0',
      config: {
        allowPartialRanking: this.allowPartialRanking,
        minRankedChoices: this.minRankedChoices
      } as RankingElectionConfig
    };
    
    metadata.meta.electionType = electionTypeInfo;

    // Keep legacy metadata for backward compatibility
    metadata.meta.rankingElection = {
      allowPartialRanking: isPartialRanking,
      minRankedChoices: minRanked,
      maxRank: this.choices.length
    };
  }

  /**
   * Custom validation for ranking elections
   */
  protected customValidation(): void {
    if (this.choices.length < 2) {
      throw new Error('Ranking elections must have at least 2 choices');
    }

    const minRanked = this.minRankedChoices ?? 0;
    if (this.allowPartialRanking && minRanked > this.choices.length) {
      throw new Error('Minimum ranked choices cannot exceed the number of choices');
    }
  }

  /**
   * Get the current ranking configuration
   */
  getRankingConfig(): {
    allowPartialRanking: boolean;
    minRankedChoices: number;
    maxRank: number;
  } {
    return {
      allowPartialRanking: this.allowPartialRanking ?? false,
      minRankedChoices: this.minRankedChoices ?? 0,
      maxRank: this.choices.length
    };
  }

  /**
   * Check if partial ranking is allowed
   */
  isPartialRankingAllowed(): boolean {
    return this.allowPartialRanking ?? false;
  }

  /**
   * Get the minimum number of choices that must be ranked
   */
  getMinRankedChoices(): number {
    return this.minRankedChoices ?? 0;
  }
}
