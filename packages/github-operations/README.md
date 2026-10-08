# GitHub Operations

`@clowder-ai/github-operations` runs GitHub tracking and repository collection
inside an installed builtin plugin. Development status and the remaining C1
migration evidence are in `migration/STATUS.md`; this W3 work is not yet a
release or a completed three-source installation acceptance.

## Use

Install and enable through Settings. Configure an optional Personal Access Token
in the secret field, or use the machine's existing authenticated canonical
`gh` session. Never paste credentials into a conversation or tracking arguments.
The optional setup-noise login list filters known setup-only conversation noise.

Discover the active tools through the Host's generic `plugin_list_tools` and
invoke their exact schemas through `plugin_call`. Register a PR/issue with its
repository, number, destination thread and notification recipient. Repository
registration enables an inbox for new contributions. A first scan records the
existing baseline silently; subsequent changes become ordinary messages.

Tracking state, cursors, deduplication, Community facts and projections belong to
the package's private SDK storage. No registration means no GitHub poll requests.
Closing or merging a tracked subject retires tracking after the final collection
and delivery. Unregistering preserves history. Disabling the plugin aborts
provider work and waits for cleanup.

## Webhooks and resources

The optional repository webhook uses the declared `github/events` path and a
separate `webhookSecret`. Use the exact callback URL exposed by the Host.
The package checks HMAC over the original request bytes and accepts only
registered repositories. It shares event identities with polling.

Seven declared schedules drive tracking and repository collection. Direct tools and
the included skill use the Host's existing generic registration mechanisms.
The retired GitHub MCP server is not revived; MCP callers use the generic
plugin management tools. The legacy `mcpToken` configuration key is retained
for inventory continuity; this runtime does not start a GitHub MCP transport.

## Authority and recovery

The Host owns installation grants, thread access, storage mechanics and generic
message/wake delivery. The plugin owns GitHub fetch/filter/decision/tracking
business. Repository content, tool arguments and message metadata never become
caller identity, action custody, approval or merge/publish authority.

Polling uses canonical `gh` without a shell. Failed event collection does not
advance tracking cursors or retire a terminal subject; pending message delivery
is retained for retry. Historical Host state is not deleted or imported
implicitly. Host cutover must separately prove replacement and no double-run
before retiring old consumers.

The owner-confirmed legacy metadata copy operation accepts an isolated, bounded
raw snapshot from the Host migration adapter. It only inserts missing issue
metadata; existing records, Host assignments/signoff/routes/drafts and tracking
remain unchanged. The adapter and real-data cutover are still pending. The
`github_issue_metadata` tool reads copies as private metadata, never governance
truth. Exact input and recovery semantics: `migration/legacy-state-disposition.md`.

## Acceptance

npm, local-directory and fixed-Git-revision installation must each demonstrate
real Host install → enable → run. Canonical or self-contained archive verification
is a separate requirement and cannot substitute for any of those three sources.

Requested Host capabilities (from `plugin.yaml`): `schedule.register`,
`plugin.config.read`, `secret.read`, `plugin.state.get`, `plugin.state.set`,
`thread.listMetadata`, `thread.write`, `messaging.send`.
