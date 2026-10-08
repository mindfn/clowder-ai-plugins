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
It proves beta.12 and beta.13 can coexist without mutating published package
manifests, rewriting SDK versions or relying on monorepo links. The installed
resolution is checked from each package. It does not claim npm has published
beta.12, nor bypass Host installation or authorization acceptance.
