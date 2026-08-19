/**
 * Real-process half of the Win32 dialog driver: spawn the dialog child
 * process (source or built plane). The child always runs under this
 * process's own Bun binary — the dialog conversation is Bun's built-in FFI
 * (`bun:ffi`), so there is no external runtime to resolve and Bun's NAPI
 * panic that the koffi tier hit is gone. The driver's logic is tested
 * against fakes of this surface instead.
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * Spawn the dialog child process. The worker always runs under this host's
 * Bun binary: built consumers launch the bundled CJS entry next to this
 * module under plain bun, and unbuilt (source) consumers hand the `.ts` entry
 * straight to Bun, which runs TypeScript natively. On a Node host (test
 * runners and the pre-bun distribution) the source entry needs the tsx ESM
 * hook, matching the repo's source-launch contract. The dialog is the child's
 * first window, so Windows activates it without a foreground call.
 * @param data - the child payload (dialog title).
 * @returns the spawned child process.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const env = { ...process.env, DSH_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/) */
  if (!import.meta.url.endsWith('.ts')) {
    return spawn(process.execPath, [fileURLToPath(new URL('./worker.cjs', import.meta.url))], { env, stdio, windowsHide: true })
  }
  const entry = fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))
  /* v8 ignore next 3 -- Node-host source plane; Bun hosts run the entry directly */
  if (process.versions.bun === undefined) {
    return spawn(process.execPath, ['--import', 'tsx/esm', entry], { env, stdio, windowsHide: true })
  }
  return spawn(process.execPath, [entry], { env, stdio, windowsHide: true })
}

export { closeDialogWindow } from './win32-dialog-bindings.ts'
