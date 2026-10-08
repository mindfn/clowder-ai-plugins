---
feature_ids: [F202]
topics: [github-operations, state-migration, authority]
doc_kind: implementation-evidence
created: 2026-10-08
---

# Legacy state copy — separate provider metadata from Host authority

Frozen source: Host `496e24089ffb5f99fa241e04c7ee0850df227be4`.
No production Redis read, legacy deletion, automatic cutover or Host modification
is performed by this implementation. An import digest is a transport integrity
check; it does not authenticate a user, assignment, origin or governance verdict.

## Implemented slice: issue metadata

Source serialization: `packages/api/src/domains/cats/services/stores/redis/RedisCommunityIssueStore.ts:177–225`.
Frozen full-file SHA256: `37c399e9ebf7d74345886b81adf632fea22551413e48460317885e3014c9660f`.
The existing owner-local operation carrier invokes the declared
`legacyIssueObservations/import` → `github.legacy-issues.import` method. The
manifest has an explicit confirmation. As with other generic operations, the
method receives `{input:{...storedConfiguration,...envelope}}`; its wrapper
extracts only the protocol fields. It is not registered as a general tool.

Envelope:

```json
{
  "protocolVersion": 1,
  "sourceDigest": "lowercase SHA-256 of canonical snapshot bytes",
  "snapshot": {"issues": {"legacy-record-id": {"id": "legacy-record-id", "repo": "owner/repo", "issueNumber": "1", "issueType": "bug", "title": "Title", "linkedPrNumbers": "[]", "createdAt": "10", "updatedAt": "20"}}}
}
```

The Host adapter must supply owner-selected raw hashes without interpreting
GitHub business fields. This adapter is **not implemented or accepted here**;
current evidence is the real package/SDK builtin with isolated raw snapshots.
Snapshot `issues` is the only top-level member. Sort raw record IDs and hash
field names with JS default UTF-16 `.sort()`, serialize every key/value using
`JSON.stringify`, and concatenate compact JSON without whitespace. Raw string
contents are not parsed or normalized for hashing. Only the package subsequently
decodes its selected metadata fields. Total protocol envelope ≤256 KiB; ≤500
records. The complete batch, digest and duplicate subjects are validated before
the first write. Unknown hash fields fail rather than silently guessing a new
legacy schema.

| Legacy field | Package disposition |
| --- | --- |
| repo / issueNumber | Validate, lowercase repository, derive private subject ID |
| issueType / title | Validated metadata, not a formal triage decision |
| linkedPrNumbers | Decode and validate positive safe integer array |
| createdAt / updatedAt | Preserve safe nonnegative integer timestamps |
| id | Verify raw map identity; never adopt as package identity |
| lastActivityAt / lastActivityEvent | Do not copy governance activity prose; private metadata gets `legacy-metadata-copy` at source updatedAt |
| state / replyState / consensusState / ownerDecision | Remain Host truth; not stored or projected by import |
| assignedThreadId / assignedCatId / guardianAssignment / routeAcceptance / routeSource | Remain Host authority; not decoded, stored or trusted |
| directionCard / relatedFeature | Remain Host; no private context copied into provider metadata |

Each destination record is one insert-only SDK CAS. Existing identical rows
count as `identical`; different rows, including later owner edits, count as
`preserved`. A failed batch may have copied earlier rows: retry safely completes
missing rows, never replaces any row, and reports counts for that invocation.
There is no TTL. Corrupt existing records fail visibly and are preserved.
The receipt contains digest/counts/scope only, no old IDs, private actors, tokens
or bodies. `github_issue_metadata` reads the result by repository/number and
labels it installation-private metadata, not current provider or governance truth.

Tests cover real manifest/operation invocation, restart, whole-batch prevalidation,
numeric-looking key ordering, raw-string preservation, digest mismatch,
case-insensitive duplicate subjects, bounded input, concurrent copies, partial
storage failure, owner edits, abort, corrupt existing data and zero notifications
or tracking. These tests do not prove production export/copy/no-double-run.

## Other legacy state remains explicitly pending or Host-retained

| State | Current disposition | Missing evidence |
| --- | --- | --- |
| PR tracking hash / TaskStore provider cursors | Pending copy/verify adaptation | Join by canonical subject; preserve independent inline/conversation cursors and terminal/pending delivery facts |
| Legacy combined PR comment cursor | Pending historical migration | IDs are different namespaces; cannot copy one scalar into both cursors or silently baseline over new activity |
| Issue collected vs delivered cursors | Pending copy/verify adaptation | Resume from delivery frontier; do not claim collected comments were delivered |
| Issue pendingWake / waitOutcome / accepted assignment | Host-retained governance consumer | Authenticated Host settlement, not plugin payload replay |
| Repository config / scan dedup / comment cursor | Pending owner-scoped copy/verify | Preserve baseline silence and failed-delivery recovery before no-double-run cutover |
| Community provider journal/history | Pending bounded provider-only copy | Do not import mixed authority events or replay old facts as new notifications |
| case.bootstrap / case.routed and assignment/signoff/route admission | Host-retained under ruling338 | Existing authenticated consumers stay; package copies removed |
| Old drafts / from-frustration | Host-retained under ruling404 | Ownership/confirmation and legacy cutover not replaced by native drafts |
| ConflictAutoExecutor | Retirement candidate under ruling463 | No default rebase/push capability; Host caller retirement/no-double-run still pending |

All three ledgers remain separate: this metadata business is implemented; real
Host replacement is pending; no Host legacy implementation or data is deleted.
Final W3 packaging waits for the coordinator's exact SDK beta.13 candidate from
task296 and uses GitHub operations alpha.1, not the old alpha.0 shell identity.
