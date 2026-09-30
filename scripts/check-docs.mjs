#!/usr/bin/env node
// Type-checks the code in the documentation against the SDK source:
//
// - every ```ts / ```typescript block of README.md, SECURITY.md, docs/**/*.md
//   and the CHANGELOG entry of this major version (older entries show older
//   APIs), compiled as its own module;
// - docs/ai/recipes/*.ts and examples/script/src/*.ts, as they are.
//
// `@vocdoni/davinci-sdk` resolves to src/index.ts. A block without an import
// of the SDK (or of ethers) gets one for the names it uses, and may use the
// free variables declared below (`sdk`, `processId`, ...); a name it declares
// itself shadows them. A block whose info string holds `nocheck` (```ts nocheck)
// is skipped: use it only for shapes that are not code.
//
// Usage: node scripts/check-docs.mjs

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'node_modules', '.cache', 'davinci-docs');

const DOCS = ['README.md', 'SECURITY.md', 'CHANGELOG.md', ...markdownUnder('docs')];
// Where a file's checked part ends.
const UNTIL = { 'CHANGELOG.md': /^## \[1\./ };
// The SDK's own module declarations (snarkjs, circomlibjs); src/index.d.ts is a copy of index.ts.
const AMBIENT = filesUnder('src', '.d.ts')
  .filter(f => f !== join('src', 'index.d.ts'))
  .map(f => join(root, f));
const CODE = [...filesUnder('docs/ai/recipes', '.ts'), ...filesUnder('examples/script/src', '.ts')];

// Free variables a block may use without declaring them.
const GLOBALS = `import type {
  DavinciSDK,
  OffchainCensus,
  ProcessConfig,
  ProcessRegistryService,
  QuestionConfig,
  Uploader,
} from '@vocdoni/davinci-sdk';
import type { Provider, Signer, Wallet } from 'ethers';

declare global {
  const sdk: DavinciSDK;
  const organizer: DavinciSDK;
  const voter: DavinciSDK;
  const registry: ProcessRegistryService;
  const reader: ProcessRegistryService;
  const writer: ProcessRegistryService;
  const processId: string;
  const voteId: string;
  const signer: Signer;
  const wallet: Wallet;
  const provider: Provider;
  const config: ProcessConfig;
  const census: OffchainCensus;
  const questions: [QuestionConfig, ...QuestionConfig[]];
  const address: string;
  const voterAddress: string;
  const uploader: Uploader;
  const organizerSecret: bigint;
  const rpcUrl: string;
  const nodeUrls: string[];
  const bucket: {
    put(key: string, data: Uint8Array, options: { contentType: string }): Promise<void>;
  };
}

export {};
`;

// ethers names a block may use without importing them.
const ETHERS = ['Wallet', 'JsonRpcProvider', 'BrowserProvider', 'getAddress', 'ZeroAddress'];

function filesUnder(dir, ext) {
  const out = [];
  const walk = d => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function markdownUnder(dir) {
  return filesUnder(dir, '.md');
}

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  types: ['node'],
  typeRoots: [join(root, 'node_modules', '@types')],
  baseUrl: root,
  paths: { '@vocdoni/davinci-sdk': ['src/index.ts'] },
};

// The names the package exports.
function sdkExports() {
  const program = ts.createProgram([...AMBIENT, join(root, 'src/index.ts')], compilerOptions);
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(join(root, 'src/index.ts')));
  return checker.getExportsOfModule(mod).map(s => s.name);
}

// ```ts blocks of a markdown file, with the line each starts on.
function blocks(file) {
  const all = readFileSync(join(root, file), 'utf8').split('\n');
  const end = UNTIL[file] ? all.findIndex(l => UNTIL[file].test(l)) : -1;
  const lines = end < 0 ? all : all.slice(0, end);
  const found = [];
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^(\s*)```(.*)$/.exec(line);
    if (!fence) {
      if (open) open.body.push(line.slice(open.indent));
      return;
    }
    if (open) {
      if (open.check) found.push({ file, line: open.line, code: open.body.join('\n') });
      open = null;
      return;
    }
    const info = fence[2].trim().split(/\s+/);
    open = {
      indent: fence[1].length,
      line: i + 2,
      body: [],
      check: ['ts', 'typescript'].includes(info[0]) && !info.includes('nocheck'),
    };
  });
  if (open) throw new Error(`${file}:${open.line - 1}: unterminated code block`);
  return found;
}

const declared = (code, name) =>
  new RegExp(`\\b(const|let|var|function|class|interface|type|enum)\\s+${name}\\b`).test(code) ||
  new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(code);

// The imports a block needs: the SDK and ethers names it uses but does not import.
function prelude(code, sdkNames) {
  const lines = [];
  const used = names =>
    names.filter(n => new RegExp(`\\b${n}\\b`).test(code) && !declared(code, n));
  if (!/from ['"]@vocdoni\/davinci-sdk['"]/.test(code)) {
    const names = used(sdkNames);
    if (names.length) lines.push(`import { ${names.join(', ')} } from '@vocdoni/davinci-sdk';`);
  }
  if (!/from ['"]ethers['"]/.test(code)) {
    const names = used(ETHERS);
    if (names.length) lines.push(`import { ${names.join(', ')} } from 'ethers';`);
  }
  return lines;
}

function check(files, where) {
  const program = ts.createProgram([...AMBIENT, ...files], compilerOptions);
  return ts.getPreEmitDiagnostics(program).map(d => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (!d.file) return `TS${d.code}: ${text}`;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    return `${where(d.file.fileName, line)}: TS${d.code}: ${text}`;
  });
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'globals.d.ts'), GLOBALS);

const sdkNames = sdkExports();
const snippets = new Map();
for (const file of DOCS) {
  for (const b of blocks(file)) {
    const head = prelude(b.code, sdkNames);
    const name = join(work, `${file.replace(/[/.]/g, '_')}_${b.line}.ts`);
    writeFileSync(name, [...head, b.code, 'export {};', ''].join('\n'));
    snippets.set(name, { ...b, offset: head.length });
  }
}

const errors = [
  ...check([join(work, 'globals.d.ts'), ...snippets.keys()], (fileName, line) => {
    const s = snippets.get(fileName);
    return s ? `${s.file}:${s.line + line - s.offset}` : relative(root, fileName);
  }),
  ...check(
    CODE.map(f => join(root, f)),
    (fileName, line) => `${relative(root, fileName)}:${line + 1}`
  ),
];

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} errors in the documentation code`);
  process.exit(1);
}
console.log(`${snippets.size} documentation blocks and ${CODE.length} files type-check`);
