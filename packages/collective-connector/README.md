# Collective backend module

This private C1 migration candidate owns the existing Collective service and connector business code.
Source is pinned to `ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`; the separate byte-preserving move is
`4952f27c9306d34cae35cd44b672803f11ed4f48`. The local migration record names every source blob.

The builtin module currently activates the backend service. The Host supplies configuration and an
authorized private data directory. It listens on loopback, preserves service state across disable,
closes its listener before reporting failed activation, and resumes an interrupted unclaimed owner
bootstrap from a private credential file. Status contains metadata and the local API URL, never credentials.
The Host owns grants, lifecycle, Task/custody/principal decisions, and future connector delivery adapters.

Client assets remain in the Host/C2 boundary. This backend returns `CLIENT_UNAVAILABLE` for asset routes;
`clientBuildId` is a retained protocol label. The private bootstrap URL is a backend handshake coordinate;
it is not a working owner onboarding UI. Settings launch/HTTP forwarding, connector invocation and all
21 browser journeys are still open in aggregate task1843. This package remains `private: true` while that
work continues; this checkpoint makes no catalog, installed Settings, publication, or whole-C1 claim.

## Configuration

| Key | Meaning |
| --- | --- |
| `servicePort` | Integer `0..65535`; default `5201`. Zero binds an ephemeral port; `3001` and `3002` are reserved. |
| `allowedHostOrigins` | Comma-separated permitted browser origins; default empty. |
| `publicUrl` | Optional HTTP(S) service URL without credentials; remote origins require HTTPS. |

The module reads only SDK configuration and its authorized data directory. The former ambient CLI is
retired. Existing domain persistence and authentication transitions are retained. Unclaimed credential
expiry still follows the source service's 24-hour bootstrap policy. No old user state is imported.

The retired CLI's `COLLECTIVE_SERVICE_HOST` is not read: the module binds `127.0.0.1` only.
`COLLECTIVE_GITHUB_CLIENT_ID` and `COLLECTIVE_GITHUB_CLIENT_SECRET` are also not read; GitHub OAuth
configuration currently comes from the existing App Manifest setup flow. Settings secret configuration
remains a later composition decision.

The package root exports only the default module, `createCollectivePluginModule`, and its options type.
Connector/service internals and domain declarations remain private implementation details.

## Install permissions

- `plugin.config.read`: read only the configuration supplied by the Host for this instance.
- `data.directory`: persist Collective business state and private credentials in the Host-authorized
  package directory. Stop preserves that state; the package never falls back to another directory.

While active, this builtin runs inside the Host process and opens a loopback HTTP listener (default
port `5201`). Current Host capabilities do not separately express listener consent. Explicit installation
disclosure/consent and measurements of state-write impact on the Host event loop remain release prerequisites.

## Verification from this checkout

```sh
pnpm --filter @clowder-ai/collective-connector typecheck
pnpm --filter @clowder-ai/collective-connector test
pnpm --filter @clowder-ai/collective-connector test:source
pnpm --filter @clowder-ai/collective-connector test:installed
```

`test:installed` builds the exact SDK/contract/module in this checkout and installs the module directory
into an empty physical npm consumer. It exercises bootstrap, create, disable, and re-enable using fresh
temporary data and loopback ephemeral ports. Exact SDK/contract tarballs resolve unpublished local versions.
The production Host admission/carrier pairing can additionally run with `F202_COLLECTIVE_HOST_ROOT`
pointing to the frozen clean Host `93fee4342cf7296e5ec8def9d9cc8ae2754be49f`. It writes only temporary
inventory/package/data/log files; it does not launch or modify the Host application.
