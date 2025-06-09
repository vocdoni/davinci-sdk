import { createRequire } from 'module';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import nodePolyfills from 'rollup-plugin-polyfill-node';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const createBundle = (config, options) => ({
  ...config,
  input: options.input,
  external: Object.keys(pkg.dependencies || {}).filter(dep => 
    options.includeSnarkjs ? true : dep !== 'snarkjs'
  ),
});

const createOutput = (name, options) => [
  { file: `dist/${name}.js`, format: 'cjs', sourcemap: true },
  { file: `dist/${name}.mjs`, format: 'es', sourcemap: true },
  {
    name: options.umdName,
    file: `dist/${name}.umd.js`,
    format: 'umd',
    globals: {
      'axios': 'axios',
      '@vocdoni/davinci-contracts': 'davinciContracts',
      'ethers': 'ethers',
      'snarkjs': 'snarkjs',
      '@ethereumjs/common': 'ethereumjsCommon'
    }
  }
];

export default [
  // Core bundle
  createBundle({
    plugins: [
      json(),
      commonjs(),
      resolve(),
      esbuild({ target: 'esnext' })
    ],
    output: createOutput('core', { umdName: 'CoreSDK' })
  }, {
    input: 'src/core/index.ts',
    includeSnarkjs: false
  }),
  
  // Core types
  createBundle({
    plugins: [dts()],
    output: { file: 'dist/core.d.ts', format: 'es' }
  }, {
    input: 'src/core/index.ts',
    includeSnarkjs: false
  }),

  // Contracts bundle
  createBundle({
    plugins: [
      json(),
      commonjs(),
      resolve(),
      esbuild({ target: 'esnext' })
    ],
    output: createOutput('contracts', { umdName: 'ContractsSDK' })
  }, {
    input: 'src/contracts/index.ts',
    includeSnarkjs: true
  }),
  
  // Contracts types
  createBundle({
    plugins: [dts()],
    output: { file: 'dist/contracts.d.ts', format: 'es' }
  }, {
    input: 'src/contracts/index.ts',
    includeSnarkjs: true
  }),
  
  // Sequencer bundle
  createBundle({
    plugins: [
      json(),
      commonjs(),
      resolve({ browser: true }),
      nodePolyfills(),
      esbuild({ target: 'esnext' })
    ],
    output: createOutput('sequencer', { umdName: 'SequencerSDK' })
  }, {
    input: 'src/sequencer/index.ts',
    includeSnarkjs: false
  }),
  
  // Sequencer types
  createBundle({
    plugins: [dts()],
    output: { file: 'dist/sequencer.d.ts', format: 'es' }
  }, {
    input: 'src/sequencer/index.ts',
    includeSnarkjs: false
  })
];
