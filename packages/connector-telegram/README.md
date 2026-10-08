# Telegram Connector

`@clowder-ai/connector-telegram` packages Telegram Bot long-poll ingress and Bot API egress for a Clowder AI
Host. It accepts private human messages, preserves Telegram message and file IDs, renders safe Telegram HTML,
splits messages without cutting surrogate pairs or HTML entities, and drains polling before shutdown.

## Authority boundary

The Host owns the bot token, connector/thread bindings, admission and wake routing, durable polling cursor,
delivery retry/dead-letter state, grants, and lifecycle. The package never derives wake authority from `@`
text and never writes an undeclared local cursor. Provider updates are sent only through a Host-issued opaque
`connector_binding` address.

## Configuration

`botToken` is a required secret issued by BotFather. The Host must project only this manifest-declared value;
the package does not read repository `.env` files or log the token.

## Safety and recovery

Only private, non-bot messages enter the connector. Long polling has bounded conflict backoff and closes the
Bot API session on drain. A Host-owned cursor is committed only after accepted delivery so restart and
rollback do not double-run the package and preserved Core poller.

The Host-loadable builtin runtime is implemented in this package and uses only the existing Host
config/secret, connector-binding, messaging, and state surfaces. Adapter exports remain testable with
isolated fixtures.

Inbound Telegram file IDs remain in manifest-declared private plugin state. Public messages contain only a
`pmr_*` reference and `sourceEventId`; the declared media source serves bounded chunks and settlement deletes
the private locator.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `media.read`, `plugin.state.get`,
`plugin.state.set`, `message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`,
`thread.write`.

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
