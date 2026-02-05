import { createRequire } from 'module';
import commonjs from '@rollup/plugin-commonjs';
import inject from '@rollup/plugin-inject';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import nodePolyfills from 'rollup-plugin-polyfill-node';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

/**
 * We must NOT mark circomlibjs/blake-hash as external, otherwise the SDK build cannot patch them.
 * Buffer must be bundled too, so injected imports work without UI config.
 */
const FORCE_BUNDLE_DEPS = new Set(['buffer', 'circomlibjs', 'blake-hash']);

const createBundle = (config, options) => ({
  ...config,
  input: options.input,
  external: Object.keys(pkg.dependencies || {}).filter(dep => {
    if (FORCE_BUNDLE_DEPS.has(dep)) return false;
    return options.includeSnarkjs ? true : dep !== 'snarkjs';
  }),
});

const createOutput = (name, options) => [
  { file: `dist/${name}.js`, format: 'cjs', sourcemap: true },
  { file: `dist/${name}.mjs`, format: 'es', sourcemap: true },
  {
    name: options.umdName,
    file: `dist/${name}.umd.js`,
    format: 'umd',
    globals: {
      axios: 'axios',
      '@vocdoni/davinci-contracts': 'davinciContracts',
      ethers: 'ethers',
      snarkjs: 'snarkjs',
      '@ethereumjs/common': 'ethereumjsCommon'
      // NOTE: circomlibjs/blake-hash/buffer are now bundled, so no globals needed for them.
    }
  }
];

export default [
  // Main bundle
  createBundle(
    {
      plugins: [
        json(),
        commonjs(),
        resolve({ browser: true, preferBuiltins: false }),
        nodePolyfills(),

        // 1) Transpile TS->JS first so inject can parse reliably
        esbuild({ target: 'esnext' }),

        // 2) Inject a lexical Buffer import wherever Buffer is referenced.
        //    This fixes blake-hash even if globalThis.Buffer is missing.
        inject({
          Buffer: ['buffer', 'Buffer']
        })
      ],
      output: createOutput('index', { umdName: 'VocdoniSDK' })
    },
    {
      input: 'src/index.ts',
      includeSnarkjs: true
    }
  ),

  // Main types bundle
  createBundle(
    {
      plugins: [dts()],
      output: { file: 'dist/index.d.ts', format: 'es' }
    },
    {
      input: 'src/index.ts',
      includeSnarkjs: true
    }
  ),

  // Contracts types bundle
  createBundle(
    {
      plugins: [dts()],
      output: { file: 'dist/contracts.d.ts', format: 'es' }
    },
    {
      input: 'src/contracts/index.ts',
      includeSnarkjs: true
    }
  ),

  // Sequencer types bundle
  createBundle(
    {
      plugins: [dts()],
      output: { file: 'dist/sequencer.d.ts', format: 'es' }
    },
    {
      input: 'src/sequencer/index.ts',
      includeSnarkjs: true
    }
  )
];
