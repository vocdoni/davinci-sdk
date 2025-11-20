// test/core/integration/SimpleProcessCreation.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig, PlainCensus, WeightedCensus } from '../../../src';
import { ProcessStatus } from '../../../src/contracts/ProcessRegistryService';
import { getElectionMetadataTemplate } from '../../../src/core/types/metadata';

jest.setTimeout(Number(process.env.TIME_OUT) || 120_000);

const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

function randomHex(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes * 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return '0x' + hex;
}

describe('Simple Process Creation Integration', () => {
  let sdk: DavinciSDK;

  beforeAll(async () => {
    sdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
      censusUrl: process.env.CENSUS_API_URL,
    });

    await sdk.init();
  });

  it('should create a complete voting process with minimal configuration', async () => {
    // Hardcoded test data
    const censusRoot = randomHex(32);
    const censusSize = 25;

    const processConfig: ProcessConfig = {
      title: 'Integration Test Election',
      description: 'A test election created via the simplified SDK createProcess method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: censusSize,
        uri: `ipfs://test-census-${Date.now()}`,
      },
      ballot: {
        numFields: 2,
        maxValue: '3',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '6',
        minValueSum: '0',
      },
      timing: {
        duration: 3600, // 1 hour
      },
      questions: [
        {
          title: 'What is your favorite programming language?',
          description: 'Choose your preferred programming language',
          choices: [
            { title: 'TypeScript', value: 0 },
            { title: 'Python', value: 1 },
            { title: 'Rust', value: 2 },
            { title: 'Go', value: 3 },
          ],
        },
        {
          title: 'What is your preferred development environment?',
          description: 'Choose your preferred IDE or editor',
          choices: [
            { title: 'VS Code', value: 0 },
            { title: 'IntelliJ', value: 1 },
            { title: 'Vim/Neovim', value: 2 },
            { title: 'Emacs', value: 3 },
          ],
        },
      ],
    };

    // Execute the simplified process creation
    const result = await sdk.createProcess(processConfig);

    // Verify the result structure
    expect(result).toBeDefined();
    expect(result.processId).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toBeDefined();
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify the process was actually created on-chain
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess).toBeDefined();
    expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(censusRoot.toLowerCase());
    expect(onChainProcess.census.maxVotes).toBe(BigInt(censusSize));
  });

  it('should create a process with minimal configuration', async () => {
    const censusRoot = randomHex(32);

    const minimalConfig: ProcessConfig = {
      title: 'Minimal Test Election',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 10,
        uri: `ipfs://minimal-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '2',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '2',
        minValueSum: '0',
      },
      timing: {
        duration: 1800,
      },
      questions: [
        {
          title: 'Do you agree?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
            { title: 'Abstain', value: 2 },
          ],
        },
      ],
    };

    const result = await sdk.createProcess(minimalConfig);

    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify on-chain
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess.census.maxVotes).toBe(BigInt(10));
  });

  it('should handle process creation with custom timing', async () => {
    const censusRoot = randomHex(32);
    const customStartTime = Math.floor(Date.now() / 1000) + 300; // Start in 5 minutes
    const customDuration = 7200; // 2 hours

    const timedConfig: ProcessConfig = {
      title: 'Custom Timing Election',
      description: 'Testing custom start time and duration',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 50,
        uri: `ipfs://timed-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1', // Simple yes/no
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: customStartTime,
        duration: customDuration,
      },
      questions: [
        {
          title: 'Do you approve this proposal?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    const result = await sdk.createProcess(timedConfig);

    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify timing on-chain
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess.duration).toBe(BigInt(customDuration));
  });

  it('should fail gracefully with invalid census configuration', async () => {
    const invalidConfig: ProcessConfig = {
      title: 'Invalid Census Test',
      description: 'This should fail due to invalid census root',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: '0xinvalid', // Invalid census root format
        size: 100,
        uri: `ipfs://invalid-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    await expect(sdk.createProcess(invalidConfig)).rejects.toThrow();
  });

  it('should create a process with CSP census type', async () => {
    const cspConfig: ProcessConfig = {
      title: 'CSP Census Test',
      description: 'Testing CSP census type support',
      census: {
        type: CensusOrigin.CensusOriginCSP,
        root: randomHex(32),
        size: 100,
        uri: `ipfs://csp-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    const result = await sdk.createProcess(cspConfig);

    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify on-chain
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess.census.censusOrigin).toBe(BigInt(CensusOrigin.CensusOriginCSP));
  });

  it('should validate SDK initialization requirement', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    const config: ProcessConfig = {
      title: 'Uninitialized SDK Test',
      description: 'This should fail due to uninitialized SDK',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: randomHex(32),
        size: 10,
        uri: `ipfs://uninitialized-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    await expect(uninitializedSdk.createProcess(config)).rejects.toThrow(
      'SDK must be initialized before creating processes. Call sdk.init() first.'
    );
  });

  it('should create a process using Date objects for timing', async () => {
    const censusRoot = randomHex(32);
    const startDate = new Date(Date.now() + 180000); // Start in 3 minutes
    const endDate = new Date(startDate.getTime() + 3600000); // End 1 hour after start

    const dateBasedConfig: ProcessConfig = {
      title: 'Date-Based Timing Test',
      description: 'Testing Date object timing configuration',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 25,
        uri: `ipfs://date-based-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: startDate,
        endDate: endDate,
      },
      questions: [
        {
          title: 'Do you approve this date-based process?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    const result = await sdk.createProcess(dateBasedConfig);

    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify timing on-chain (duration should be calculated automatically)
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess.duration).toBe(BigInt(3600)); // 1 hour in seconds
  });

  it('should create a process using ISO string dates', async () => {
    const censusRoot = randomHex(32);
    const now = new Date();
    const startDate = new Date(now.getTime() + 240000); // Start in 4 minutes
    const endDate = new Date(startDate.getTime() + 1800000); // End 30 minutes after start

    const isoStringConfig: ProcessConfig = {
      title: 'ISO String Timing Test',
      description: 'Testing ISO string timing configuration',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 15,
        uri: `ipfs://iso-string-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '2',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '2',
        minValueSum: '0',
      },
      timing: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      questions: [
        {
          title: 'Rate this ISO string feature',
          choices: [
            { title: 'Excellent', value: 0 },
            { title: 'Good', value: 1 },
            { title: 'Poor', value: 2 },
          ],
        },
      ],
    };

    const result = await sdk.createProcess(isoStringConfig);

    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify timing on-chain (duration should be calculated automatically)
    const onChainProcess = await sdk.processes.getProcess(result.processId);
    expect(onChainProcess.duration).toBe(BigInt(1800)); // 30 minutes in seconds
  });

  it('should fail when both duration and endDate are provided', async () => {
    const invalidTimingConfig: ProcessConfig = {
      title: 'Invalid Timing Test',
      description: 'This should fail due to conflicting timing configuration',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: randomHex(32),
        size: 10,
        uri: `ipfs://invalid-timing-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: new Date(Date.now() + 300000),
        duration: 3600,
        endDate: new Date(Date.now() + 7200000), // Both duration and endDate provided
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    await expect(sdk.createProcess(invalidTimingConfig)).rejects.toThrow(
      "Cannot specify both 'duration' and 'endDate'. Use one or the other."
    );
  });

  it('should fail when neither duration nor endDate are provided', async () => {
    const noTimingConfig: ProcessConfig = {
      title: 'No Timing Test',
      description: 'This should fail due to missing timing configuration',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: randomHex(32),
        size: 10,
        uri: `ipfs://no-timing-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: new Date(Date.now() + 300000),
        // Neither duration nor endDate provided
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    await expect(sdk.createProcess(noTimingConfig)).rejects.toThrow(
      "Must specify either 'duration' (in seconds) or 'endDate'."
    );
  });

  it('should fail when endDate is before startDate', async () => {
    const invalidDateOrderConfig: ProcessConfig = {
      title: 'Invalid Date Order Test',
      description: 'This should fail due to endDate being before startDate',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: randomHex(32),
        size: 10,
        uri: `ipfs://invalid-date-order-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: new Date(Date.now() + 3600000), // Start in 1 hour
        endDate: new Date(Date.now() + 1800000), // End in 30 minutes (before start)
      },
      questions: [
        {
          title: 'Test Question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    await expect(sdk.createProcess(invalidDateOrderConfig)).rejects.toThrow(
      'End date must be after start date.'
    );
  });

  it('should get process information using the simple wrapper', async () => {
    // First create a process to test with
    const censusRoot = randomHex(32);
    const processConfig: ProcessConfig = {
      title: 'Get Process Test',
      description: 'Testing the getProcess wrapper method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 50,
        uri: `ipfs://get-process-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Test question for getProcess',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Now test getting the process information
    const processInfo = await sdk.getProcess(createResult.processId);

    // Verify the process information
    expect(processInfo).toBeDefined();
    expect(processInfo.title).toBe('Get Process Test');
    expect(processInfo.description).toBe('Testing the getProcess wrapper method');
    expect(processInfo.census.root.toLowerCase()).toBe(censusRoot.toLowerCase());
    expect(processInfo.census.size).toBe(50);
    expect(processInfo.duration).toBe(3600);
    expect(processInfo.status).toBeDefined();
    expect(processInfo.status).toBe(ProcessStatus.READY); // Process should be in READY status when created
    expect(processInfo.startDate).toBeDefined();
    expect(processInfo.startDate).toBeInstanceOf(Date);
    expect(processInfo.endDate).toBeDefined();
    expect(processInfo.endDate).toBeInstanceOf(Date);
    expect(processInfo.duration).toBe(3600);
    expect(processInfo.timeRemaining).toBeDefined();
    expect(processInfo.creator).toBeDefined();

    // Verify that the creator address matches the wallet address that created the process
    const walletAddress = await wallet.getAddress();
    expect(processInfo.creator.toLowerCase()).toBe(walletAddress.toLowerCase());

    expect(processInfo.questions).toBeDefined();
    expect(processInfo.questions.length).toBe(1);
    expect(processInfo.questions[0].title).toBe('Test question for getProcess');
  });

  it('should validate SDK initialization requirement for getProcess', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    await expect(
      uninitializedSdk.getProcess(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).rejects.toThrow('SDK must be initialized before getting processes. Call sdk.init() first.');
  });

  it('should create a process using async generator stream and yield transaction status events', async () => {
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Stream API Test Election',
      description: 'Testing the createProcessStream async generator method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 30,
        uri: `ipfs://stream-test-census-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: Math.floor(Date.now() / 1000) + 180,
        duration: 3600,
      },
      questions: [
        {
          title: 'Do you approve the stream API?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    const stream = sdk.createProcessStream(processConfig);

    let hasPendingEvent = false;
    let hasCompletedEvent = false;
    let transactionHash = '';
    let processId = '';

    for await (const event of stream) {
      if (event.status === 'pending') {
        hasPendingEvent = true;
        transactionHash = event.hash;

        expect(event.hash).toBeDefined();
        expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'completed') {
        hasCompletedEvent = true;
        processId = event.response.processId;

        expect(event.response).toBeDefined();
        expect(event.response.processId).toBeDefined();
        expect(event.response.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(event.response.transactionHash).toBeDefined();
        expect(event.response.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown'}`);
      }
    }

    // Verify that we received both pending and completed events
    expect(hasPendingEvent).toBe(true);
    expect(hasCompletedEvent).toBe(true);
    expect(transactionHash).toBeTruthy();
    expect(processId).toBeTruthy();

    // Verify the process was actually created on-chain
    const onChainProcess = await sdk.processes.getProcess(processId);
    expect(onChainProcess).toBeDefined();
    expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(censusRoot.toLowerCase());
  });

  it('should end a process using async generator stream and yield transaction status events', async () => {
    // First create a process to end
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'End Process Stream Test',
      description: 'Testing the endProcessStream async generator method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 20,
        uri: `ipfs://end-process-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: Math.floor(Date.now() / 1000) + 10, // Start in 10 seconds to avoid underflow
        duration: 3600,
      },
      questions: [
        {
          title: 'Should this process be ended?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforeEnd = await sdk.processes.getProcess(processId);
    expect(processBeforeEnd.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start to avoid underflow error (block.timestamp - p.startTime)
    // The contract calculates newDuration = block.timestamp - p.startTime when ending
    // If current time < start time, this causes Panic(17) overflow
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Now end the process using the stream
    const endStream = sdk.endProcessStream(processId);

    let hasPendingEvent = false;
    let hasCompletedEvent = false;
    let transactionHash = '';

    for await (const event of endStream) {
      if (event.status === 'pending') {
        hasPendingEvent = true;
        transactionHash = event.hash;

        expect(event.hash).toBeDefined();
        expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'completed') {
        hasCompletedEvent = true;

        expect(event.response).toBeDefined();
        expect(event.response.success).toBe(true);
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown'}`);
      }
    }

    // Verify that we received both pending and completed events
    expect(hasPendingEvent).toBe(true);
    expect(hasCompletedEvent).toBe(true);
    expect(transactionHash).toBeTruthy();

    // Verify the process status was changed to ENDED on-chain
    const processAfterEnd = await sdk.processes.getProcess(processId);
    expect(processAfterEnd.status).toBe(BigInt(ProcessStatus.ENDED));
  });

  it('should end a process using the simplified endProcess method', async () => {
    // First create a process to end
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Simple End Process Test',
      description: 'Testing the simplified endProcess method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 15,
        uri: `ipfs://simple-end-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        startDate: Math.floor(Date.now() / 1000) + 10, // Start in 10 seconds to avoid underflow
        duration: 3600,
      },
      questions: [
        {
          title: 'Simple end test question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforeEnd = await sdk.processes.getProcess(processId);
    expect(processBeforeEnd.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start to avoid underflow error
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // End the process using the simplified method
    await sdk.endProcess(processId);

    // Verify the process status was changed to ENDED on-chain
    const processAfterEnd = await sdk.processes.getProcess(processId);
    expect(processAfterEnd.status).toBe(BigInt(ProcessStatus.ENDED));
  });

  it('should validate SDK initialization requirement for endProcess', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    await expect(
      uninitializedSdk.endProcess(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).rejects.toThrow('SDK must be initialized before ending processes. Call sdk.init() first.');
  });

  it('should validate SDK initialization requirement for endProcessStream', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    expect(() =>
      uninitializedSdk.endProcessStream(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).toThrow('SDK must be initialized before ending processes. Call sdk.init() first.');
  });

  it('should pause a process using async generator stream and yield transaction status events', async () => {
    // First create a process to pause
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Pause Process Stream Test',
      description: 'Testing the pauseProcessStream async generator method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 20,
        uri: `ipfs://pause-process-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Should this process be paused?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforePause = await sdk.processes.getProcess(processId);
    expect(processBeforePause.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Now pause the process using the stream
    const pauseStream = sdk.pauseProcessStream(processId);

    let hasPendingEvent = false;
    let hasCompletedEvent = false;
    let transactionHash = '';

    for await (const event of pauseStream) {
      if (event.status === 'pending') {
        hasPendingEvent = true;
        transactionHash = event.hash;

        expect(event.hash).toBeDefined();
        expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'completed') {
        hasCompletedEvent = true;

        expect(event.response).toBeDefined();
        expect(event.response.success).toBe(true);
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown'}`);
      }
    }

    // Verify that we received both pending and completed events
    expect(hasPendingEvent).toBe(true);
    expect(hasCompletedEvent).toBe(true);
    expect(transactionHash).toBeTruthy();

    // Verify the process status was changed to PAUSED on-chain
    const processAfterPause = await sdk.processes.getProcess(processId);
    expect(processAfterPause.status).toBe(BigInt(ProcessStatus.PAUSED));
  });

  it('should pause a process using the simplified pauseProcess method', async () => {
    // First create a process to pause
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Simple Pause Process Test',
      description: 'Testing the simplified pauseProcess method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 15,
        uri: `ipfs://simple-pause-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Simple pause test question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforePause = await sdk.processes.getProcess(processId);
    expect(processBeforePause.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Pause the process using the simplified method
    await sdk.pauseProcess(processId);

    // Verify the process status was changed to PAUSED on-chain
    const processAfterPause = await sdk.processes.getProcess(processId);
    expect(processAfterPause.status).toBe(BigInt(ProcessStatus.PAUSED));
  });

  it('should validate SDK initialization requirement for pauseProcess', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    await expect(
      uninitializedSdk.pauseProcess(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).rejects.toThrow('SDK must be initialized before pausing processes. Call sdk.init() first.');
  });

  it('should validate SDK initialization requirement for pauseProcessStream', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    expect(() =>
      uninitializedSdk.pauseProcessStream(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).toThrow('SDK must be initialized before pausing processes. Call sdk.init() first.');
  });

  it('should cancel a process using async generator stream and yield transaction status events', async () => {
    // First create a process to cancel
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Cancel Process Stream Test',
      description: 'Testing the cancelProcessStream async generator method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 20,
        uri: `ipfs://cancel-process-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Should this process be canceled?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforeCancel = await sdk.processes.getProcess(processId);
    expect(processBeforeCancel.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Now cancel the process using the stream
    const cancelStream = sdk.cancelProcessStream(processId);

    let hasPendingEvent = false;
    let hasCompletedEvent = false;
    let transactionHash = '';

    for await (const event of cancelStream) {
      if (event.status === 'pending') {
        hasPendingEvent = true;
        transactionHash = event.hash;

        expect(event.hash).toBeDefined();
        expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'completed') {
        hasCompletedEvent = true;

        expect(event.response).toBeDefined();
        expect(event.response.success).toBe(true);
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown'}`);
      }
    }

    // Verify that we received both pending and completed events
    expect(hasPendingEvent).toBe(true);
    expect(hasCompletedEvent).toBe(true);
    expect(transactionHash).toBeTruthy();

    // Verify the process status was changed to CANCELED on-chain
    const processAfterCancel = await sdk.processes.getProcess(processId);
    expect(processAfterCancel.status).toBe(BigInt(ProcessStatus.CANCELED));
  });

  it('should cancel a process using the simplified cancelProcess method', async () => {
    // First create a process to cancel
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Simple Cancel Process Test',
      description: 'Testing the simplified cancelProcess method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 15,
        uri: `ipfs://simple-cancel-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Simple cancel test question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforeCancel = await sdk.processes.getProcess(processId);
    expect(processBeforeCancel.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Cancel the process using the simplified method
    await sdk.cancelProcess(processId);

    // Verify the process status was changed to CANCELED on-chain
    const processAfterCancel = await sdk.processes.getProcess(processId);
    expect(processAfterCancel.status).toBe(BigInt(ProcessStatus.CANCELED));
  });

  it('should validate SDK initialization requirement for cancelProcess', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    await expect(
      uninitializedSdk.cancelProcess(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).rejects.toThrow('SDK must be initialized before canceling processes. Call sdk.init() first.');
  });

  it('should validate SDK initialization requirement for cancelProcessStream', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    expect(() =>
      uninitializedSdk.cancelProcessStream(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).toThrow('SDK must be initialized before canceling processes. Call sdk.init() first.');
  });

  it('should resume a paused process using async generator stream and yield transaction status events', async () => {
    // First create a process
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Resume Process Stream Test',
      description: 'Testing the resumeProcessStream async generator method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 20,
        uri: `ipfs://resume-process-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Should this process be resumed?',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforePause = await sdk.processes.getProcess(processId);
    expect(processBeforePause.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Pause the process first
    await sdk.pauseProcess(processId);

    // Verify the process is paused
    const processAfterPause = await sdk.processes.getProcess(processId);
    expect(processAfterPause.status).toBe(BigInt(ProcessStatus.PAUSED));

    // Now resume the process using the stream
    const resumeStream = sdk.resumeProcessStream(processId);

    let hasPendingEvent = false;
    let hasCompletedEvent = false;
    let transactionHash = '';

    for await (const event of resumeStream) {
      if (event.status === 'pending') {
        hasPendingEvent = true;
        transactionHash = event.hash;

        expect(event.hash).toBeDefined();
        expect(event.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } else if (event.status === 'completed') {
        hasCompletedEvent = true;

        expect(event.response).toBeDefined();
        expect(event.response.success).toBe(true);
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown'}`);
      }
    }

    // Verify that we received both pending and completed events
    expect(hasPendingEvent).toBe(true);
    expect(hasCompletedEvent).toBe(true);
    expect(transactionHash).toBeTruthy();

    // Verify the process status was changed to READY on-chain
    const processAfterResume = await sdk.processes.getProcess(processId);
    expect(processAfterResume.status).toBe(BigInt(ProcessStatus.READY));
  });

  it('should resume a paused process using the simplified resumeProcess method', async () => {
    // First create a process
    const censusRoot = randomHex(32);

    const processConfig: ProcessConfig = {
      title: 'Simple Resume Process Test',
      description: 'Testing the simplified resumeProcess method',
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 15,
        uri: `ipfs://simple-resume-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
      questions: [
        {
          title: 'Simple resume test question',
          choices: [
            { title: 'Yes', value: 0 },
            { title: 'No', value: 1 },
          ],
        },
      ],
    };

    // Create the process
    const createResult = await sdk.createProcess(processConfig);
    expect(createResult.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const processId = createResult.processId;

    // Verify initial process status is READY
    const processBeforePause = await sdk.processes.getProcess(processId);
    expect(processBeforePause.status).toBe(BigInt(ProcessStatus.READY));

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 24000)); // Wait 24 seconds

    // Pause the process first
    await sdk.pauseProcess(processId);

    // Verify the process is paused
    const processAfterPause = await sdk.processes.getProcess(processId);
    expect(processAfterPause.status).toBe(BigInt(ProcessStatus.PAUSED));

    // Resume the process using the simplified method
    await sdk.resumeProcess(processId);

    // Verify the process status was changed to READY on-chain
    const processAfterResume = await sdk.processes.getProcess(processId);
    expect(processAfterResume.status).toBe(BigInt(ProcessStatus.READY));
  });

  it('should validate SDK initialization requirement for resumeProcess', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    await expect(
      uninitializedSdk.resumeProcess(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).rejects.toThrow('SDK must be initialized before resuming processes. Call sdk.init() first.');
  });

  it('should validate SDK initialization requirement for resumeProcessStream', async () => {
    const uninitializedSdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
    });

    expect(() =>
      uninitializedSdk.resumeProcessStream(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      )
    ).toThrow('SDK must be initialized before resuming processes. Call sdk.init() first.');
  });

  // ==================== NEW: Census Object Tests ====================

  describe('Census Object Support (Auto-Publishing)', () => {
    it('should create a process using PlainCensus (auto-publishes)', async () => {
      // Create a plain census
      const census = new PlainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        '0x9876543210987654321098765432109876543210',
      ]);

      // Census is NOT published yet - SDK will auto-publish!
      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'PlainCensus Test Election',
        description: 'Testing automatic census publishing with PlainCensus',
        census: census, // Just pass the census object! SDK auto-publishes ✨
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you approve this PlainCensus test?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      // Create process - SDK will auto-publish the census
      const result = await sdk.createProcess(processConfig);

      // Verify result
      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBeDefined();
      expect(census.censusURI).toBeDefined();
      expect(census.size).toBe(3);

      // Verify on-chain
      const onChainProcess = await sdk.processes.getProcess(result.processId);
      expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(
        census.censusRoot!.toLowerCase()
      );
      expect(onChainProcess.census.maxVotes).toBe(BigInt(3));
    });

    it('should create a process using WeightedCensus with string weights (auto-publishes)', async () => {
      // Create a weighted census with string weights
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '5' },
        { key: '0x9876543210987654321098765432109876543210', weight: '10' },
      ]);

      // Census is NOT published yet
      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'WeightedCensus String Test',
        description: 'Testing automatic publishing with WeightedCensus (string weights)',
        census: census, // SDK auto-publishes! ✨
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you approve this WeightedCensus test?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.size).toBe(3);

      // Verify on-chain
      const onChainProcess = await sdk.processes.getProcess(result.processId);
      expect(onChainProcess.census.maxVotes).toBe(BigInt(3));
    });

    it('should create a process using WeightedCensus with number weights (auto-publishes)', async () => {
      // Create a weighted census with number weights
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 1 }, // number
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 5 }, // number
        { key: '0x9876543210987654321098765432109876543210', weight: 10 }, // number
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'WeightedCensus Number Test',
        description: 'Testing automatic publishing with WeightedCensus (number weights)',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Rate this number weight feature',
            choices: [
              { title: 'Excellent', value: 0 },
              { title: 'Good', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(census.isPublished).toBe(true);
    });

    it('should create a process using WeightedCensus with bigint weights (auto-publishes)', async () => {
      // Create a weighted census with bigint weights
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 100n }, // bigint
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 500n }, // bigint
        { key: '0x9876543210987654321098765432109876543210', weight: 1000n }, // bigint
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'WeightedCensus BigInt Test',
        description: 'Testing automatic publishing with WeightedCensus (bigint weights)',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you like bigint support?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(census.isPublished).toBe(true);
    });

    it('should create a process using WeightedCensus with mixed weight types', async () => {
      // Create a weighted census with mixed weight types
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' }, // string
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 10 }, // number
        { key: '0x9876543210987654321098765432109876543210', weight: 100n }, // bigint
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'WeightedCensus Mixed Types Test',
        description: 'Testing automatic publishing with mixed weight types',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you like mixed weight types?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(census.isPublished).toBe(true);
      expect(census.size).toBe(3);
    });

    it('should work with already published census (no re-publish)', async () => {
      // Create a census
      const census = new PlainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);

      expect(census.isPublished).toBe(false);

      // Use it once - SDK will auto-publish
      const processConfig1: ProcessConfig = {
        title: 'First Process with Census',
        description: 'This auto-publishes the census',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'First process question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result1 = await sdk.createProcess(processConfig1);
      expect(result1).toBeDefined();
      expect(result1.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBeDefined();
      const originalRoot = census.censusRoot;

      // Use same census again - should NOT re-publish (root should stay the same)
      const processConfig2: ProcessConfig = {
        title: 'Second Process with Same Census',
        description: 'Testing reuse of already published census',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Second process question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result2 = await sdk.createProcess(processConfig2);
      expect(result2).toBeDefined();
      expect(result2.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Census root should be the same (not re-published)
      expect(census.censusRoot).toBe(originalRoot);
    });

    it('should still support manual census config (backwards compatible)', async () => {
      // This test verifies that the old way still works
      const censusRoot = randomHex(32);

      const processConfig: ProcessConfig = {
        title: 'Manual Config Test (Backwards Compatible)',
        description: 'Testing backwards compatibility with manual census config',
        census: {
          type: CensusOrigin.CensusOriginMerkleTree,
          root: censusRoot,
          size: 25,
          uri: `ipfs://manual-census-${Date.now()}`,
        },
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Does manual config still work?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify on-chain
      const onChainProcess = await sdk.processes.getProcess(result.processId);
      expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(censusRoot.toLowerCase());
      expect(onChainProcess.census.maxVotes).toBe(BigInt(25));
    });
  });

  it('should create a process using pre-existing metadataUri', async () => {
    // Step 1: Manually upload metadata to get a metadata URI using the template helper
    const metadata = getElectionMetadataTemplate();
    metadata.title.default = 'Metadata URI Test Election';
    metadata.description.default = 'Testing metadataUri feature by uploading metadata manually';
    metadata.questions = [
      {
        title: { default: 'Do you approve this test?' },
        description: { default: 'Test question for metadataUri' },
        meta: {},
        choices: [
          { title: { default: 'Yes' }, value: 0, meta: {} },
          { title: { default: 'No' }, value: 1, meta: {} },
        ],
      },
    ];

    // Upload metadata directly to the sequencer
    const metadataHash = await sdk.api.sequencer.pushMetadata(metadata);
    const uploadedMetadataUri = sdk.api.sequencer.getMetadataUrl(metadataHash);
    
    expect(uploadedMetadataUri).toBeDefined();
    expect(uploadedMetadataUri).toBeTruthy();

    // Step 2: Create a process using the uploaded metadataUri (no title/description/questions needed!)
    const censusRoot = randomHex(32);
    const processConfig: ProcessConfig = {
      metadataUri: uploadedMetadataUri, // Just provide the URI!
      census: {
        type: CensusOrigin.CensusOriginMerkleTree,
        root: censusRoot,
        size: 10,
        uri: `ipfs://metadatauri-test-${Date.now()}`,
      },
      ballot: {
        numFields: 1,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: {
        duration: 3600,
      },
    };

    const result = await sdk.createProcess(processConfig);

    // Verify the process was created successfully
    expect(result).toBeDefined();
    expect(result.processId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify the process uses the uploaded metadata URI
    const process = await sdk.getProcess(result.processId);
    expect(process.metadataURI).toBe(uploadedMetadataUri);

    // Verify the metadata content matches what we uploaded
    expect(process.title).toBe('Metadata URI Test Election');
    expect(process.description).toBe('Testing metadataUri feature by uploading metadata manually');
    expect(process.questions.length).toBe(1);
    expect(process.questions[0].title).toBe('Do you approve this test?');
    expect(process.questions[0].description).toBe('Test question for metadataUri');
  });
});
