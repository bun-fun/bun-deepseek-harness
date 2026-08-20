/**
 * Minimal ambient type surface for the `bun:ffi` builtin, which only exists
 * on the Bun runtime. The repo pins `types: ["node"]` (no bun-types), so the
 * module's own declarations are unavailable; `win32.ts` describes the two
 * exports it actually touches. The Node-host path never imports this module.
 */
declare module 'bun:ffi' {
  export const dlopen: (name: string, definitions: Record<string, unknown>) => { symbols: Record<string, unknown> }
  export const ptr: (view: ArrayBufferView) => unknown
}
