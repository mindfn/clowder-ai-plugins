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
controls below; remaining authority-dependent controls and native invocation are still open in aggregate task1843. This package remains `private: true` while that
work continues; this checkpoint makes no catalog, installed Settings, publication, or whole-C1 claim.

## Owner control HTTP

The existing Host authenticated webhook lane calls `collective.control.http`; it is distinct from the
browser-service action and native MCP identity. Declarations use the actual `official.collective-connector`
ID. The old root GET becomes `/api/plugins/official.collective-connector/connections`; individual
connection resources use `connections/:connectionId/...`. No anonymous verification secret is declared.

This checkpoint declares eleven existing owner method/path pairs: connections GET; service/provision
POST; inbox/route GET; reconnect/revoke POST; listening GET/POST; and work-policy GET/adopt/revoke.
They call the moved connector algorithms. Listening/policy/route preserve local owner checks and
original request schemas. Unknown local sync/revoke outcomes remain visible 409 recovery states;
ordinary reconnect does not replay or clear a hold. Provision returns the existing `{service,launchUrl}`
shape from the current Host binding and persistent metadata, without starting a second listener.
Only this authenticated launch response contains an unclaimed private bootstrap fragment; public
Service status and connections metadata never do. Claiming bootstrap alone is still setup-required.

The remaining eleven owner pairs and nine native methods depend on the precise Host roster/source/
Task-admission/prepared-artifact facts being paired in task1843. They are not declared as working actions.
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
