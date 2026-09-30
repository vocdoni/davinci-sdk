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

/**
 * ffjavascript's browser build (bundled through circomlibjs) inlines the
 * `web-worker` shim as `var browser = Worker;`, which reads the global when
 * the bundle loads, so the bundle throws on import in Node, which has no
 * global Worker. circomlibjs only builds single-threaded curves and never
 * starts a worker: read the global when a worker is created instead.
 */
const WORKER_SHIM = 'var browser = Worker;';
const lazyWebWorker = {
  name: 'lazy-web-worker',
  transform(code, id) {
    if (!/[\\/]ffjavascript[\\/]build[\\/]browser\.esm\.js$/.test(id)) return null;
    if (code.split(WORKER_SHIM).length !== 2) {
      this.error(`${id}: expected one "${WORKER_SHIM}" to patch`);
    }
    return {
      code: code.replace(
        WORKER_SHIM,
        'var browser = function Worker(url, options) { return new globalThis.Worker(url, options); };'
      ),
      map: null,
    };
  },
};

const createBundle = (config, options) => ({
  ...config,
  input: options.input,
  external: Object.keys(pkg.dependencies || {}).filter(dep => {
    if (FORCE_BUNDLE_DEPS.has(dep)) return false;
    return options.includeSnarkjs ? true : dep !== 'snarkjs';
  }),
  onwarn(warning, warn) {
    // Suppress circular dependency warnings from stream polyfills
    // These are expected and harmless in Node.js stream implementations
    if (
      warning.code === 'CIRCULAR_DEPENDENCY' &&
      (warning.message.includes('_stream_') ||
       warning.message.includes('readable-stream'))
    ) {
      return;
    }
    // Show all other warnings
    warn(warning);
  }
});

// The package is `"type": "module"`, so the CommonJS build must be `.cjs`:
// Node would load a `.js` file as ESM and `require()` would see no exports.
const createOutput = (name, options) => [
  { file: `dist/${name}.cjs`, format: 'cjs', sourcemap: true },
  { file: `dist/${name}.mjs`, format: 'es', sourcemap: true },
  {
    name: options.umdName,
    file: `dist/${name}.umd.js`,
    format: 'umd',
    globals: {
      ethers: 'ethers',
      snarkjs: 'snarkjs',
      // NOTE: circomlibjs/blake-hash/buffer are now bundled, so no globals needed for them.
    }
  }
];

export default [
  // Main bundle
  createBundle(
    {
      plugins: [
        lazyWebWorker,
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

  // Main types bundle, once for `import` and once for `require` (`.d.cts`)
  createBundle(
    {
      plugins: [dts()],
      output: [
        { file: 'dist/index.d.ts', format: 'es' },
        { file: 'dist/index.d.cts', format: 'es' }
      ]
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
