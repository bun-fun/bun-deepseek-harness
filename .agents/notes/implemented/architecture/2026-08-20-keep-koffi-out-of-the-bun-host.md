# Agent Note: Keep koffi out of the Bun host — dual-runtime win32 FFI and worker finalizer hardening

Status: implemented

English | [中文](2026-08-20-keep-koffi-out-of-the-bun-host.zh.md)

## Problem

`bun dsh web` on Windows crashed twice in one session, and both crashes were Bun 1.3.14 finalizer faults around FFI objects.

The main process panicked with `napi_reference_unref` in a crash report whose URL named `koffi.node`. The web bundle mounts `session-persistence-jsonl`, and on Windows that package publishes durable session files through `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` via koffi — a Node N-API addon loaded lazily by `win32.ts`. Bun's JavaScriptCore runtime cannot host N-API addons safely on Windows; the addon loads and works for a while, then Bun panics in GC finalization. Bun 1.3.14 is the latest stable release, so there was no upgrade to fix it.

The picker worker — the child that runs the Win32 folder dialog through `bun:ffi` — segfaulted with a Finalizer/GC error after about 21 seconds of runtime, in a process that had loaded only `bun:ffi` and never koffi. Bun 1.3.14 also faults when its GC finalizes `CFunction` objects (the same N-API finalizer defect family), and a long modal dialog run gives the collector time to reclaim the per-call `CFunction` instances the vtable binder creates.

## Decision

`session-persistence-jsonl`'s `win32.ts` now selects its binding by runtime: `bun:ffi` on a Bun host, Koffi on a Node host. The Node path is byte-for-byte the previous implementation. The Bun path loads `kernel32.dll` through `dlopen` and wraps `MoveFileExW`/`GetLastError` with UTF-16LE buffer conversion, mirroring the directory picker's `bun:ffi` port. The package gains an ambient `src/bun-ffi.d.ts` (the repo pins `types: ["node"]`), and the win32 unit suite is parametrized over both runtimes with mocked kernel32 worlds — the Koffi mock decodes `str16` arguments natively, the `bun:ffi` mock round-trips `ptr` addresses back to the UTF-16 buffers the binding builds. The real Windows integration suite (`jsonl.spec.ts`) now exercises the real `bun:ffi` kernel32 binding on a Bun host.

The picker worker keeps every `CFunction` it constructs referenced for the process lifetime and exits with `process.exit(0)` after its outcome is on the IPC wire, skipping the natural teardown pass where Bun runs the buggy finalizers. The message is flushed before the exit callback runs, so the parent always sees the result.

## Alternatives considered

**Guard-only: refuse to load koffi on a Bun host with a loud error.** Rejected: it stops the crash but breaks Windows session persistence under Bun — the primary host — so `dsh web` could boot but could not create sessions.

**Upgrade Bun past 1.3.14.** Rejected: 1.3.14 is the latest stable; the fix must live in the code.

**Reuse one `CFunction` per vtable slot instead of per call.** Rejected: fewer objects reduce finalizer churn but do not eliminate it; the worker still creates transient objects (`read.ptr` results, buffers) that the collector may reclaim. Keeping references for the process lifetime removes the class entirely.

## Consequences

- `dsh web` on Windows+Bun no longer loads `koffi.node` in the main process; the session-persistence win32 path binds kernel32 through `bun:ffi` and works.
- The picker worker no longer runs teardown GC finalizers, removing the segfault class behind the second crash report.
- `sandbox-windows-acl` (eager `import koffi`) and `fs-local` (lazy `import('koffi')`) carry the same latent Bun-hostile pattern. Neither is mounted by the web/headless bundles today, so this change leaves them untouched; if a future composition mounts them, they need the same dual-runtime treatment.
- The win32 unit suite doubles (7 tests x 2 runtimes), and the coverage gate (`test:coverage`) still sees both binding paths on every host through the mocked kernel32 worlds.