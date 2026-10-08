# WeCom Bot Connector

`@clowder-ai/connector-wecom-bot` packages WeCom intelligent-bot WebSocket ingress, proactive replies,
frame-bound streaming, template cards, and encrypted media transfer for a Clowder AI Host.

## Configuration

- `botId`: WeCom intelligent-bot identity.
- `botSecret`: secret used only to authenticate the provider WebSocket session.

Both fields are user-pasted in the plugin configuration (the package has no QR login). The
`wecom_validate` operation (`测试并连接` / `断开连接`) tests the credentials against the provider
and starts or stops the in-process stream. The package does not read repository `.env` files or
ambient Host configuration.

## 迁移已知差异

- **面板里填好即可直接「测试并连接」**：在 `wecom_validate` 面板里粘贴 Bot ID / Secret（未保存的输入值优先），点击「测试并连接」即完成真实 WebSocket 验证；成功后凭据作为 operation target 持久化并建立进程内连接，无需先停用插件或预先保存配置。旧 Hub 在 operation 面板内粘贴、validate 成功才持久化，用户旅程一致。
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

## Commands and owner permission recovery

The builtin entrypoint intercepts `/where`, `/new`, `/threads`, `/use`, `/thread`, `/commands`, `/cats`,
`/status`, `/history`, `/unbind`, `/allow-group`, `/deny-group`, `/focus`, and `/ask` before ordinary ingress.
Commands reply through the provider and keep their audit quiet. Only an explicit body in `/thread` or
`/ask` requests Agent invocation; successful delivery is acknowledged only after the Host accepts it.
`/use` traverses the owner-visible live thread inventory beyond the first 50 rows, deduplicates IDs and
rejects a non-progressing or exhausted traversal instead of selecting from an incomplete list.

Permission state starts **uninitialized**, not permissive. After the declared runtime is available, use
Settings “读取当前权限”, edit the visible whitelist/admin/group fields, then explicitly confirm
“应用权限设置”. Reading does not initialize state; saving requires the displayed revision. If a concurrent
change makes the form stale, read it again before saving. An explicitly empty admin list stays empty.
Group facts come from the authenticated provider adapter; direct-only integrations do not invent groups.

“一次性导入旧权限” accepts only the bounded raw snapshot supplied by the owner-authorized Host cutover
tool, after confirmation; the package never connects to legacy Redis. It recomputes the snapshot digest
and inserts permission state only when absent. The same untouched digest returns `already_applied`;
existing or subsequently edited state returns `preserved_existing`, never an overwrite. Disabling the
plugin preserves this state. Keep the old Host implementation and hashes until actual replacement and
no-double-run verification pass; archive tests alone do not authorize their deletion.
