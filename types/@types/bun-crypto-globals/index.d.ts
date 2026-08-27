/**
 * Bun exposes `node:crypto` and `node:zlib` functions as globals. `@types/node`
 * does not declare them, so TypeScript cannot resolve the bare calls. This
 * ambient augmentation bridges the gap until `@types/bun` or upstream
 * `@types/node` covers the Bun runtime.
 *
 * @see https://bun.sh/docs/runtime/nodejs-apis
 */

import type { Hash, HashOptions, RandomUUIDOptions } from 'node:crypto'
import type { ZstdDecompress, ZstdOptions } from 'node:zlib'

type InputType = string | ArrayBuffer | NodeJS.ArrayBufferView
type CompressCallback = (error: Error | null, result: Buffer) => void

declare global {
  // node:crypto globals
  function createHash(algorithm: string, options?: HashOptions): Hash
  function randomBytes(size: number): Buffer
  function randomBytes(
    size: number,
    callback: (err: Error | null, buf: Buffer) => void,
  ): void
  function randomUUID(options?: RandomUUIDOptions): `${string}-${string}-${string}-${string}-${string}`

  // node:zlib globals
  function createZstdDecompress(options?: ZstdOptions): ZstdDecompress
  function zstdDecompress(buf: InputType, callback: CompressCallback): void
  function zstdDecompress(
    buf: InputType,
    options: ZstdOptions,
    callback: CompressCallback,
  ): void
  function zstdDecompressSync(buf: InputType, options?: ZstdOptions): Buffer

  // Allow promisify to infer the promise signature for zstdDecompress
  namespace zstdDecompress {
    function __promisify__(buffer: InputType, options?: ZstdOptions): Promise<Buffer>
  }
}
