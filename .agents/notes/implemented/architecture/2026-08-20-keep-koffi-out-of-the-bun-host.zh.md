# Agent Note: 让 koffi 远离 Bun 宿主——win32 双运行时 FFI 与 worker finalizer 加固

Status: implemented

[English](2026-08-20-keep-koffi-out-of-the-bun-host.md) | 中文

## 问题

`bun dsh web` 在 Windows 上一次会话内崩了两次，而这两次崩溃都是 Bun 1.3.14 围绕 FFI 对象的 finalizer 故障。

主进程以 `napi_reference_unref` 崩溃，崩溃报告 URL 指向 `koffi.node`。web 组合挂载了 `session-persistence-jsonl`，该包在 Windows 上通过 koffi（一个 Node N-API 插件，由 `win32.ts` 懒加载）以 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` 发布持久会话文件。Bun 的 JavaScriptCore 运行时在 Windows 上无法安全承载 N-API 插件；插件能加载并工作一段时间，然后在 GC finalization 时 Bun 崩溃。Bun 1.3.14 是当前最新稳定版，没有可升级的修复版本。

选择器 worker——通过 `bun:ffi` 运行 Win32 文件夹对话框的子进程——在运行约 21 秒后以 Finalizer/GC 错误段错误崩溃，而该进程只加载了 `bun:ffi`、从未加载 koffi。Bun 1.3.14 在其 GC 终结 `CFunction` 对象时同样会故障（同一 N-API finalizer 缺陷家族），长时间模态对话框运行给了收集器时间来回收 vtable 绑定器每次调用创建的 `CFunction` 实例。

## 决策

`session-persistence-jsonl` 的 `win32.ts` 现在按运行时选择绑定：Bun 宿主用 `bun:ffi`，Node 宿主用 Koffi。Node 路径与此前实现逐字节一致。Bun 路径通过 `dlopen` 加载 `kernel32.dll`，用 UTF-16LE 缓冲区转换封装 `MoveFileExW`/`GetLastError`，镜像目录选择器的 `bun:ffi` 移植。该包新增环境声明 `src/bun-ffi.d.ts`（仓库固定 `types: ["node"]`），win32 单元测试套件在两种运行时下参数化运行，配以模拟的 kernel32 世界——Koffi 模拟原生解码 `str16` 参数，`bun:ffi` 模拟把 `ptr` 地址回环成绑定构建的 UTF-16 缓冲区。真实 Windows 集成套件（`jsonl.spec.ts`）现在在 Bun 宿主上实测真实的 `bun:ffi` kernel32 绑定。

选择器 worker 将每个构造的 `CFunction` 在进程生命周期内保持引用，并在结果放到 IPC 通道后以 `process.exit(0)` 退出，跳过 Bun 运行缺陷 finalizer 的自然 teardown 过程。消息在退出回调执行前已刷新，父进程始终能看到结果。

## 备选方案

**仅加守卫：在 Bun 宿主上以 loud error 拒绝加载 koffi。** 已否决：它能阻止崩溃，但会让 Windows 会话持久化在 Bun（主要宿主）下不可用，`dsh web` 能启动却无法创建会话。

**升级到 1.3.14 之后的 Bun。** 已否决：1.3.14 已是最新稳定版；修复必须落在代码里。

**按 vtable 槽位复用单个 `CFunction` 而非每次调用新建。** 已否决：对象变少只是减少 finalizer 抖动，并未根除——worker 仍会创建瞬态对象（`read.ptr` 结果、缓冲区），收集器仍可能回收它们。进程生命周期内保持引用才能根除这一类问题。

## 后果

- `dsh web` 在 Windows+Bun 下不再于主进程加载 `koffi.node`；session 持久化 win32 路径改由 `bun:ffi` 绑定 kernel32 并正常工作。
- 选择器 worker 不再运行 teardown GC finalizer，消除了第二个崩溃报告背后的段错误类别。
- `sandbox-windows-acl`（顶层 `import koffi`）和 `fs-local`（懒 `import('koffi')`）带有同样的潜在 Bun 敌意模式。两者目前均未被 web/headless 组合挂载，本次改动不触碰它们；若未来某组合挂载它们，需要同样的双运行时处理。
- win32 单元套件翻倍（7 个测试 x 2 运行时），覆盖率门禁（`test:coverage`）通过模拟的 kernel32 世界在每个宿主上仍能看到两条绑定路径。