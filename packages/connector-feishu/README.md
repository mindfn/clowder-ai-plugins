# Feishu / Lark Connector

`@clowder-ai/connector-feishu` packages authenticated Feishu/Lark webhook and long-connection message
parsing, interactive cards, media transfer, token refresh, and QR credential setup for a Clowder AI Host.

## Configuration

The Host projects only the declared App ID, App Secret, connection mode, optional verification token, and
optional group mention aliases. The package does not read repository `.env` files or ambient Host state.

## 迁移已知差异

- **配置与启用独立**：App ID / App Secret 保留原必填约束；扫码可在停用时完成，challenge 由 Host operation state 保存，轮询不依赖运行实例。成功后 Host 保存凭据，保持原启用意图；启用时才运行消息连接。
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
