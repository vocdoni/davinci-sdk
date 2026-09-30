import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256, toUtf8Bytes, toUtf8String } from 'ethers';
import {
  MetadataError,
  buildElectionMetadata,
  fetchMetadataHash,
  getElectionMetadataTemplate,
  localizedText,
  publishMetadata,
  readMetadata,
  serializeMetadata,
  type ElectionMetadata,
  type ElectionMetadataConfig,
  type QuestionConfig,
} from '../../../src/core';
import { metadataHash } from '../../../src/contracts';
import { DocumentHost } from '../../helpers/documentHost';

const DEMO = join(__dirname, '../../fixtures/sequencer/demo');

// The metadata documents davinci-sequencer's demo wrote (e2e/src/demo.rs, render).
function demoDocuments(dir = DEMO): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return demoDocuments(path);
    return /^metadata(-\d+)?\.json$/.test(name) ? [path] : [];
  });
}

interface Doc {
  title: unknown;
  description: unknown;
  questions: {
    title: unknown;
    description: unknown;
    choices: { title: unknown; value: number }[];
  }[];
  meta?: { electionPreset: unknown };
}

// The config an organizer would give for a demo document.
function configOf(doc: Doc): ElectionMetadataConfig {
  return {
    title: doc.title as ElectionMetadataConfig['title'],
    description: doc.description as ElectionMetadataConfig['description'],
    questions: doc.questions.map(
      (q): QuestionConfig => ({
        title: q.title as QuestionConfig['title'],
        description: q.description as QuestionConfig['description'],
        choices: q.choices.map(c => ({
          title: c.title as QuestionConfig['title'],
          value: c.value,
        })),
      })
    ),
    ...(doc.meta && {
      electionPreset: doc.meta.electionPreset as ElectionMetadataConfig['electionPreset'],
    }),
  };
}

const questions: [QuestionConfig] = [
  {
    title: 'Which site?',
    choices: [
      { title: 'North', value: 0 },
      { title: 'South', value: 1 },
    ],
  },
];

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );

describe('metadata documents', () => {
  it('builds the demo documents byte for byte, and their hash is the sha256 of the bytes', () => {
    const files = demoDocuments();
    expect(files).toHaveLength(14);
    for (const file of files) {
      const name = relative(DEMO, file);
      const bytes = new Uint8Array(readFileSync(file));
      const doc = JSON.parse(toUtf8String(bytes)) as Doc;
      expect(serializeMetadata(buildElectionMetadata(configOf(doc))), name).toEqual(bytes);
      expect(serializeMetadata(doc as unknown as ElectionMetadata), name).toEqual(bytes);
      expect(metadataHash(serializeMetadata(buildElectionMetadata(configOf(doc))))).toBe(
        sha256(bytes)
      );
    }
  });

  it('writes plain text as the default language', () => {
    const bytes = readFileSync(join(DEMO, 'wave2/13-dog-park/metadata.json'));
    const doc = buildElectionMetadata({
      title: 'Where should the new dog park go?',
      description:
        'The parks department has three possible sites for a fenced dog park. Pick the one you prefer; the department will build on the site with the most votes.',
      questions: [
        {
          title: 'Which site do you prefer?',
          description: 'Pick one site.',
          choices: [
            { title: 'The north corner of the central park', value: 0 },
            { title: 'Next to the sports ground', value: 1 },
            { title: 'The empty lot on Mill Street', value: 2 },
          ],
        },
      ],
      electionPreset: { type: 'single_choice' },
    });
    expect(serializeMetadata(doc)).toEqual(new Uint8Array(bytes));
  });

  it('puts every key in its place, whatever the order it was given in', () => {
    const doc = buildElectionMetadata({
      title: { es: 'Hola', default: 'Hello', en: 'Hello' },
      questions,
      media: { logo: 'https://img.example/logo.png', header: 'https://img.example/h.png' },
      meta: { source: 'test' },
      electionPreset: { minSelections: 1, maxSelections: 2, type: 'multiple_choice' },
    });
    const shuffled = {
      meta: {
        source: 'test',
        electionPreset: { maxSelections: 2, type: 'multiple_choice', minSelections: 1 },
      },
      questions: [
        {
          choices: [
            { value: 0, title: { default: 'North' } },
            { value: 1, title: { default: 'South' } },
          ],
          description: { default: '' },
          title: { default: 'Which site?' },
        },
      ],
      media: { header: 'https://img.example/h.png', logo: 'https://img.example/logo.png' },
      description: { default: '' },
      title: { es: 'Hola', en: 'Hello', default: 'Hello' },
      version: '1.1',
    } as unknown as ElectionMetadata;
    const text = toUtf8String(serializeMetadata(doc));
    expect(toUtf8String(serializeMetadata(shuffled))).toBe(text);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'version',
      'title',
      'description',
      'media',
      'questions',
      'meta',
    ]);
    expect(text).toContain(
      '"title": {\n    "default": "Hello",\n    "es": "Hola",\n    "en": "Hello"'
    );
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('writes election presets with their defaults, as the demo does', () => {
    const presetOf = (electionPreset: ElectionMetadataConfig['electionPreset']) =>
      JSON.stringify(buildElectionMetadata({ title: 't', questions, electionPreset }).meta);
    expect(presetOf({ type: 'single_choice', allowAbstain: false })).toBe(
      '{"electionPreset":{"type":"single_choice"}}'
    );
    expect(presetOf({ type: 'single_choice', allowAbstain: true })).toBe(
      '{"electionPreset":{"type":"single_choice","allowAbstain":true}}'
    );
    expect(presetOf({ type: 'multiple_choice', maxSelections: 2 })).toBe(
      '{"electionPreset":{"type":"multiple_choice","maxSelections":2,"minSelections":0}}'
    );
    expect(presetOf({ type: 'rating', maxValue: 5 })).toBe(
      '{"electionPreset":{"type":"rating","maxValue":5,"minValue":0}}'
    );
    expect(presetOf({ type: 'quadratic', budget: 100 })).toBe(
      '{"electionPreset":{"type":"quadratic","budget":100,"minValueSum":0}}'
    );
    expect(presetOf({ type: 'ranking' })).toBe('{"electionPreset":{"type":"ranking"}}');
    expect(presetOf(undefined)).toBeUndefined();
  });

  it('refuses a document that is not one', () => {
    const refused: [ElectionMetadataConfig, string][] = [
      [{ title: 't', questions: [] }, 'at least one question'],
      [{ title: 't', questions: [{ title: 'q', choices: [] }] }, 'has no choices'],
      [
        {
          title: 't',
          questions: [
            {
              title: 'q',
              choices: [
                { title: 'a', value: 0 },
                { title: 'b', value: 0 },
              ],
            },
          ],
        },
        'gives value 0 to two choices',
      ],
      [
        { title: 't', questions: [{ title: 'q', choices: [{ title: 'a', value: -1 }] }] },
        'non-negative',
      ],
      [
        { title: 't', questions: [{ title: 'q', choices: [{ title: 'a', value: 0.5 }] }] },
        'non-negative',
      ],
      [{ title: 5 as unknown as string, questions }, 'title is not text'],
      [{ title: { es: 'x' } as unknown as string, questions }, 'title is not text'],
      [
        { title: { default: 'x', es: 3 } as unknown as string, questions },
        'title.es is not a string',
      ],
      [
        {
          title: 't',
          questions,
          electionPreset: { type: 'approval' },
          meta: { electionPreset: { type: 'approval' } },
        },
        'give the election preset once',
      ],
    ];
    for (const [config, msg] of refused) {
      expect(() => buildElectionMetadata(config), msg).toThrow(MetadataError);
      expect(() => buildElectionMetadata(config), msg).toThrow(msg);
    }
    const doc = buildElectionMetadata({ title: 't', questions });
    expect(() =>
      serializeMetadata({ ...doc, meta: { big: 1n } } as unknown as ElectionMetadata)
    ).toThrow('not JSON');
    expect(() =>
      serializeMetadata({ ...doc, questions: 'x' } as unknown as ElectionMetadata)
    ).toThrow('questions is not a list');
  });

  it('keeps the template in the shape the builder writes', () => {
    const template = getElectionMetadataTemplate();
    expect(template.version).toBe('1.1');
    expect(serializeMetadata(template)).toEqual(
      serializeMetadata(
        buildElectionMetadata({
          title: '',
          questions: [
            {
              title: '',
              choices: [
                { title: 'Yes', value: 0 },
                { title: 'No', value: 1 },
              ],
            },
          ],
        })
      )
    );
  });

  it('reads text in a language, else the default', () => {
    const t = { default: 'Hello', es: 'Hola' };
    expect(localizedText(t)).toBe('Hello');
    expect(localizedText(t, 'es')).toBe('Hola');
    expect(localizedText(t, 'ca')).toBe('Hello');
    expect(localizedText('plain', 'es')).toBe('plain');
    expect(localizedText({ es: 'x' })).toBeUndefined();
    expect(localizedText(undefined)).toBeUndefined();
  });
});

describe('publishMetadata', () => {
  it('uploads the exact bytes and checks the URL serves them', async () => {
    const host = new DocumentHost();
    const doc = buildElectionMetadata({ title: 'Budget', questions });
    const bytes = serializeMetadata(doc);
    const out = await publishMetadata(doc, host.uploader, { fetchImpl: host.fetchImpl });
    expect(out).toEqual({ uri: host.urlOf(bytes), hash: sha256(bytes) });
    expect(host.uploads).toEqual([
      { kind: 'metadata', data: bytes, contentType: 'application/json', sha256: sha256(bytes) },
    ]);
    expect(host.fetches.map(f => f.url)).toEqual([out.uri]);
    expect(host.fetches[0].init?.redirect).toBe('manual');

    // Bytes and text are published as given.
    const raw = toUtf8Bytes('{"title":{"default":"x"}}');
    expect((await publishMetadata(raw, host.uploader, { fetchImpl: host.fetchImpl })).hash).toBe(
      sha256(raw)
    );
    expect(
      (await publishMetadata('{"title":{"default":"x"}}', host.uploader, { verify: false })).hash
    ).toBe(sha256(raw));
  });

  it('refuses a URL that serves other bytes, a failed upload and no URL', async () => {
    const host = new DocumentHost();
    const doc = buildElectionMetadata({ title: 'Budget', questions });
    host.serve(host.urlOf(serializeMetadata(doc)), { body: '{}' });
    const err = await errorOf(publishMetadata(doc, host.uploader, { fetchImpl: host.fetchImpl }));
    expect(err).toBeInstanceOf(MetadataError);
    expect(err?.message).toContain(`serves bytes that hash to ${sha256(toUtf8Bytes('{}'))}`);
    host.failUpload = new Error('denied');
    await expect(publishMetadata(doc, host.uploader)).rejects.toThrow(
      'the metadata upload failed: denied'
    );
    await expect(publishMetadata(doc, { upload: () => Promise.resolve('') })).rejects.toThrow(
      'no URL'
    );
    const gone = new DocumentHost();
    gone.serve(gone.urlOf(serializeMetadata(doc)), { status: 500 });
    await expect(
      publishMetadata(doc, gone.uploader, { fetchImpl: gone.fetchImpl })
    ).rejects.toThrow('HTTP 500');
    await expect(
      publishMetadata(new Uint8Array(4 * 1024 * 1024 + 1), host.uploader)
    ).rejects.toThrow('over 4194304 bytes');
  });
});

describe('readMetadata', () => {
  const url = 'https://files.example.org/m.json';
  const doc = buildElectionMetadata({ title: { default: 'Budget', es: 'Presupuesto' }, questions });
  const bytes = serializeMetadata(doc);

  it('verifies the bytes served against the registry hash, then parses them', async () => {
    const host = new DocumentHost();
    host.serve(url, { body: bytes });
    expect(
      await readMetadata(url, sha256(bytes).toUpperCase().replace('0X', '0x'), {
        fetchImpl: host.fetchImpl,
      })
    ).toEqual({ status: 'verified', hash: sha256(bytes), document: doc });
    // A byte-order mark is covered by the hash and dropped before parsing.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    host.serve(url, { body: bom });
    expect(await readMetadata(url, sha256(bom), { fetchImpl: host.fetchImpl })).toEqual({
      status: 'verified',
      hash: sha256(bom),
      document: doc,
    });
    expect(await fetchMetadataHash(url, { fetchImpl: host.fetchImpl })).toBe(sha256(bom));
  });

  it('tells a mismatch, an unreachable document and verified bytes that are not JSON apart', async () => {
    const host = new DocumentHost();
    host.serve(url, { body: bytes });
    const other = `0x${'aa'.repeat(32)}`;
    expect(await readMetadata(url, other, { fetchImpl: host.fetchImpl })).toEqual({
      status: 'mismatch',
      hash: sha256(bytes),
      error: `${url} serves bytes that hash to ${sha256(bytes)}; the registry has ${other}`,
    });
    const missing = await readMetadata('https://files.example.org/none.json', other, {
      fetchImpl: host.fetchImpl,
    });
    expect(missing.status).toBe('unreachable');
    expect(missing.error).toContain('HTTP 404');
    const refused = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect((await readMetadata(url, other, { fetchImpl: refused })).status).toBe('unreachable');
    expect((await readMetadata('ipfs://x', other, { fetchImpl: host.fetchImpl })).status).toBe(
      'refused'
    );
    host.serve(url, { body: 'not json' });
    const garbage = await readMetadata(url, sha256(toUtf8Bytes('not json')), {
      fetchImpl: host.fetchImpl,
    });
    expect(garbage.status).toBe('verified');
    expect(garbage.document).toBeUndefined();
    expect(garbage.error).toContain('not UTF-8 JSON');
    await expect(
      fetchMetadataHash('https://files.example.org/none.json', { fetchImpl: host.fetchImpl })
    ).rejects.toThrow(MetadataError);
  });
});

describe('metadata URL policy', () => {
  const doc = serializeMetadata(buildElectionMetadata({ title: 'Parks', questions }));
  const hash = sha256(doc);
  // A host that would serve the right document at any URL: a refused URL
  // must not depend on what is behind it.
  const everywhere = () => {
    const urls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(new Response(doc));
    }) as typeof fetch;
    return { urls, fetchImpl };
  };
  const refused = [
    'http://10.0.0.5:9200/_cluster/health',
    'http://172.16.3.4/m.json',
    'http://192.168.1.1/m.json',
    'http://127.0.0.1:8545/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/m.json',
    'http://localhost:8080/m.json',
    'http://metadata.localhost/m.json',
    'http://[::1]/m.json',
    'http://[fd00::1]/m.json',
    'http://[fe80::1]/m.json',
    'http://[::ffff:10.0.0.1]/m.json',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'data:application/json,{}',
    'file:///etc/passwd',
    'ftp://files.example.org/m.json',
    'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    'not a url',
  ];

  it('refuses private hosts and other schemes without a request', async () => {
    const { urls, fetchImpl } = everywhere();
    for (const url of refused) {
      const read = await readMetadata(url, hash, { fetchImpl });
      expect(read.status, url).toBe('refused');
      expect(read.hash).toBeUndefined();
      expect(read.document).toBeUndefined();
      expect(read.error).toMatch(/^not read: /);
      const err = await errorOf(fetchMetadataHash(url, { fetchImpl }));
      expect(err, url).toBeInstanceOf(MetadataError);
      expect(err?.message).toContain(`refused the metadata at ${url}`);
    }
    expect(urls).toEqual([]);
  });

  it('reads private hosts only with allowPrivateHosts, and never other schemes', async () => {
    const { urls, fetchImpl } = everywhere();
    const local = 'http://localhost:8080/m.json';
    const opts = { fetchImpl, allowPrivateHosts: true };
    expect((await readMetadata(local, hash, opts)).status).toBe('verified');
    expect((await readMetadata('http://[::1]/m.json', hash, opts)).status).toBe('verified');
    for (const url of ['data:application/json,{}', 'file:///etc/passwd']) {
      expect((await readMetadata(url, hash, opts)).status, url).toBe('refused');
    }
    expect(urls).toEqual([local, 'http://[::1]/m.json']);
  });

  it('follows no redirect, to another host or its own', async () => {
    const host = new DocumentHost();
    const moved = 'https://files.example.org/moved.json';
    const same = 'https://files.example.org/same.json';
    host.serve(moved, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
    host.serve(same, { status: 301, headers: { location: '/m.json' } });
    host.serve('https://files.example.org/m.json', { body: doc });
    for (const url of [moved, same]) {
      const read = await readMetadata(url, hash, { fetchImpl: host.fetchImpl });
      expect(read.status, url).toBe('unreachable');
      expect(read.error).toContain('redirects are refused');
      await expect(fetchMetadataHash(url, { fetchImpl: host.fetchImpl })).rejects.toThrow(
        `cannot read the metadata at ${url}`
      );
    }
    expect(host.fetches.map(f => [f.url, f.init?.redirect])).toEqual([
      [moved, 'manual'],
      [moved, 'manual'],
      [same, 'manual'],
      [same, 'manual'],
    ]);
  });

  it('refuses to publish at a URL readers would refuse, even unverified', async () => {
    for (const base of ['http://127.0.0.1:8080', 'http://[fd00::1]']) {
      const host = new DocumentHost(base);
      const err = await errorOf(
        publishMetadata(doc, host.uploader, { fetchImpl: host.fetchImpl, verify: false })
      );
      expect(err).toBeInstanceOf(MetadataError);
      expect(err?.message).toContain('is not a public host');
      expect(host.fetches).toHaveLength(0);
      const ok = await publishMetadata(doc, host.uploader, {
        fetchImpl: host.fetchImpl,
        allowPrivateHosts: true,
      });
      expect(ok.hash).toBe(hash);
    }
    const ipfs = { upload: () => Promise.resolve('ipfs://bafy') };
    await expect(publishMetadata(doc, ipfs, { verify: false })).rejects.toThrow(
      'only http(s) URLs are read, not ipfs:'
    );
  });
});
