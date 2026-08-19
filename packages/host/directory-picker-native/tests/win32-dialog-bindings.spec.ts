/**
 * The bun:ffi-backed bindings against a mocked `bun:ffi` module (the same
 * technique as dsh-session-persistence-jsonl's win32 suite): a small in-memory
 * COM world stands in for ole32/user32, keeping the vtable dispatch, result
 * extraction, memory hygiene, and the WM_CLOSE poster covered on every host.
 * The worker entry is exercised the same way with a mocked process boundary
 * (env title + `process.send`). Real-COM behavior is pinned by the win32-only
 * smoke in win32-dialog.spec.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HRESULT_CANCELLED, runFolderDialog } from '../src/win32-dialog-logic.ts'

const E_FAIL = 0x80004005 | 0
const WM_CLOSE = 0x10
/**
 * Derived from `process.arch` exactly like the bindings' own pointer width:
 * the fake COM world computes vtable offsets and checks out-buffer sizes
 * against the SAME width, so a hardcoded width anywhere in the bindings
 * diverges and fails the vtable lookup or the out-buffer check — the
 * win32-ia32 bug class, kept honest because bun:ffi has no `sizeof` to mock.
 */
const FAKE_POINTER_SIZE = process.arch === 'ia32' ? 4 : 8

interface ComWorld {
  coInitHr: number
  coCreateHr: number
  showHr: number
  getResultHr: number
  getDisplayNameHr: number
  hasThreadDpi: boolean
  /** Contexts `SetThreadDpiAwarenessContext` accepts; others return NULL. */
  supportedDpiContexts: number[]
  path: string
  titles: string[]
  options: number[]
  dpiContexts: unknown[]
  freed: unknown[]
  released: string[]
  searchedTitles: string[]
  posted: { hwnd: unknown; message: number }[]
  cfas: string[]
  uninitialized: number
  windowHwnd: unknown
}

function comWorld(overrides: Partial<ComWorld> = {}): ComWorld {
  return {
    coInitHr: 0, coCreateHr: 0, showHr: 0, getResultHr: 0, getDisplayNameHr: 0,
    hasThreadDpi: true, supportedDpiContexts: [-4],
    path: 'C:\\选中\\directory',
    titles: [], options: [], dpiContexts: [], freed: [], released: [],
    searchedTitles: [], posted: [], cfas: [], uninitialized: 0, windowHwnd: null,
    ...overrides,
  }
}

/**
 * Install a fake `bun:ffi` over a fake COM world: native addresses are
 * numeric tokens, vtable slots are bound per object, out-params are written
 * through `memory`, and `toBuffer` fabricates the UTF-16 result string.
 */
function installFakeBunFfi(world: ComWorld): void {
  const objects = { dialog: 0x1000, item: 0x2000 }
  const nameAddr = 0x3000
  const vtables = { dialog: 0x4000, item: 0x5000 }
  const memory = new Map<number, number>()
  const buffers = new Map<ArrayBufferView, number>()
  const buffersByAddr = new Map<number, ArrayBufferView>()
  const targets = new Map<number, { self: 'dialog' | 'item'; slot: number }>()
  const vtableEntries = new Map<number, number>()
  let nextBuffer = 0x6000
  let nextFn = 0x10000

  for (const [self, slots] of [['dialog', [2, 3, 9, 17, 20]], ['item', [2, 5]]] as const) {
    for (const slot of slots) {
      vtableEntries.set(vtables[self] + slot * FAKE_POINTER_SIZE, nextFn)
      targets.set(nextFn, { self, slot })
      nextFn += 1
    }
  }

  const dispatch = (target: { self: 'dialog' | 'item'; slot: number }, callArgs: unknown[]): number => {
    const args = callArgs.slice(1)
    if (target.self === 'dialog') {
      switch (target.slot) {
        case 9: world.options.push(args[0] as number); return 0
        case 17: {
          const bytes = buffersByAddr.get(args[0] as number)
          if (bytes !== undefined) {
            world.titles.push(Buffer.from(bytes as Uint8Array).toString('utf16le').replace(/\0+$/, ''))
          }
          return 0
        }
        case 3: return world.showHr
        case 20: {
          if (world.getResultHr < 0) return world.getResultHr
          memory.set(args[0] as number, objects.item)
          return 0
        }
        case 2: world.released.push('dialog'); return 0
        default: throw new Error(`unexpected dialog slot ${target.slot}`)
      }
    }
    switch (target.slot) {
      case 5: {
        if (world.getDisplayNameHr < 0) return world.getDisplayNameHr
        memory.set(args[1] as number, nameAddr)
        return 0
      }
      case 2: world.released.push('item'); return 0
      default: throw new Error(`unexpected item slot ${target.slot}`)
    }
  }

  const symbolFor = (dll: string, name: string): ((...args: unknown[]) => unknown) => {
    switch (name) {
      case 'CoInitializeEx': return () => world.coInitHr
      case 'CoUninitialize': return () => { world.uninitialized += 1 }
      case 'CoCreateInstance': return (...args: unknown[]) => {
        if (world.coCreateHr < 0) return world.coCreateHr
        // The out-pointer must be allocated at the bindings' pointer width.
        if ((buffersByAddr.get(args[4] as number) as ArrayBufferView).byteLength !== FAKE_POINTER_SIZE) {
          throw new Error(`CoCreateInstance out buffer must be ${FAKE_POINTER_SIZE} bytes`)
        }
        memory.set(args[4] as number, objects.dialog)
        return 0
      }
      case 'CoTaskMemFree': return (addr: unknown) => { world.freed.push(addr) }
      case 'SetThreadDpiAwarenessContext': {
        if (!world.hasThreadDpi) throw new Error(`${dll}: SetThreadDpiAwarenessContext not found`)
        return (context: unknown) => {
          world.dpiContexts.push(context)
          return world.supportedDpiContexts.includes(context as number) ? { kind: 'previous-context' } : null
        }
      }
      case 'FindWindowW': return (_className: unknown, titleAddr: unknown) => {
        const bytes = buffersByAddr.get(titleAddr as number)
        if (bytes !== undefined) {
          world.searchedTitles.push(Buffer.from(bytes as Uint8Array).toString('utf16le').replace(/\0+$/, ''))
        }
        return world.windowHwnd
      }
      case 'PostMessageW': return (hwnd: unknown, message: unknown) => { world.posted.push({ hwnd, message: message as number }); return 1 }
      default: throw new Error(`unexpected native import ${dll}/${name}`)
    }
  }

  vi.doMock('bun:ffi', () => ({
    dlopen: (name: string, definitions: Record<string, unknown>) => ({
      symbols: Object.fromEntries(Object.keys(definitions).map(n => [n, symbolFor(name, n)])),
    }),
    CFunction: vi.fn(function (this: unknown, options: { ptr: number; args: string[]; returns: string; cfa: string }) {
      // A constructible implementation: the bindings build vtable callbacks
      // with `new CFunction`, and vitest's `new` forwards to `Reflect.construct`,
      // which refuses arrow functions. The mock returns the dispatcher closure,
      // so the constructed value IS the callable (as Bun's real CFunction).
      world.cfas.push(options.cfa)
      const target = targets.get(options.ptr)
      if (target === undefined) throw new Error(`no vtable target for fn pointer ${options.ptr}`)
      return (...callArgs: unknown[]) => dispatch(target, callArgs)
    }),
    ptr: (view: ArrayBufferView) => {
      let addr = buffers.get(view)
      if (addr === undefined) {
        addr = nextBuffer
        nextBuffer += 1
        buffers.set(view, addr)
        buffersByAddr.set(addr, view)
      }
      return addr
    },
    read: {
      ptr: (addr: number) => {
        const memoryHit = memory.get(addr)
        if (memoryHit !== undefined) return memoryHit
        if (addr === objects.dialog) return vtables.dialog
        if (addr === objects.item) return vtables.item
        const entry = vtableEntries.get(addr)
        if (entry !== undefined) return entry
        throw new Error(`unexpected read.ptr(${addr})`)
      },
    },
    toBuffer: (addr: number) => {
      if (addr !== nameAddr) throw new Error(`unexpected toBuffer(${addr})`)
      return Buffer.from(`${world.path}\0`, 'utf16le').buffer
    },
  }))
}

async function loadBindingsModule(): Promise<typeof import('../src/win32-dialog-bindings.ts')> {
  return await import('../src/win32-dialog-bindings.ts')
}

// The bindings gate `import('bun:ffi')` on a Bun runtime (process.versions.bun);
// the fake module then stands in for the real one, so the guard sees a Bun.
const originalBunVersion = process.versions.bun
beforeAll(() => {
  ;(process.versions as Record<string, string | undefined>).bun = '1.3.14'
})
afterAll(() => {
  ;(process.versions as Record<string, string | undefined>).bun = originalBunVersion
})

afterEach(() => {
  vi.doUnmock('bun:ffi')
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('../src/win32-dialog-bindings.ts')
  vi.resetModules()
})

describe('loadWin32DialogBindings over the fake COM world', () => {
  it('drives the full selection conversation with memory hygiene', async () => {
    const world = comWorld()
    installFakeBunFfi(world)
    const { loadWin32DialogBindings } = await loadBindingsModule()
    const bindings = await loadWin32DialogBindings()

    expect(runFolderDialog(bindings, '选择工作区目录')).toBe('C:\\选中\\directory')
    expect(world.dpiContexts).toEqual([-4])
    expect(world.titles).toEqual(['选择工作区目录'])
    expect(world.options).toHaveLength(1)
    expect(world.cfas.length).toBeGreaterThan(0)
    expect(world.cfas.every(cfa => cfa === 'stdcall')).toBe(true)
    expect(world.freed).toHaveLength(1)
    expect(world.released).toEqual(['item', 'dialog'])
    expect(world.uninitialized).toBe(1)
  })

  it('maps dismissal and the S_FALSE CoInitializeEx', async () => {
    const world = comWorld({ showHr: HRESULT_CANCELLED, coInitHr: 1 })
    installFakeBunFfi(world)
    const { loadWin32DialogBindings } = await loadBindingsModule()
    const bindings = await loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick')).toBeNull()
    expect(world.released).toEqual(['dialog'])
    expect(world.uninitialized).toBe(1)
  })

  it('cascades DPI contexts to the first the host accepts', async () => {
    const world = comWorld({ supportedDpiContexts: [-3] })
    installFakeBunFfi(world)
    const bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick')).toBe('C:\\选中\\directory')
    expect(world.dpiContexts).toEqual([-4, -3])
  })

  it('keeps the tier when no DPI context is accepted or the symbol is absent', async () => {
    // DPI is a cosmetic best-effort: the modern dialog still opens.
    const rejecting = comWorld({ supportedDpiContexts: [] })
    installFakeBunFfi(rejecting)
    let bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick')).toBe('C:\\选中\\directory')
    expect(rejecting.dpiContexts).toEqual([-4, -3, -2])

    vi.doUnmock('bun:ffi')
    vi.resetModules()
    const preThreadDpi = comWorld({ hasThreadDpi: false })
    installFakeBunFfi(preThreadDpi)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick')).toBe('C:\\选中\\directory')
    expect(preThreadDpi.dpiContexts).toEqual([])
  })

  it('refuses to load on a non-Bun runtime', async () => {
    ;(process.versions as Record<string, string | undefined>).bun = undefined
    try {
      const { loadWin32DialogBindings } = await loadBindingsModule()
      await expect(loadWin32DialogBindings()).rejects.toThrow('requires the Bun runtime')
    } finally {
      ;(process.versions as Record<string, string | undefined>).bun = '1.3.14'
    }
  })

  it('surfaces creation and extraction failures as HRESULT errors', async () => {
    const creationWorld = comWorld({ coCreateHr: E_FAIL })
    installFakeBunFfi(creationWorld)
    let bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => bindings.createFolderDialog()).toThrow('CoCreateInstance(FileOpenDialog) failed: HRESULT 0x80004005')

    vi.doUnmock('bun:ffi')
    vi.resetModules()
    const resultWorld = comWorld({ getResultHr: E_FAIL })
    installFakeBunFfi(resultWorld)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => runFolderDialog(bindings, 'Pick')).toThrow('GetResult failed')
    expect(resultWorld.released).toEqual(['dialog'])

    vi.doUnmock('bun:ffi')
    vi.resetModules()
    const nameWorld = comWorld({ getDisplayNameHr: E_FAIL })
    installFakeBunFfi(nameWorld)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => runFolderDialog(bindings, 'Pick')).toThrow('GetResult failed')
    // The shell item is released even when its display name cannot be read.
    expect(nameWorld.released).toEqual(['item', 'dialog'])
    expect(nameWorld.freed).toHaveLength(0)
  })
})

describe('closeDialogWindow over the fake COM world', () => {
  it('posts WM_CLOSE to the window whose caption matches the title', async () => {
    const world = comWorld({ windowHwnd: { kind: 'hwnd', n: 1 } })
    installFakeBunFfi(world)
    const { closeDialogWindow } = await loadBindingsModule()
    await closeDialogWindow('Select Workspace Directory')
    expect(world.searchedTitles).toEqual(['Select Workspace Directory'])
    expect(world.posted).toEqual([{ hwnd: { kind: 'hwnd', n: 1 }, message: WM_CLOSE }])
  })

  it('posts nothing when no window has the caption', async () => {
    const world = comWorld()
    installFakeBunFfi(world)
    const { closeDialogWindow } = await loadBindingsModule()
    await closeDialogWindow('Select Workspace Directory')
    expect(world.posted).toEqual([])
  })
})

describe('the worker entry over a mocked process boundary', () => {
  const originalSend = process.send?.bind(process)
  const originalTitle = process.env.DSH_DIALOG_TITLE

  const installBoundary = (): { posted: { kind: string; message?: string }[] } => {
    const posted: { kind: string; message?: string }[] = []
    process.env.DSH_DIALOG_TITLE = 'Pick'
    // Never invoke the post callback: it runs the worker's disconnect(), and
    // this process is IPC-connected under the forks pool — severing vitest's
    // own channel would kill the test worker. The real close lifecycle
    // belongs to built-worker.e2e.ts.
    ;(process as { send?: unknown }).send = (message: { kind: string }) => {
      posted.push(message)
      return true
    }
    return { posted }
  }

  afterEach(() => {
    delete (process as { send?: unknown }).send
    if (originalSend !== undefined) (process as { send?: unknown }).send = originalSend
    if (originalTitle === undefined) delete process.env.DSH_DIALOG_TITLE
    else process.env.DSH_DIALOG_TITLE = originalTitle
    vi.doUnmock('../src/win32-dialog-bindings.ts')
    vi.resetModules()
  })

  it('posts done for a completed conversation', async () => {
    const { posted } = installBoundary()
    vi.doMock('../src/win32-dialog-bindings.ts', () => ({
      loadWin32DialogBindings: async () => ({
        setThreadDpiAwareness: () => undefined,
        coInitializeSta: () => 0,
        coUninitialize: () => undefined,
        createFolderDialog: () => ({
          setOptions: () => 0,
          setTitle: () => 0,
          show: () => 0,
          resultPath: () => ({ hr: 0, path: 'C:\\from-worker' }),
          release: () => undefined,
        }),
      }),
    }))
    await import('../src/win32-dialog-worker.ts')
    expect(posted).toEqual([
      { kind: 'done', path: 'C:\\from-worker' },
    ])
  })

  it('posts the failure message when the native surface cannot load', async () => {
    const { posted } = installBoundary()
    vi.doMock('../src/win32-dialog-bindings.ts', () => ({
      loadWin32DialogBindings: async () => { throw new Error('no ole32 here') },
    }))
    await import('../src/win32-dialog-worker.ts')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.kind).toBe('error')
    expect(posted[0]?.message).toContain('no ole32 here')
  })

  it('stringifies stackless and non-Error failures', async () => {
    const stackless = new Error('bare message')
    delete stackless.stack
    for (const [thrown, expected] of [[stackless, 'bare message'], ['plain refusal', 'plain refusal']] as const) {
      vi.resetModules()
      const { posted } = installBoundary()
      vi.doMock('../src/win32-dialog-bindings.ts', () => ({
        loadWin32DialogBindings: async () => { throw thrown },
      }))
      await import('../src/win32-dialog-worker.ts')
      expect(posted[0]?.message).toBe(expected)
    }
  })

  it('refuses to run without the dialog title', async () => {
    delete process.env.DSH_DIALOG_TITLE
    ;(process as { send?: unknown }).send = () => true
    await expect(import('../src/win32-dialog-worker.ts')).rejects.toThrow('DSH_DIALOG_TITLE is required')
  })

  it('refuses to run outside a child process', async () => {
    process.env.DSH_DIALOG_TITLE = 'Pick'
    delete (process as { send?: unknown }).send
    await expect(import('../src/win32-dialog-worker.ts')).rejects.toThrow('must run as a child process')
  })
})
