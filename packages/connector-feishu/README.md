# Feishu / Lark Connector

`@clowder-ai/connector-feishu` packages authenticated Feishu/Lark webhook and long-connection message
parsing, interactive cards, media transfer, token refresh, and QR credential setup for a Clowder AI Host.

## Configuration

The Host projects only the declared App ID, App Secret, connection mode, optional verification token, and
optional group mention aliases. The package does not read repository `.env` files or ambient Host state.

## 迁移已知差异

- **新装走扫码要先把连接模式设成 WebSocket 并保存**：默认的 webhook 模式下 `verificationToken` 必填，配置不就绪就不能启用插件。旧版扫码同样会强制切到 websocket，行为一致，但新装 owner 需要知道先改连接模式。
- **`groupBotMentionsJson` 没有 owner 入口**：群 @bot 别名映射只能通过包配置调整，配置面板不暴露该项。
- **扫码的 target 去掉了 `verificationToken`**：QR 登录回写的 targetValues 不再包含 verificationToken（webhook 校验 token 走普通配置项）。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值，而不是旧 Hub 的实时连接状态；实时状态请使用 `feishu.test`。

## Security and authority

The Host owns installation, grants, secrets, webhook admission, connector bindings, wake policy, delivery,
and durable state. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

Tenant tokens and downloaded media are transient runtime data. Rollback drains the package connection before
the preserved Core adapter starts, while Host-owned bindings and configuration remain unchanged.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding and declared configuration/secret surfaces. No package-local persistence fallback is provided.

Inbound provider media locators remain in manifest-declared private plugin state. Public messages expose
only a `pmr_*` reference plus `sourceEventId`; the declared media source serves bounded chunks and removes
the locator when the Host settles the import.

## Exposed capability

The connector contributes one Feishu identity, message subscription, media source, and verified webhook,
and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`,
`message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. QR setup
obtains credentials but does not transfer Host configuration authority.

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
