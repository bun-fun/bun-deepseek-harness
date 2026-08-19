/**
 * Driver tests: the child-process message protocol mapped onto the promise,
 * the WM_CLOSE-by-title abort service (including the show-race retry and the
 * kill last resort) against fakes, plus the real spawn plumbing — POSIX hosts
 * prove the default path rejects cleanly (no ole32.dll there), Node-host
 * win32 proves the Bun-runtime refusal, and Bun win32 briefly opens and
 * auto-aborts a real dialog.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DIALOG_TITLE, pickWin32Directory, type Win32DialogInternals, type Win32DialogWorkerLike } from '../src/win32-dialog.ts'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

class FakeWorker extends EventEmitter implements Win32DialogWorkerLike {
  kill = vi.fn(() => true)
  post(message: Win32DialogWorkerMessage): void {
    this.emit('message', message)
  }
}

interface Harness {
  worker: FakeWorker
  internals: Win32DialogInternals
  close: ReturnType<typeof vi.fn>
}

function harness(overrides: Partial<Win32DialogInternals> = {}): Harness {
  const worker = new FakeWorker()
  const close = vi.fn(async () => undefined)
  return {
    worker,
    close,
    internals: {
      spawnWorker: () => worker,
      closeDialogWindow: close,
      closeRetryMs: 1,
      ...overrides,
    },
  }
}

const live = (): AbortSignal => new AbortController().signal

describe('pickWin32Directory', () => {
  it('resolves the selected path and the cancellation null', async () => {
    const first = harness()
    const picked = pickWin32Directory(live(), first.internals)
    first.worker.post({ kind: 'done', path: 'C:\\picked' })
    await expect(picked).resolves.toBe('C:\\picked')
    expect(first.close).not.toHaveBeenCalled()

    const second = harness()
    const cancelled = pickWin32Directory(live(), second.internals)
    second.worker.post({ kind: 'done', path: null })
    await expect(cancelled).resolves.toBeNull()
  })

  it('rejects on a reported dialog failure, a worker crash, and a silent exit', async () => {
    const reported = harness()
    const failing = pickWin32Directory(live(), reported.internals)
    reported.worker.post({ kind: 'error', message: 'CoCreateInstance failed' })
    await expect(failing).rejects.toThrow('win32 folder dialog failed: CoCreateInstance failed')

    const crashed = harness()
    const crashing = pickWin32Directory(live(), crashed.internals)
    crashed.worker.emit('error', new Error('worker blew up'))
    await expect(crashing).rejects.toThrow('worker blew up')

    const silent = harness()
    const exiting = pickWin32Directory(live(), silent.internals)
    silent.worker.emit('exit', 0)
    await expect(exiting).rejects.toThrow('exited before reporting a result')
  })

  it('settles once: a late exit after the result is inert', async () => {
    const { worker, internals } = harness()
    const picked = pickWin32Directory(live(), internals)
    worker.post({ kind: 'done', path: 'C:\\once' })
    worker.emit('exit', 0)
    await expect(picked).resolves.toBe('C:\\once')
  })

  it('throws immediately on an already-aborted signal without spawning', async () => {
    const spawnWorker = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(pickWin32Directory(controller.signal, { spawnWorker, closeDialogWindow: async () => undefined }))
      .rejects.toThrow('native directory picker aborted')
    expect(spawnWorker).not.toHaveBeenCalled()
  })

  it('services an abort by closing the dialog window until the worker reports', async () => {
    const { worker, internals, close } = harness()
    const controller = new AbortController()
    // Attach the expectation BEFORE driving the race: on a fast host the
    // close budget can exhaust (and reject) between waitFor ticks, and a
    // rejection with no listener yet would count as unhandled.
    const picked = expect(pickWin32Directory(controller.signal, internals)).rejects.toThrow('native directory picker aborted')
    controller.abort()
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(DIALOG_TITLE)
    })
    worker.post({ kind: 'done', path: null })
    await picked
  })

  it('retries the title-based close while posting rejects', async () => {
    const closeFailures = vi.fn(async () => { throw new Error('window not there yet') })
    const { worker, internals } = harness({ closeDialogWindow: closeFailures })
    const controller = new AbortController()
    // Attached before the race for the same unhandled-rejection reason above.
    const picked = expect(pickWin32Directory(controller.signal, internals)).rejects.toThrow('native directory picker aborted')
    controller.abort()
    await vi.waitFor(() => {
      expect(closeFailures.mock.calls.length).toBeGreaterThan(1)
    })
    worker.post({ kind: 'done', path: null })
    await picked
  })

  it('kills a worker that never reports after an abort', async () => {
    // The budget runs unconditionally, so a worker hung before the dialog
    // window exists cannot dangle the pick.
    const { worker, internals, close } = harness()
    const controller = new AbortController()
    const picked = expect(pickWin32Directory(controller.signal, internals)).rejects.toThrow('dialog unresponsive; worker killed')
    controller.abort()
    await picked
    expect(worker.kill).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith(DIALOG_TITLE)
  })

  it('kills an unresponsive worker after the close budget', async () => {
    const { worker, internals, close } = harness()
    const controller = new AbortController()
    const picked = pickWin32Directory(controller.signal, internals)
    controller.abort()
    await expect(picked).rejects.toThrow('dialog unresponsive; worker killed')
    expect(worker.kill).toHaveBeenCalledOnce()
    expect(close.mock.calls.length).toBeGreaterThan(10)
  })

  // POSIX hosts exercise the REAL default plumbing end to end: the worker
  // spawns under the host runtime, bun:ffi cannot load ole32.dll, and the
  // failure is reported. The same applies to Node-host win32, where the
  // worker refuses the non-Bun runtime before any FFI load.
  it.skipIf(process.platform === 'win32')('rejects through the real worker where the Win32 surface is unavailable', async () => {
    await expect(pickWin32Directory(live())).rejects.toThrow('win32 folder dialog failed')
  }, 30_000)

  it.skipIf(process.platform !== 'win32' || process.versions.bun !== undefined)('rejects through the real worker on a Node-host win32', async () => {
    await expect(pickWin32Directory(live())).rejects.toThrow('requires the Bun runtime')
  }, 30_000)

  // Bun-host win32 runs the true COM smoke instead: a real dialog opens
  // briefly and the abort service closes it by title (the same lever a
  // disconnecting client pulls).
  it.skipIf(process.platform !== 'win32' || process.versions.bun === undefined)('opens and abort-closes a real dialog', async () => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 400)
    await expect(pickWin32Directory(controller.signal)).rejects.toThrow('native directory picker aborted')
  }, 30_000)
})
