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
it is not a working owner onboarding UI. Settings launch/HTTP forwarding, connector invocation and all
21 browser journeys are still open in aggregate task1843. This package remains `private: true` while that
work continues; this checkpoint makes no catalog, installed Settings, publication, or whole-C1 claim.

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

The module reads only SDK configuration and its authorized data directory. The former ambient CLI is
retired. Existing domain persistence and authentication transitions are retained. Unclaimed credential
expiry still follows the source service's 24-hour bootstrap policy. No old user state is imported.

The retired CLI's `COLLECTIVE_SERVICE_HOST` is not read: listener ownership belongs to the Host.
`COLLECTIVE_GITHUB_CLIENT_ID` and `COLLECTIVE_GITHUB_CLIENT_SECRET` are also not read; GitHub OAuth
configuration currently comes from the existing App Manifest setup flow. Settings secret configuration
remains a later composition decision.

The package root exports only the default module, `createCollectivePluginModule`, and its options type.
Connector/service internals and domain declarations remain private implementation details.

## Install permissions

- `plugin.config.read`: read only the configuration supplied by the Host for this instance.
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
Actual Host implementation, Manager route/lifetime pairing, retained Client iframe/popup journeys,
the remaining 31 native controls and authority mapping, bootstrap expiry/recovery (N2), protocol/build
parity (N5), all 21 browser journeys, human acceptance and soak remain open. Publication is not admitted.
