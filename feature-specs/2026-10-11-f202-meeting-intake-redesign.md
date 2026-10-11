---
feature_ids: [F202, F292]
topics: [plugins, meeting-intake, migration, lifecycle, authority]
doc_kind: implementation-plan
created: 2026-10-11
architecture-cell: plugin
---

# Meeting intake: owned records, SDK notification and installed MCP

Status: source-grounded candidate for the next original Task1843 work unit. No new
runtime, SDK export, setup lane, package release or installed acceptance is claimed.
The author remains the sole package writer. Host implementation remains its existing owner.

## Accepted goal and applicable source

The current C1 contract's **overview takes precedence over its old later sections**:
`docs/plans/2026-09-21-f202-c1-contract.md` in the Host feature checkout, overview
“迁什么” row11, plugin work c″, per-package meeting row and completion criteria.
It requires redesign rather than moving the obsolete Needs Me workflow: SDK send
notifications; plugin-owned meeting records and registered MCP reads. The old §6
“not in this PR” and F292's historical Host-owned credentials/intake/sourceGrant
are behavior history, not the current authority allocation. Operator deletion-first
source is `thread_mu8dg6h7l2x4ohsk#0001791597354169-000043-8e6a39d2`;
current terminal is `#0001791692969613-000094-97be6e64`, with C1 reminder096.
Task1843's accepted package continuation explicitly retains this redesign.

Before: find/download transcript, copy it to a thread and explain its provenance.
After: an authorized generated artifact has a durable plugin record; one ordinary
notification identifies it; a cat reads the exact recorded source through the
installed plugin MCP and the human supplies speaker/context/output judgment.
The human retains account authorization, source-read permission and destination
choice. No summarizer, household memory store, Needs Me producer or implicit
historical replay is added. C2 meeting cards remain outside package redesign.

## Source and concrete incompatibilities

Package starting source: clean `1a5d534b0890ce4cabfef9beef9caf06a2bbef11`;
meeting package remains alpha.10. It has no canonical YAML. Its manifest exposes
input-source/events.publish; entrypoint starts the broker handshake. Runtime source
normalization, bounded event/poll fallback, catch-up preview fingerprint and cursor
rules are reusable. The publication adapter and credential/source authority are not.

- `src/runtime.ts:flush` publishes the durable outbox head, then acknowledges it.
  `src/state-store.ts:acknowledge` removes the event. Once delivered, there is no
  persistent meeting index to serve the new MCP read. Outbox is not record custody.
- `src/artifact.ts:createFeishuTranscriptSourceAdapter` requires Host intakeId and
  sourceGrant. `src/gateway.ts:FeishuTranscriptGateway` explicitly assigns that lane
  to Host. Those cannot authorize reads after the specialized Host backend is removed.
- `src/lark-cli-gateway.ts` defaults to the process home; `lark-cli-runner.ts` gives
  the child HOME. Plugin ownership must not adopt operator-global credentials by
  choosing homedir. CLI credential isolation (including native keychain/backend),
  pinned binary acquisition and process-tree shutdown need executable evidence.
- The old resolver in Host `ca5b831b` supports minute and note transcript formats,
  2,000,000-byte text and temporary output cleanup. It does not prove exact revision
  parity: record reads must check the observed revision and honestly refuse stale
  or unavailable source, rather than labelling “latest” as the saved revision.

## Owner map and candidate lanes

Plugin owns account adapter, credential compartment, metadata index, source refs,
cursor, pending notification receipts and catch-up decision history. Source text
remains Feishu truth; any authorized local snapshot must retain its exact provenance
and no expiry by default. Host owns installation/digest/grants, user/thread/native
identity, module lifetime, target resolution and message dedupe. Source metadata
never supplies a Host user, thread or invocation identity.

Prefer the **existing** builtin module and declaration-activated stdio MCP carrier.
The MCP child follows W3's `createModuleActionClient` pattern: it receives only its
Host-issued action environment and runtime call metadata, then invokes the module's
private declared native methods. It gets neither the credential home nor direct
filesystem access to meeting records; no auxiliary listener, bearer config field,
Host callback meeting route or external stdio broker is added.

Candidate native methods: `meeting.records.list` (bounded metadata),
`meeting.records.read` (opaque record ID plus bounded text cursor). They require the
separate native context, current user/instance/grant and approved record/read scope
before and after asynchronous source work. A tool body cannot name another user,
record root, URL or target thread. Resource access through ordinary/HTTP/owner lanes
must fail closed. Final method/tool IDs, manifest grants and exact wire shape are
not frozen by this proposal.

Notifications use feature `messaging.send` and one Host-selected/granted destination,
not a source-selected target. Record and stable notification intent are persisted
before send; receipt is persisted after send. The 200-character MessageDraft key is
a fixed-length hash of instance + canonical source identity/revision, not the older
signal key (which may exceed that limit). Response loss must reuse the exact target,
key and payload through Host dedupe; it must not create a second source record or
clear pending state on failure. Destination changes cannot silently retarget an
uncertain send. Revoke/disable fences ongoing reads and effects, and never erases
records or authorization history.

## Pairing seam that must be resolved before activation implementation

Real current Host `InstalledPluginOperations.resolve` accepts only an installed,
**enabled + healthy** instance. Its commit fence repeats that condition; module
invocation resolves only an active module action table. Old Feishu device auth ran
before enable through special official-plugin routes. A direct mechanical migration
therefore cannot run its first connect action while the plugin is disabled.

An isolated executable probe calls the actual Host TypeScript service with an
in-memory disabled/stopped inventory: actual409, zero handler calls and zero config
writes. The proposed pre-enable journey's expected200 assertion fails. This is a
**candidate journey RED, not a defect in the current security guard** and not proof
of authenticated owner identity, installed resources or real device authorization.
Evidence and exact source hashes are in the linked receipt below.

Host owner must pair the existing generic control/activation lifecycle. Package
start must not start polling/login or adopt global credentials merely to make the
Manager guard green. Nor may the package mark an unauthenticated collector running.
A control-only activation, if the existing neutral lifecycle supports it, must
separately and honestly expose auth/config/collection intent/live status and require
fresh authorization plus explicit source intent before collection. If no such
existing lifecycle is sound, return the exact neutral setup seam for a jointly
frozen amendment; do not add a Feishu exception, weaken the current action guard,
use ambient owner/native context, or launch an untracked setup process.

## Retained consumers: classify, do not recreate obsolete business

Frozen Host `ca5b831b` has ten intake routes: list/get, repair/clear, confirm, dismiss,
retry, presentation-retry, regrant and manual-import. It also has two catch-up routes,
one official history-import route, two official auth routes and one callback
meeting-artifact read route. These are sixteen explicit route dependencies across
four source files plus official auth, not just `/api/meeting-intakes`.

The old confirm/destination/sourceGrant/Needs Me semantics are not equivalent to the
new record/read/notification model. Package redesign does not recreate them or
create new cards. Host owner must classify the retained C2 calls as valid existing
neutral forwards or visible unavailable/retired states with exact status/response
checks. Generic handling cannot resurrect deleted F292 backend or source leases.
Historical records/data are not migrated, deleted, replayed or granted by this work.
The old callback read/tool must not remain a second successful resource authority.

## Implementation and proof units

1. **Lifecycle pairing:** consume this source-grounded RED; freeze control/source
   activation and owner-authorized setup/catch-up tuple with Host. Matrix includes
   never-authorized first install, verified login, expired/probe-failed auth,
   disable/restart/stop/timeout/revoke and late results. Host owner returns exact
   existing surface or amendment; package writer implements only that pairing.
2. **Owned record + notification core:** replace events publication with SDK send;
   append-only source/revision identity plus a durable outbox/receipt. Test discovery,
   overlap/redelivery, concurrent manual import, disk-full, crash before/after send,
   lost receipt, restart, target revocation and schema migration using isolated data.
   Cursor may advance only with record and notification intent durably committed.
   Fsync files/directories and CAS/fences are required at effect boundaries.
3. **Package-owned account/read adapter:** preserve bounded provider logic, move
   relevant source/auth behavior from exact pre-delete blobs with named semantic
   deltas. Prove isolated credential scope, fixed device domains, secret-free product
   projection, current auth before collection/read, bounded subprocess output,
   timeout/abort/process-tree cleanup, note/minute and revision/deletion failures.
4. **Installed MCP and Manager presentation:** canonical YAML and generated manifest,
   builtin module lifecycle, stdio MCP native client, generic auth/catch-up/status
   operations. Read-only status/list cannot start/replay/repair. Catch-up keeps the
   existing scanned fingerprint and explicit future-only/replay choice; owner
   tuple/currentness is checked before CAS and effect. No Needs Me or old broker fallback.
5. **Artifact and actual directory journey:** freeze a new local version and exact
   contract/SDK graph after source review; prove packed physical closure in an empty
   consumer, then actual Host directory-select/install/grant/auth/enable/discovery/
   notification/MCP/disable/restart. Archive green is not raw-directory green. Current
   alpha.10's dependency/resource exemption remains history; closure must use Host's
   reviewed materialization policy, without quota exceptions or registry substitutions.

Relevant existing commands: `pnpm --filter @clowder-ai/feishu-meeting-intake typecheck`,
`pnpm --filter @clowder-ai/feishu-meeting-intake test`,
`pnpm --filter @clowder-ai/feishu-meeting-intake build`,
`pnpm test:train-c1-inventory`, `git diff --check`. The new behavior probes will be
implemented under TDD after pairing; none of those package commands is claimed run
on a redesign here. Full operator acceptance/soak/release/C1 remain open.

Architecture cell: plugin. Map delta: candidate authority inversion from historical
F292 Host source/intake custody to package record/read custody; requires exact Host
pairing before contract changes. Why: the accepted C1 overview cancels specialized
Needs Me/intake/source-grant integration while preserving ordinary notification and
source-bound authorized reading. No new operator value decision is needed.

[Probe, observation and source-binding receipt](</Users/lang/workspace/github-lab/f202-handoff/meeting-redesign-2026-10-11/source-receipt.json>)
