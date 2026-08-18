/**
 * Real-process half of the Win32 dialog driver: spawn the dialog child
 * process (source or built plane) and close a dialog thread's windows. The
 * module itself loads everywhere (the import chain from native-picker.ts is
 * static); what stays win32-only is koffi, imported dynamically inside the
 * bindings' functions. A Bun host cannot run the worker itself — Bun's NAPI
 * panics when koffi's addon initializes instead of reporting the failure —
 * so the spawner resolves a real Node.js binary (the `DSH_WIN32_DIALOG_NODE`
 * override or the first non-Bun `node` on `PATH`) and fails loud when none
 * exists. The driver's logic is tested against fakes of this surface instead.
 */

import { execFileSync, spawn, type StdioOptions } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/** Env override naming the real Node.js binary the dialog worker must run under. */
export const DIALOG_NODE_BIN_ENV = 'DSH_WIN32_DIALOG_NODE'

/** Injectable resolution facts for deterministic tests; defaults reflect the live host. */
export interface DialogNodeInternals {
  /** Whether the host runs under Bun; defaults to `process.versions.bun !== undefined`. */
  hostIsBun?: boolean
  /** Process environment supplying the override and `PATH`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Probe a candidate binary for real-Node status; defaults to {@link probeIsRealNode}. */
  isRealNode?: (candidate: string) => boolean
}

/**
 * Find the Node.js binary the koffi-backed dialog worker runs under. Bun's
 * NAPI panics when koffi's addon initializes (`napi_reference_unref`) instead
 * of reporting a load failure, so a Bun host must hand the worker to real
 * Node rather than re-spawn Bun. A real-Node host keeps its own binary; a
 * Bun host honors the `DSH_WIN32_DIALOG_NODE` override, then scans `PATH`
 * for a binary that is not Bun.
 * @param internals - resolution facts for deterministic tests.
 * @returns an absolute binary path that runs the worker under real Node.
 * @throws {Error} on a Bun host with no usable real Node binary.
 */
export function resolveDialogNode(internals: DialogNodeInternals = {}): string {
  const env = internals.env ?? process.env
  if (!(internals.hostIsBun ?? process.versions.bun !== undefined)) return process.execPath

  const isRealNode = internals.isRealNode ?? probeIsRealNode
  const explicit = env[DIALOG_NODE_BIN_ENV]
  if (explicit !== undefined && explicit !== '') {
    if (!isRealNode(explicit)) {
      throw new Error(`${DIALOG_NODE_BIN_ENV}=${explicit} is not real Node.js; Bun cannot load koffi`)
    }
    return explicit
  }
  for (const candidate of pathNodeCandidates(env.PATH ?? '')) {
    if (isRealNode(candidate)) return candidate
  }
  throw new Error(`no real Node.js binary found for the Win32 folder dialog (Bun cannot load koffi); install Node.js or set ${DIALOG_NODE_BIN_ENV}`)
}

/** Absolute `PATH` locations of the platform's node binary, in scan order. */
function pathNodeCandidates(pathValue: string): string[] {
  const candidates: string[] = []
  for (const entry of pathValue.split(delimiter)) {
    if (entry === '') continue
    // Both spellings per entry so one scan serves every platform without a
    // platform branch; a missing probe (e.g. `node.exe` on POSIX) is rejected.
    candidates.push(join(entry, 'node.exe'), join(entry, 'node'))
  }
  return candidates
}

/**
 * Whether a binary is real Node. Runs the binary with a probe that prints
 * the Bun version — empty on real Node, and still populated under Bun's
 * `node` shim. A missing, non-executable, or nonzero-exiting binary is not
 * real Node. Never loads koffi, so a Bun candidate cannot panic the probe.
 * @param candidate - the binary path to run.
 * @returns whether the binary is real Node.
 */
export function probeIsRealNode(candidate: string): boolean {
  try {
    const output = execFileSync(candidate, ['-p', 'process.versions.bun ?? ""'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim() === ''
  } catch {
    return false
  }
}

/**
 * Spawn the dialog child process. The worker always runs under real Node:
 * built consumers launch the bundled CJS entry next to this module under
 * plain node; unbuilt (source) consumers bootstrap tsx first, mirroring the
 * dsh CLI's source launch. A Bun host resolves a real Node binary first —
 * Bun's NAPI panics loading koffi instead of reporting the failure. The
 * dialog is the child's first window, so Windows activates it without a
 * foreground call.
 * @param data - the child payload (dialog title).
 * @returns the spawned child process.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const env = { ...process.env, DSH_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
  const node = resolveDialogNode()
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/) */
  if (!import.meta.url.endsWith('.ts')) {
    return spawn(node, [fileURLToPath(new URL('./worker.cjs', import.meta.url))], { env, stdio, windowsHide: true })
  }
  // Source launch under real Node: tsx's ESM hook transforms the worker and
  // resolves tsconfig paths.
  return spawn(node, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true })
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
