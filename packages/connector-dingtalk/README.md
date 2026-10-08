# DingTalk Connector

`@clowder-ai/connector-dingtalk` packages DingTalk Stream ingress and OpenAPI/AI Card egress for a Clowder AI
Host. It parses direct and group messages, preserves provider message IDs and media download codes, sends
bounded text/markdown/media replies, and shuts down the Stream client during Host drain.

## Authority boundary

The Host owns installation, grants, configuration and secrets, connector-to-thread bindings, admission,
wake routing, retry/dead-letter policy, and lifecycle supervision. The package never parses `@` text to
invent wake authority and never mints a connector-binding handle. It requires the Host to supply a verified
opaque `connector_binding` handle for inbound delivery and the corresponding external DingTalk coordinate
for outbound delivery and restart recovery.

## Configuration

- `appKey` is the DingTalk enterprise application App Key.
- `appSecret` is a secret and must be projected only from the manifest-declared Host configuration.

The package does not read a repository `.env` file and does not persist credentials. DingTalk access tokens
remain runtime-ephemeral. Group conversation identifiers may be checkpointed only through a Host-owned
store injected into the adapter.

Inbound provider media locators are retained only in the package's manifest-declared private state. The
public message carries a `pmr_*` reference and `sourceEventId`; the Host reads bounded chunks through the
declared media source, then settlement removes the private locator.

## Safety and recovery

Provider HTTP errors fail closed. Media upload and download responses are bounded by the provider contract;
error text must not include credentials. Disabling or draining the plugin closes the Stream connection before
the preserved Core adapter can be restored, preventing double consumption.

The Host-loadable builtin runtime is implemented in this package and consumes only the existing Host-owned
config/secret, binding, state, and messaging surfaces. Adapter exports are usable for isolated provider
conformance tests without claiming that synthetic handles constitute production activation.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `plugin.config.read`,
`plugin.state.get`, `plugin.state.set`, `media.read`, `message.event.subscribe`, `messaging.send`,
`secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`.

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
