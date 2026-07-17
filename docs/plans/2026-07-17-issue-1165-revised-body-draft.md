---
feature_ids:
  - P-1
  - M0
topics:
  - plugin-contract
  - shape-co-sign
  - issue-1165
doc_kind: issue-body-draft
created: 2026-07-17
---

# #1165 revised body — draft (P-1a.0 收官投递物)

**用途**：整体替换 [zts212653/clowder-ai#1165](https://github.com/zts212653/clowder-ai/issues/1165) 的 issue body（GitHub 保留 edit history，可逆）。
**真相源**：`docs/plans/2026-07-17-m0-standalone-io-plan.md` @ `252952a`（R16，sol 零 finding 收敛）。本 draft 是其 line 183 spec 的呈现式转写——**(0)** lifecycle、**(1)** 三 snapshot rows、**(2)** row-6 paging 三项 owner decisions + stable portion co-sign，零预设。
**状态**：draft by 宪宪，pending sol 窄扫（对照 plan 终态 + addendum 一手措辞）。零 finding 后投递：sol 有原 body 署名与通道先例；通道不可用则升级 operator 机械投递。
**忠实性边界**：unmarked = canonical-decided（maintainer 已决，呈现仅确认吸收正确）；★ = our proposal pending co-sign；★★ = decision packet（owner 拍板）。原 body 的 "K-1 remains pinned to beta.1" 错误陈述在本版修正（R5 grounding correction）。

---

## BODY（verbatim replace begins below）

## Status and request — revised after your verdict and P1 addendum

This remains a **shape-only K-2 / P-1a.0 co-sign anchor**. It does not authorize implementation, publication, or dependency migration.

Since the original anchor: your row-by-row verdict, your P1 addendum ([comment 5000048510](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5000048510)), and the canonical fix #1168 (merged `d606aab859883422b04d996cf223560fc20ae232`) have been absorbed field-by-field through twelve fresh-context review rounds (R5–R16); the final round reported zero findings. The shape below is the corrected, field-level form.

**This revision asks you for exactly three decisions and one co-sign:**

- **DECISION 0** — the proofs-vs-shape lifecycle (your addendum's withheld condition);
- **DECISION 1** — the snapshot sub-protocol decision rows (view coordinates / completion authorization / item shape);
- **DECISION 2** — `messaging.read` bounded-paging disposition;
- **CO-SIGN** — the complete-and-stable portion (unchanged for ≥2 scan rounds, listed in full below).

Whether approval is **partial** (e.g. detaching rows 6/8 into their own decision rounds) is your explicit call — this anchor presumes neither the split nor the lifecycle order.

The confirmed cross-repository order is unchanged:

```
core interface shape-approved
→ contract PR co-signed
→ exact artifact published and registry-verified
→ each consumer explicitly re-pins
```

## Corrections from your verdict/addendum — absorbed, confirmation requested

1. **Row 6 publication gate absorbed.** Your proof (a contract-valid compact `messaging.read` frame reaches 1,049,033 bytes — 457 over the 1,048,576 ceiling) is recorded; `messaging.read` stays publication-gated until a contract-owned bounded `SubscriptionReadPageRequest/Response` with atomic page assembly exists (see DECISION 2).
2. **Registry-wide `wireBounds` invariant pinned from the merged canonical doc** (`d606aab`, semantically equivalent restatement; the merged doc is the literal truth source): one generated `wireBounds` truth whose frame cap is v0 `maxFrameBytes`; a row may be marked ready only when ① every variable-length request/result/notification/acknowledgement/public-error field has a structural limit **plus an exact UTF-8/JSON byte validator** (`maxLength` counts characters, not encoded bytes), ② the row declares `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes`, each ≤ `maxFrameBytes` under the v0 compact profile incl. shared `CallMeta` and escaping, ③ collection assemblers admit an item only if the encoded page stays within the row's result budget, preserve continuation/watermark state when the next item does not fit, and prove one individually valid item fits, ④ request validation + row proofs are checked before authorization-visible business dispatch, dynamic page assembly completes within budget before advancing any delivered watermark, callback lease, or settlement state, and the final encoded frame is re-checked before write-queue mutation — an over-budget value is a contract violation, never a partially emitted success. Proof coverage spans requestId, plugin/package/version/session identifiers, `bindingNonce`, message/thread/subscription identifiers, handles, cursors, `deliveryId`, callback acknowledgements, and closed public error data. A method name may be reserved without proof, but cannot be published or advertised as ready.
3. **Grounding correction to the original anchor (our error, now fixed):** the original body claimed "K-1 remains pinned to exact `@clowder-ai/plugin-contract@0.1.0-beta.1`". That was wrong — K-1 branch `9fb37310` has **no plugin-contract package dependency and no pin**; it owns a hand-written mirror that already drifts from beta.2. The corrected later gate: co-signed contract PR → exact registry-verified artifact → K-1/K-2 explicitly re-pin that exact version → **K-1 removes its mirror before merge**. Neither consumer ever follows `next` or any mutable dist-tag.

## DECISION 0 — proofs-vs-shape lifecycle (owner decision; we state no preference)

Two of your one-hand rules hold simultaneously:

- your P1 addendum states verbatim that *"`shape-approved` remains withheld and the required revision now also must"* give every ready method/notification a generated `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes` proof — i.e. proofs are written into the **current shape-approved withheld condition**;
- the merged canonical doc's method-level rule says a method may be **reserved** without proof but cannot be **published** without it.

Neither rule implies the other's ordering, and the proofs are generated by P-1a tooling that normally starts after shape approval — so the lifecycle order is yours to set:

- **Option A — reservation-only shape co-sign.** `shape-approved` covers the field-level shape with all 12 names reserved; generated byte proofs move to P-1a's **publication readiness** gate (no row publishes or is advertised ready without its proof; proof failure returns here as an explicit delta request).
- **Option B — proofs stay a shape gate.** You authorize a **pre-shape contract-proof spike** whose deliverable is the full withheld-condition set from your addendum: generated per-row `maxEncoded{Request,Result,Error}Bytes` proof metadata **plus** the exact UTF-8/JSON byte validators **plus** the required raw-byte conformance (max-boundary frames in ASCII / multibyte UTF-8 / JSON-escaping encodings, +1-byte oversize rejection, bounded page continuation, zero-side-effect oversize rejection) — still excluding production runtime and any publication; `shape-approved` follows only after that spike lands.

This plan presumes no relocation and no order until you answer.

## DECISION 1 — snapshot sub-protocol (★★ decision packet)

Review rounds proved this sub-protocol's free variables live in K-1/K-2 ground truth (ack-guard implementation, store-vs-event coordinates, canonical envelope shape) — not in this repo's authority. We therefore present invariants we can fix, the decisions only you can pick, and candidate shapes conditional on those picks. **Row 8 stays publication-gated until every decision row is signed; if that takes longer than the rest of the shape, row 8 detaches into its own decision round and the remainder proceeds — your call.**

**Fixed invariants (self-decidable; hold under every option below):**

- No page response ever moves a cursor (response-loss safety); completion is client-explicit.
- Completion authorization must be **Host-verifiable** — plugin-presented tokens alone cannot authorize cursor movement past `lastDeliveredSequence` (K-1's `q <= lastDeliveredSequence` guard is load-bearing against forgery and stays so).
- Pages bounded: page and item ceilings are **derived from generated full-frame proofs** and land strictly below `maxFrameBytes`. The specific values (`maxItems` 1..64, `pageByteBudget = 786_432`, `maxSerializedItemBytes = 393_216`) are **provisional candidates only**, adjusted without ceremony if the generated proof rejects them. Oversize stored item = system fault (`SNAPSHOT_UNAVAILABLE`), never caller `VALIDATION`, never silent skip.
- Page/completion tokens opaquely bind `(pluginInstanceId, subscription identity, view anchor, position, shape digest)`; cross-context presentation → `VALIDATION` fail-closed.
- All snapshot strings carry exact `maxLength` on their own request/response fields (`subscriptionId` ≤ 128; `pageToken`/`nextPageToken`/`snapshotAckToken` ≤ 512).

**★★ DECISION 1a — view coordinates.** K-1's snapshot includes host-relayed messages with no plugin publish sequence, beta.2 has no deletion events, and a store MVCC version and an event-log sequence are different coordinate systems — one integer cannot be both the traversal anchor and the cursor-advance target. Options:

- (a) store-canonical sequence covering every snapshot-visible message + new deletion events — unified coordinates, touches K-1's event model;
- (b) membership narrowed to sequenced plugin output — cheapest, incompatible with K-1's current snapshot;
- (c) **two-coordinate capture**: `viewVersion` (immutable store view for membership/pagination) **plus** `resumeAfterSequence` (event-log watermark captured atomically at the same instant; the only value cursor advancement may target).

*Our lean:* (c), both fields minted in one atomic capture. A single dual-purpose `fenceSequence` is withdrawn — it cannot exist across the two coordinate systems.

**★★ DECISION 1b — completion authorization mechanism.** Reusing plain `messaging.ack` is withdrawn — it cannot pass K-1's `q <= lastDelivered` guard without a relaxation that enables forged cursor skips. Options:

- (a) Host persists an exact completion-token → `(subscription, resumeAfterSequence)` entitlement, consumed atomically on ack;
- (b) authenticated (MAC) kind-tagged tokens verified statelessly;
- (c) a distinct `messaging.completeSnapshot` method so ack semantics stay untouched.

*Our lean:* (a) — no new crypto surface, no new method, the guard stays load-bearing. Regression set must cover: forged token, cross-subscription token, response loss, final-page replay, concurrent read/snapshot.

**★★ DECISION 1c — item shape.** Frozen beta.2 snapshot items are full `MessageEnvelope`s and K-1 returns `MessageEnvelope[]`; a narrowed item type silently discards `actor/audience/occurredAt/replyTo/provenance/correlation` — metadata unrecoverable post-catch-up. Options:

- (a) **semantically complete bounded DTO** — field-for-field carry of every canonical envelope member with `maxLength` on each copied field (bounds live on the DTO; frozen `$defs` untouched);
- (b) narrowed projection as an explicit owner-signed breaking/narrowing decision with a K-1 parity migration.

*Our lean:* (a); "no K-1 parity migration" is only claimable under (a).

**Candidate shapes (conditional on the rows above — NOT closed until signed):**

- `SnapshotPageRequest`: `subscriptionId` (≤128); `pageToken` (≤512, absent = first page); `maxItems` (1..64).
- `SnapshotPageResponse` as closed discriminated variants: *intermediate* = `{ items, nextPageToken: string(≤512), snapshotAckToken: null }`; *final* = `{ items, nextPageToken: null, snapshotAckToken: string(≤512) }` — presence rules exact, no third combination; same-token replay re-serves the equivalent page; token expiry bound to the view anchor's lifetime.
- Completion per DECISION 1b; cursor advance targets `resumeAfterSequence` per DECISION 1a(c).
- Oversize-vs-immutable-traversal: an `OVERSIZED_ITEM` fault poisons and expires the traversal's view anchor — the same `pageToken` thereafter returns `SNAPSHOT_UNAVAILABLE { reason: "VIEW_EXPIRED" }`; after Host-side repair the caller starts a **new** snapshot; repair never mutates an existing view.

## DECISION 2 — `messaging.read` bounded-paging disposition (owner decision; we presume none)

Current fact (your addendum, absorbed): row 6 is **publication-gated** until a contract-owned bounded `SubscriptionReadPageRequest/Response` with atomic page assembly exists; per the merged canonical text, bounded page assembly advances `lastDeliveredSequence` only through the last emitted event, and only ack advances `ackedSequence`. The paging shape itself does not exist yet. Dispositions we can execute — the choice is yours:

- (a) approve the stable shape with row 6 detached into its own follow-up decision round; we then draft the bounded paging shape as an explicit delta returning to this issue;
- (b) hold `shape-approved` until a bounded paging proposal is drafted and co-signed inside this round — we will draft it on your instruction;
- (c) supply the paging shape or its constraints directly and we mechanize verbatim.

## Complete and stable — co-sign requested (unchanged for ≥2 scan rounds)

Unmarked items are canonical-decided (your verdict absorbed; co-sign here confirms our absorption is correct). ★ items are our proposals awaiting your signature.

### Handshake (contract-generated structures)

| Structure | Fields | Authority |
|---|---|---|
| `CandidateHello` (plugin → Host, *candidate claims only*) | `pluginId`, `packageDigest`, `contractVersion`, `wireVersion` | plugin self-report, validated against the exact installed record |
| `SessionBinding` (Host → plugin, *authoritative*) | the four hello fields + Host-minted `pluginInstanceId`, `brokerSessionId`, `grantRevision`, `effectiveGrants`, one-use connection-bound `bindingNonce` | Host |
| `broker.ready` params | **only** `bindingNonce` (activation-only; not a resume carrier) | plugin |

`CandidateHello` and ready params **reject** any additional identity/instance/grant/session fields — caller-supplied authority fails as `AUTHORITY_VIOLATION`. The runtime never selects authority by echoing plugin-supplied fields.

### Framing

JSON-RPC 2.0 over UTF-8 NDJSON; one non-batch object per LF-delimited frame; stdout protocol-only (logs → stderr); **v0 compact encoding profile (canonical, merged `d606aab`)**: compact UTF-8 JSON, no BOM, no insignificant whitespace, LF terminator; non-control Unicode encoded directly as UTF-8; required JSON escaping counts toward the budget. Batch arrays, compression, blank frames, invalid UTF-8, trailing non-whitespace all rejected in v0. **`maxFrameBytes = 1_048_576`** counted on raw UTF-8 bytes excluding LF; an unterminated frame crossing the ceiling → stop buffering, close connection — the decoder ceiling is the last fail-closed defense, never the normal rejection path for schema-valid values (inbound checked pre-dispatch, outbound pre-write-queue); oversized domain results are never transport-split — method schemas paginate below the ceiling or negotiate a later wireVersion.

### Package digest

Exactly **one** canonical `sha512-<base64>` SRI token over the exact staged archive bytes, for every package source. npm artifacts additionally pass registry integrity; local packages become an exact archive before install. An unpacked-tree normalization is not a second digest truth.

### Call meta & settlement identity

```
JSON-RPC id = requestId          attempt correlation ONLY
params.meta.deadlineUnixMs       Host-capped absolute deadline
params.input                     method-owned schema
registry.settlementKeySource     authoritative domain field/composite or "none"
```

No generic wire `operationId`. The Broker *extracts* the settlement key from input, never duplicates it. Retry: new requestId + same settlement key + same input → converges on the existing terminal/in-flight result; same key + different input → conflict. Rows marked `none` must prove at-least-once replay safety and monotonic cursor advancement before publication.

**`CallMeta`** (closed, v0): `deadlineUnixMs` — integer, Host-capped absolute Unix ms. Sole field; `requestId` lives in the JSON-RPC `id`, never in meta.

### Production method registry (12 reserved names; your matrix columns verbatim from `b32170a8`)

| # | Method | Direction | Grant | Input → Result | Error set | Settlement key source |
|---|---|---|---|---|---|---|
| 1 | `broker.hello` | plugin → Host | protocol-intrinsic | `CandidateHello` → `SessionBinding` | `HANDSHAKE_REJECTED` | — |
| 2 | `broker.ready` | plugin → Host | protocol-intrinsic | `bindingNonce` → `null` | `HANDSHAKE_REJECTED` | — |
| 3 | `messaging.send` | plugin → Host | `messaging.send` | `MessageDraft` → `SendReceipt` **with `messageHandle`** | `MessagingErrorCode` + deadline | `input.idempotencyKey` |
| 4 | `messaging.appendElements` | plugin → Host | `messaging.appendElements` | `AppendElementsRequest` → `AppendReceipt` | `MessagingErrorCode` + deadline | `(Host-resolved messageId from input.handle, input.operationId)` |
| 5 | `messaging.subscribe` | plugin → Host | `message.event.subscribe` | handle → subscriptionId | `MessagingErrorCode` + deadline | Host-resolved `input.handle` identity (K-1 create-or-get authoritative) |
| 6 | `messaging.read` | plugin → Host | `message.event.subscribe` | subscriptionId + limit → `SubscriptionReadResponse` — **publication-gated (your addendum; see DECISION 2)** | `MessagingErrorCode` + deadline | none (at-least-once; bounded page assembly advances `lastDeliveredSequence` only through the last emitted event; only ack advances `ackedSequence`) |
| 7 | `messaging.ack` | plugin → Host | `message.event.subscribe` | subscriptionId + ackToken → `null` | `MessagingErrorCode` + deadline | `(input.subscriptionId, input.ackToken)` |
| 8 | `messaging.snapshot` | plugin → Host | `message.event.subscribe` | bounded `SnapshotPageRequest` → `SnapshotPageResponse` (candidate — see DECISION 1) | ★`DOMAIN_ERROR`/`DEADLINE_EXPIRED`/`SNAPSHOT_UNAVAILABLE` per wire mapping | none for traversal; completion = DECISION 1b — **publication gated on all three DECISION-1 rows; may detach into its own round** |
| 9 | `host.messaging.deliver` | Host → plugin | `onMessage` | deliveryId + threadHandle + envelope → **`deliveryId` ack (canonical; ★ echoed value must byte-equal the Host request identity, mismatch = protocol violation)** | ★`DELIVERY_REJECTED` per wire mapping — **publication-gated per canonical: blocked until callback request/ack/rejection byte proofs close** | `input.deliveryId` (Host-side authoritative) |
| 10 | `host.grants.changed` | Host → plugin | protocol-intrinsic | `GrantSnapshot` notification | none | (grantRevision monotonic) |
| 11 | `host.lifecycle.ping` | Host → plugin | protocol-intrinsic | nonce → nonce | protocol errors only | — |
| 12 | `host.lifecycle.drain` | Host → plugin | protocol-intrinsic | deadlineUnixMs → `null` | deadline | — |

No production method exists for fixture setup/observe, grant presets, revocation, permission-matrix inspection, or replay deletion; and **no grant-introspection RPC** — `SessionBinding` and `host.grants.changed` are the authoritative grant snapshots (your ruling). Fixture words never become production RPCs; capability ≠ semantic operation ≠ fixture op ≠ production method; identity is Host-bound (`pluginInstanceId` never accepted from params).

### Concrete wire types

**★ `GrantSnapshot`** (closed; the *name* is canonical but this exact field set is **our proposal**, derived from `SessionBinding`'s fields, submitted for co-sign): `grantRevision` — integer, strictly monotonic per instance; `effectiveGrants` — unique `Capability[]`. `SessionBinding` embeds these same two fields; `host.grants.changed` params = `GrantSnapshot`. Stale-revision notifications are discarded by revision comparison.

**`SendReceipt` beta.3 delta**: adds `messageHandle` typed as the **existing frozen `MessageHandle` $def** (`{kind:"message", token}`) — no new shape invented. Conformance oracle: `messageHandle.token !== messageId`. Fixture updates accompany the schema change (additive, disclosed).

### ★ Delivery rejection (row 9)

- *Error class:* public **`DELIVERY_REJECTED`** wire error with `error.data = { reason }` — sole data field; closed enum `UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL`.
- *Identity:* resolved **exclusively from the JSON-RPC correlation**; `error.data` carries no `deliveryId`.
- *Retry policy is Host-owned:* contract-fixed mapping — `UNSUPPORTED_PAYLOAD`/`NO_HANDLER` → dead-letter; `PLUGIN_BUSY`/`PLUGIN_INTERNAL` → bounded retry. The runtime reports facts, never selects Broker behavior; any other error shape on a deliver call is a connection-level protocol violation.
- *Success (canonical, equality target disambiguated):* result = `deliveryId` ack exactly as your matrix states, with a ★ strengthening: the echoed value **must byte-equal `params.input.deliveryId`** of the originating request — never compared against the JSON-RPC `id`/`requestId`; mismatch is a connection-level protocol violation. The error path remains correlation-only and echoes nothing.

### ★ Wire error envelope mapping (JSON-RPC 2.0 requires integer `error.code`)

| Named class | `error.code` (proposed reserved range) | `error.data` (closed; all fields `required`; `additionalProperties: false`) |
|---|---|---|
| `HANDSHAKE_REJECTED` | `-32090` | `{ reason: HandshakeRejectReason }` — closed 7-value enum below |
| `DELIVERY_REJECTED` | `-32091` | `{ reason: "UNSUPPORTED_PAYLOAD" \| "NO_HANDLER" \| "PLUGIN_BUSY" \| "PLUGIN_INTERNAL" }` |
| `DOMAIN_ERROR` | `-32092` | `{ code: MessagingErrorCode }` — frozen 6-value enum |
| `DEADLINE_EXPIRED` | `-32093` | `{}` (empty object, exactly) |
| `SNAPSHOT_UNAVAILABLE` | `-32094` | `{ reason: "OVERSIZED_ITEM" \| "VIEW_EXPIRED" \| "STORE_UNAVAILABLE" }` — closed enum |

Every registry row's error set resolves through this table; no string ever appears as a top-level JSON-RPC `code`; new classes/reasons require a contract delta — the integer range is contract-reserved.

### Reject taxonomy (closed, per your verdict)

One public `HANDSHAKE_REJECTED` class, closed reason enum: `MALFORMED_HELLO`, `PACKAGE_MISMATCH`, `CONTRACT_INCOMPATIBLE`, `WIRE_INCOMPATIBLE`, `AUTHORITY_VIOLATION`, `DEADLINE_EXPIRED`, `BINDING_REPLAY`. Detailed Host diagnostics stay private.

### Session / resume (deferred, per your verdict)

V0 has **no resume token**. Every reconnect performs fresh `broker.hello`/`broker.ready` and receives a new `brokerSessionId`; logical work recovers through durable settlement/delivery ledgers. `bindingNonce` is connection-bound activation-only — replay of a consumed nonce is the executable `BINDING_REPLAY` oracle.

### Cross-repo release sequence (strict, per delta)

**① this issue's explicit approval → ② contract PR review + merge → ③ publish `0.1.0-beta.3` on `next` (`latest` untouched) → ④ registry-verify exact version + integrity + exports → ⑤ K-1/K-2 re-pin that exact artifact and K-1 deletes its mirror.** No step precedes its predecessor; never via dist-tags.

## Resolved from the original anchor (no re-answer needed)

| Original question | Your decision (absorbed) |
|---|---|
| Reject taxonomy | single `HANDSHAKE_REJECTED` + closed reason enum |
| Framing / ceiling | JSON-RPC 2.0 NDJSON; 1 MiB hard; method-level pagination only; v0 compact profile per `d606aab` |
| `packageDigest` | single canonical SRI token |
| Settlement identity | no generic wire `operationId`; per-row `settlementKeySource` |
| Session/resume | deferred; fresh handshake per reconnect; `bindingNonce` = `BINDING_REPLAY` carrier |
| `SendReceipt → MessageHandle` | explicit `messageHandle` in receipt (frozen `$def`) |
| Method/callback names | 12-row reserved registry above (your matrix `b32170a8`) |

## Ownership boundary (unchanged)

The plugins repository provides a **test-host conformance harness** only (framing/handshake/crash-isolation proofs). Production spawn, kill, restart budget, callback retry/dead-letter, restart reconciliation, and the three-stage production byte-proof enforcement (pre-dispatch / pre-state / pre-write) remain K-2 Host Broker responsibilities, proven at the joint M0 gate. The harness never evolves into a second production Broker.

## Shape gate checklist (current state)

- [x] authority direction for every handshake field — verdict absorbed above
- [x] production method registry (12 reserved names, field-level) — verdict absorbed above
- [x] session-injected identity boundary — Host-bound, fail-closed
- [x] idempotency/settlement identity single truth source — per-row `settlementKeySource`
- [x] receipt-to-handle relationship — explicit `messageHandle`
- [x] framing and rejection semantics — incl. v0 compact profile + `wireBounds` invariant from `d606aab`
- [ ] **DECISION 0** — proofs-vs-shape lifecycle
- [ ] **DECISION 1** — snapshot rows (1a view coordinates / 1b completion authorization / 1c item shape)
- [ ] **DECISION 2** — row-6 bounded-paging disposition
- [ ] **CO-SIGN** — complete-and-stable portion above
- [ ] K-2 maintainer records `shape-approved` (scope per your partial/full call)

No implementation, no `beta.3` publication, and no consumer re-pin begins before your explicit approval, in the order you set.
