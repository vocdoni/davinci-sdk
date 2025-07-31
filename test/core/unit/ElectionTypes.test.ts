import { DavinciSDK } from '../../../src/core/DavinciSDK';
import { ApprovalElection } from '../../../src/core/ApprovalElection';
import { RatingElection } from '../../../src/core/RatingElection';
import { RankingElection } from '../../../src/core/RankingElection';
import { QuadraticElection } from '../../../src/core/QuadraticElection';
import { ElectionConfig } from '../../../src/core/types/election';
import { Wallet, JsonRpcProvider } from 'ethers';

describe('Election Types', () => {
  let sdk: DavinciSDK;
  let config: ElectionConfig;

  beforeEach(() => {
    const provider = new JsonRpcProvider("https://sepolia.infura.io/v3/test");
    const mockSigner = new Wallet("0x1234567890123456789012345678901234567890123456789012345678901234", provider);
    
    sdk = new DavinciSDK({
      signer: mockSigner,
      sequencerUrl: "https://sequencer.test.com",
      censusUrl: "https://census.test.com",
      chain: "sepolia"
    });

    config = {
      title: 'Test Election',
      description: 'Test election description',
      duration: 3600,
      censusRoot: '0x1234567890abcdef',
      maxVotes: '100'
    };
  });

  describe('ApprovalElection', () => {
    it('should validate approval voting correctly', () => {
      const election = new ApprovalElection(sdk, config);
      election
        .addChoice('Question 1')
        .addChoice('Question 2')
        .addChoice('Question 3')
        .addChoice('Question 4')
        .addChoice('Question 5');

      // Valid approval vote (matches Excel example: ballot 1 = [0,1,0,1,1])
      const validVote = [0, 1, 0, 1, 1];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Invalid vote - wrong number of votes
      const invalidVote1 = [1, 0, 1];
      const result1 = election.validateVote(invalidVote1);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('exactly 5 votes');

      // Invalid vote - value not 0 or 1
      const invalidVote2 = [0, 2, 0, 1, 1];
      const result2 = election.validateVote(invalidVote2);
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('must be either 0 (disapprove) or 1 (approve)');
    });

    it('should generate correct ballot mode for approval voting', () => {
      const election = new ApprovalElection(sdk, config);
      election
        .addChoice('Question 1')
        .addChoice('Question 2')
        .addChoice('Question 3')
        .addChoice('Question 4')
        .addChoice('Question 5');

      const ballotMode = (election as any).generateBallotMode();
      
      expect(ballotMode.maxCount).toBe(5);
      expect(ballotMode.maxValue).toBe('1');
      expect(ballotMode.minValue).toBe('0');
      expect(ballotMode.forceUniqueness).toBe(false);
      expect(ballotMode.costExponent).toBe(1);
      expect(ballotMode.maxTotalCost).toBe('5');
      expect(ballotMode.minTotalCost).toBe('0');
    });

    it('should handle approval limits correctly', () => {
      const election = new ApprovalElection(sdk, config);
      election
        .addChoice('Question 1')
        .addChoice('Question 2')
        .addChoice('Question 3')
        .requireMinimumApprovals(1)
        .limitMaximumApprovals(2);

      // Valid vote within limits
      const validVote = [1, 1, 0];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);

      // Invalid - too few approvals
      const invalidVote1 = [0, 0, 0];
      const result1 = election.validateVote(invalidVote1);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('Must approve at least 1');

      // Invalid - too many approvals
      const invalidVote2 = [1, 1, 1];
      const result2 = election.validateVote(invalidVote2);
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('Cannot approve more than 2');
    });
  });

  describe('RatingElection', () => {
    it('should validate rating correctly', () => {
      const election = new RatingElection(sdk, config);
      election
        .addChoice('Item 1')
        .addChoice('Item 2')
        .addChoice('Item 3')
        .addChoice('Item 4')
        .addChoice('Item 5')
        .setMaxRating(10);

      // Valid rating vote (matches Excel example: ballot 1 = [8,6,4,7,10])
      const validVote = [8, 6, 4, 7, 10];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Invalid vote - rating out of range
      const invalidVote = [8, 6, 4, 12, 10];
      const result1 = election.validateVote(invalidVote);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('must be between 0 and 10');
    });

    it('should generate correct ballot mode for rating', () => {
      const election = new RatingElection(sdk, config);
      election
        .addChoice('Item 1')
        .addChoice('Item 2')
        .addChoice('Item 3')
        .addChoice('Item 4')
        .addChoice('Item 5')
        .setMaxRating(10);

      const ballotMode = (election as any).generateBallotMode();
      
      expect(ballotMode.maxCount).toBe(5);
      expect(ballotMode.maxValue).toBe('10');
      expect(ballotMode.minValue).toBe('0');
      expect(ballotMode.forceUniqueness).toBe(false);
      expect(ballotMode.costExponent).toBe(1);
      expect(ballotMode.maxTotalCost).toBe('50');
      expect(ballotMode.minTotalCost).toBe('0');
    });

    it('should handle total rating limits', () => {
      const election = new RatingElection(sdk, config);
      election
        .addChoice('Item 1')
        .addChoice('Item 2')
        .addChoice('Item 3')
        .setMaxRating(10)
        .setMaxTotalRating(20);

      // Valid vote within total limit
      const validVote = [5, 5, 5];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(false); // Should fail because total is 15 but we need exactly 20 or less
      
      const validVote2 = [7, 7, 6];
      const result2 = election.validateVote(validVote2);
      expect(result2.valid).toBe(false); // 20 total, should be valid but exceeds our limit

      const validVote3 = [6, 6, 6];
      const result3 = election.validateVote(validVote3);
      expect(result3.valid).toBe(true); // 18 total, within limit
    });
  });

  describe('RankingElection', () => {
    it('should validate full ranking correctly', () => {
      const election = new RankingElection(sdk, config);
      election
        .addChoice('Destination 1')
        .addChoice('Destination 2')
        .addChoice('Destination 3')
        .addChoice('Destination 4')
        .addChoice('Destination 5')
        .requireFullRanking();

      // Valid ranking vote (matches Excel example: ballot 1 = [1,3,2,4,5])
      const validVote = [1, 3, 2, 4, 5];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Invalid vote - duplicate ranking
      const invalidVote1 = [1, 5, 3, 4, 5];
      const result1 = election.validateVote(invalidVote1);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('All rankings must be unique');

      // Invalid vote - missing ranking
      const invalidVote2 = [1, 3, 2, 4, 6];
      const result2 = election.validateVote(invalidVote2);
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('must be between 1 and 5');
    });

    it('should validate partial ranking correctly', () => {
      const election = new RankingElection(sdk, config);
      election
        .addChoice('Destination 1')
        .addChoice('Destination 2')
        .addChoice('Destination 3')
        .addChoice('Destination 4')
        .addChoice('Destination 5')
        .enablePartialRanking(2);

      // Valid partial ranking (rank top 3, leave others as 0)
      const validVote = [1, 2, 3, 0, 0];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);

      // Invalid - not enough rankings
      const invalidVote = [1, 0, 0, 0, 0];
      const result1 = election.validateVote(invalidVote);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('Must rank at least 2');

      // Invalid - non-consecutive rankings
      const invalidVote2 = [1, 3, 0, 0, 0];
      const result2 = election.validateVote(invalidVote2);
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('consecutive sequence starting from 1');
    });

    it('should generate correct ballot mode for ranking', () => {
      const election = new RankingElection(sdk, config);
      election
        .addChoice('Destination 1')
        .addChoice('Destination 2')
        .addChoice('Destination 3')
        .addChoice('Destination 4')
        .addChoice('Destination 5')
        .requireFullRanking();

      const ballotMode = (election as any).generateBallotMode();
      
      expect(ballotMode.maxCount).toBe(5);
      expect(ballotMode.maxValue).toBe('5');
      expect(ballotMode.minValue).toBe('1');
      expect(ballotMode.forceUniqueness).toBe(true);
      expect(ballotMode.costExponent).toBe(1);
      // Sum of 1+2+3+4+5 = 15
      expect(ballotMode.maxTotalCost).toBe('15');
      expect(ballotMode.minTotalCost).toBe('15');
    });
  });

  describe('QuadraticElection', () => {
    it('should validate quadratic voting correctly', () => {
      const election = new QuadraticElection(sdk, config);
      election
        .addChoice('Option 1')
        .addChoice('Option 2')
        .addChoice('Option 3')
        .addChoice('Option 4')
        .addChoice('Option 5')
        .setTotalCredits(12);

      // Valid quadratic vote (matches Excel example: ballot 1 = [1,1,2,0,0])
      // Cost: 1² + 1² + 2² + 0² + 0² = 1 + 1 + 4 + 0 + 0 = 6 credits
      const validVote = [1, 1, 2, 0, 0];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Invalid vote - exceeds credit limit
      // Cost: 3² + 3² + 0² + 0² + 0² = 9 + 9 = 18 credits (exceeds 12)
      const invalidVote = [3, 3, 0, 0, 0];
      const result1 = election.validateVote(invalidVote);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('Cannot spend more than 12 credits');
    });

    it('should handle full budget requirement', () => {
      const election = new QuadraticElection(sdk, config);
      election
        .addChoice('Option 1')
        .addChoice('Option 2')
        .addChoice('Option 3')
        .setTotalCredits(9)
        .requireFullBudget();

      // Valid vote - spends exactly 9 credits (3² = 9)
      const validVote = [3, 0, 0];
      const result = election.validateVote(validVote);
      expect(result.valid).toBe(true);

      // Invalid vote - doesn't spend all credits
      const invalidVote = [2, 0, 0]; // Only spends 4 credits
      const result1 = election.validateVote(invalidVote);
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('Must spend exactly 9 credits');
    });

    it('should generate correct ballot mode for quadratic voting', () => {
      const election = new QuadraticElection(sdk, config);
      election
        .addChoice('Option 1')
        .addChoice('Option 2')
        .addChoice('Option 3')
        .addChoice('Option 4')
        .addChoice('Option 5')
        .setTotalCredits(12);

      const ballotMode = (election as any).generateBallotMode();
      
      expect(ballotMode.maxCount).toBe(5);
      expect(ballotMode.maxValue).toBe('3'); // floor(sqrt(12)) = 3
      expect(ballotMode.minValue).toBe('-3');
      expect(ballotMode.forceUniqueness).toBe(false);
      expect(ballotMode.costFromWeight).toBe(false);
      expect(ballotMode.costExponent).toBe(2);
      expect(ballotMode.maxTotalCost).toBe('12');
      expect(ballotMode.minTotalCost).toBe('0');
    });

    it('should calculate vote costs correctly', () => {
      const election = new QuadraticElection(sdk, config);
      election.setTotalCredits(12);

      expect(election.calculateVoteCost(0)).toBe(0);
      expect(election.calculateVoteCost(1)).toBe(1);
      expect(election.calculateVoteCost(2)).toBe(4);
      expect(election.calculateVoteCost(3)).toBe(9);
      expect(election.calculateVoteCost(-2)).toBe(4);

      expect(election.calculateMaxVoteForCost(0)).toBe(0);
      expect(election.calculateMaxVoteForCost(1)).toBe(1);
      expect(election.calculateMaxVoteForCost(4)).toBe(2);
      expect(election.calculateMaxVoteForCost(9)).toBe(3);
      expect(election.calculateMaxVoteForCost(12)).toBe(3);
    });
  });

  describe('Election Configuration', () => {
    it('should provide correct configuration getters', () => {
      const approvalElection = new ApprovalElection(sdk, config);
      approvalElection.requireMinimumApprovals(1).limitMaximumApprovals(3);
      expect(approvalElection.getApprovalLimits()).toEqual({ min: 1, max: 3 });

      const ratingElection = new RatingElection(sdk, config);
      ratingElection.setMaxRating(5).setMinTotalRating(10).setMaxTotalRating(20);
      expect(ratingElection.getRatingConfig()).toEqual({
        minRating: 0,
        maxRating: 5,
        minTotalRating: 10,
        maxTotalRating: 20
      });

      const rankingElection = new RankingElection(sdk, config);
      rankingElection.addChoice('A').addChoice('B').addChoice('C').enablePartialRanking(2);
      expect(rankingElection.getRankingConfig()).toEqual({
        allowPartialRanking: true,
        minRankedChoices: 2,
        maxRank: 3
      });

      const quadraticElection = new QuadraticElection(sdk, config);
      quadraticElection.setTotalCredits(16).requireFullBudget();
      expect(quadraticElection.getQuadraticConfig()).toEqual({
        totalCredits: 16,
        useCensusWeightAsBudget: false,
        minStep: 1,
        forceFullBudget: true,
        maxVotePerChoice: 4
      });
    });
  });
});
