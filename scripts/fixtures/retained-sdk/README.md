---
feature_ids: [F202]
topics: [fresh-consumer, immutable-dependencies]
doc_kind: test-fixture-provenance
created: 2026-10-08
---

# Retained SDK beta.12 fixture

This is the canonical MIT-licensed `@clowder-ai/plugin-sdk@0.2.0-beta.12`
archive independently rebuilt from exact source
`80e26fc4bc2c337449c80e3f32184db1a96f07cf` during Batch9 acceptance.
It is test input, not a new release or a replacement for registry publication.

- Size: 55,750 bytes; 58 archive members.
- SHA-256: `af0cd615aa2b2f8f9de994499f541f83163d9637d56fb89406bc1f7aa023ad7b`
- SRI: `sha512-OWaRO97kFIs5X3RDo+PlIN0C80oLvH7CPp/+55fXOi1NqJxUIB6cuhReQnXU0mvCX0/gDgQjsFLNOPpJHWur1w==`
- Toolchain: Node24.18.0 / npm11.16.0 / pnpm9.15.4, darwin-arm64.
- Historical evidence: `f202-handoff/batch9-sol/final-run/verification.json`
  and `f202-w1-tarballs/clowder-ai-plugin-sdk-0.2.0-beta.12.tgz`.

The fresh consumer test verifies the hash and checks SRI against all retained
production shrinkwraps, then applies a version-specific test-only file resolver.
It proves retained beta.12 and the current SDK can coexist without mutating published package
manifests, rewriting SDK versions or relying on monorepo links. The installed
resolution is checked from each package. It does not claim npm has published
beta.12, nor bypass Host installation or authorization acceptance.

## Retained contract beta.29

The beta.12 SDK still requires contract beta.29. This unchanged canonical archive
comes from the accepted de917e86f39631aa4b70006fa056c7be470942d8 graph
(candidate-de917e8-artifact-matrix.json), and is used only as fresh-consumer input.
Size: 228047 bytes. SHA-256: `25225f3c1b3f9935c692dbca7f8f001eca70ab7c198165b4e9ef69ca91d9b458`.
SRI: `sha512-77p2pQyLZvbC+kv7yOOzIdsXNYeUblxy50H6VQVQYx2CB6vwySSux2LvUXzPLvdVZCNuJkFHpY04mZ3vHmnXgQ==`.
The test verifies the retained shrinkwrap and resolves each SDK's contract
independently; beta.30 never masquerades as beta.29.
