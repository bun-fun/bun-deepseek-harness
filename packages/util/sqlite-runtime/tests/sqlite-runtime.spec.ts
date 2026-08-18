import { describe, expect, it } from 'vitest'
import { DatabaseSync, type StatementSync } from '@deepseek-ai/dsh-sqlite-runtime'

describe('DatabaseSync facade', () => {
  it('opens an in-memory database, execs DDL, and closes', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)')
    expect(db).toBeInstanceOf(DatabaseSync)
    db.close()
  })

  it('round-trips get, all, and run over a prepared statement', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER)')
    const insert: StatementSync = db.prepare('INSERT INTO t (k, n) VALUES (?, ?)')
    const result = insert.run('a', 1)
    expect(Number(result.lastInsertRowid)).toBe(1)
    expect(Number(result.changes)).toBe(1)
    db.prepare('INSERT INTO t (k, n) VALUES (?, ?)').run('b', null)
    const all = db.prepare('SELECT k, n FROM t ORDER BY k').all() as Array<{ k: string; n: number | null }>
    expect(all.map(row => row.k)).toEqual(['a', 'b'])
    const hit = db.prepare('SELECT n FROM t WHERE k = ?').get('a') as { n: number | null }
    expect(hit.n).toBe(1)
    const miss = db.prepare('SELECT n FROM t WHERE k = ?').get('missing')
    expect(miss).toBeUndefined()
    db.close()
  })

  it('binds every SqliteValue variant', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (n INTEGER, r INTEGER, s TEXT, b BLOB)')
    db.prepare('INSERT INTO t (n, r, s, b) VALUES (?, ?, ?, ?)').run(
      null,
      42n,
      '文本',
      new Uint8Array([255, 0]),
    )
    const row = db.prepare('SELECT n, r, s, b FROM t').get() as {
      n: null
      r: number
      s: string
      b: Uint8Array
    }
    expect(row.n).toBeNull()
    expect(Number(row.r)).toBe(42)
    expect(row.s).toBe('文本')
    expect(Array.from(row.b)).toEqual([255, 0])
    db.close()
  })
})
