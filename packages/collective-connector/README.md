---
feature_ids: [F202]
topics: [plugins, collective, lifecycle, recovery]
doc_kind: package-guide
created: 2026-10-10
tips_exempt: Private migration implementation checkpoint; Host Settings discovery and user-facing recovery tips are paired in the Host implementation, not published by this package.
---

# Collective backend module

This private C1 migration candidate owns the existing Collective service and connector business code.
Source is pinned to `ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`; the separate byte-preserving move is
`4952f27c9306d34cae35cd44b672803f11ed4f48`. The local migration record names every source blob.

The builtin module activates the backend business using a browser-service binding supplied by the Host
before start. The Host owns the stable loopback origin, listener, retained Client resources, grants and
lifecycle. The package opens no listener and has no network fallback for local dispatch. It preserves
business state across disable and resumes an interrupted unclaimed owner bootstrap from a private
credential file. Status contains metadata and the bound API URL, never credentials. Host
Task/custody/principal decisions remain in the Host.

Client assets remain in the Host/C2 boundary. Asset paths cannot enter the declared business transport;
`clientBuildId` is a retained protocol label distinct from the actual asset digest. The private bootstrap URL is a backend handshake coordinate;
it is not a working owner onboarding UI. Settings install/enable/status and the current owner-local Service binding have paired Host evidence.
The authenticated owner HTTP adapter now restores the retained launch/status and existing connector
controls below; remaining authority-dependent controls and native/Host installed use are still open in aggregate task1843. This package remains `private: true` while that
work continues; this checkpoint makes no catalog, installed Settings, publication, or whole-C1 claim.

## Owner control HTTP

The existing Host authenticated webhook lane calls `collective.control.http`; it is distinct from the
browser-service action and native MCP identity. Declarations use the actual `official.collective-connector`
ID. The old root GET becomes `/api/plugins/official.collective-connector/connections`; individual
connection resources use `connections/:connectionId/...`. No anonymous verification secret is declared.

The original eleven owner method/path pairs remain: connections GET; service/provision
POST; inbox/route GET; reconnect/revoke POST; listening GET/POST; and work-policy GET/adopt/revoke.
`POST connections/:connectionId/work/reconsider` retains the original public reclassification request
under an adopted Service rule. It stores the purpose/message relationship alongside the retained private
Connector document, linked to its original inbox receipt; historical packages can still read that document.
It sends without ordinary wake, and then admits through the existing Host Queue after releasing the
connection fence. Replays restore the same entry; terminal unhandled requests remain refused.
The verifier and native callbacks reread the original source and selected rule/class, including queued
original input. Recall or deletion still refuses before launch. The complete installed user journey
remains unverified. Queue admission never means Work completion.
They call the moved connector algorithms. Listening/policy/route preserve local owner checks and
original request schemas. Raw route PUT also retains strict paired-Human targets, scoped revision CAS,
owned participant threads and standing-work channel bounds before `setHostRoute` / publication.
It explicitly opts into the existing Host roster quota fact: `available` is independent of native
`supported`. Default roster consumers retain their original strict shape. Unregistered Cats cannot
be invented from request data. This configuration does not create Task admission or execution
authority; real installed owner use still requires the matching approved Host projection. Unknown local sync/revoke outcomes remain visible 409 recovery states;
ordinary reconnect does not replay or clear a hold. Provision returns the existing `{service,launchUrl}`
shape from the current Host binding and persistent metadata, without starting a second listener.
Only this authenticated launch response contains an unclaimed private bootstrap fragment; public
Service status and connections metadata never do. Claiming bootstrap alone is still setup-required.

The production module now registers seven ordinary native methods (`context.current`, `context.read`,
`participation.set-interest`, `reply.submit`, `work.propose`, `work.accept`, `work.continue`) under `collective-native` and its stdio MCP entrypoint.
It also registers the original `entry-roster`, `pair` and `participation/reconcile` owner webhooks.
Settings → Collective participation → Paired connections lists owner-bound routes; each row’s Sync
uses the authenticated owner operation to send each exact named request with `wake: {catId}`.
Host owns persistence and wake deduplication in that single operation. Native source reads may start
before its receipt returns; they bind the authenticated Host origin to the original inbox and Service.
The private activation verifier rereads the existing Connector inbox and Service permission; it is not
an ordinary action. Native Agent verification reads the actual Host native context, never tool-body
identity. A Work proposal uses the original Service operation. Acceptance and continuation require the
current owner-adopted Work grant and exact source/revision references; they return
`accepted_pending_host_admission`, not an active Host Task. Retained sources keep their original granted
methods after upgrades. Two other native methods and the private Work/purpose and remaining owner controls retain their original
separate consumers and are not advertised as complete.
Host owns authentication and those durable facts; the package parses its own participation/Work rules.
Actual retained page and installed use must be validated with a matching Host caller candidate.

## Binding and recovery

The Host binding supplies the exact service origin, parent origin, protocol label, asset digest and
finite transport limits. There are no package port/origin/public-URL configuration overrides.
The manifest declares 59 literal routes, of which 19 permit local dispatch. Local pairing exchange
requires the exact parent origin; other local calls omit Origin and cookies. Browser mutations require
the service origin; the two declared provider callbacks retain their explicit Origin exception.

Four local effect families (outbox, ACK, participation and revoke) persist an attempt before entry.
Unsettled attempts survive restart as unknown holds. Ordinary sync/reconnect cannot clear them or
change the operation identity to bypass them. The existing Manager recovery operation lists bounded
rows and offers authenticated `reconcile` and, when proof permits, one `resume` of the same operation.
Owner identity/lifetime comes from the distinct Host owner-operation context, never from request data.
Unknown revoke keeps its credential and revoking state; a 401 or a message mentioning revocation
does not prove success. Confirmed recovery uses exact same-instance persisted evidence; event dedup
alone does not certify Work result/progress effects. Remote fetch/recovery retains the source behavior.

The module uses its authorized data directory and the Host browser-service binding; it does not read
SDK configuration. The declared Settings operations are actions, not configuration values. The former ambient CLI is
retired. Existing domain persistence and authentication transitions are retained. Unclaimed credential
expiry still follows the source service's 24-hour bootstrap policy. No old user state is imported.

The retired CLI's `COLLECTIVE_SERVICE_HOST` is not read: listener ownership belongs to the Host.
`COLLECTIVE_GITHUB_CLIENT_ID` and `COLLECTIVE_GITHUB_CLIENT_SECRET` are also not read; GitHub OAuth
configuration currently comes from the existing App Manifest setup flow. Settings secret configuration
remains a later composition decision.

The package root exports only the default module, `createCollectivePluginModule`, and its options type.
Connector/service internals and domain declarations remain private implementation details.

## Install permissions

- `plugin.state.get`: re-read the original first-source/Cat business receipt from the Host-private container.
- `plugin.state.set`: retain the immutable first choice and exact execution binding through the existing CAS container; it does not issue permission.
- `task.admitEntrusted`: the separate Work feature may prepare/dispatch the exact current authorized source; this does not grant `task.write` or Task CRUD.
- `thread.readContent`: read only the authenticated native origin and its current source through Host ports.
- `thread.listMetadata`: verify the owner-created route thread before admitting a named request.
- `thread.write`: create the original per-channel owner threads and materialize selected participants.
- `messaging.send`: send an exact request and wake its named member in one Host operation; replies return through the Collective business outbox.
- `data.directory`: persist Collective business state and private credentials in the Host-authorized
  package directory. Stop preserves that state; the package never falls back to another directory.

While active, this builtin runs inside the Host process. Explicit Host listener disclosure/consent and
measurements of state-write impact on the Host event loop remain release prerequisites. The transport
policy is bounded at 256 KiB request, 32 MiB response and 10 seconds, not a claim of arbitrary-state parity.
Timeout/abort can refuse a response after a business write has committed; it never implies rollback.

## Verification from this checkout

```sh
pnpm --filter @clowder-ai/collective-connector typecheck
pnpm --filter @clowder-ai/collective-connector test
pnpm --filter @clowder-ai/collective-connector test:source
pnpm --filter @clowder-ai/collective-connector test:installed
```

`test:installed` builds the exact SDK/contract/module in this checkout and installs the module directory
into an empty physical npm consumer. It exercises bootstrap, create, disable, and re-enable using fresh
temporary data and a fixture Host binding; it asserts zero package listener attempts. Exact local
contract `0.1.0-beta.36` and SDK `0.2.0-beta.20` archives resolve unpublished versions. This proves
physical closure and module behavior, not actual Host or browser acceptance. Host `93fee434` predates
this transport and owner-operation surface; its old pairing probe is not a green acceptance target.
Matching Host retained Client launch/iframe and normal stop/restart journeys, the remaining owner/native
controls and authority mapping, and the original finite C1 installation/use acceptance remain open.
The existing maintainer local acceptance is the original combined testing/publication finish line; this
package does not add a second operator acceptance or soak gate. Publication is not admitted.

### Retained participation policy

The retained Host participation panel can send `PUT connections/:connectionId/participation/policy`
through the existing owner-authenticated webhook lane. Its strict body is
`{expectedRevision, channelIds, policy:{defaultMode:"include", excludedCatIds, channelOverrides}}`.
The original reconciler reads the current Host roster, keeps owner threads and initial exclusions,
checks the route revision, and publishes the resulting participation. This operation changes the
participation policy; it does not admit a Task or grant private execution. `POST .../participation/reconcile`
continues to accept only `{expectedRevision, channelIds}`.

Request/Task mutations and private Work callbacks remain migration work. This policy endpoint does
not make those missing journeys available; the independent owner send is described below.

### Owner Agent messages

The separate `collective-owner-native` MCP contribution exposes
`cat_cafe_collective_connector_send({connectionId,clientEventId,target,body,replyToEventId?})`.
It uses the authenticated second action context from Host `c3e78fd8cc5183ea48ad2f88f411e46a4fb11e0a`
and requires strict owner provenance with no limited tool policy, the owner's paired connection,
and the current Host Cat profile. Agent identity/session and display-name qualification come from
the Host context and roster; they are never tool arguments.

The original seven public methods remain in their own `collective-native` contribution. Public
participation and purpose/private Work returns cannot use unrestricted owner send. Owner send
only queues an original Agent message; the existing Connector Sync sends it to the Service.
Reuse the exact clientEventId, payload and invocation after response loss. A changed payload or
Agent session for the same clientEventId conflicts. Late authority loss may leave a queued effect;
a rejected response never claims rollback. This operation grants no Task or private execution.

The SDK declares the existing authenticated `ownerAuthProvenance`, optional policy and exact
`originTriggerMessageId` facts. It does not derive permission from userId, input or a held source.
Original private Task admission/execution remains migration work.

### Retained owner participation view

`GET connections/:connectionId/participation` preserves the original owner view: connection and route
revision, registered/removed Cat eligibility, desired policy and initial exclusions, bindings/channel
routes/interests, owner thread choices, routed requests/responses and the owner's admitted-source Work
Task summaries. It reads existing Host ports and requires `task.read`; it never writes/adopts a Task,
admits execution, creates a thread or borrows native identity. Accessible foreign threads and Tasks do
not become owner data. The Host thread list is traversed with its existing exclusive cursor, then every
row is checked through the strict owner thread port.

Request progress preserves the original owner, source event, connection, recipient Cat and target
binding checks. It consumes the existing Host `sourceFacts.readProgress` owner-only, content-free
projection. Current Queue `status` and per-target seen/exposure/failure/handled witnesses supply
queued/started/failed/ended; the deleted `executionScope` marker is not synthesized. Terminal custody
is retained by the actual Queue delivery transition. Queued body reads stay forbidden. Missing ports,
missing Queue facts or refused progress reads omit execution instead of inferring it from Task status
or content. These display facts never authorize private Work or Task execution. Complete retained
request/Task actions, private/progress returns and real owner browser journeys remain open.



The retained participation GET consumes the SDK's declared `PluginTaskReadItem` through existing
`task.read` ports. Owner/source filtering uses explicit `userId` and the bounded entrusted Work
summary; a Host missing that projection fails the read visibly. It does not grant Task writes,
admission or execution, and unavailable Queue progress facts remain unavailable.


### Retained individual participation mutation

The existing owner `PUT connections/:connectionId/participation` retains the original strict per-Cat
schema, route revision CAS and connection mutation serialization. Enable stores the Cat's public
participation and optional owner standing-work scope; disable removes both while preserving the
same owner thread. The current Host roster decides eligibility and strict owner thread ports reject
deleted or foreign threads before mutation. The original Connector persists route/standing-work
revisions and publishes participation to the Service. This configuration does not create a Task,
admit execution or allow a public/native caller to act as the owner. Work admission and progress use
the separate Work feature below; resume and the complete retained browser journey remain open.

## Private Work production actions

The distinct `collective-work` feature owns exactly one Task MCP, `collective-work-native`.
Its three tools read the current admitted Task/source, read that source through a context reference,
and publish real progress. They consume the actual Host `includeTask:true` snapshot and the original
package first receipt; ordinary public participation and the owner-send MCP retain their six existing
grants and cannot enter this private method set. Progress preserves result/execution identity and
never completes Work. The inherited native reference key remains under the same authorized directory.

Settings → Private Collective Work → Paired Work connections offers an authenticated Sync operation.
It sends current committed initial Work notices without wake, records the original inbox mapping,
then consumes current Service or human standing authority through the reviewed package admission caller.
The Host supplies the real instance identity through that owner-operation context; neither manifest
plugin id nor tool input substitutes for it. `POST connections/:connectionId/work/admit` enters the
separate `collective.work.control.http` owner webhook and the reviewed manual/replay caller. The original
resume DTO is registered but honestly returns unavailable while its separate recovery boundary is open.

This is production declaration and consumer wiring, not a complete installed Work journey.
Autonomous source publication, later execution/bootstrap, independent owner resume/current custody,
result publication/file seals/accepted history and the packaged Work skill still need their original
complete integration. The old skill is not advertised or packed while it instructs unavailable callbacks.
No background source is emitted using a guessed instance id or Host provenance. Full C1 remains open.
