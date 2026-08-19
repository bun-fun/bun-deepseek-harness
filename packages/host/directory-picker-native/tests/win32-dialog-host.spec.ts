/**
 * Dialog-worker spawning for the bun:ffi-backed picker: the child always runs
 * under this process's own runtime — Bun hosts hand the source `.ts` entry to
 * Bun directly, Node hosts (test runners, the pre-bun distribution) reach it
 * through the tsx ESM hook, and built consumers launch the bundled `worker.cjs`
 * next to the module. The title travels via `DSH_DIALOG_TITLE` and the channel
 * is IPC, so the driver maps messages onto its promise.
 */

import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { closeDialogWindow, spawnDialogWorker } from '../src/win32-dialog-host.ts'

const sourceEntry = fileURLToPath(new URL('../src/win32-dialog-worker.ts', import.meta.url))

const originalBunVersion = process.versions.bun

describe('spawnDialogWorker', () => {
  beforeAll(() => {
    ;(process.versions as Record<string, string | undefined>).bun = '1.3.14'
  })
  afterAll(() => {
    ;(process.versions as Record<string, string | undefined>).bun = originalBunVersion
  })

  it('runs the source worker under this Bun binary with the title in env and an IPC channel', () => {
    spawnDialogWorker({ title: 'Pick' })
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [sourceEntry], {
      env: expect.objectContaining({ DSH_DIALOG_TITLE: 'Pick' }),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
  })

  it('reaches the source worker through the tsx ESM hook on a Node host', () => {
    ;(process.versions as Record<string, string | undefined>).bun = undefined
    try {
      spawnDialogWorker({ title: 'Pick' })
      expect(spawnMock).toHaveBeenCalledWith(process.execPath, ['--import', 'tsx/esm', sourceEntry], expect.objectContaining({
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      }))
    } finally {
      ;(process.versions as Record<string, string | undefined>).bun = '1.3.14'
    }
  })
})

describe('closeDialogWindow re-export', () => {
  it('exposes the title-based WM_CLOSE poster to the driver', () => {
    expect(typeof closeDialogWindow).toBe('function')
  })
})
