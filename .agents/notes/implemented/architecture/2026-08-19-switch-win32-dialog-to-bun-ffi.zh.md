# Agent Note: 将 win32 文件夹对话框从 koffi 切换到 bun:ffi

Status: implemented

[English](2026-08-19-switch-win32-dialog-to-bun-ffi.md) | 中文

## 问题

原生目录选择器的 win32 层通过 koffi 驱动 `IFileOpenDialog` COM 会话，而 koffi 是 Node 原生插件：它经由 N-API/`process.dlopen` 加载，在 Bun 的 JavaScriptCore 运行时下无法使用。因此该层必须用真实的 `node` 二进制启动 worker——要么显式配置 `DSH_WIN32_DIALOG_NODE`，要么在 PATH 中搜索——而选择器的其余各层都在进程内运行。随着本仓库自身改为 Bun 优先（`bun.lock`、`bun --bun`），只部署 Bun 的环境在选择目录时会报「no real Node.js binary found for the Win32 folder dialog」，除非 PATH 上恰好另装了一个 Node。一个对话框层不应让整个应用再背上第二种运行时。

基于线程的 abort 关闭机制同样只依赖 Node 独有的机制：worker 上报其线程 id（`showing` 协议消息、bindings 上的 `currentThreadId`），driver 通过 `PostThreadMessageW` 向该线程投递 `WM_CLOSE`。要在 `bun:ffi` 下达到同样的线程态，需要带回调的 `EnumThreadWindows`，而 `JSCallback`——给 `CFunction` 提供回调体的机制——在 Windows Bun 1.3.14 上是坏的（`cb.ptr` 为 undefined 且调用抛错）。

## 决策

win32 文件夹对话框现在是一个 Bun 子进程。`spawnDialogWorker` 启动 `process.execPath`——在 Bun 下，`bun <worker>` 直接运行 `.ts` 源码（无需真实 Node、无需 `DSH_WIN32_DIALOG_NODE`、无需 PATH 搜索）；Node 宿主在源码平面上仍通过 `node --import tsx/esm` 运行 worker。worker 通过 `bun:ffi` 运行同一条 `IFileOpenDialog` 会话：`dlopen('ole32.dll')` + `CoInitializeEx` + `CoCreateInstance`，用 `new CFunction({ ptr, args, returns, cfa: 'stdcall' })` 构建 vtable 调用且 self 指针作为显式第一个参数，返回的路径经 `CoTaskMemFree` 释放的缓冲区读取。ABI 事实（vtable 槽位、GUID、`SIGDN_FILESYSPATH`、FOS 标志、`WM_CLOSE`、DPI 上下文）统一放在 `win32-dialog-abi.ts`，作为 bindings 唯一的事实来源。

abort 关闭不再需要 worker 的线程 id。driver 按窗口标题关闭对话框：对通过 `SetTitle` 设置的精确标题执行 `FindWindowW(null, <caption>)` + `PostMessageW(hwnd, WM_CLOSE)`，每隔 `CLOSE_RETRY_MS` 重试至多 `CLOSE_MAX_ATTEMPTS` 次，并以 `worker.kill()` 作为兜底。这之所以可行，是因为对话框对其所在子进程是模态的：标题已知、窗口是顶级窗口、且永远不需要 `JSCallback`。worker 协议缩减为 `{kind:'done',path}` | `{kind:'error',message}`；`showing`、`currentThreadId`、`onShowing` 均被删除。

子进程形态被刻意保留：对话框的消息循环与选择器进程隔离（crash isolation），且选择器进程在繁忙桌面上获得首窗激活。

本包的 `bun:ffi` 类型面在 `src/bun-ffi.d.ts` 中以环境方式声明，因为仓库固定 `types: ["node"]` 且未携带 `bun-types`。

## 考虑过的替代方案

**保留 koffi，用真实 Node 启动 worker，并硬性要求 `DSH_WIN32_DIALOG_NODE`。**拒绝：它让选择器为单个对话框继续依赖第二种运行时，并保留了本次变更要消除的「no real Node.js binary found」失败类别。

**通过 `EnumThreadWindows` + `JSCallback` 做线程关闭。**拒绝：`JSCallback` 在 Windows Bun 1.3.14 上损坏（`cb.ptr` undefined，抛错）。即便回调可用，也仍需要本次标题关闭方案删掉的 `showing`/线程 id 协议。

**在选择器进程内直接驱动对话框（无 worker）。**拒绝：失去 crash isolation 和首窗激活，且选择器进程未必是前台属主。

**只保留真实 Node 子进程 + `node --import tsx/esm` 一条路径。**拒绝：在 Bun 部署中，子进程与其父进程属于不同运行时，仍然需要一个 Node 安装。

**在 Bun 下垫平 koffi 的原生绑定。**拒绝：koffi 分发的是预编译的 Node 插件 ABI，没有 Bun 加载路径。

## 后果

- win32 选择器现在要求 Bun 宿主；在 Node 宿主上，worker 在任何 FFI 加载之前就会明确拒绝（「requires the Bun runtime」）。构建产物 `lib/worker.cjs` 在纯 Bun 下运行，保持 `./worker` 包导出形态。
- `koffi` 从本包依赖中移除。`sandbox-windows-acl` 与 `session-persistence-jsonl` 仍依赖它，未做改动。
- `DSH_WIN32_DIALOG_NODE`、真实 Node 解析、`closeThreadWindows`、`currentThreadId`、`showing` 协议字段均从本包消失。
- win32 真实对话框 smoke 测试（win32 + Bun 门控）现在会真实打开并用 abort 关闭一个对话框，验证 `Show` 显式传入 `null` owner 句柄（`IModalWindow::Show(HWND)` 需要 owner 参数；省略它会返回 `E_INVALIDARG`）。
- `built-worker.e2e.ts` 守卫保持其正则契约（`/ole32|requires the Bun runtime/i`），并按设计在 win32 上跳过。
- 重新引入条件：如果 Bun 提供原生对话框 API，或 `JSCallback` 在 Windows 上变得可靠，可把标题关闭替换为线程关闭。