/**
 * Real-Node resolution for the koffi-backed dialog worker: a real-Node host
 * keeps its own binary; a Bun host honors the `DSH_WIN32_DIALOG_NODE`
 * override or scans `PATH` for a non-Bun binary, failing loud when none
 * exists (Bun's NAPI panics initializing koffi instead of reporting the
 * failure). The real probe needs a real Node binary, so its happy path and
 * the probe-fallback branch self-skip on Bun hosts — CI runs real Node and
 * exercises them.
 */

import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeIsRealNode, resolveDialogNode, type DialogNodeInternals } from '../src/win32-dialog-host.ts'

const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node'

function bunInternals(overrides: Partial<DialogNodeInternals> = {}): DialogNodeInternals {
  return { hostIsBun: true, env: {}, isRealNode: () => false, ...overrides }
}

describe('resolveDialogNode', () => {
  it('keeps the host binary under real Node', () => {
    expect(resolveDialogNode({ hostIsBun: false })).toBe(process.execPath)
  })

  it('honors a real-Node DSH_WIN32_DIALOG_NODE override', () => {
    const node = join('C:\\Program Files\\nodejs', nodeExecutable)
    const internals = bunInternals({ env: { DSH_WIN32_DIALOG_NODE: node }, isRealNode: () => true })
    expect(resolveDialogNode(internals)).toBe(node)
  })

  it('rejects a DSH_WIN32_DIALOG_NODE override that is not real Node', () => {
    const node = join('C:\\bun', nodeExecutable)
    const internals = bunInternals({ env: { DSH_WIN32_DIALOG_NODE: node } })
    expect(() => resolveDialogNode(internals)).toThrow(/DSH_WIN32_DIALOG_NODE=.*not real Node/)
  })

  it('scans PATH for the first real Node binary, skipping empty entries', () => {
    const bunDir = 'C:\\bun'
    const nodeDir = 'C:\\Program Files\\nodejs'
    const realNode = join(nodeDir, nodeExecutable)
    const internals = bunInternals({
      env: { PATH: [bunDir, '', nodeDir].join(delimiter) },
      isRealNode: candidate => candidate === realNode,
    })
    expect(resolveDialogNode(internals)).toBe(realNode)
  })

  it('fails loud when no real Node binary exists', () => {
    const internals = bunInternals({ env: { PATH: 'C:\\bun' } })
    expect(() => resolveDialogNode(internals)).toThrow(/install Node.js or set DSH_WIN32_DIALOG_NODE/)
  })

  it.skipIf(process.versions.bun !== undefined)('uses the real probe when no injectable one is given', () => {
    const dir = dirname(process.execPath)
    const resolved = resolveDialogNode({ hostIsBun: true, env: { PATH: dir } })
    expect(resolved).toBe(join(dir, nodeExecutable))
  })
})

describe('probeIsRealNode', () => {
  it.skipIf(process.versions.bun !== undefined)('accepts a real Node binary', () => {
    expect(probeIsRealNode(process.execPath)).toBe(true)
  })

  it('rejects a missing binary', () => {
    expect(probeIsRealNode(join('definitely-missing-node-dir', nodeExecutable))).toBe(false)
  })
})
