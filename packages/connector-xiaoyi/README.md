# XiaoYi Connector

`@clowder-ai/connector-xiaoyi` packages XiaoYi OpenClaw dual-WebSocket ingress and A2A egress for a Clowder
AI Host. It preserves provider authentication, heartbeat, bounded reconnect, session task ordering, duplicate
suppression, append accumulation, and explicit completion or failure frames.

## Configuration

- `accessKey`: XiaoYi OpenClaw access key.
- `secretKey`: XiaoYi OpenClaw secret key. The Host stores and projects it as a secret.
- `agentId`: XiaoYi agent identity used for authentication and session addressing.

The package does not read repository `.env` files or ambient Host configuration.

## Security and authority

The Host owns installation, grants, configuration, secrets, connector bindings, wake policy, and durable
checkpoint data. Inbound provider messages target only an authenticated Host-issued `connector_binding`;
message text, including `@`, cannot mint a binding or wake an Agent. Credentials are used only for the
provider WebSocket handshake and are never emitted in message payloads.

## Lifecycle and recovery

The adapter opens primary and backup WebSocket channels only after Host activation, stops both channels and
all timers during drain, and keeps provider retry bounded. WebSocket resume and deduplication watermarks must
be committed through a Host-owned, manifest-declared checkpoint namespace after accepted delivery.

The Host-loadable builtin runtime is implemented in this package and uses only the existing authenticated
binding, declared configuration/secret, state, and messaging surfaces. The package intentionally provides no
local-file, ambient Redis, or environment fallback.

## Exposed capability

The connector contributes XiaoYi messaging and requests `plugin.config.read`, `plugin.state.get`, `plugin.state.set`, `message.event.subscribe`, `messaging.send`, `secret.read`, `thread.readContent`, `thread.listMetadata`, `thread.write`. It does not expose audio
capture, ASR, TTS, embedding, LLM post-processing, mention parsing, public UI slots, or generic public hooks.

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
