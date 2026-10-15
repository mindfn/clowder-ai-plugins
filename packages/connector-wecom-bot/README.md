# WeCom Bot Connector

`@clowder-ai/connector-wecom-bot` packages WeCom intelligent-bot WebSocket ingress, proactive replies,
frame-bound streaming, template cards, and encrypted media transfer for a Clowder AI Host.

## Configuration

- `botId`: WeCom intelligent-bot identity.
- `botSecret`: secret used only to authenticate the provider WebSocket session.

Both fields are user-pasted in the plugin configuration (the package has no QR login). The
`wecom_validate` operation (`测试并连接` / `断开连接`) tests the credentials against the provider
without starting a messaging stream. The Host saves successful credentials and preserves enable intent:
enabled instances reload their connection; disabled instances stay stopped. The package does not read repository `.env` files or
ambient Host configuration.

## 迁移已知差异

- **面板里填好即可直接「测试并连接」**：未保存的输入优先；验证成功后凭据由 Host 持久化。操作不改变启用意图，停用时不建立消息连接，已启用时由 Host 重载新配置。
- **validate 失败不再回滚已存凭据**：旧版 stream 起不来会自动清空已写入的凭据；新版验证失败只是不连接，已保存的配置值保留，需 owner 自行修改。
- **凭据只经由 operation target 写入**：`wecom_validate` 的 `targetValues` 回写 botId/botSecret（disconnect 置空），包内不写 `context.storage`、不打印凭据。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值（配置级）；实时连接状态请使用 `wecom-bot.test`（WebSocket connected 才返回 ok）。

## Security and authority

The Host owns installation, grants, secrets, connector bindings, wake policy, delivery, and durable state.
Inbound provider messages target only an authenticated Host-issued `connector_binding`. Group `@bot` text
may be normalized as provider syntax, but package text never decides Host admission or wake authority.

## Lifecycle and recovery

Disable and rollback drain the WebSocket, timers, cached frames, and active streams before another runtime
starts. Resume state and deduplication watermarks must use a Host-owned, manifest-declared checkpoint after
accepted delivery; package-local files, ambient Redis, and inventory snapshots are not substitutes.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding, declared configuration/secret, state, and messaging surfaces; C1 does not add another public wire.

Inbound encrypted-media locators remain in manifest-declared private plugin state. Public messages carry
only a `pmr_*` reference and `sourceEventId`; the declared media source decrypts into bounded chunks and
settlement removes the locator.

## Exposed capability

The connector contributes WeCom messaging and a media source, and requests `plugin.config.read`,
`plugin.state.get`, `plugin.state.set`, `media.read`, `message.event.subscribe`, `messaging.send`,
`secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It also declares the
`wecom_validate` operation (`测试并连接` / `断开连接`) and a `wecom-bot.test` connection check. It does not expose C2 audio
services, mention parsing, public UI slots, or generic public hooks.

## Commands and configuration

The builtin entrypoint intercepts `/where`, `/new`, `/threads`, `/use`, `/thread`, `/commands`, `/cats`,
`/status`, `/history`, `/unbind`, `/allow-group`, `/deny-group`, `/focus`, and `/ask` before ordinary ingress.
Commands reply through the provider and keep their audit quiet. Only an explicit body in `/thread` or
`/ask` requests Agent invocation; successful delivery is acknowledged only after the Host accepts it.
`/use` traverses the owner-visible live thread inventory beyond the first 50 rows, deduplicates IDs and
rejects a non-progressing or exhausted traversal instead of selecting from an incomplete list.

Group whitelist, administrators and the group-command restriction keep their original configuration semantics.
Use normal configuration controls; no permission JSON, separate initialization or legacy import is required.
The initial group whitelist and command restriction are off and the administrator list is empty.
Group management commands still require an explicitly configured administrator; an empty list grants nobody administration.
