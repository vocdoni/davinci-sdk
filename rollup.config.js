import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import { createRequire } from 'module';
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
      axios: 'axios',
      '@vocdoni/davinci-contracts': 'davinciContracts',
      ethers: 'ethers',
      snarkjs: 'snarkjs',
      '@ethereumjs/common': 'ethereumjsCommon',
    },
  },
];

export default [
  // Main bundle
  createBundle(
    {
      plugins: [
        json(),
        commonjs(),
        resolve({ browser: true }),
        nodePolyfills(),
        esbuild({ target: 'esnext' }),
      ],
      output: createOutput('index', { umdName: 'VocdoniSDK' }),
    },
    {
      input: 'src/index.ts',
      includeSnarkjs: true,
    }
  ),

  // Main types bundle
  createBundle(
    {
      plugins: [dts()],
      output: { file: 'dist/index.d.ts', format: 'es' },
    },
    {
      input: 'src/index.ts',
      includeSnarkjs: true,
    }
  ),
];
