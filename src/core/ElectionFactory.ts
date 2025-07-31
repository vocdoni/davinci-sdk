import { DavinciSDK } from "./DavinciSDK";
import { BaseElection } from "./BaseElection";
import { ApprovalElection } from "./ApprovalElection";
import { RatingElection } from "./RatingElection";
import { RankingElection } from "./RankingElection";
import { QuadraticElection } from "./QuadraticElection";
import { BasicElection } from "./BasicElection";
import { ElectionMetadata, ElectionResultsTypeNames } from "./types/metadata";
import { BallotMode } from "./types/common";
import { 
  ElectionTypeMetadata, 
  ProcessInfo, 
  ApprovalElectionConfig,
  RatingElectionConfig,
  RankingElectionConfig,
  QuadraticElectionConfig
} from "./types/electionTypes";

/**
 * Factory class for reconstructing election instances from metadata and process information
 */
export class ElectionFactory {
  /**
   * Create an election instance from metadata and process information
   */
  static fromMetadata(
    sdk: DavinciSDK, 
    metadata: ElectionMetadata, 
    processInfo: ProcessInfo
  ): BaseElection | null {
    try {
      // Extract election type information from metadata
      const electionTypeInfo = metadata.meta?.electionType as ElectionTypeMetadata | undefined;
      
      if (electionTypeInfo) {
        // We have explicit type information - use it
        return this.createFromTypeInfo(sdk, metadata, processInfo, electionTypeInfo);
      } else {
        // No explicit type info - try to detect from ballot mode and metadata
        return this.detectFromBallotMode(sdk, metadata, processInfo);
      }
    } catch (error) {
      console.warn('Failed to reconstruct election from metadata:', error);
      return null;
    }
  }

  /**
   * Create election from explicit type information
   */
  private static createFromTypeInfo(
    sdk: DavinciSDK,
    metadata: ElectionMetadata,
    processInfo: ProcessInfo,
    typeInfo: ElectionTypeMetadata
  ): BaseElection | null {
    // Create base configuration from process info
    const config = this.createBaseConfig(metadata, processInfo);
    
    switch (typeInfo.type) {
      case 'approval':
        return this.createApprovalElection(sdk, config, typeInfo.config as ApprovalElectionConfig, metadata);
      
      case 'rating':
        return this.createRatingElection(sdk, config, typeInfo.config as RatingElectionConfig, metadata);
      
      case 'ranking':
        return this.createRankingElection(sdk, config, typeInfo.config as RankingElectionConfig, metadata);
      
      case 'quadratic':
        return this.createQuadraticElection(sdk, config, typeInfo.config as QuadraticElectionConfig, metadata);
      
      case 'basic':
      default:
        return this.createBasicElection(sdk, config, metadata);
    }
  }

  /**
   * Attempt to detect election type from ballot mode and metadata patterns
   */
  private static detectFromBallotMode(
    sdk: DavinciSDK,
    metadata: ElectionMetadata,
    processInfo: ProcessInfo
  ): BaseElection | null {
    const ballotMode = processInfo.ballotMode as BallotMode;
    const config = this.createBaseConfig(metadata, processInfo);

    // Detection logic based on ballot mode characteristics
    // Check for quadratic voting first (most specific)
    if (ballotMode.costExponent === 2) {
      // Quadratic voting - try to get config from legacy metadata
      const legacyConfig = metadata.meta?.quadraticElection || {};
      return this.createQuadraticElection(sdk, config, legacyConfig, metadata);
    }
    
    // Check for quadratic voting by metadata type name
    if (metadata.type.name === ElectionResultsTypeNames.QUADRATIC) {
      const legacyConfig = metadata.meta?.quadraticElection || {};
      return this.createQuadraticElection(sdk, config, legacyConfig, metadata);
    }
    
    if (ballotMode.forceUniqueness && ballotMode.minValue === "1") {
      // Likely ranking (unique values starting from 1)
      return this.createRankingElection(sdk, config, {}, metadata);
    }
    
    if (ballotMode.maxValue === "1" && ballotMode.minValue === "0") {
      // Binary choices - could be approval
      return this.createApprovalElection(sdk, config, {}, metadata);
    }
    
    if (parseInt(ballotMode.maxValue) > 1 && !ballotMode.forceUniqueness && (metadata.type.name as string) !== ElectionResultsTypeNames.QUADRATIC) {
      // Multi-value, non-unique - likely rating (but not quadratic)
      return this.createRatingElection(sdk, config, {}, metadata);
    }

    // Fallback to basic election
    return this.createBasicElection(sdk, config, metadata);
  }

  /**
   * Create base election configuration from process info
   */
  private static createBaseConfig(metadata: ElectionMetadata, processInfo: ProcessInfo) {
    return {
      title: metadata.title.default,
      description: metadata.description?.default || '',
      censusRoot: processInfo.census.censusRoot,
      maxVotes: processInfo.census.maxVotes,
      duration: processInfo.duration,
      startTime: new Date(processInfo.startTime * 1000),
      media: metadata.media ? {
        header: metadata.media.header,
        logo: metadata.media.logo
      } : undefined
    };
  }

  /**
   * Create and configure ApprovalElection
   */
  private static createApprovalElection(
    sdk: DavinciSDK,
    config: any,
    approvalConfig: ApprovalElectionConfig,
    metadata: ElectionMetadata
  ): ApprovalElection {
    const election = new ApprovalElection(sdk, config);
    
    // Add choices
    if (metadata.questions && metadata.questions[0]?.choices) {
      metadata.questions[0].choices.forEach(choice => {
        election.addChoice(choice.title.default, choice.value, choice.meta);
      });
    }
    
    // Configure approval-specific settings
    if (approvalConfig.minApprovals !== undefined) {
      election.requireMinimumApprovals(approvalConfig.minApprovals);
    }
    if (approvalConfig.maxApprovals !== undefined) {
      election.limitMaximumApprovals(approvalConfig.maxApprovals);
    }
    
    return election;
  }

  /**
   * Create and configure RatingElection
   */
  private static createRatingElection(
    sdk: DavinciSDK,
    config: any,
    ratingConfig: RatingElectionConfig,
    metadata: ElectionMetadata
  ): RatingElection {
    const election = new RatingElection(sdk, config);
    
    // Add choices
    if (metadata.questions && metadata.questions[0]?.choices) {
      metadata.questions[0].choices.forEach(choice => {
        election.addChoice(choice.title.default, choice.value, choice.meta);
      });
    }
    
    // Configure rating-specific settings
    // Try to get config from the new electionType metadata first, then fallback to legacy
    const legacyConfig = metadata.meta?.ratingElection;
    const finalConfig = Object.keys(ratingConfig).length > 0 ? ratingConfig : legacyConfig || {};
    
    if (finalConfig.minRating !== undefined && finalConfig.minRating !== null) {
      election.setMinRating(finalConfig.minRating);
    }
    if (finalConfig.maxRating !== undefined && finalConfig.maxRating !== null) {
      election.setMaxRating(finalConfig.maxRating);
    }
    if (finalConfig.minTotalRating !== undefined && finalConfig.minTotalRating !== null) {
      election.setMinTotalRating(finalConfig.minTotalRating);
    }
    if (finalConfig.maxTotalRating !== undefined && finalConfig.maxTotalRating !== null) {
      election.setMaxTotalRating(finalConfig.maxTotalRating);
    }
    
    return election;
  }

  /**
   * Create and configure RankingElection
   */
  private static createRankingElection(
    sdk: DavinciSDK,
    config: any,
    rankingConfig: RankingElectionConfig,
    metadata: ElectionMetadata
  ): RankingElection {
    const election = new RankingElection(sdk, config);
    
    // Add choices
    if (metadata.questions && metadata.questions[0]?.choices) {
      metadata.questions[0].choices.forEach(choice => {
        election.addChoice(choice.title.default, choice.value, choice.meta);
      });
    }
    
    // Configure ranking-specific settings
    if (rankingConfig.allowPartialRanking) {
      election.enablePartialRanking(rankingConfig.minRankedChoices || 1);
    } else {
      election.requireFullRanking();
    }
    
    return election;
  }

  /**
   * Create and configure QuadraticElection
   */
  private static createQuadraticElection(
    sdk: DavinciSDK,
    config: any,
    quadraticConfig: QuadraticElectionConfig,
    metadata: ElectionMetadata
  ): QuadraticElection {
    const election = new QuadraticElection(sdk, config);
    
    // Add choices
    if (metadata.questions && metadata.questions[0]?.choices) {
      metadata.questions[0].choices.forEach(choice => {
        election.addChoice(choice.title.default, choice.value, choice.meta);
      });
    }
    
    // Configure quadratic-specific settings
    // Try to get config from the new electionType metadata first, then fallback to legacy
    const legacyConfig = metadata.meta?.quadraticElection;
    const finalConfig = Object.keys(quadraticConfig).length > 0 ? quadraticConfig : legacyConfig || {};
    
    if (finalConfig.totalCredits !== undefined) {
      election.setTotalCredits(finalConfig.totalCredits);
    }
    if (finalConfig.useCensusWeightAsBudget) {
      election.enableCensusWeightAsBudget();
    }
    if (finalConfig.minStep !== undefined) {
      election.setMinStep(finalConfig.minStep);
    }
    if (finalConfig.forceFullBudget) {
      election.requireFullBudget();
    } else {
      election.allowPartialBudget();
    }
    
    return election;
  }

  /**
   * Create BasicElection as fallback
   */
  private static createBasicElection(
    sdk: DavinciSDK,
    config: any,
    metadata: ElectionMetadata
  ): BasicElection {
    const election = new BasicElection(sdk, config);
    
    // Add choices
    if (metadata.questions && metadata.questions[0]?.choices) {
      metadata.questions[0].choices.forEach(choice => {
        election.addChoice(choice.title.default, choice.value, choice.meta);
      });
    }
    
    return election;
  }
}
