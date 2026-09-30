# `references/metadata.md` — The metadata document and its hash

Companion to the [[davinci-sdk]] skill. The title, description, questions and choices of an election live in a JSON **metadata document** served at a URL. The registry stores the URL and the SHA-256 of the exact bytes served there (`metadataHash`), so a reader can tell the document the organizer committed from any other.

## The document

```json
{
  "version": "1.1",
  "title": { "default": "Budget", "es": "Presupuesto" },
  "description": { "default": "" },
  "questions": [
    {
      "title": { "default": "Which project?" },
      "description": { "default": "" },
      "choices": [
        { "title": { "default": "Park" }, "value": 0 },
        { "title": { "default": "Library" }, "value": 1 }
      ]
    }
  ],
  "meta": { "electionPreset": { "type": "single_choice" } }
}
```

- A choice's `value` is the ballot field it fills: `choices[i]` of a vote is the value for the choice whose `value` is `i`.
- Text is plain (`{ "default": … }`) or multi-language, `default` first.
- `meta.electionPreset` records the preset the process was created with; `getProcess` reads it back as `electionPreset`, and results use it to name the ballot kind.
- `media` (`header`, `logo`) is optional.

## Creating a process with metadata

With `title` and `questions` in the config, `createProcess` builds the document, publishes it through the `uploader`, downloads it back, checks its hash, and registers the URL and hash:

```ts
const { processId } = await sdk.createProcess({
  title: { default: 'Budget', es: 'Presupuesto' },
  questions: [
    {
      title: 'Which project?',
      choices: [
        { title: 'Park', value: 0 },
        { title: 'Library', value: 1 },
      ],
    },
  ],
  electionPreset: { type: 'single_choice' },
  census,
  timing: { duration: 3600 },
});
```

A document you serve yourself goes in as `metadataUri`; its hash is downloaded and computed when `metadataHash` is omitted:

```ts
await sdk.createProcess({
  metadataUri: 'https://files.example.org/budget.json',
  metadataHash: '0x5c2f…', // sha256 of the exact bytes served; optional
  ballot: {
    numFields: 2,
    minValue: '0',
    maxValue: '1',
    uniqueValues: false,
    costExponent: 1,
    minValueSum: '1',
    maxValueSum: '1',
  },
  census,
  timing: { duration: 3600 },
});
```

A preset needs the `questions` form; with `metadataUri` give a raw `ballot`.

## The exact bytes

The hash covers bytes, not JSON: any other formatting of the same content hashes differently. The SDK writes one form: UTF-8, two-space indentation, keys in a fixed order and a final newline (what davinci-sequencer's demo writes).

```ts
import { buildElectionMetadata, metadataHash, publishMetadata, serializeMetadata } from '@vocdoni/davinci-sdk';

const doc = buildElectionMetadata({
  title: 'Budget',
  questions: [{ title: 'Which project?', choices: [{ title: 'Park', value: 0 }] }],
});
const bytes = serializeMetadata(doc);
const hash = metadataHash(bytes); // what the registry stores
const { uri } = await publishMetadata(doc, uploader); // { uri, hash }, read back and checked
```

Serve exactly those bytes: a host that reformats JSON or re-encodes text breaks the hash. Numbers in free-form `meta` should be integers or strings: `1.0` is written `1`.

## Reading and verifying

`getProcess` downloads the document and hashes what it got:

```ts
const info = await sdk.getProcess(processId);
switch (info.metadataStatus) {
  case 'verified': // the bytes hash to metadataHash: title, questions and preset are filled in
    console.log(info.title, info.questions);
    break;
  case 'mismatch': // the URL serves another document: its content is not shown
  case 'unreachable': // no answer, an error status or a redirect
  case 'refused': // not an http(s) URL on a public host: never requested
    console.warn(info.metadataError);
}
```

The SDK never shows unverified content: on anything but `verified`, `title` and `questions` are empty. Downloads follow the same policy as census files: `http(s)` on a public host (`documents.allowPrivateHosts` for local development), no redirect, at most 4 MiB. `readMetadata(uri, expectedHash)` does the same read on its own and never throws.

## Updating

```ts
// A new document, built and published through the uploader:
await sdk.updateMetadata(processId, {
  title: 'Budget 2027',
  description: 'Corrected: the vote closes on Friday.',
  questions,
});
// Or a document already served (hashed from the URL when `hash` is omitted):
await sdk.updateMetadata(processId, { uri: 'https://files.example.org/budget-2.json' });
```

It takes a config, an `ElectionMetadata`, exact bytes (`Uint8Array`) or `{ uri, hash? }`. Only the organizer, while the process is READY or PAUSED and before its end; readers see the new version and the registry emits `ProcessMetadataUpdated`.

## Cross-references

- `references/process.md`: the config forms.
- `references/results.md`: how the verified metadata titles the results.
- `references/setup.md`: the uploader and `documents`.
