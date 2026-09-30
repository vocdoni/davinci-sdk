import { ZeroHash, sha256, toUtf8Bytes } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { ProcessMetadataError } from '../../src/contracts/errors';
import { parseRegistryLogs } from '../../src/contracts/ProcessRegistryService';
import { buildElectionMetadata, MetadataError, serializeMetadata } from '../../src/core/metadata';
import type { QuestionConfig } from '../../src/core/types/metadata';
import {
  acrossTheEnd,
  addresses,
  connect,
  election,
  startNode,
  streamError,
  type MockNode,
} from './harness';

const ACCOUNT = 5;
const STRANGER = 18;

const QUESTIONS: [QuestionConfig] = [
  {
    title: { default: 'Which day?', ca: 'Quin dia?' },
    choices: [
      { title: 'Friday', value: 0 },
      { title: 'Saturday', value: 1 },
    ],
  },
];

describe('metadata', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let census: OffchainCensus;

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
    census = new OffchainCensus();
    census.add(addresses(2));
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('publishes the document and commits to its hash in the creation', async () => {
    const { processId, transactionHash } = await sdk.createProcess(
      election(census, { title: { default: 'Picnic', ca: 'Berenar' }, questions: QUESTIONS })
    );
    const upload = node.uploads.filter(u => u.kind === 'metadata').at(-1);
    const receipt = await sdk.provider.getTransactionReceipt(transactionHash);
    const events = parseRegistryLogs(receipt?.logs ?? [], sdk.network.processRegistry);
    expect(events.map(e => e.name)).toEqual(['ProcessCreated', 'ProcessMetadataUpdated']);
    expect(events[1]).toMatchObject({
      processId,
      metadataUri: `${node.url}/files/${upload?.sha256.slice(2)}.json`,
      metadataHash: upload?.sha256,
    });

    const p = await sdk.getProcess(processId);
    expect(p).toMatchObject({
      metadataVerified: true,
      metadataStatus: 'verified',
      title: 'Picnic',
      metadataHash: upload?.sha256,
    });
    expect(p.metadata?.title).toEqual({ default: 'Picnic', ca: 'Berenar' });
    expect(p.questions[0]).toMatchObject({ title: 'Which day?' });
  });

  it('moves a process to a new document, published or already served', async () => {
    const { processId } = await sdk.createProcess(election(census));

    // A config is built and published.
    await sdk.updateMetadata(processId, { title: 'Corrected', questions: QUESTIONS });
    expect(await sdk.getProcess(processId)).toMatchObject({
      title: 'Corrected',
      metadataVerified: true,
    });

    // Exact bytes are published as given.
    const bytes = toUtf8Bytes('{"title":"Bytes","questions":[]}');
    await sdk.updateMetadata(processId, bytes);
    const raw = await sdk.registry.getProcess(processId);
    expect(raw.metadataHash).toBe(sha256(bytes));
    expect((await sdk.getProcess(processId)).title).toBe('Bytes');

    // A document served elsewhere, hashed from its URL.
    const doc = buildElectionMetadata({ title: 'Served', questions: QUESTIONS });
    const url = node.serve('/docs/served.json', serializeMetadata(doc));
    await sdk.updateMetadata(processId, { uri: url });
    expect(await sdk.registry.getProcess(processId)).toMatchObject({
      metadataUri: url,
      metadataHash: sha256(serializeMetadata(doc)),
    });
    const events = await sdk.registry.queryEvents({
      processId,
      fromBlock: Number(raw.creationBlock),
    });
    expect(events.filter(e => e.name === 'ProcessMetadataUpdated')).toHaveLength(4);
  });

  it('reads a document that does not match its hash as a mismatch', async () => {
    const doc = serializeMetadata(
      buildElectionMetadata({ title: 'Original', questions: QUESTIONS })
    );
    const url = node.serve('/docs/changing.json', doc);
    const { processId } = await sdk.createProcess({
      census,
      ballot: {
        numFields: 2,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      },
      timing: { duration: 3600 },
      metadataUri: url,
    });
    expect(await sdk.getProcess(processId)).toMatchObject({
      metadataVerified: true,
      title: 'Original',
    });

    node.serve(
      '/docs/changing.json',
      serializeMetadata(buildElectionMetadata({ title: 'Swapped', questions: QUESTIONS }))
    );
    const p = await sdk.getProcess(processId);
    expect(p).toMatchObject({ metadataVerified: false, metadataStatus: 'mismatch', title: '' });
    expect(p.questions).toEqual([]);
    expect(p.metadataError).toMatch(/hash to/);

    // A hash given with the URL is recorded as it is.
    await sdk.updateMetadata(processId, { uri: url, hash: sha256(doc) });
    expect((await sdk.getProcess(processId)).metadataStatus).toBe('mismatch');

    await sdk.updateMetadata(processId, { uri: `${node.url}/docs/gone.json`, hash: sha256(doc) });
    expect((await sdk.getProcess(processId)).metadataStatus).toBe('unreachable');
  });

  it('never downloads from a private host unless allowed', async () => {
    const { processId } = await sdk.createProcess(election(census));
    const reader = await connect(ACCOUNT, node, { config: { documents: {} } });
    const p = await reader.getProcess(processId);
    expect(p).toMatchObject({ metadataStatus: 'refused', metadataVerified: false });
  });

  it('refuses a metadata change the registry would', async () => {
    const { processId } = await sdk.createProcess(election(census));
    const empty = await streamError(sdk.updateMetadataStream(processId, { uri: '' }));
    expect(empty).toBeInstanceOf(ProcessMetadataError);
    expect(empty).toMatchObject({ revertName: 'InvalidMetadata' });
    await expect(
      sdk.updateMetadata(processId, { uri: `${node.url}/nothing.json` })
    ).rejects.toBeInstanceOf(MetadataError);
    for (const [uri, hash] of [
      ['https://files.example.org/m.json', ZeroHash],
      ['', sha256('0x01')],
    ]) {
      const err = await streamError(sdk.processes.setProcessMetadata(processId, uri, hash));
      expect(err).toMatchObject({ name: 'ProcessMetadataError', revertName: 'InvalidMetadata' });
    }
    const stranger = await connect(STRANGER, node);
    expect(
      await streamError(
        stranger.updateMetadataStream(processId, {
          uri: 'https://x.example.org/m.json',
          hash: sha256('0x01'),
        })
      )
    ).toMatchObject({ revertName: 'Unauthorized' });

    const end = await sdk.registry.getProcessEndTime(processId);
    const uri = 'https://files.example.org/final.json';
    const hash = sha256('0x02');
    await acrossTheEnd(
      end,
      () => sdk.updateMetadataStream(processId, { uri, hash }),
      () => sdk.processes.setProcessMetadata(processId, uri, hash)
    );
  });
});
