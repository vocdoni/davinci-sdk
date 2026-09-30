import {
  Interface,
  Wallet,
  ZeroAddress,
  getAddress,
  sha256,
  toUtf8Bytes,
  type Result,
} from 'ethers';
import {
  CensusError,
  CensusOrigin,
  CensusPublishError,
  OffchainCensus,
  OffchainDynamicCensus,
  OnchainCensus,
  PublishedCensus,
} from '../../../src/census';
import {
  CensusNotUpdatable,
  ONCHAIN_CENSUS_ABI,
  PROCESS_REGISTRY_ABI,
  ProcessRegistryService,
  ProcessStatus,
} from '../../../src/contracts';
import { VocdoniApiService } from '../../../src/core/api/ApiService';
import {
  ProcessOrchestrationService,
  buildElectionMetadata,
  serializeMetadata,
  type ProcessConfig,
  type QuestionConfig,
} from '../../../src/core';
import { bjjMulBase, slotFromAddress } from '../../../src/crypto';
import { GNOSIS } from '../../../src/networks';
import { DocumentHost } from '../../helpers/documentHost';
import { MockChain } from '../../helpers/mockChain';

const REGISTRY = GNOSIS.processRegistry;
const KEY = `0x${'11'.repeat(32)}`;
const PID = `0x${'aa'.repeat(20)}f5848002${'00'.repeat(6)}01`;
const KEY_NODE = 'https://key.sequencer.test';
const KEY_POINT = bjjMulBase(12345n);
const CONTRACT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const iface = new Interface(PROCESS_REGISTRY_ABI);

const questions: [QuestionConfig] = [
  {
    title: 'Which site?',
    choices: [
      { title: 'North', value: 0 },
      { title: 'South', value: 1 },
    ],
  },
];

const ballot = {
  numFields: 2,
  maxValue: '1',
  minValue: '0',
  uniqueValues: false,
  costExponent: 1,
  maxValueSum: '1',
  minValueSum: '0',
};

const timing = { startDate: Math.floor(Date.now() / 1000) + 60, duration: 3600 };

function onchainProcess(organizer: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    organizationId: organizer,
    encryptionKey: { x: KEY_POINT.x, y: KEY_POINT.y },
    latestStateRoot: `0x${'04'.repeat(32)}`,
    result: [],
    startTime: 1_700_000_000n,
    duration: 3600n,
    maxVoters: 100n,
    votersCount: 0n,
    overwrittenVotesCount: 0n,
    creationBlock: 48_600_000n,
    batchNumber: 0n,
    metadataURI: '',
    metadataHash: `0x${'aa'.repeat(32)}`,
    ballotMode: {
      uniqueValues: false,
      numFields: 2,
      groupSize: 2,
      costExponent: 1,
      maxValue: 1n,
      minValue: 0n,
      maxValueSum: 1n,
      minValueSum: 0n,
    },
    census: {
      censusOrigin: 2,
      censusRoot: `0x${'00'.repeat(31)}05`,
      contractAddress: ZeroAddress,
      censusURI: 'https://files.example.org/c0.json',
      onchainAllowAnyValidRoot: false,
    },
    keyMode: 0,
    dkgEpochId: `0x${'00'.repeat(12)}`,
    dkgFirstIndex: 0,
    dkgCount: 0,
    dkgZeroSkipped: 0,
    dkgResultsRequested: false,
    dkgAid: `0x${'00'.repeat(32)}`,
    grace: 180,
    lastVoteAt: 0n,
    ...overrides,
  };
}

function setup(options: { uploader?: boolean; verify?: boolean } = {}) {
  const chain = new MockChain();
  const wallet = new Wallet(KEY, chain);
  const state = { process: onchainProcess(wallet.address) };
  chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
    getNextProcessId: () => [PID],
    getProcess: () => [state.process],
    newProcess: () => [PID.slice(0, 64)],
    setProcessCensus: () => [],
    setProcessMetadata: () => [],
  });
  chain.onMine = tx => {
    const parsed = iface.parseTransaction({ data: tx.data });
    if (parsed?.name !== 'newProcess') return { status: 1 };
    const { topics, data } = iface.encodeEventLog('ProcessCreated', [PID, wallet.address]);
    return { status: 1, logs: [{ address: REGISTRY, topics, data }] };
  };
  const keyRequests: string[] = [];
  const keyFetch = ((input: string | URL | Request) => {
    keyRequests.push(String(input));
    const body = JSON.stringify({ x: KEY_POINT.x.toString(), y: KEY_POINT.y.toString() });
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  const api = new VocdoniApiService({
    keySequencerURL: KEY_NODE,
    sequencerConfig: { fetchImpl: keyFetch },
  });
  const host = new DocumentHost();
  const registry = new ProcessRegistryService(REGISTRY, wallet, { receiptTimeoutMs: 2000 });
  const orchestrator = new ProcessOrchestrationService(registry, api, wallet, {
    ...(options.uploader !== false && { uploader: host.uploader }),
    documents: { fetchImpl: host.fetchImpl, verify: options.verify },
  });
  const sent = () =>
    chain.sent.map(tx => iface.parseTransaction({ data: tx.data })).filter(p => p !== null);
  return { chain, wallet, state, host, orchestrator, keyRequests, sent };
}

const census = (args: Result) => args.getValue('census') as Result;

describe('ProcessOrchestrationService.createProcess', () => {
  it('publishes the census and the metadata, then creates the process with them', async () => {
    const { host, orchestrator, keyRequests, sent } = setup();
    const members = new OffchainCensus();
    members.add([A, { key: B, weight: 3 }]);
    const result = await orchestrator.createProcess({
      title: { default: 'Parks', es: 'Parques' },
      description: 'Pick one',
      census: members,
      electionPreset: { type: 'single_choice' },
      timing,
      questions,
    });
    expect(result.processId).toBe(PID);

    const metadata = serializeMetadata(
      buildElectionMetadata({
        title: { default: 'Parks', es: 'Parques' },
        description: 'Pick one',
        questions,
        electionPreset: { type: 'single_choice' },
      })
    );
    expect(host.uploads.map(u => u.kind)).toEqual(['census', 'metadata']);
    expect(host.uploads[0].data).toEqual(members.serialize());
    expect(host.uploads[1].data).toEqual(metadata);
    expect(keyRequests).toEqual([`${KEY_NODE}/processes/keys`]);

    const [create] = sent();
    expect(create.name).toBe('newProcess');
    expect(create.args.getValue('maxVoters')).toBe(2n);
    const c = census(create.args);
    expect([...c]).toEqual([
      1n,
      await members.root(),
      ZeroAddress,
      host.urlOf(members.serialize()),
      false,
    ]);
    expect(create.args.getValue('metadataURI')).toBe(host.urlOf(metadata));
    expect(create.args.getValue('metadataHash')).toBe(sha256(metadata));
  });

  it('needs an uploader for a census object or the metadata fields, and sends nothing without one', async () => {
    const { orchestrator, chain, keyRequests } = setup({ uploader: false });
    const members = new OffchainCensus();
    members.add(A);
    await expect(
      orchestrator.createProcess({ title: 't', census: members, ballot, timing, questions })
    ).rejects.toThrow('publishing the census file needs an uploader');
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    await expect(
      orchestrator.createProcess({
        title: 't',
        census: csp,
        ballot,
        timing,
        questions,
        maxVoters: 5,
      })
    ).rejects.toThrow('publishing the metadata document needs an uploader');
    expect(chain.sent).toHaveLength(0);
    expect(keyRequests).toHaveLength(0);
  });

  it('takes a metadata URL with its hash, or hashes what it serves', async () => {
    const { host, orchestrator, sent } = setup();
    const doc = toUtf8Bytes('{"title":{"default":"served"}}');
    const url = 'https://files.example.org/meta.json';
    host.serve(url, { body: doc });
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const base = { census: csp, ballot, timing, maxVoters: 5, metadataUri: url };
    await orchestrator.createProcess(base);
    await orchestrator.createProcess({ ...base, metadataHash: `0x${'CD'.repeat(32)}` });
    const [fetched, given] = sent();
    expect(fetched.args.getValue('metadataHash')).toBe(sha256(doc));
    expect(given.args.getValue('metadataHash')).toBe(`0x${'cd'.repeat(32)}`);
    expect(host.uploads).toHaveLength(0);
    await expect(
      orchestrator.createProcess({ ...base, metadataHash: `0x${'00'.repeat(32)}` })
    ).rejects.toThrow('not a non-zero 32-byte hex hash');
    // A metadata URL to hash is read under the URL policy.
    const internal = 'http://10.0.0.5/meta.json';
    host.serve(internal, { body: doc });
    await expect(orchestrator.createProcess({ ...base, metadataUri: internal })).rejects.toThrow(
      `refused the metadata at ${internal}`
    );
    expect(host.fetches.map(f => f.url)).not.toContain(internal);
  });

  it('checks a Merkle census URL given by hand before asking for a key', async () => {
    const { host, orchestrator, keyRequests } = setup();
    const members = new OffchainCensus();
    members.add([A, B]);
    const url = 'https://census.example.org/c.json';
    host.serve(url, { body: members.serialize() });
    const doc = buildElectionMetadata({ title: 't', questions });
    const config = (root: string): ProcessConfig => ({
      title: 't',
      census: { type: CensusOrigin.OffchainStatic, root, uri: url },
      ballot,
      timing,
      questions,
      maxVoters: 2,
    });
    await expect(orchestrator.createProcess(config(`0x${'05'.padStart(64, '0')}`))).rejects.toThrow(
      CensusPublishError
    );
    expect(keyRequests).toHaveLength(0);
    await orchestrator.createProcess(config(await members.root()));
    expect(host.uploads.map(u => u.data)).toEqual([serializeMetadata(doc)]);
    // A published census object is checked the same way; verify: false skips it.
    await expect(
      orchestrator.createProcess({
        ...config(''),
        census: new PublishedCensus(CensusOrigin.OffchainStatic, 7n, url),
      })
    ).rejects.toThrow('serves a census with root');
    const lenient = setup({ verify: false });
    await lenient.orchestrator.createProcess({
      ...config(''),
      census: new PublishedCensus(CensusOrigin.OffchainStatic, 7n, url),
    });
  });

  it('checks an on-chain census is a davinci-zkvm census contract', async () => {
    const { chain, orchestrator, sent } = setup();
    chain.contract(CONTRACT, ONCHAIN_CENSUS_ABI, {
      getCensusRoot: () => [9n],
      treeSize: () => [3n],
      slotOf: args => [slotFromAddress(args[0] as string)],
    });
    const base = { title: 't', ballot, timing, questions, maxVoters: 3 };
    await orchestrator.createProcess({ ...base, census: new OnchainCensus(CONTRACT) });
    const c = census(sent()[0].args);
    expect([...c]).toEqual([
      3n,
      `0x${'00'.repeat(32)}`,
      getAddress(CONTRACT),
      `onchain://${getAddress(CONTRACT)}`,
      false,
    ]);
    const missing = '0x4444444444444444444444444444444444444444';
    await expect(
      orchestrator.createProcess({ ...base, census: new OnchainCensus(missing) })
    ).rejects.toThrow(`no contract at ${getAddress(missing)}`);
    await expect(
      orchestrator.createProcess({
        ...base,
        census: new OnchainCensus(CONTRACT),
        maxVoters: undefined,
      })
    ).rejects.toThrow('maxVoters is required');
  });
});

describe('ProcessOrchestrationService.updateCensus', () => {
  it('publishes the new version and moves the process to it', async () => {
    const { host, orchestrator, sent } = setup();
    const members = new OffchainDynamicCensus();
    members.add([A, B]);
    await orchestrator.updateCensus(PID, members);
    expect(host.uploads.map(u => u.kind)).toEqual(['census']);
    const [update] = sent();
    expect(update.name).toBe('setProcessCensus');
    expect(update.args[0]).toBe(PID.toLowerCase());
    expect([...(update.args[1] as Result)]).toEqual([
      2n,
      await members.root(),
      ZeroAddress,
      host.urlOf(members.serialize()),
      false,
    ]);
    // A census file served elsewhere, by root and URL.
    const url = 'https://census.example.org/v3.json';
    host.serve(url, { body: members.serialize() });
    await orchestrator.updateCensus(PID, { root: await members.root(), uri: url });
    expect([...(sent()[1].args[1] as Result)][3]).toBe(url);
  });

  it('refuses before any upload a census that cannot change, or is not the organizer’s', async () => {
    const { host, orchestrator, state, chain, wallet } = setup();
    const members = new OffchainDynamicCensus();
    members.add(A);
    state.process = onchainProcess(wallet.address, {
      census: { ...onchainProcess(wallet.address).census, censusOrigin: 1 },
    });
    await expect(orchestrator.updateCensus(PID, members)).rejects.toThrow(CensusNotUpdatable);
    state.process = onchainProcess(wallet.address, { status: ProcessStatus.ENDED });
    await expect(orchestrator.updateCensus(PID, members)).rejects.toThrow(
      'only while it is READY or PAUSED (status ENDED)'
    );
    state.process = onchainProcess(getAddress(B));
    await expect(orchestrator.updateCensus(PID, members)).rejects.toThrow('only the organizer');
    state.process = onchainProcess(wallet.address);
    const fixed = new OffchainCensus();
    fixed.add(A);
    await expect(orchestrator.updateCensus(PID, fixed)).rejects.toThrow(CensusError);
    expect(host.uploads).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('ProcessOrchestrationService.updateMetadata', () => {
  it('publishes a config, a document or bytes, or takes a URL, then sets it', async () => {
    const { host, orchestrator, sent } = setup();
    const config = { title: 'Parks', questions };
    const doc = buildElectionMetadata({ ...config, description: 'v2' });
    const raw = toUtf8Bytes('{"title":{"default":"raw"}}');
    const url = 'https://files.example.org/m3.json';
    host.serve(url, { body: raw });
    await orchestrator.updateMetadata(PID, config);
    await orchestrator.updateMetadata(PID, doc);
    await orchestrator.updateMetadata(PID, raw);
    await orchestrator.updateMetadata(PID, { uri: url });
    await orchestrator.updateMetadata(PID, { uri: url, hash: `0x${'ab'.repeat(32)}` });
    const built = serializeMetadata(buildElectionMetadata(config));
    expect(host.uploads.map(u => u.data)).toEqual([built, serializeMetadata(doc), raw]);
    expect(sent().map(t => [t.name, t.args[1] as unknown, t.args[2] as unknown])).toEqual([
      ['setProcessMetadata', host.urlOf(built), sha256(built)],
      ['setProcessMetadata', host.urlOf(serializeMetadata(doc)), sha256(serializeMetadata(doc))],
      ['setProcessMetadata', host.urlOf(raw), sha256(raw)],
      ['setProcessMetadata', url, sha256(raw)],
      ['setProcessMetadata', url, `0x${'ab'.repeat(32)}`],
    ]);
  });

  it('refuses a closed process before uploading', async () => {
    const { host, orchestrator, state, wallet } = setup();
    state.process = onchainProcess(wallet.address, { status: ProcessStatus.CANCELED });
    await expect(orchestrator.updateMetadata(PID, { title: 't', questions })).rejects.toThrow(
      'READY or PAUSED'
    );
    expect(host.uploads).toHaveLength(0);
  });
});

describe('ProcessOrchestrationService.getProcess', () => {
  const url = 'https://files.example.org/m.json';
  const doc = buildElectionMetadata({
    title: { default: 'Parks', es: 'Parques' },
    description: 'Pick one',
    questions,
    electionPreset: { type: 'multiple_choice', maxSelections: 1 },
  });
  const bytes = serializeMetadata(doc);

  it('reads the metadata only when it hashes to the registry value', async () => {
    const { host, orchestrator, state, wallet } = setup();
    host.serve(url, { body: bytes });
    state.process = onchainProcess(wallet.address, {
      metadataURI: url,
      metadataHash: sha256(bytes),
    });
    const info = await orchestrator.getProcess(PID);
    expect(info).toMatchObject({
      title: 'Parks',
      description: 'Pick one',
      questions: [
        {
          title: 'Which site?',
          description: '',
          choices: [
            { title: 'North', value: 0 },
            { title: 'South', value: 1 },
          ],
        },
      ],
      metadataURI: url,
      metadataHash: sha256(bytes),
      metadataVerified: true,
      metadataStatus: 'verified',
      metadata: doc,
      electionPreset: { type: 'multiple_choice', maxSelections: 1, minSelections: 0 },
      census: { type: CensusOrigin.OffchainDynamic },
    });
    expect(info.metadataError).toBeUndefined();

    state.process = onchainProcess(wallet.address, {
      metadataURI: url,
      metadataHash: `0x${'aa'.repeat(32)}`,
    });
    const mismatch = await orchestrator.getProcess(PID);
    expect(mismatch).toMatchObject({
      title: '',
      questions: [],
      metadataVerified: false,
      metadataStatus: 'mismatch',
    });
    expect(mismatch.metadata).toBeUndefined();
    expect(mismatch.electionPreset).toBeUndefined();
    expect(mismatch.metadataError).toContain('the registry has 0xaaaa');

    state.process = onchainProcess(wallet.address, {
      metadataURI: 'https://files.example.org/gone.json',
    });
    expect(await orchestrator.getProcess(PID)).toMatchObject({
      metadataVerified: false,
      metadataStatus: 'unreachable',
    });
  });

  it('drops choices whose value is not a number from a verified document', async () => {
    const { host, orchestrator, state, wallet } = setup();
    const raw = toUtf8Bytes(
      '{"title":"t","questions":[{"title":"q","choices":[{"title":"a","value":"0"},{"title":"b","value":1}]}]}'
    );
    host.serve(url, { body: raw });
    state.process = onchainProcess(wallet.address, { metadataURI: url, metadataHash: sha256(raw) });
    const info = await orchestrator.getProcess(PID);
    expect(info.metadataStatus).toBe('verified');
    expect(info.questions).toEqual([
      { title: 'q', description: undefined, choices: [{ title: 'b', value: 1 }] },
    ]);
  });

  it('never requests a metadata URI outside the URL policy', async () => {
    const { host, orchestrator, state, wallet } = setup();
    for (const uri of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5:9200/_cluster/health',
      'http://[::1]/m.json',
      'data:application/json,{}',
    ]) {
      host.serve(uri, { body: bytes });
      state.process = onchainProcess(wallet.address, {
        metadataURI: uri,
        metadataHash: sha256(bytes),
      });
      const info = await orchestrator.getProcess(PID);
      expect(info, uri).toMatchObject({
        title: '',
        questions: [],
        metadataVerified: false,
        metadataStatus: 'refused',
      });
      expect(info.metadata).toBeUndefined();
    }
    expect(host.fetches).toHaveLength(0);
  });

  it('gives an on-chain census its contract', async () => {
    const { orchestrator, state, wallet } = setup();
    state.process = onchainProcess(wallet.address, {
      census: {
        censusOrigin: 3,
        censusRoot: `0x${'00'.repeat(31)}09`,
        contractAddress: CONTRACT,
        censusURI: 'onchain://x',
        onchainAllowAnyValidRoot: false,
      },
    });
    expect((await orchestrator.getProcess(PID)).census).toEqual({
      type: CensusOrigin.Onchain,
      root: `0x${'00'.repeat(31)}09`,
      uri: 'onchain://x',
      contractAddress: getAddress(CONTRACT),
    });
  });
});
