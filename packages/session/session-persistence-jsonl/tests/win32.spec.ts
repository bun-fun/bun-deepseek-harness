/**
 * Unit tests for the Windows durable namespace helper with a mocked kernel32
 * binding. The helper binds kernel32 through the active runtime's FFI: Koffi
 * on a Node host, `bun:ffi` on a Bun host. Each suite below drives BOTH
 * bindings with the same fake kernel32 world (the `bun:ffi` one uses the same
 * buffer-address round-trip technique as dsh-directory-picker-native), keeping
 * the Win32 error mapping and race handling covered on every host. The real
 * JSONL suite exercises the helper on native Windows.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOVEFILE_WRITE_THROUGH = 0x00000008
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183

type Runtime = 'koffi' | 'bun'
type MoveFileExW = (existing: string, replacement: string, flags: number, setLastError: (code: number) => void) => number

const roots: string[] = []

function stripNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-win32-'))
  roots.push(dir)
  return dir
}

// The module gates its binding on `process.versions.bun`; the fake FFI module
// then stands in for the real one, so the guard sees the runtime under test.
const originalBunVersion = process.versions.bun

function setRuntime(runtime: Runtime): void {
  ;(process.versions as Record<string, string | undefined>).bun = runtime === 'bun' ? '1.3.14' : undefined
}

/**
 * Install a fake kernel32 binding for `runtime` over the injected `moveFileExW`
 * callback. The Koffi mock decodes `str16` arguments natively; the `bun:ffi`
 * mock round-trips `ptr` addresses back to the UTF-16LE buffers the binding
 * builds, so both see the same string arguments and report the same errors.
 */
function installKernel32Mock(runtime: Runtime, moveFileExW: MoveFileExW): void {
  let lastError = 0
  const setLastError = (code: number): void => { lastError = code }
  const move: (existing: string, replacement: string, flags: number) => number = (existing, replacement, flags) => {
    const ok = moveFileExW(existing, replacement, flags, setLastError)
    lastError = ok === 0 ? lastError : 0
    return ok
  }
  if (runtime === 'koffi') {
    vi.doMock('koffi', () => ({
      default: {
        load: () => ({
          func: (_convention: string, name: string, result: string) => {
            if (name === 'MoveFileExW') return (existing: string, replacement: string, flags: number) => {
              expect(result).toBe('int')
              return move(existing, replacement, flags)
            }
            return () => lastError
          },
        }),
      },
    }))
    return
  }
  const buffers = new Map<ArrayBufferView, number>()
  const byAddress = new Map<number, ArrayBufferView>()
  let nextAddress = 1
  const decode = (address: number): string => {
    const view = byAddress.get(address)
    if (view === undefined) throw new Error(`no buffer for kernel32 address ${address}`)
    return Buffer.from(view as Uint8Array).toString('utf16le').replace(/\0+$/, '')
  }
  vi.doMock('bun:ffi', () => ({
    dlopen: (_name: string, _definitions: Record<string, unknown>) => ({
      symbols: {
        MoveFileExW: (existing: number, replacement: number, flags: number) => move(decode(existing), decode(replacement), flags),
        GetLastError: () => lastError,
      },
    }),
    ptr: (view: ArrayBufferView) => {
      let address = buffers.get(view)
      if (address === undefined) {
        address = nextAddress
        nextAddress += 1
        buffers.set(view, address)
        byAddress.set(address, view)
      }
      return address
    },
  }))
}

function installErrorKernel32(runtime: Runtime, code: number): void {
  installKernel32Mock(runtime, (_existing, _replacement, _flags, setLastError) => {
    setLastError(code)
    return 0
  })
}

async function importWithMove(runtime: Runtime, moveFileExW: MoveFileExW): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  setRuntime(runtime)
  installKernel32Mock(runtime, moveFileExW)
  return import('../src/win32.ts')
}

async function importWithError(runtime: Runtime, code: number): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  setRuntime(runtime)
  installErrorKernel32(runtime, code)
  return import('../src/win32.ts')
}

async function importWithFilesystemMove(runtime: Runtime): Promise<typeof import('../src/win32.ts')> {
  return importWithMove(runtime, (existing, replacement, flags, setLastError) => {
    expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
    const from = stripNamespace(existing)
    const to = stripNamespace(replacement)
    if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
    if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
    renameSync(from, to)
    return 1
  })
}

afterEach(async () => {
  ;(process.versions as Record<string, string | undefined>).bun = originalBunVersion
  vi.doUnmock('koffi')
  vi.doUnmock('bun:ffi')
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('node:path')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.each<Runtime>(['koffi', 'bun'])('Windows durable namespace helpers (%s)', (runtime) => {
  it('keeps drive-root probes native while namespacing descendants', async () => {
    const probes: string[] = []
    vi.resetModules()
    setRuntime(runtime)
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        stat: async (path: string) => {
          probes.push(path)
          return { isDirectory: () => true }
        },
      }
    })
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:path')>()
      return {
        ...actual,
        join: (...paths: string[]) => actual.win32.join(...paths),
        parse: (path: string) => actual.win32.parse(path),
        resolve: (...paths: string[]) => actual.win32.resolve(...paths),
        toNamespacedPath: (path: string) => actual.win32.toNamespacedPath(path),
      }
    })
    const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')

    await ensureDurableDirectoryWin32('C:\\existing')

    expect(probes).toEqual(['C:\\', '\\\\?\\C:\\existing'])
  })

  it('publishes a new file with write-through MoveFileExW semantics', async () => {
    const { publishNewFileWin32 } = await importWithFilesystemMove(runtime)
    const root = await tempRoot()
    const tmp = join(root, 'log.tmp')
    const final = join(root, 'log.jsonl')
    await writeFile(tmp, 'content')

    await publishNewFileWin32(tmp, final)
    expect(existsSync(tmp)).toBe(false)
    expect(readFileSync(final, 'utf8')).toBe('content')
  })

  it('maps Win32 publish failures to Node-style errno codes', async () => {
    const cases = [
      [ERROR_FILE_NOT_FOUND, 'ENOENT'],
      [ERROR_PATH_NOT_FOUND, 'ENOENT'],
      [ERROR_ACCESS_DENIED, 'EACCES'],
      [ERROR_NOT_SAME_DEVICE, 'EXDEV'],
      [ERROR_FILE_EXISTS, 'EEXIST'],
      [ERROR_ALREADY_EXISTS, 'EEXIST'],
      [ERROR_INVALID_NAME, 'EINVAL'],
      [9999, 'EIO'],
    ] as const
    for (const [win32Code, code] of cases) {
      const { publishNewFileWin32 } = await importWithError(runtime, win32Code)
      await expect(publishNewFileWin32('from', 'to')).rejects.toMatchObject({ code, win32Code, path: 'from', dest: 'to' })
    }
  })

  it('creates missing directories through staging siblings and tolerates an already-created race', async () => {
    const root = await tempRoot()
    const raced = join(root, 'raced')
    const { ensureDurableDirectoryWin32 } = await importWithMove(runtime, (existing, replacement, flags, setLastError) => {
      expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (to === raced) {
        mkdirSync(to)
        setLastError(ERROR_ALREADY_EXISTS)
        return 0
      }
      if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
      if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
      renameSync(from, to)
      return 1
    })

    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    expect(existsSync(join(root, 'a', 'b'))).toBe(true)
    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    await ensureDurableDirectoryWin32(raced)
    expect(existsSync(raced)).toBe(true)
  })

  it('keeps staging names valid for a maximum-length target component', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove(runtime)
    const root = await tempRoot()
    const target = join(root, 'x'.repeat(255))

    await ensureDurableDirectoryWin32(target)
    expect(existsSync(target)).toBe(true)
  })

  it('surfaces directory publication failures other than an existing-target race', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithError(runtime, ERROR_ACCESS_DENIED)
    const root = await tempRoot()

    await expect(ensureDurableDirectoryWin32(join(root, 'denied'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects a non-directory component instead of treating it as missing', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove(runtime)
    const root = await tempRoot()
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'x')

    await expect(ensureDurableDirectoryWin32(join(blocked, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
