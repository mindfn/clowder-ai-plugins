# GitHub Operations

`@clowder-ai/github-operations` runs GitHub tracking and repository collection
inside an installed builtin plugin. Development status and the remaining C1
migration evidence are in `migration/STATUS.md`; this W3 work is not yet a
release or a completed local installation acceptance.

## Use

Install and enable through Settings. Configure an optional Personal Access Token
in the secret field, or use the machine's existing authenticated canonical
`gh` session. Never paste credentials into a conversation or tracking arguments.
The optional setup-noise login list filters known setup-only conversation noise.

The plugin declares its native `github-tracking` MCP server. Use
`cat_cafe_register_pr_tracking`, `cat_cafe_register_issue_tracking` and
`cat_cafe_unregister_tracking` with their advertised schemas. A registration
takes repository, number and a unique `registrationId`; reuse that ID and the
same arguments after an unknown response. Host authenticates the current cat,
thread and invocation; these identities are not tool arguments. A fresh live
baseline is silent; subsequent matching changes become ordinary messages.
Repository registration separately enables the repository inbox.

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

Five declared schedules drive tracking and repository collection. One PR poll
reads the complete snapshot for all armed predicates; issue tracking has its own
poll. The plugin's native MCP process calls its active module through the SDK's
authenticated action transport. Background work uses in-process SDK ports.
The retired external GitHub MCP integration is not revived. The legacy `mcpToken`
configuration key remains for inventory continuity and is not an action credential.

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

Provider predicates, baselines, registration receipts and renewal remain private
to the plugin. Before sending a wait notification, the module publishes the
neutral generation/outcome through `tasks.setWait`. A failed projection retains
the outbox. The Host supplies instance and invocation identity and consumes that
projection for continuation; the plugin cannot supply authority fields.

The private review predicate provider requires the owner-visible L2
`custody.verify` grant. It checks the assigned reviewer against private state and
reads the current open PR HEAD; its methods are not tools or ordinary actions.
The Host still selects the installation, binds each lease generation and commits
completion. Current migrated review records lack an authenticated publisher
association, so delivery verification returns `insufficient` even when the exact
GitHub review exists. No successful review completion is claimed by this source
checkpoint. The rebuilt archive and Host installation journey remain pending.

The owner-confirmed legacy metadata copy operation accepts an isolated, bounded
raw snapshot from the Host migration adapter. It only inserts missing issue
metadata; existing records, Host assignments/signoff/routes/drafts and tracking
remain unchanged. The adapter and real-data cutover are still pending. The
`github_issue_metadata` tool reads copies as private metadata, never governance
truth. Exact input and recovery semantics: `migration/legacy-state-disposition.md`.

## Acceptance

Current migration acceptance is an isolated Host worktree with a local-directory
installation: native MCP registration → provider change → notification and Host
continuation → disable/reload → no duplicate old caller. Archive integrity alone
does not prove this journey. npm, remote Git, public release and soak are later
distribution work, not prerequisites for fresh local acceptance.

Requested Host capabilities (from `plugin.yaml`): `schedule.register`,
`plugin.config.read`, `secret.read`, `plugin.state.get`, `plugin.state.set`,
`task.read`, `task.write`, `thread.listMetadata`, `thread.readContent`,
`thread.write`, `messaging.send`, `custody.verify`. `thread.readContent` is an
explicit L2 grant required by the current Host's reliable thread point lookup;
installation must display and obtain it rather than infer consent.
