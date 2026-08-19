# Agent Note: Switch the win32 folder dialog from koffi to bun:ffi

Status: implemented

English | [中文](2026-08-19-switch-win32-dialog-to-bun-ffi.zh.md)

## Problem

The win32 tier of the native directory picker drove the `IFileOpenDialog` COM conversation through koffi, and koffi is a Node native addon: it loads via N-API/`process.dlopen` and is unusable under Bun's JavaScriptCore runtime. The tier therefore spawned its worker with a real `node` binary — a `DSH_WIN32_DIALOG_NODE` override or a PATH search — while every other picker tier ran in-process. With the repository itself now Bun-first (`bun.lock`, `bun --bun`), a deployment that ships only Bun failed the picker with "no real Node.js binary found for the Win32 folder dialog" unless a separate Node install happened to be on PATH. One dialog tier should not impose a second runtime on the whole application.

The thread-based abort close also depended on Node-only mechanics: the worker reported its thread id (`showing` protocol message, `currentThreadId` on the bindings) and the driver posted `WM_CLOSE` to that thread via `PostThreadMessageW`. Reaching the same thread state through `bun:ffi` requires `EnumThreadWindows` with a callback, and `JSCallback` — the mechanism that gives `CFunction` a callback body — is broken on Windows Bun 1.3.14 (`cb.ptr` is undefined and the call throws).

## Decision

The win32 folder dialog is now a Bun child process. `spawnDialogWorker` spawns `process.execPath` — under Bun, `bun <worker>` runs the `.ts` source directly (no real Node required, no `DSH_WIN32_DIALOG_NODE`, no PATH search); a Node host still runs the worker through `node --import tsx/esm` for the source plane. The worker runs the same `IFileOpenDialog` conversation through `bun:ffi`: `dlopen('ole32.dll')` + `CoInitializeEx` + `CoCreateInstance`, vtable calls built with `new CFunction({ ptr, args, returns, cfa: 'stdcall' })` with the self pointer as an explicit first argument, and `CoTaskMemFree`-freed buffer reads for the returned path. ABI facts (vtable slots, GUIDs, `SIGDN_FILESYSPATH`, FOS flags, `WM_CLOSE`, DPI contexts) live in `win32-dialog-abi.ts`, the single home the bindings import.

The abort close no longer needs the worker's thread id. The driver closes the dialog by window title: `FindWindowW(null, <caption>)` + `PostMessageW(hwnd, WM_CLOSE)` against the exact caption set through `SetTitle`, retried every `CLOSE_RETRY_MS` up to `CLOSE_MAX_ATTEMPTS`, with `worker.kill()` as the backstop. This works because the dialog is modal to its own child process: the caption is known, the window is top-level, and `JSCallback` is never needed. The worker protocol shrinks to `{kind:'done',path}` | `{kind:'error',message}`; `showing`, `currentThreadId`, and `onShowing` are gone.

The child-process shape is kept deliberately: the dialog's message loop stays isolated from the picker process (crash isolation) and the picker process gets first-window activation on a busy desktop.

The package's `bun:ffi` type surface is declared ambiently in `src/bun-ffi.d.ts` because the repository pins `types: ["node"]` and does not carry `bun-types`.

## Alternatives considered

**Keep koffi and spawn a real Node for the worker, hard-requiring `DSH_WIN32_DIALOG_NODE`.** Rejected: it leaves the picker depending on a second runtime for one dialog and preserves the "no real Node.js binary found" failure class this change removes.

**Thread-based close via `EnumThreadWindows` + `JSCallback`.** Rejected: `JSCallback` is broken on Windows Bun 1.3.14 (`cb.ptr` undefined, throws). Even a working callback would still require the `showing`/thread-id protocol the title-based close deletes.

**Drive the dialog in the picker process itself (no worker).** Rejected: loses crash isolation and first-window activation, and the picker process may not be the foreground owner.

**Keep a real-Node child and `node --import tsx/esm` as the only path.** Rejected: on a Bun deployment the child would be a different runtime than its parent and still require a Node install.

**Polyfill koffi's native binding under Bun.** Rejected: koffi ships a prebuilt Node-addon ABI with no Bun load path.

## Consequences

- The win32 picker now requires a Bun host; on a Node host the worker refuses loudly ("requires the Bun runtime") before any FFI load. The built artifact `lib/worker.cjs` runs under plain Bun, keeping the `./worker` package export shape.
- `koffi` is removed from this package's dependencies. `sandbox-windows-acl` and `session-persistence-jsonl` still depend on it and are untouched.
- `DSH_WIN32_DIALOG_NODE`, the real-Node resolution, `closeThreadWindows`, `currentThreadId`, and the `showing` protocol field are gone from the package.
- The win32 real-dialog smoke test (gated on win32 + Bun) now opens and abort-closes a real dialog, exercising `Show` with an explicit `null` owner handle (`IModalWindow::Show(HWND)` takes an owner argument; omitting it returns `E_INVALIDARG`).
- The `built-worker.e2e.ts` guard keeps its regex contract (`/ole32|requires the Bun runtime/i`) and skips on win32 by design.
- Reintroduction condition: if Bun ships a native dialog API, or `JSCallback` becomes reliable on Windows, the title-based close could be replaced by a thread-based one.