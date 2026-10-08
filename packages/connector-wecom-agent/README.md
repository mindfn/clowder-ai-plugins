# WeCom Agent Connector

`@clowder-ai/connector-wecom-agent` packages WeCom custom-application callback verification, AES-256-CBC
decryption, normalized text/media ingress, token refresh, message sending, media transfer, and byte-bounded
reply chunking for a Clowder AI Host.

## Configuration

- `corpId` and `agentId`: WeCom enterprise and application identifiers.
- `agentSecret`: secret used only to obtain short-lived provider access tokens.
- `callbackToken`: secret used to authenticate callback signatures.
- `encodingAesKey`: secret used to decrypt callback bodies and URL-verification challenges.

The package does not read repository `.env` files or ambient Host configuration.

## Security and authority

The Host owns installation, grants, configuration, secrets, webhook admission, connector bindings, wake
policy, delivery, and durable state. Callback bodies are accepted only after signature, decryption, and corp
identity verification. Ordinary message text, including `@`, cannot mint a binding or wake an Agent.

## Lifecycle and recovery

Provider access tokens are short-lived process caches. Host webhook routing must drain before rollback so
the package and preserved Core callback handler never consume the same event concurrently. The package does
not persist callback bodies or credentials.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding and declared configuration/secret surfaces. No package-local environment or persistence fallback is
provided.

Inbound provider media IDs remain in manifest-declared private plugin state. Public messages expose only a
`pmr_*` reference plus `sourceEventId`; the declared media source returns bounded chunks and settlement
deletes the private locator.

## Exposed capability

The connector contributes one authenticated webhook, one WeCom message subscription, and one media source,
and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `media.read`,
`message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It does not
expose C2 audio/AI services, mention parsing, UI slots, or generic public hooks.

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
