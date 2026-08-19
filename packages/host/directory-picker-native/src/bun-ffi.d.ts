/**
 * Minimal ambient type surface for the `bun:ffi` builtin, which only exists
 * on the Bun runtime. The repo pins `types: ["node"]` (no bun-types), so the
 * module's own declarations are unavailable; `win32-dialog-bindings.ts`
 * describes the handful of exports it actually touches.
 */
declare module 'bun:ffi' {
  export const CFunction: unknown
  export const dlopen: unknown
  export const ptr: unknown
  export const read: unknown
  export const toBuffer: unknown
}
