# dsh-sqlite-runtime

[English](README.md) | 中文

宿主侧 SQLite 后端共享的**运行时选择的 SQLite 门面**：一个带 `node:sqlite` 接口面（打开、`exec`、`prepare` 与 `get`/`all`/`run`、`close`）的 `DatabaseSync` 类在 Node 与 Bun 上都能运行。构造该类时加载当前运行时的驱动——Node 下为 `node:sqlite`，Bun 下为 `bun:sqlite`——并把该模块的加载推迟到首次打开，因此导入本包不会加载任何一种驱动。

它的三个消费方是 SQLite 后端：[`session-persistence-sqlite`](../../session/session-persistence-sqlite/README.md)、[`storage-sqlite`](../../storage/storage-sqlite/README.md) 与 [`session-query-sqlite`](../../session-query/session-query-sqlite/README.md)。用本包替换它们对 `node:sqlite` 的直接导入，使同一套持久化磁盘格式无需为切换运行时而重新编译即可在两个运行时上打开。

它是**库，不是服务或插件**：没有 `ctx`、不注册任何东西、不持有状态、不发事件。

## 接口面

```ts
import { DatabaseSync } from '@deepseek-ai/dsh-sqlite-runtime'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t (k TEXT)')
db.prepare('INSERT INTO t VALUES (?)').run('a')
const rows = db.prepare('SELECT k FROM t').all()
db.close()
```

## 模型体验

无；这是宿主侧数据库管道，这里没有任何东西进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **仅转发已用接口面**——门面只暴露被用到的子集（`exec`、`prepare`、`close`）；自定义函数、聚合、`isTransaction` 以及 `node:sqlite` 的其他扩展不在其中。当消费方确实需要时，再添加一个转发成员。