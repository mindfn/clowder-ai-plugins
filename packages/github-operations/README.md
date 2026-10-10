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
checkpoint. The Host installation journey remains pending.

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
`thread.write`, `messaging.send`, `custody.invoke`, `custody.verify`, `deployment.read`,
`frustration.read`, `frustration.link`. The last three are separate explicit L2
grants; no grant is inferred from installing the plugin. `thread.readContent` is an
explicit L2 grant required by the current Host's reliable thread point lookup;
installation must display and obtain it rather than infer consent.


### Community HTTP composition

The source module now activates the embedded Community router with 33 method/path
pairs in 29 owner-only webhook declarations. The dispatcher is not a tool, MCP
action or Settings operation; native-context calls to it are rejected. It shares
the collector's projection queue and uses guarded SDK thread/source ports.
Publishing repositories are read from `publishRepositories` on each request and
again at the publication journal boundary. An empty list disables new drafts
and publishing while durable drafts remain readable.

This is source composition, not installed acceptance. Review settlement/publisher association, final
real Host identity/CAS/browser journeys remain
open. Owner HTTP does not mint a native caller for callback-only routes. The six
Community callbacks are now separately declared in native MCP and use the Host
second context. They cannot perform owner resolve or lease completion. Report
checks the exact public issue comment through the bounded repository-authorized
reader; this is issue closure evidence, not review publisher authentication. Missing
Host source ports fail explicitly; no source or deployment catalog is fabricated.

### Community narrator

Set both `narratorCatId` and `narratorThreadId` in plugin settings to opt into
manual dispatch triage. The cat must be available in the Host deployment catalog
and the thread must be accessible through the granted thread read capability.
The Host owns the cat's model and execution policy; the plugin does not import
roster roles, invent a model, or mint a native invocation.

Dispatch commits `discussing` and the frozen target/briefing in one private CAS.
The existing Community reconciler schedule materializes the durable message
outbox; Settings also exposes delivery status and retry. Failed outbox writes,
lost replies and module recreation retain the same source/idempotency key.
Changing either target setting pauses existing delivery, never redirects it;
restore the original settings and retry to resume. Empty settings disable new
intents; enabling later does not wake historical or disabled dispatches. Closed
or otherwise non-discussing cases do not admit new narrator sends. Stop joins
in-flight SDK sends and leaves uncertain outcomes for idempotent recovery.

Briefings name the declared native `github_community_triage_complete` callback.
The briefing is a request for triage, not authority for owner resolve, code
changes or lease completion. This source checkpoint covers manual dispatch and
recovery, not installed Host messaging or a real cat response journey. The fixed
migration source (`bb9f9f08`) only wired manual dispatch: its automatic eligibility
helper had no production caller. The package retains that pure helper and does
not add automatic admission or wake historical cases.

Native external-review submissions use `github_record_external_review_verdict`
with the assigned exact HEAD and lease generation. The current Host invocation
supplies identity; the tool does not publish a review or accept identity/time
fields. A delivered candidate is saved before the Host independently verifies
completion. `pending_verification` means the submission is durable, **not** that
review delivery or lease completion succeeded. Retry the identical submission
under a fresh native invocation after the missing verification becomes available;
background schedules never borrow the stored reviewer identity. The current
publisher association is unavailable, so matching GitHub objects alone remain
insufficient. This source integration requires the explicit `custody.invoke`
grant and is not an installed-acceptance claim.


PR notification polling admits at most 20 waits per tick using one scoped CI
base-fact batch. Required-check diagnostics and truncated rollup reads run inside
each PR's own 10-second deadline within the 30-second poll budget; failure leaves
that wait's baseline and generation unchanged. Configured credentials are resolved
again for each batch and per-PR CI read. Concurrent registration/cancellation is
rechecked before consuming the batch; pending notifications can recover even when
new batch facts are unavailable. These package regressions do not establish the
upstream distributable gate or installed Host acceptance.

### Artifact dependency closure

The alpha.16 production shrinkwrap pins contract beta.35, SDK beta.19 and the
embedded Fastify router with their transitive dependencies. Development archives
use the exact reviewed local contract/SDK bytes; their registry coordinates do
not claim those versions are published. A fresh consumer must resolve the packed
module and its production dependencies without workspace links. Archive checks
and isolated module fixtures do not replace real Host grant, identity, CAS or
browser acceptance.
