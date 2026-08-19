/**
 * Shared Win32 ABI facts for the folder dialog: the frozen vtable layout,
 * GUIDs, and flag constants the `bun:ffi` bindings (`win32-dialog-bindings.ts`)
 * run against. The COM surface (IModalWindow/IFileDialog/IFileOpenDialog and
 * IShellItem vtable order, the GUIDs, `FOS_*` and `SIGDN_FILESYSPATH`) is
 * frozen Windows ABI since Vista; slots are offsets into the vtable at the
 * object's first pointer.
 */

/**
 * Encode a canonical GUID string as its 16 little-endian bytes.
 * @param text - the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` form.
 * @returns the in-memory GUID bytes CoCreateInstance expects.
 */
export function guidBytes(text: string): Uint8Array {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text) as RegExpExecArray
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, parseInt(match[1] as string, 16), true)
  view.setUint16(4, parseInt(match[2] as string, 16), true)
  view.setUint16(6, parseInt(match[3] as string, 16), true)
  const tail = (match[4] as string) + (match[5] as string)
  for (let i = 0; i < 8; i++) view.setUint8(8 + i, parseInt(tail.slice(i * 2, i * 2 + 2), 16))
  return bytes
}

export const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
export const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')

/** `CoInitializeEx` apartment flag: a single-threaded apartment. */
export const COINIT_APARTMENTTHREADED = 0x2
/** `CoCreateInstance` class-context flag: in-process server. */
export const CLSCTX_INPROC_SERVER = 0x1
/** `IShellItem::GetDisplayName` form: the filesystem path. */
export const SIGDN_FILESYSPATH = 0x80058000 | 0
/**
 * Thread DPI awareness contexts, best first: per-monitor-v2 (Windows 10
 * 1703+), per-monitor (1607+), then system-aware. `SetThreadDpiAwarenessContext`
 * returns NULL for an unsupported context instead of throwing, so the caller
 * cascades to the best one the host accepts; DPI stays a cosmetic
 * best-effort — an unsupported host still gets the modern dialog.
 */
export const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]
/** `WM_CLOSE`: the abort lever's message against a dialog thread's windows. */
export const WM_CLOSE = 0x10

/** IFileOpenDialog vtable slots (IUnknown 0-2, IModalWindow 3, IFileDialog 4+). */
export const SLOT_RELEASE = 2
export const SLOT_SHOW = 3
export const SLOT_SET_OPTIONS = 9
export const SLOT_SET_TITLE = 17
export const SLOT_GET_RESULT = 20
/** IShellItem vtable slot for `GetDisplayName`. */
export const SLOT_GET_DISPLAY_NAME = 5
