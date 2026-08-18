# dsh-sqlite-runtime

English | [中文](README.zh.md)

A **runtime-selected SQLite facade** shared by the host-side SQLite backends: one `DatabaseSync` class with the `node:sqlite` surface (open, `exec`, `prepare` with `get`/`all`/`run`, `close`) runs on both Node and Bun. Constructing the class loads the active runtime's driver — `node:sqlite` under Node, `bun:sqlite` under Bun — and defers that module load until the first open, so importing this package never loads either driver.

Its three consumers are the SQLite backends: [`session-persistence-sqlite`](../../session/session-persistence-sqlite/README.md), [`storage-sqlite`](../../storage/storage-sqlite/README.md), and [`session-query-sqlite`](../../session-query/session-query-sqlite/README.md). Replacing their direct `node:sqlite` imports lets the same persisted on-disk formats open on both runtimes without a driver-switch recompile.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state, emits no events.

## Surface

```ts
import { DatabaseSync } from '@deepseek-ai/dsh-sqlite-runtime'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t (k TEXT)')
db.prepare('INSERT INTO t VALUES (?)').run('a')
const rows = db.prepare('SELECT k FROM t').all()
db.close()
```

## Model Experience

None, as this is host-side database plumbing; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Forwarded surface only** — the facade exposes the used subset (`exec`, `prepare`, `close`); custom functions, aggregates, `isTransaction`, and other `node:sqlite` extras are absent. Add a forwarded member when a consumer genuinely needs it.