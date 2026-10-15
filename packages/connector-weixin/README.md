# WeChat Personal Connector

`@clowder-ai/connector-weixin` packages iLink long polling, message normalization, QR login, media transfer,
typing, and reply delivery for a Clowder AI Host.

## Configuration

The Host projects the Bot Token and optional media behavior explicitly from the manifest. The Bot Token is
written only by the `weixin_qr_login` operation target — it is hidden and optional so the plugin can start
healthy (idle) before credentials exist. Relative Host media URLs have no package-side base URL override
anymore: outbound media with a relative URL fails closed with a clear error instead of being silently sent.

## Security and authority

The Host owns installation, grants, credentials, connector bindings, wake policy, delivery, and durable
checkpoint state. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

The iLink polling cursor and context tokens use the existing Host-owned state surface. They must not be stored
in package-local files or ambient Redis. Rollback drains polling before the preserved Core adapter starts.

Inbound CDN locators share that manifest-declared private state surface but never enter the Host envelope,
logs, or transcript. Public messages carry only a `pmr_*` reference plus `sourceEventId`; the declared media
source serves bounded chunks and settlement deletes the locator.

The Host-loadable builtin runtime is implemented in this package and uses only the existing Host-owned
binding, configuration/secret, state, and messaging surfaces.

## Exposed capability

The package contributes one WeChat identity and message subscription and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`, `message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It also declares the `weixin_qr_login` operation (`qr-generate` / `qr-status` / `disconnect`) and a `weixin.test` connection check. QR login
obtains a Bot Token but leaves credential persistence and activation under Host control.

## 迁移已知差异

- **配置与启用独立**：保留原扫码配置流程，不增加权限初始化、旧权限导入或手动配置 JSON 的步骤；Host 侧配置/扫码可用性与启用意图分别验收。
- **语音三项 lost runtime env override**：`voiceItemMode`（保持无默认值——未设置本身有独立语义）、`enableUnsafeVoiceModes`、`captureInboundVoiceMedia` 现在全部 hidden，只能通过包配置 A/B 调整，不再有运行时环境变量覆盖入口。
- **`apiBaseUrl` 已删除**：出站媒体只接受 Host 授权的 `hmr_*` 引用，并在 outbound action 返回前通过 `media.read` 读完；旧的相对 URL、绝对路径与裸引用不再读取，改为向用户显示媒体不可用提示。
- **凭据只经由 operation target 写入**：Bot Token 仅通过 `weixin_qr_login` 的 `targetValues` 由 Host 持久化，包内不写 `context.storage`、不打印凭据。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值，而不是旧 Hub 的实时连接状态；实时状态请使用 `weixin.test`（有 token 且轮询活跃才返回 ok）。

## Commands and configuration

The builtin entrypoint intercepts `/where`, `/new`, `/threads`, `/use`, `/thread`, `/commands`, `/cats`,
`/status`, `/history`, `/unbind`, `/allow-group`, `/deny-group`, `/focus`, and `/ask` before ordinary ingress.
Commands reply through the provider and keep their audit quiet. Only an explicit body in `/thread` or
`/ask` requests Agent invocation; successful delivery is acknowledged only after the Host accepts it.
`/use` traverses the owner-visible live thread inventory beyond the first 50 rows, deduplicates IDs and
rejects a non-progressing or exhausted traversal instead of selecting from an incomplete list.

This adapter supports direct conversations only. Configure the original account/login fields and receive messages;
there is no group-permission page, permission initialization or legacy-import step. Group management commands
do not grant a direct-message sender administrator authority. Existing stored data is not deleted.
