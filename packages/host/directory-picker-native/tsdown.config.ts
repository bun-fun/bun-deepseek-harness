import { defineConfig } from 'tsdown'

/**
 * Node-only backend. The Win32 dialog worker builds as its own CJS entry
 * (mirroring dsh-workflow-worker-thread's worker): path-loaded by the driver,
 * inlining the dialog logic while `bun:ffi` stays an external built-in that
 * only the Bun runtime resolves.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['bun:ffi'] },
  },
  {
    // The artifact is lib/worker.cjs (the ./worker export the workspace
    // constraint keys on), bundled from the descriptive source entry.
    entry: { worker: 'lib/types/win32-dialog-worker.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['bun:ffi'] },
  },
])
