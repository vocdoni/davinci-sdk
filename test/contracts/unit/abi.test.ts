import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, type JsonFragment, type ParamType } from 'ethers';
import {
  CENSUS_VALIDATOR_ABI,
  CONTRACTS_ABI_COMMIT,
  DAVINCI_DKG_ADAPTER_ABI,
  DAVINCI_ERRORS_ABI,
  DKG_APP_MANAGER_ABI,
  DKG_MANAGER_ABI,
  PROCESS_REGISTRY_ABI,
  ZISK_VERIFIER_ABI,
  decodeDavinciError,
} from '../../../src/contracts/abis';

// Drift guard for the vendored ABIs (davinci-contracts 36c0b0a). Every value
// below is transcribed from the selector and topic tables the SDK was designed
// against; a sync that moves any of them must be a deliberate change here too.

const registry = new Interface(PROCESS_REGISTRY_ABI);
const adapter = new Interface(DAVINCI_DKG_ADAPTER_ABI);

const REGISTRY_FUNCTIONS: Record<string, string> = {
  'newProcess(uint8,uint256,uint256,uint256,(bool,uint8,uint8,uint8,uint256,uint256,uint256,uint256),(uint8,bytes32,address,string,bool),string,bytes32,(uint256,uint256),(uint8,bytes12,uint256,uint256,uint256,uint256,uint256))':
    '0x08c0fdd3',
  'getProcess(bytes31)': '0x59d821c4',
  'getNextProcessId(address)': '0x68141f2c',
  'getProcessEndTime(bytes31)': '0x04ed00fa',
  'getProcessGraceEnd(bytes31)': '0x3ea4ee41',
  'setProcessStatus(bytes31,uint8)': '0x082b642e',
  'setProcessCensus(bytes31,(uint8,bytes32,address,string,bool))': '0x6c7aff7f',
  'setProcessMetadata(bytes31,string,bytes32)': '0x46c15da8',
  'setProcessDuration(bytes31,uint256)': '0x9b464994',
  'setProcessMaxVoters(bytes31,uint256)': '0x026cdee8',
  'setProcessGrace(bytes31,uint32)': '0x9a037789',
  'revealProcessKey(bytes31,uint256)': '0x73417705',
  'finalizeResultsFromDKG(bytes31)': '0xf1431097',
  'requestResultsDecryption(bytes31,uint256[64],bytes32[])': '0xe965eead',
  'setProcessResults(bytes31,bytes,bytes)': '0x766422e0',
  'submitStateTransition(bytes31,bytes,bytes,bytes[],bytes32[],bytes[])': '0x1fdf3449',
  'aidFor(bytes31)': '0x702574b3',
  'dkgAdapter()': '0xe16d5b7c',
  'defaultGrace()': '0xc8f0582f',
  'graceFloor()': '0x5ff5f981',
  'graceCeil()': '0x1542bbe2',
  'graceMaxTotal()': '0x549d5995',
  'noticeMin()': '0xd4138a20',
  'ziskVerifier()': '0x7f64b72f',
  'batchProgramVK()': '0x946544bf',
  'resultsProgramVK()': '0xaa240221',
  'rootCVadcopFinal()': '0x62115338',
  'ballotVKHash()': '0x0e2ebcf7',
  'chainID()': '0xadc879e9',
  'pidPrefix()': '0xcddf08bc',
  'processCount()': '0x848df540',
  'processNonce(address)': '0x62fa11fc',
  'MAX_STATUS()': '0x72c628ef',
  'genesisRoot(bytes31,(bool,uint8,uint8,uint8,uint256,uint256,uint256,uint256),(uint256,uint256),uint8)':
    '0xbf74291e',
  'getSTVerifierVKeyHash()': '0x4c0acc56',
  'getRVerifierVKeyHash()': '0xf9aa4499',
};

const ADAPTER_FUNCTIONS: Record<string, string> = {
  'aidFor(bytes31)': '0x702574b3',
  'registrationEpoch()': '0xf08c9b3c',
  'registry()': '0x7b103999',
  'manager()': '0x481c6a75',
  'appManager()': '0xebe86c13',
};

const REMOVED_FUNCTIONS = ['MAX_CENSUS_ORIGIN', 'BLOB_INDEX', 'stVerifier', 'rVerifier', 'blobsDA'];

const REGISTRY_EVENTS: Record<string, string> = {
  'ProcessCreated(bytes31,address)':
    '0xeefcd49abfaf7291d2e1c15f581f85a3610d4f103666e075bd536faef609e1d1',
  'ProcessStatusChanged(bytes31,uint8,uint8)':
    '0x56f95be551d4235ff95edcee7dca6f56f66968ed1b176f73ffd899721aa19abf',
  'CensusUpdated(bytes31,bytes32,string)':
    '0x660d494893b9a2e6c617bc5137fb9bac10f3cf87e7c43125657872f2a1959ed2',
  'ProcessMetadataUpdated(bytes31,string,bytes32)':
    '0x77e65e34059d7d8e9b78033507a4bc1fbac6bd614e0703b7ca2c6c7d5fa4e1f0',
  'ProcessDurationChanged(bytes31,uint256)':
    '0x45edf61f525089c4937f17d4abc513c0a865c52ff2f704d35bb9a5e207af41ba',
  'ProcessMaxVotersChanged(bytes31,uint256)':
    '0x36c67c90d9fb754eb7d39c3c925b71dad1c9c05324eaf1fc6976dd7fcff4d2be',
  'ProcessGraceChanged(bytes31,uint32)':
    '0xdf161c6af27d090672f982bb8002da0e7f2a530ffbd779e02ab9eba9397e51f1',
  'ProcessStateTransitioned(bytes31,address,bytes32,bytes32,uint256,uint256,uint256)':
    '0x36c6781d994e030a156d2f6fa11abcc1cd6814482a5d61f90da3f336318b1d23',
  'ProcessResultsSet(bytes31,address,uint256[])':
    '0xdf1be195647bf0f039490311aa7fd2242eb64a0eb3844c37f174b8d7c25d448e',
  'ResultsDecryptionRequested(bytes31,bytes12,bytes32,uint16,uint8)':
    '0xdca6075f07367349a836825d3ee7c35c204d2e727ae81a5b7a48aca95b9c270b',
};

// All 61 registry errors, by name.
const REGISTRY_ERRORS: Record<string, string> = {
  BallotModeMaxValueSumTooLarge: '0x271fb805',
  BallotModeMaxValueTooLarge: '0x481eb79f',
  BallotModeMinValueSumTooLarge: '0xdd6f54df',
  BallotModeMinValueTooLarge: '0x871a7fa3',
  BlobCountMismatch: '0xb8ff08e9',
  CannotAcceptResult: '0xf0dabb68',
  CensusNotUpdatable: '0x142ddf1c',
  CircuitFailed: '0x54aabb00',
  DKGDisabled: '0x0003eb8f',
  EmptyTransition: '0x7f19b8aa',
  GraceOpen: '0xc23ee5e6',
  InvalidAccumulator: '0xa88d6454',
  InvalidBlobCommitmentLength: '0xe2c85a2c',
  InvalidBlobOpening: '0x8308e1e9',
  InvalidBlobsDigest: '0x797265c8',
  InvalidBlockNumber: '0x4e47846c',
  InvalidCensusAddress: '0xac5cb2e2',
  InvalidCensusConfig: '0xf545b7bf',
  InvalidCensusOrigin: '0xf37f7b5d',
  InvalidCensusRoot: '0x5e32eadd',
  InvalidCensusURI: '0x1f172642',
  InvalidDKGParams: '0xe4291a19',
  InvalidDuration: '0x76166401',
  InvalidEncryptionKey: '0x411ca7ca',
  InvalidGrace: '0x795ee5af',
  InvalidGroupSize: '0x2cbdc231',
  InvalidInclusionProof: '0xf35959c0',
  InvalidKeyMode: '0x65b75c39',
  InvalidKZGProofLength: '0x50320ab1',
  InvalidMaxCount: '0xac38930b',
  InvalidMaxMinValueBounds: '0x207ea56d',
  InvalidMaxValue: '0xb1911d8b',
  InvalidMaxVoters: '0x2c45be6f',
  InvalidMetadata: '0xbcecb64a',
  InvalidMinTotalCost: '0xfb3a91a8',
  InvalidMinValue: '0x63f4b4b7',
  InvalidOccupiedBefore: '0xd0480f74',
  InvalidProcessId: '0xcbf4a645',
  InvalidPublicValues: '0x3d879ff4',
  InvalidStartTime: '0xb290253c',
  InvalidStateRoot: '0xb6fac030',
  InvalidStatus: '0xf525e320',
  InvalidTimeBounds: '0xe843c5eb',
  InvalidUniqueValues: '0xe9fd383f',
  InvalidValueSumBounds: '0xda807d8e',
  InvalidVerifierConfig: '0x06f9b907',
  MaxPossibleResultCapExceeded: '0xeba5c29b',
  MaxVotersReached: '0xafa31aa6',
  MissingBlob: '0x95ed3b32',
  NoBlobs: '0xfdac229f',
  ProcessAlreadyExists: '0xa08189a6',
  ProcessNotEnded: '0xed74559c',
  ProcessNotFound: '0x4d36eb69',
  ProofInvalid: '0x7fcdd1f4',
  ReentrancyGuardReentrantCall: '0x3ee5aeb5',
  ResultsAlreadyRequested: '0xd915d296',
  ResultsNotReady: '0xe0d4dc50',
  SmtLengthMismatch: '0xd0882493',
  SmtMaxLevelsReached: '0xe53f4904',
  Unauthorized: '0x82b42900',
  UnknownProcessIdPrefix: '0x4532ee1a',
};

// Errors that bubble up through the registry from the adapter, the verifier
// and davinci-dkg, and are not in the registry ABI.
const FOREIGN_ERRORS: Record<string, [JsonFragment[], Record<string, string>]> = {
  DavinciDKGAdapter: [
    DAVINCI_DKG_ADAPTER_ABI,
    { NotRegistry: '0xc85d9d6c', NoLiveEpoch: '0x40f54b88', NonContiguousIndex: '0x57149e25' },
  ],
  ZiskVerifier: [ZISK_VERIFIER_ABI, { InvalidProof: '0x09bde339' }],
  IDKGAppManager: [
    DKG_APP_MANAGER_ABI,
    {
      InvalidApplication: '0xf1d26476',
      ApplicationAlreadyExists: '0x0b792c8f',
      InvalidSchnorrProof: '0x4fefd69a',
      PointNotInSubgroup: '0xb28e7891',
      InvalidEpoch: '0xd5b25b63',
      InvalidPhase: '0x9a36fd9c',
      InvalidOrganizerSecret: '0x8204c84a',
      InvalidPolicy: '0xd06b96b1',
      AlreadyRevealed: '0xa89ac151',
      PoolExhausted: '0x8d3f5fe8',
    },
  ],
  IDKGManager: [
    DKG_MANAGER_ABI,
    {
      InvalidProofInput: '0xd1fed5fd',
      InvalidCiphertext: '0x989a539a',
      CiphertextAlreadySubmitted: '0x2dfd630a',
      DecryptionLimitReached: '0x464e67af',
    },
  ],
};

// `getProcess` returns DAVINCITypes.Process: 25 fields, grace and lastVoteAt
// flat at the end, as in the Solidity source.
const PROCESS_STRUCT = [
  'status:uint8',
  'organizationId:address',
  'encryptionKey:tuple(x:uint256,y:uint256)',
  'latestStateRoot:bytes32',
  'result:uint256[]',
  'startTime:uint256',
  'duration:uint256',
  'maxVoters:uint256',
  'votersCount:uint256',
  'overwrittenVotesCount:uint256',
  'creationBlock:uint256',
  'batchNumber:uint256',
  'metadataURI:string',
  'metadataHash:bytes32',
  'ballotMode:tuple(uniqueValues:bool,numFields:uint8,groupSize:uint8,costExponent:uint8,maxValue:uint256,minValue:uint256,maxValueSum:uint256,minValueSum:uint256)',
  'census:tuple(censusOrigin:uint8,censusRoot:bytes32,contractAddress:address,censusURI:string,onchainAllowAnyValidRoot:bool)',
  'keyMode:uint8',
  'dkgEpochId:bytes12',
  'dkgFirstIndex:uint16',
  'dkgCount:uint8',
  'dkgZeroSkipped:uint16',
  'dkgResultsRequested:bool',
  'dkgAid:bytes32',
  'grace:uint32',
  'lastVoteAt:uint64',
];

const NEW_PROCESS_INPUTS = [
  'status:uint8',
  'startTime:uint256',
  'duration:uint256',
  'maxVoters:uint256',
  'ballotMode:tuple(uniqueValues:bool,numFields:uint8,groupSize:uint8,costExponent:uint8,maxValue:uint256,minValue:uint256,maxValueSum:uint256,minValueSum:uint256)',
  'census:tuple(censusOrigin:uint8,censusRoot:bytes32,contractAddress:address,censusURI:string,onchainAllowAnyValidRoot:bool)',
  'metadataURI:string',
  'metadataHash:bytes32',
  'encryptionKey:tuple(x:uint256,y:uint256)',
  'dkg:tuple(mode:uint8,epochId:bytes12,orgPKx:uint256,orgPKy:uint256,popAx:uint256,popAy:uint256,popZ:uint256)',
];

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`${what} is missing`);
  return v;
}

function layout(p: ParamType): string {
  if (p.isTuple()) return `${p.name}:tuple(${p.components.map(layout).join(',')})`;
  return `${p.name}:${p.type}`;
}

describe('vendored contract ABIs', () => {
  it('match the files recorded by the sync script', () => {
    const dir = join(__dirname, '../../../src/contracts/abi');
    const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as {
      commit: string;
      files: Record<string, string>;
    };
    expect(source.commit).toBe('36c0b0aa9f4d5f3c6a777ab1d1db2774e379cb9c');
    expect(CONTRACTS_ABI_COMMIT).toBe(source.commit);
    expect(Object.keys(source.files).sort()).toEqual([
      'DavinciDKGAdapter.json',
      'ICensusValidator.json',
      'IDKGAppManager.json',
      'IDKGManager.json',
      'ProcessRegistry.json',
      'ZiskVerifier.json',
    ]);
    for (const [file, sha] of Object.entries(source.files)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex');
      expect(digest, file).toBe(sha);
    }
  });

  it('pin the registry function selectors', () => {
    for (const [signature, selector] of Object.entries(REGISTRY_FUNCTIONS)) {
      expect(must(registry.getFunction(signature), signature).selector, signature).toBe(selector);
    }
  });

  it('pin the adapter function selectors', () => {
    for (const [signature, selector] of Object.entries(ADAPTER_FUNCTIONS)) {
      expect(must(adapter.getFunction(signature), signature).selector, signature).toBe(selector);
    }
  });

  it('drop the functions removed since v0.0.49', () => {
    const names = new Set<string>();
    registry.forEachFunction(f => names.add(f.name));
    for (const name of REMOVED_FUNCTIONS) expect(names.has(name), name).toBe(false);
  });

  it('pin every registry event topic', () => {
    const events: string[] = [];
    registry.forEachEvent(e => events.push(e.format('sighash')));
    expect(events.sort()).toEqual(Object.keys(REGISTRY_EVENTS).sort());
    for (const [signature, topic] of Object.entries(REGISTRY_EVENTS)) {
      expect(must(registry.getEvent(signature), signature).topicHash, signature).toBe(topic);
    }
  });

  it('pin every registry error selector', () => {
    const errors: Record<string, string> = {};
    registry.forEachError(e => {
      errors[e.name] = e.selector;
    });
    expect(errors).toEqual(REGISTRY_ERRORS);
  });

  it('pin the adapter, verifier and DKG errors', () => {
    for (const [contract, [abi, expected]] of Object.entries(FOREIGN_ERRORS)) {
      const errors: Record<string, string> = {};
      new Interface(abi).forEachError(e => {
        errors[e.name] = e.selector;
      });
      for (const [name, selector] of Object.entries(expected)) {
        expect(errors[name], `${contract}.${name}`).toBe(selector);
      }
    }
  });

  it('pin the getProcess struct layout', () => {
    const f = must(registry.getFunction('getProcess'), 'getProcess');
    expect(f.outputs).toHaveLength(1);
    expect(must(f.outputs[0].components, 'Process').map(layout)).toEqual(PROCESS_STRUCT);
  });

  it('pin the newProcess argument layout', () => {
    const f = must(registry.getFunction('newProcess'), 'newProcess');
    expect(f.inputs.map(layout)).toEqual(NEW_PROCESS_INPUTS);
  });

  it('pin the census validator interface', () => {
    const iface = new Interface(CENSUS_VALIDATOR_ABI);
    const outputs = (sig: string) => must(iface.getFunction(sig), sig).outputs.map(o => o.type);
    expect(outputs('getCensusRoot()')).toEqual(['uint256']);
    expect(outputs('getRootBlockNumber(uint256)')).toEqual(['uint256']);
    expect(outputs('getTotalVotingPowerAtRoot(uint256)')).toEqual(['uint256']);
    expect(iface.getEvent('WeightChanged(address,uint88,uint88)')).not.toBeNull();
  });

  it('pin the verifier root getter', () => {
    const iface = new Interface(ZISK_VERIFIER_ABI);
    const root = must(iface.getFunction('getRootCVadcopFinal()'), 'getRootCVadcopFinal');
    expect(root.outputs.map(o => o.type)).toEqual(['bytes32']);
    expect(iface.getFunction('verifySnarkProof(bytes32,bytes32,bytes,bytes)')).not.toBeNull();
  });
});

describe('DAVINCI error decoding', () => {
  const all = {
    ...REGISTRY_ERRORS,
    ...Object.assign({}, ...Object.values(FOREIGN_ERRORS).map(([, e]) => e)),
  } as Record<string, string>;

  it('merge one fragment per selector', () => {
    const selectors = new Interface(DAVINCI_ERRORS_ABI);
    const seen: string[] = [];
    selectors.forEachError(e => seen.push(e.selector));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...new Set(Object.values(all))].sort());
  });

  it('name every known selector', () => {
    for (const [name, selector] of Object.entries(all)) {
      const args = name === 'InvalidBlobOpening' || name === 'MissingBlob' ? '0'.repeat(64) : '';
      expect(decodeDavinciError(selector + args)?.name, name).toBe(name);
    }
  });

  it('decode arguments', () => {
    const d = decodeDavinciError(`0x95ed3b32${'0'.repeat(63)}3`);
    expect(d?.signature).toBe('MissingBlob(uint256)');
    expect(d?.args[0]).toBe(3n);
  });

  it('return null for unknown or malformed data', () => {
    expect(decodeDavinciError('0x12345678')).toBeNull();
    expect(decodeDavinciError('0x')).toBeNull();
    expect(decodeDavinciError('0x95ed3b32')).toBeNull();
  });
});
