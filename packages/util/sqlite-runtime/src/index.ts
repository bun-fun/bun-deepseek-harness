/**
 * Runtime-selected SQLite facade for the host side: a `node:sqlite`
 * `DatabaseSync`-compatible class that runs on both Node and Bun. Constructing
 * {@link DatabaseSync} resolves the active runtime's driver — `node:sqlite`
 * under Node, `bun:sqlite` under Bun — and defers that module load until the
 * first open, so importing this module never loads either driver.
 *
 * Only the surface the harness consumers use is forwarded: `exec`, `prepare`
 * with `get`/`all`/`run`, and `close`. Everything else (custom functions,
 * aggregates, `isTransaction`) is out of scope.
 *
 * @module @deepseek-ai/dsh-sqlite-runtime
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** A value the active runtime driver can bind to a statement parameter. */
export type SqliteValue = null | number | bigint | string | Uint8Array

/** Result of a prepared statement's `run`. */
export interface StatementResultingChanges {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

/** A prepared statement over the active runtime driver. */
export interface StatementSync {
  get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined
  all(...params: SqliteValue[]): Array<Record<string, SqliteValue>>
  run(...params: SqliteValue[]): StatementResultingChanges
}

/** The driver surface the facade forwards to. */
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): unknown
  close(): void
}

/** The driver's prepared statement, before facade normalization. */
interface DriverStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
  finalize?(): void
}

/**
 * A driver entry point: `new Ctor(path)` yields a usable handle.
 */
interface DatabaseConstructor {
  new (path: string): SqliteDatabase
}

/**
 * Wrap a driver statement as the harness {@link StatementSync}, normalizing
 * the no-row `get` result to `undefined` (node:sqlite already returns
 * `undefined`; bun:sqlite returns `null`).
 * @param statement - the raw driver statement.
 * @returns the normalized statement facade.
 */
function normalizeStatement(statement: DriverStatement): StatementSync {
  return {
    get: (...params) => {
      const row = statement.get(...params)
      return row === null || row === undefined
        ? undefined
        : (row as Record<string, SqliteValue>)
    },
    all: (...params) => statement.all(...params) as Array<Record<string, SqliteValue>>,
    run: (...params) => statement.run(...params) as StatementResultingChanges,
  }
}

/**
 * Resolve the active runtime's SQLite driver constructor.
 * @returns the driver's database constructor, loaded on first construction.
 */
function loadDriver(): DatabaseConstructor {
  if (process.versions.bun !== undefined) {
    /* v8 ignore start -- node CI coverage exercises the node arm; bun covers the exact one */
    const { Database } = require('bun:sqlite') as { Database: DatabaseConstructor }
    return Database
    /* v8 ignore stop */
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseConstructor }
  return DatabaseSync
}

/**
 * A `node:sqlite`-compatible database handle backed by the active runtime's
 * driver. Each instance opens one SQLite database; callers must `close` it.
 */
export class DatabaseSync {
  private readonly impl: SqliteDatabase
  private readonly statements = new Set<DriverStatement>()

  /**
   * Open the database at `path`, loading the runtime driver on first use.
   * @param path - database file path or `:memory:`.
   */
  constructor(path: string) {
    this.impl = new (loadDriver())(path)
  }

  /**
   * Execute one or more statements.
   * @param sql - the SQL to run.
   */
  exec(sql: string): void {
    return this.impl.exec(sql)
  }

  /**
   * Prepare a statement for reuse. The statement is finalized by {@link close};
   * bun:sqlite keeps the database file pinned while a prepared statement
   * survives, so closing without finalizing would leave Windows unable to
   * delete the file.
   * @param sql - the statement SQL.
   * @returns a prepared statement with `get`/`all`/`run`.
   */
  prepare(sql: string): StatementSync {
    const statement = this.impl.prepare(sql) as DriverStatement
    this.statements.add(statement)
    return normalizeStatement(statement)
  }

  /** Close the underlying database handle, releasing every prepared statement. */
  close(): void {
    for (const statement of this.statements) {
      if (statement.finalize !== undefined) statement.finalize()
    }
    this.statements.clear()
    return this.impl.close()
  }
}
