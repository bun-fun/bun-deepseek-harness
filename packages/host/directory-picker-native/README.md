# @deepseek-ai/dsh-host-directory-picker-native

English | [中文](README.zh.md)

The **native-OS-chooser backend** of the [directory-picker seam](../directory-picker/README.md): `NativeDirectoryPicker` registers `ctx.directoryPicker` with the `native` capability, whose `pick(signal)` opens one native chooser per call and resolves the chosen absolute path (`null` on cancel). Platform tools run without a shell: `osascript` on macOS and Zenity with a KDialog fallback on Linux; the caller's abort terminates the native process. Windows opens the modern `IFileOpenDialog` in a spawned child process — a `bun:ffi`-driven COM conversation on the child's main thread (Bun has no built-in dialog API) with the best thread DPI awareness the host accepts (per-monitor-v2 first), aborted by posting `WM_CLOSE` to the dialog window. Only viable when the operator sits at the host's display — remote deployments compose [`-browse`](../directory-picker-browse/README.md) instead. The command boundary (`DirectoryPickerRunner`) and platform facts are injectable. The shared no-shell subprocess runner lives in [`dsh-native-command`](../../util/native-command/README.md).

**Dual-face package**: the browser half (`./client`) registers a renderless flow occupant into [ui-workspace's](../../client/ui-workspace/README.md) two directory-flow holes — each `open` request drives `host.pickDirectory` and reports the one outcome (picked path / cancel / failure) through the hole's owner conversation. Both directory-flow declarations must be live before either contribution installs. One cordis.yml row therefore composes both sides of the native interaction; the client carries no capability-kind branching, and mounting a second flow package fails at load (the holes are `single` kind).

## Model Experience

None, as the backend serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Linux requires desktop tooling** — with neither Zenity nor KDialog installed, `pick` rejects with an actionable error; it does not fall back to a typed-path prompt (the browse backend is that fallback at the composition level).
- **Windows has no mechanism fallback** — the child-process picker driven by `bun:ffi` is the only native tier, so a COM refusal or dialog crash surfaces the failure. The browse backend remains the fallback at the composition level.
- **The Windows dialog requires a Bun host** — `bun:ffi` only exists on the Bun runtime, so `pick` rejects with an actionable error when a non-Bun process (e.g. a Node test runner) reaches the Win32 tier; Node hosts cannot open the native dialog.
