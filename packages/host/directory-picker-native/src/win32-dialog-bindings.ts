/**
 * `bun:ffi`-backed Win32 bindings for the folder dialog: the COM vtable calls
 * behind {@link Win32DialogBindings} plus the title-based window closer the
 * driver uses to service aborts. The module loads on every platform; `bun:ffi`
 * itself is imported lazily inside each function, so non-Bun processes never
 * load it — the same containment as the repo's other `win32.ts` modules.
 *
 * Bun has no built-in native dialog API, so this drives the modern
 * `IFileOpenDialog` directly through Bun's FFI: `dlopen` loads ole32/user32,
 * `CFunction` calls each vtable slot, and `read`/`toBuffer` extract out-params
 * and the UTF-16 result. The conversation is identical to the one the previous
 * koffi tier ran, minus the external runtime the driver had to resolve. The
 * IShellItem vtable order, the GUIDs, `FOS_*` and `SIGDN_FILESYSPATH`) is
 * frozen Windows ABI since Vista; slots are offsets into the vtable at the
 * object's first pointer.
 */

import type { Win32DialogBindings, Win32FolderDialog } from './win32-dialog-logic.ts'
import {
  CLSCTX_INPROC_SERVER, CLSID_FILE_OPEN_DIALOG, COINIT_APARTMENTTHREADED,
  DPI_AWARENESS_CONTEXTS, IID_IFILE_OPEN_DIALOG, SIGDN_FILESYSPATH,
  SLOT_GET_DISPLAY_NAME, SLOT_GET_RESULT, SLOT_RELEASE, SLOT_SET_OPTIONS,
  SLOT_SET_TITLE, SLOT_SHOW, WM_CLOSE,
} from './win32-dialog-abi.ts'

// The repo pins `types: ["node"]`, so `bun:ffi`'s own type surface is
// unavailable; the ambient subset lives in `bun-ffi.d.ts`.

/** One exported native symbol as Bun's FFI hands it back. */
interface FfiSymbol { (...args: unknown[]): unknown }
/** The dlopen result: symbols keyed by their definition name. */
interface FfiLibrary { symbols: Record<string, FfiSymbol | undefined> }
/** The `bun:ffi` surface this module uses (a subset of the module's exports). */
interface BunFfi {
  dlopen(name: string, definitions: Record<string, { args: string[]; returns: string }>): FfiLibrary
  CFunction: new (options: { ptr: number; args: string[]; returns: string; cfa: string }) => FfiSymbol
  ptr(view: ArrayBufferView): number
  read: { ptr(address: number): number }
  toBuffer(address: number, offset: number, length: number): ArrayBuffer
}

/** The pointer width of the running process: 8 on x64/arm64, 4 on ia32. */
const POINTER_SIZE = process.arch === 'ia32' ? 4 : 8

/**
 * Read a NUL-terminated UTF-16 string at a native address. The COM
 * `_Out_ LPWSTR` surface hands back a raw address; `toBuffer` views the
 * memory directly instead of asking FFI to dereference it.
 * @param ffi - the loaded `bun:ffi` module.
 * @param address - the native address of the UTF-16 string.
 * @returns the decoded string, up to the first NUL.
 */
function readUtf16(ffi: BunFfi, address: number): string {
  const bytes = Buffer.from(ffi.toBuffer(address, 0, 32768))
  let end = 0
  while (end + 1 < bytes.length && bytes[end] !== 0) end += 2
  return bytes.toString('utf16le', 0, end)
}

/**
 * Load the `bun:ffi` module, refusing loudly on non-Bun runtimes instead of
 * surfacing a module-resolution failure from deep inside the conversation.
 * @returns the loaded `bun:ffi` module.
 */
async function loadBunFfi(): Promise<BunFfi> {
  if (process.versions.bun === undefined) {
    throw new Error('the win32 folder dialog requires the Bun runtime (bun:ffi drives the IFileOpenDialog COM conversation)')
  }
  return await import('bun:ffi') as unknown as BunFfi
}

/**
 * Load the dialog bindings for this thread.
 * @returns the bindings {@link runFolderDialog} sequences against.
 */
export async function loadWin32DialogBindings(): Promise<Win32DialogBindings> {
  const ffi = await loadBunFfi()
  const ole32 = ffi.dlopen('ole32.dll', {
    CoInitializeEx: { args: ['ptr', 'u32'], returns: 'i32' },
    CoUninitialize: { args: [], returns: 'void' },
    CoCreateInstance: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    CoTaskMemFree: { args: ['ptr'], returns: 'void' },
  })

  // The DPI symbol is a Windows 10 1607+ addition; `dlopen` refuses a missing
  // symbol at load, so the whole definition (and the opt-in with it) is
  // dropped when the host lacks it — the dialog still works, just without a
  // per-thread DPI correction on museum hosts.
  let setThreadDpiAwarenessContext: FfiSymbol | undefined
  try {
    setThreadDpiAwarenessContext = ffi.dlopen('user32.dll', {
      SetThreadDpiAwarenessContext: { args: ['isize'], returns: 'ptr' },
    }).symbols.SetThreadDpiAwarenessContext
  } catch {
    setThreadDpiAwarenessContext = undefined
  }

  const coInitializeEx = ole32.symbols.CoInitializeEx as FfiSymbol
  const coUninitialize = ole32.symbols.CoUninitialize as FfiSymbol
  const coCreateInstance = ole32.symbols.CoCreateInstance as FfiSymbol
  const coTaskMemFree = ole32.symbols.CoTaskMemFree as FfiSymbol

  /** Bind vtable slot `slot` of COM object `self` to a caller through `CFunction`. */
  const method = (self: number, slot: number, args: string[], returns: string): FfiSymbol => {
    const vtable = ffi.read.ptr(self)
    const fn = ffi.read.ptr(vtable + slot * POINTER_SIZE)
    return new ffi.CFunction({ ptr: fn, args: ['ptr', ...args], returns, cfa: 'stdcall' })
  }

  return {
    setThreadDpiAwareness: () => {
      if (setThreadDpiAwarenessContext === undefined) return
      for (const context of DPI_AWARENESS_CONTEXTS) {
        if (setThreadDpiAwarenessContext(context) !== null) return
      }
      // Unreachable in practice (SYSTEM_AWARE is accepted wherever the symbol
      // exists); if a host ever refuses everything, the dialog still works —
      // just without a DPI opt-in.
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED) as number,
    coUninitialize: () => {
      coUninitialize()
    },
    createFolderDialog: (): Win32FolderDialog => {
      const out = Buffer.alloc(POINTER_SIZE)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, ffi.ptr(out)) as number
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = ffi.read.ptr(ffi.ptr(out))
      return {
        setOptions: options => method(dialog, SLOT_SET_OPTIONS, ['u32'], 'i32')(dialog, options) as number,
        setTitle: (title) => {
          const titleBuf = Buffer.from(`${title}\0`, 'utf16le')
          return method(dialog, SLOT_SET_TITLE, ['ptr'], 'i32')(dialog, ffi.ptr(titleBuf)) as number
        },
        show: () => method(dialog, SLOT_SHOW, ['ptr'], 'i32')(dialog, null) as number,
        resultPath: () => {
          const itemOut = Buffer.alloc(POINTER_SIZE)
          const gotItem = method(dialog, SLOT_GET_RESULT, ['ptr'], 'i32')(dialog, ffi.ptr(itemOut)) as number
          if (gotItem < 0) return { hr: gotItem }
          const item = ffi.read.ptr(ffi.ptr(itemOut))
          try {
            const nameOut = Buffer.alloc(POINTER_SIZE)
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, ['i32', 'ptr'], 'i32')(item, SIGDN_FILESYSPATH, ffi.ptr(nameOut)) as number
            if (gotName < 0) return { hr: gotName }
            const path = readUtf16(ffi, ffi.read.ptr(ffi.ptr(nameOut)))
            coTaskMemFree(ffi.read.ptr(ffi.ptr(nameOut)))
            return { hr: gotName, path }
          } finally {
            method(item, SLOT_RELEASE, [], 'u32')(item)
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, [], 'u32')(dialog)
        },
      }
    },
  }
}

/**
 * Post `WM_CLOSE` to the top-level window whose caption is exactly `title` —
 * the driver's abort lever against a worker blocked inside `Show`, after
 * which `Show` returns `HRESULT_CANCELLED` and the worker unwinds normally.
 * The dialog caption is the exact `SetTitle` text, so a title lookup needs no
 * window enumeration callback (Bun's FFI `JSCallback` trampoline is
 * unavailable on Windows). A missing window posts nothing — the driver's
 * retry cadence re-searches as the dialog window appears.
 * @param title - the exact dialog caption (`SetTitle` text).
 */
export async function closeDialogWindow(title: string): Promise<void> {
  const ffi = await loadBunFfi()
  const user32 = ffi.dlopen('user32.dll', {
    FindWindowW: { args: ['ptr', 'ptr'], returns: 'ptr' },
    PostMessageW: { args: ['ptr', 'u32', 'usize', 'isize'], returns: 'i32' },
  })
  const titleBuf = Buffer.from(`${title}\0`, 'utf16le')
  const findWindowW = user32.symbols.FindWindowW as FfiSymbol
  const postMessageW = user32.symbols.PostMessageW as FfiSymbol
  const hwnd = findWindowW(null, ffi.ptr(titleBuf))
  if (hwnd === null) return
  postMessageW(hwnd, WM_CLOSE, 0, 0)
}
