---
feature_ids:
  - P-1
  - M0
topics:
  - plugin-contract
  - standalone-runtime
  - standard-io
  - handshake
  - sdk
doc_kind: implementation-plan
created: 2026-07-17
---

# M0 Standalone Runtime / Standard I/O Plan (P-1 remainder)

> **Status: draft R8 — field-level co-signable shape. One explicit ★★ DECISION ROW (snapshot membership vs K-1 host-message/deletion truth, FC-13) is deliberately left for K-2/K-1 to pick; every other ★ item is a complete proposal. Registry deltas from the canonical matrix are all ★-disclosed (none silent). Absorbed the K-2 maintainer verdict on [clowder-ai#1165](https://github.com/zts212653/clowder-ai/issues/1165) (comment 2026-07-17T06:11Z; canonical assessment `main@b32170a8`). Pending explicit `shape-approved` on the revised issue body. No implementation, no beta.3 publication, no K-1/K-2 re-pin before that reply.**

**Goal:** Complete the plugins-side M0 vertical slice (roadmap PR-4 "P-1"): a real child-process standalone runtime speaking the standard I/O wire protocol, one shared SDK client that first- and third-party plugins use identically (P14), and the adversarial matrix executed with SDK-surface operations over the real transport — with every wire-level word contract-owned before any runtime consumes it.

**Position in roadmap:** P-2 (merged PR #6, `f52e820`) was slice-0: the 16+2 signed behavior cases execute in-process. This plan covers the remainder as revertible slices **P-1a (wire contract delta, mechanizing the #1165-corrected shape) → P-1b (shared wire-client core + test-host harness, dual-transport oracle) → P-1c (SDK author surface)**. M0 gate additionally requires kernel-side K-2 (Host Broker MVP, maintainer).

---

## Post-merge truth baseline

| Fact | Value | Verified via |
|---|---|---|
| upstream main (plugins) | `f52e820` (P-2 merge) | git fetch + log |
| npm `next` | `0.1.0-beta.2`, integrity `sha512-u2u+suCu…WQkiBA==` | anonymous registry query |
| npm `latest` | `0.1.0-beta.1` (bootstrap exception, byte-frozen) | same |
| signed protocol | `contractVersion = 0.1.0` | package + fixture assertions |
| published API | `.`, `./conformance`, 3 schema paths | registry `exports` map |
| behavior oracle | 18 cases | conformance 18/18 |
| **K-1 dependency truth (corrected per #1165)** | K-1 branch `9fb37310` has **no plugin-contract package dependency and no beta.1 pin** — it owns a hand-written mirror that already drifts from beta.2. Later gate: co-signed contract PR → exact registry-verified artifact → K-1/K-2 explicitly pin that exact version → **K-1 removes its mirror before merge**. Neither consumer ever follows `next` or any mutable dist-tag | #1165 maintainer verdict, grounding correction |

## Frozen-interface boundary matrix

**Column A — frozen now, consume by reference (artifact `0.1.0-beta.2`, protocol 0.1.0):** unchanged from R2 — messaging **data types** (46 `$defs`, zero wire methods), executor-only fixture vocabulary, capability table, manifest `RuntimeDeclaration`, 18 behavior cases, `./conformance` API, `P7D`, lifecycle-intrinsic ruling.

**Column B — maintainer-corrected wire shape (#1165 verdict). Not yet contract-owned; P-1a mechanizes it after explicit `shape-approved`. Naming and identity disciplines from R3 remain in force (capability ≠ semantic operation ≠ fixture op ≠ production method; identity is Host-bound).**

### Handshake (contract-generated structures)

| Structure | Fields | Authority |
|---|---|---|
| `CandidateHello` (plugin → Host, *candidate claims only*) | `pluginId`, `packageDigest`, `contractVersion`, `wireVersion` | plugin self-report, validated against the exact installed record |
| `SessionBinding` (Host → plugin, *authoritative*) | the four hello fields + Host-minted `pluginInstanceId`, `brokerSessionId`, `grantRevision`, `effectiveGrants`, one-use connection-bound `bindingNonce` | Host |
| `broker.ready` params | **only** `bindingNonce` (activation-only; not a resume carrier) | plugin |

CandidateHello and ready params **reject** any additional identity/instance/grant/session fields — caller-supplied authority fails as `AUTHORITY_VIOLATION`. The runtime never selects authority by echoing plugin-supplied fields.

### Framing (accepted with constraints)

JSON-RPC 2.0 over UTF-8 NDJSON; one non-batch object per LF-delimited frame; stdout is protocol-only (logs → stderr); batch arrays, compression, blank frames, invalid UTF-8, trailing non-whitespace all rejected in v0; **`maxFrameBytes = 1_048_576`** counted on raw UTF-8 bytes excluding LF (4× beta.2's 262,144-byte element-payload ceiling); an unterminated frame crossing the ceiling → stop buffering, close connection; oversized domain results are **never** transport-split — method schemas paginate below the ceiling or negotiate a later wireVersion.

### Package digest

Exactly **one** canonical `sha512-<base64>` SRI token over the exact staged archive bytes, for every package source. npm artifacts additionally pass registry integrity; local packages become an exact archive before install. An unpacked-tree normalization is not a second digest truth.

### Call meta & settlement identity (replaces every earlier `operationId` proposal)

```
JSON-RPC id = requestId          attempt correlation ONLY
params.meta.deadlineUnixMs       Host-capped absolute deadline
params.input                     method-owned schema
registry.settlementKeySource     authoritative domain field/composite or "none"
```

There is **no generic wire `operationId`**. The Broker *extracts* the settlement key from input, never duplicates it. Retry: new requestId + same settlement key + same input → converges on the existing terminal/in-flight result; same key + different input → conflict. Rows marked `none` must prove at-least-once replay safety and monotonic cursor advancement before publication.

### Production method registry (12 reserved names; canonical columns verbatim from `b32170a8`; fixture verbs stay conformance-only)

| # | Method | Direction | Grant | Input → Result | Error set | Settlement key source |
|---|---|---|---|---|---|---|
| 1 | `broker.hello` | plugin → Host | protocol-intrinsic | `CandidateHello` → `SessionBinding` | `HANDSHAKE_REJECTED` | — |
| 2 | `broker.ready` | plugin → Host | protocol-intrinsic | `bindingNonce` → `null` | `HANDSHAKE_REJECTED` | — |
| 3 | `messaging.send` | plugin → Host | `messaging.send` | `MessageDraft` → `SendReceipt` **with `messageHandle`** | `MessagingErrorCode` + deadline | `input.idempotencyKey` |
| 4 | `messaging.appendElements` | plugin → Host | `messaging.appendElements` | `AppendElementsRequest` → `AppendReceipt` | `MessagingErrorCode` + deadline | `(Host-resolved messageId from input.handle, input.operationId)` |
| 5 | `messaging.subscribe` | plugin → Host | `message.event.subscribe` | handle → subscriptionId | `MessagingErrorCode` + deadline | Host-resolved `input.handle` identity (K-1 create-or-get authoritative) |
| 6 | `messaging.read` | plugin → Host | `message.event.subscribe` | subscriptionId + limit → `SubscriptionReadResponse` | `MessagingErrorCode` + deadline | none (at-least-once; `lastDeliveredSequence` monotonic, only ack moves `ackedSequence`) |
| 7 | `messaging.ack` | plugin → Host | `message.event.subscribe` | subscriptionId + ackToken → `null` | `MessagingErrorCode` + deadline | `(input.subscriptionId, input.ackToken)` |
| 8 | `messaging.snapshot` | plugin → Host | `message.event.subscribe` | bounded `SnapshotPageRequest` → `SnapshotPageResponse` incl. final-page `snapshotAckToken` (proposal below) | ★`DOMAIN_ERROR`/`DEADLINE_EXPIRED`/`SNAPSHOT_UNAVAILABLE` per wire mapping | none for traversal; completion settles via row 7 `messaging.ack` with the snapshot token — **publication additionally gated on the FC-13 membership decision row** |
| 9 | `host.messaging.deliver` | Host → plugin | `onMessage` | deliveryId + threadHandle + envelope → **`deliveryId` ack (canonical; ★ echoed value must byte-equal the Host request identity, mismatch = protocol violation)** | ★`DELIVERY_REJECTED` per wire mapping | `input.deliveryId` (Host-side authoritative) |
| 10 | `host.grants.changed` | Host → plugin | protocol-intrinsic | `GrantSnapshot` notification | none | (grantRevision monotonic) |
| 11 | `host.lifecycle.ping` | Host → plugin | protocol-intrinsic | nonce → nonce | protocol errors only | — |
| 12 | `host.lifecycle.drain` | Host → plugin | protocol-intrinsic | deadlineUnixMs → `null` | deadline | — |

There is **no production method** for fixture setup/observe, grant presets, revocation, permission-matrix inspection, or replay deletion; and **no grant-introspection RPC** — `SessionBinding` and `host.grants.changed` are the authoritative grant snapshots (canonical ruling).

### Concrete wire types (field-level; ★ = our proposal pending co-sign, unmarked = canonical-decided)

**`CallMeta`** (closed, v0): `deadlineUnixMs` — integer, Host-capped absolute Unix ms. Sole field; `requestId` lives in the JSON-RPC `id`, never in meta.

**★ `GrantSnapshot`** (closed; FC-10 — the *name* is canonical but this exact field set is **our proposal**, derived from `SessionBinding`'s fields, explicitly submitted for co-sign): `grantRevision` — integer, strictly monotonic per instance; `effectiveGrants` — unique `Capability[]`. `SessionBinding` embeds these same two fields; `host.grants.changed` params = `GrantSnapshot`. Stale-revision notifications are discarded by revision comparison.

**`SendReceipt` beta.3 delta**: adds `messageHandle` typed as the **existing frozen `MessageHandle` $def** (`{kind:"message", token}`) — no new shape invented. Conformance oracle: `messageHandle.token !== messageId` (messageId is never the capability token). Fixture updates accompany the schema change (additive, disclosed).

**★ `SnapshotPageRequest`** (closed): `subscriptionId` — string; `pageToken` — optional opaque Host-minted continuation (absent = first page); `maxItems` — integer 1..64.
**★ `SnapshotPageResponse`** (closed): `items` — snapshot-view message projections, length ≤ `maxItems`; `nextPageToken` — string \| null (null = final page); `fenceSequence` — integer, minted on the first page and constant across the traversal.

**★ Snapshot completion via existing ack (FC-12 — replaces R7's response-delivery auto-advance, which had a response-loss hole and no replay carrier for single-page snapshots):**
- **No page response ever moves a cursor** — not intermediate, not final. The Host cannot observe whether the plugin received/persisted a response; cursor movement on write-out would let a pipe/process fault push `ackedSequence` past a fence the client never saw.
- The final page carries a **`snapshotAckToken`** (subscription-local, Host-minted, same `SubscriptionCursor` type as read-path ack tokens). **Client completion is explicit:** the plugin calls the existing `messaging.ack(subscriptionId, snapshotAckToken)`, which atomically max-advances `lastDeliveredSequence`/`ackedSequence` to the fence. Settlement rides row 7's existing key `(subscriptionId, ackToken)` — idempotent, replay-safe, works identically for single-page snapshots (the completion carrier is the token in the response, not a request pageToken).
- Consequences: non-stale subscriptions are never silently confirmed (advancing past unacked events is now the client's explicit ack decision); `read` remains parameter-unchanged; the acked/delivered co-advance question from R7 dissolves — it is a normal `ack` with a fence-valued token.
- `fenceSequence` stays monotonic across successive snapshots of one subscription.

**★★ DECISION ROW for K-2/K-1 (FC-13 — snapshot membership vs existing K-1 truth; we cannot self-decide this):** R7 defined membership as "canonical **publish** sequence ≤ fence", but K-1's snapshot today includes **host-relayed messages that carry no plugin publish sequence** (regression evidence: 205 host messages, resume=0), and beta.2's `MessageOutputEvent` covers only `message.publish | message.elements.append` — **there is no deletion event**, so "deletions reconcile via the post-fence event stream" referenced a stream that does not exist. Options for co-sign:
  (a) mint a **store-canonical sequence** covering every snapshot-visible message (plugin-published *and* host-relayed) and add deletion events to the output stream — most general, touches K-1 event model;
  (b) narrow snapshot membership to sequenced plugin output only — cheapest, but **incompatible with K-1's current snapshot shape**;
  (c) define an independent message-store MVCC fence (snapshot reads a store version, event stream stays as-is) — no new events needed, deletion race resolved by store versioning.
  *Our lean:* (c), because it matches K-1's existing behavior (host messages visible, no deletion events) without inventing new event kinds; membership then = "message visible in store version ≤ fence". Until K-2/K-1 pick a row, the fence's membership definition is **open** and rows 8's publication stays gated.
- *Token binding (unchanged from R7):* `pageToken` opaquely binds `(pluginInstanceId, subscription identity, fence, position, view-shape digest)`; any cross-context presentation → `VALIDATION`, fail-closed.

**★ Boundedness via a named wire DTO (FC-14 — must not tighten frozen Column-A `$defs`):**
1. `items` are **`SnapshotItem`** — a *new, named wire DTO* (projection: `messageId`, `threadId`, `revision`, fence-time `elements`), **not** the frozen `MessageEnvelope`. Field bounds (`messageId`/`threadId`/`subscriptionId` ≤ 128, actor/handle/page tokens ≤ 256, element ids ≤ 128) live **on the DTO**, so beta.2's published `$defs` are untouched — no breaking data-contract delta, no K-1 parity migration.
2. Defensive ceiling `maxSerializedItemBytes = 393_216` (384 KiB). An oversized stored item is a **system fault, not a caller error**: the response is the wire-level `SNAPSHOT_UNAVAILABLE` error class (below) with `data.reason = "OVERSIZED_ITEM"` — never `VALIDATION` against the requester, never a silent skip. Repair is Host-side; the caller may retry the same traversal after repair.
3. Page assembly truncates at `pageByteBudget = 786_432` bytes or `maxItems`, whichever first; with (1)+(2) every legal item fits a page and pages stay under the 1 MiB frame with ≥25% headroom.

**★ Delivery rejection (FC-8/FC-16 — no second identity source, no runtime-selected policy, canonical result restored):**
- *Error class:* public **`DELIVERY_REJECTED`** wire error (integer code per the mapping table below) with `error.data = { reason }` — `reason` is the sole data field; closed enum `UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL`.
- *Identity:* resolved **exclusively from the JSON-RPC correlation**; `error.data` carries no `deliveryId`.
- *Retry policy is Host-owned:* contract-fixed mapping — `UNSUPPORTED_PAYLOAD`/`NO_HANDLER` → dead-letter, `PLUGIN_BUSY`/`PLUGIN_INTERNAL` → bounded retry. The runtime reports facts, never selects Broker behavior; any other error shape on a deliver call is a connection-level protocol violation.
- *Success (canonical restored per FC-16):* result = **`deliveryId` ack exactly as the maintainer matrix states**, with a ★ strengthening: the echoed `deliveryId` **must equal** the Host's request identity byte-for-byte; mismatch is a connection-level protocol violation (fail-closed equality, per the R6 FC-8 fallback clause). R7's `null` result was an undisclosed delta from the canonical matrix and is withdrawn.

**★ Wire error envelope mapping (FC-15 — JSON-RPC 2.0 requires integer `error.code`; named classes map to reserved integers, strings live in `error.data`):**

| Named class | `error.code` (proposed reserved range) | `error.data` |
|---|---|---|
| `HANDSHAKE_REJECTED` | `-32090` | `{ reason }` — closed handshake reason enum |
| `DELIVERY_REJECTED` | `-32091` | `{ reason }` — closed delivery reason enum |
| `DOMAIN_ERROR` | `-32092` | `{ code }` — frozen `MessagingErrorCode` value |
| `DEADLINE_EXPIRED` | `-32093` | `{}` |
| `SNAPSHOT_UNAVAILABLE` | `-32094` | `{ reason }` — e.g. `OVERSIZED_ITEM` (system fault, Host-side repair) |

Every registry row's "error set" resolves through this table; no string ever appears as a top-level JSON-RPC `code`. New classes require a contract delta — the integer range is contract-reserved.

### Reject taxonomy (closed)

One public `HANDSHAKE_REJECTED` class, closed reason enum: `MALFORMED_HELLO`, `PACKAGE_MISMATCH`, `CONTRACT_INCOMPATIBLE`, `WIRE_INCOMPATIBLE`, `AUTHORITY_VIOLATION`, `DEADLINE_EXPIRED`, `BINDING_REPLAY`. Detailed Host diagnostics stay private.

### Session / resume (deferred)

V0 has **no resume token**. Every reconnect performs fresh `broker.hello`/`broker.ready` and receives a new `brokerSessionId`; logical work recovers through durable settlement/delivery ledgers. `bindingNonce` is connection-bound activation-only — replay of a consumed nonce is the executable `BINDING_REPLAY` oracle (resolving R4's OQ-6: the carrier now exists).

**Column C — kernel-owned, joined at the M0 gate:** unchanged (Broker dispatch/retry/dead-letter/reconcile, production supervision, production persistence — K-2).

**Cross-repo pinning declaration (replaces R4 version-skew text; sequence corrected per FC-17 — registry verification can only follow publication):** today *neither* kernel consumer pins a plugin-contract artifact — K-1 carries a drifting hand-written mirror (see baseline). The strict per-delta sequence is: **① #1165 explicit approval → ② contract PR review + merge → ③ publish beta.3 → ④ registry-verify exact version + integrity + exports → ⑤ K-1/K-2 re-pin that exact artifact and K-1 deletes the mirror.** No step precedes its predecessor; never via dist-tags.

## §3.8-1 adversarial-matrix coverage map

| Requirement | Slice/owner | Oracle |
|---|---|---|
| Existing 18 messaging cases | done (P-2) | 18/18 in-process; SDK-surface subset re-run over wire in P-1b |
| Handshake: malformed hello, package mismatch, contract/wire incompatible, **authority violation** (caller-supplied identity/grants), **binding replay** (consumed nonce), deadline expiry | P-1a fixtures + P-1b wire enforcement | stateful reject cases per closed reason enum |
| **Wire conformance (verdict condition 4):** split-read assembly, oversize frame, invalid frame (batch/blank/bad UTF-8/trailing data), authority violation, binding replay, **zero-side-effect handshake failure** | P-1a schemas + P-1b harness | conformance cases, fail-closed each |
| Deadline settlement, reconnect idempotency (same settlement key convergence), denied-grant call | P-1c | new behavior cases (additive, disclosed) |
| Crash isolation | P-1b harness demo + K-2 production | kill -9 mid-case → fails closed, harness survives |
| Callback retry / dead-letter / reconcile | K-2 (kernel), joint M0 gate | K-2 CI + joint run |
| Event-input four items / uninstall-durable state / namespace escape | C-2 / C-3 (unchanged defers) | per signed fixture allocation |
| P14 same-channel | P-1c | three-part lock (unchanged) |

## Slices

### P-1a.0 — Shape co-sign on #1165 (in progress)

**State:** first-party anchor open; maintainer verdict = *corrections required* (row-by-row above). **Gate order (corrected in R6):** every approval precondition is satisfied **inside this plan revision, before approval** — the field-level shape above (handshake structures, CallMeta, GrantSnapshot, SendReceipt delta, SnapshotPage pair, DeliveryRejection, full 12-row registry) *is* the co-signable artifact. Next action = replay this field-level shape into the #1165 issue body and request explicit `shape-approved`. P-1a then mechanizes the approved words verbatim; it defines nothing new. Precondition accounting:

1. corrected K-1 dependency truth — **in baseline table**;
2. `CandidateHello` / `SessionBinding` / `CallMeta` / `GrantSnapshot` / `SendReceipt.messageHandle` / registry rows / closed error data — **field-level in Column B** (contract ownership lands with P-1a mechanization);
3. bounded `SnapshotPageRequest/Response` + `DeliveryRejection` under the 1 MiB ceiling — **defined with boundedness proof in Column B** (★-marked fields are our proposal for maintainer decision);
4. split-read / oversize / invalid-frame / authority-violation / binding-replay / zero-side-effect handshake conformance — **in coverage map + P-1b**;
5. publication and K-1/K-2 re-pinning strictly ordered `approval → PR review/merge → publish → registry-verify → re-pin` (FC-17: verification necessarily follows publication) — **in cross-repo pinning declaration**.

Ownership-gate record (R3) stands: thread-level seam review is evidence, not signature.

### P-1a — Wire-protocol contract delta (contract PR, co-signed)

*Scope:* **mechanize the approved field-level shape verbatim — this slice defines nothing new.** Generated schemas for every Column-B type exactly as approved on #1165; NDJSON framing constants; the 12-row registry as machine truth; `HANDSHAKE_REJECTED` + closed reasons; **stateful reject fixtures** per closed reason incl. binding replay and zero-side-effect handshake failure; codegen projection + value-level regression locks. Any field the mechanization proves unworkable goes back to #1165 as a delta request — never silently adjusted.
*Non-goals:* no runtime, no transport code.
*Version:* `0.1.0-beta.3` on `next`; `latest` untouched; K-1/K-2 pinning per the cross-repo declaration.

### P-1b — Shared wire-client core + test-host harness (plugins PR)

Unchanged structure from R3/R4 (single wire client consumed by SDK; harness-not-Broker), now bound to the corrected shape: hello/ready two-step with nonce activation, frame-limit enforcement, deadline from `params.meta.deadlineUnixMs`. Dual-transport oracle split unchanged: plugin→Host semantic operations traverse the wire; governance/fixture-control stays in-process. Adds the six wire-conformance cases (coverage map) to the harness run.

### P-1c — SDK author surface (plugins PR)

Unchanged from R4 (same transport core; P14 three-part lock; SDK-expressible adversarial extensions now including settlement-key retry convergence). One canonical constraint added: **there is no grant-introspection RPC** — the SDK's grant surface is a local projection of `SessionBinding` + `host.grants.changed` (revision-monotonic cache), never a wire call; the Host re-reads current grants on every call regardless.

### Joint M0 gate — unchanged from roadmap.

## Review & release rhythm — unchanged (per-slice scan → fix → exact-SHA verdict → cloud → maintainer; unique prerelease; `latest` frozen; additive-only fixtures disclosed).

## Open questions

1. ~~Reject taxonomy~~ — **decided** (#1165): single `HANDSHAKE_REJECTED` + closed reason enum.
2. ~~Frame ceiling~~ — **decided**: 1 MiB hard, method-level pagination only.
3. ~~packageDigest form~~ — **decided**: single canonical SRI token.
4. Harness packaging (`./conformance` extension vs dev-only package) — still open, P-1a review decides.
5. ~~Settlement ↔ domain idempotency~~ — **decided**: no generic wire operationId; per-row `settlementKeySource`.
6. ~~Session/resume carrier~~ — **decided**: resume deferred; fresh handshake per reconnect; `bindingNonce` gives BINDING_REPLAY its carrier.

## Revision log

(R1–R4 predate this file's first git commit; their provenance is the Cat Café review exchange in threads `thread_mrkn6povq4zzgh45` (FC/SC rounds) and `thread_mrkmxgdfqquounc9` (K-1 seam evidence), not git history.)

- **R1 (2026-07-17):** fresh-context FC-1…FC-6 — core-shape predecessor, hello/ack split, wire/control-plane split, §3.8-1 coverage map, single wire client, P14 three-part lock.
- **R2 (2026-07-17):** FC-7 — Column A narrowed to data types + fixture vocabulary; wire method registry added.
- **R3 (2026-07-17):** K-1 seam corrections SC-1…SC-6 — four-way naming discipline; Host-bound identity; ownership gate recorded.
- **R4 (2026-07-17):** SC-7 — envelope settlement identity restored to owner-neutral three-candidate form.
- **R5 (2026-07-17):** absorbed the #1165 K-2 maintainer verdict (row-by-row): handshake structures `CandidateHello`/`SessionBinding` with one-use `bindingNonce`; framing accepted with constraints (1 MiB, NDJSON, protocol-only stdout); single SRI digest truth; settlement identity finalized as per-row `settlementKeySource` (no generic wire operationId — OQ-5 owner decision landed near the third candidate); resume deferred with fresh-handshake semantics (OQ-6 resolved; BINDING_REPLAY carrier = bindingNonce); explicit `SendReceipt.messageHandle` (supersedes R3 derivation phrasing); 12-method reserved registry with rows 8–9 publication-gated; closed `HANDSHAKE_REJECTED` taxonomy; **K-1 grounding correction** — `9fb37310` has no pin and a drifting mirror, R4's "K-1 stays on beta.1" text removed; five approval preconditions recorded in P-1a.0; wire-conformance six-pack added to coverage map and P-1b.
- **R6 (2026-07-17):** fresh-context findings on R5 (`34f9ef6`) absorbed — shape lifted from name-level to **field-level co-signable**: registry expanded to the canonical 12-row form verbatim (grant / input→result / error set per row, incl. `ack → null`, `ping nonce → nonce`); Concrete-wire-types section added — `CallMeta` (sole field `deadlineUnixMs`), `GrantSnapshot` (`grantRevision` + `effectiveGrants`, revision-monotonic), `SendReceipt.messageHandle` bound to the **existing frozen `MessageHandle` $def** with a `token !== messageId` oracle, ★`SnapshotPageRequest/Response` with fence/resume semantics and a byte-budget boundedness proof under the 1 MiB frame, ★`DeliveryRejection` closed enum with `retryable` broker input (FC-1/FC-2); **gate order fixed** — all approval preconditions satisfied inside this revision, P-1a mechanizes verbatim and defines nothing (FC-3); no-grant-introspection-RPC canonical ruling noted in P-1c; revision provenance corrected to thread anchors, R1–R4 no longer claim git history (FC-4).
- **R7 (2026-07-17):** fresh-context findings on R6 (`f842b8c`) absorbed — ★-proposal semantics settled: **final-page settlement** replaces the contradictory `resumeSequence` (intermediate pages zero cursor side effects; final page atomically max-advances `lastDeliveredSequence`/`ackedSequence` to the fence, idempotent under token replay; the acked co-advance explicitly flagged for K-2 judgment) (FC-5); **snapshot view semantics** defined — membership = publish sequence ≤ fence exactly once, fence-time revision projection, deletion-race immunity, pageToken opaquely bound to instance/subscription/fence/position/shape-digest (FC-6); **boundedness rebuilt** — root fix = ★maxLength on unbounded identity/string wire fields, defensive `maxSerializedItemBytes = 384 KiB` with fail-closed oversize error, then the 768 KiB page budget (payload cap alone proven insufficient) (FC-7); **delivery rejection de-privileged** — no `deliveryId` echo (correlation-only identity), no plugin-supplied `retryable`; closed reason → Host-owned policy mapping; public `DELIVERY_REJECTED` class with `reason` as sole data field; success = `null` ack (FC-8, closing rows 8–9 error placeholders per FC-9); `GrantSnapshot` field set re-marked ★ as our proposal, not canonical fact (FC-10); registry consistently described as 12-row and stale R5 markers removed (FC-11).
- **R8 (2026-07-17):** fresh-context findings on R7 (`81756f3`) absorbed — **snapshot completion made client-explicit** (FC-12): no page response ever moves a cursor; the final page carries a `snapshotAckToken` and completion rides the existing `messaging.ack` settlement `(subscriptionId, ackToken)` — closing the response-loss hole, giving single-page snapshots a completion carrier, and dissolving R7's auto-advance judgment; **snapshot membership converted to a ★★ DECISION ROW** (FC-13): R7's "publish sequence ≤ fence" conflicts with K-1's host-relayed unsequenced messages and beta.2's missing deletion events — three co-sign options recorded (store-canonical sequence + deletion events / plugin-output-only / store MVCC fence) with our lean = MVCC, publication of row 8 additionally gated on it; **`SnapshotItem` named wire DTO** (FC-14): field bounds live on the DTO, frozen Column-A `$defs` untouched (no breaking delta); oversized stored items are `SNAPSHOT_UNAVAILABLE` system faults with Host-side repair, never caller `VALIDATION`; **wire error envelope mapping added** (FC-15): named classes → reserved integer `error.code` (−32090…−32094), strings only in `error.data` — JSON-RPC 2.0 legality restored for every registry row; **row 9 result restored to canonical `deliveryId` ack** (FC-16) with a ★ byte-equality fail-closed strengthening — R7's undisclosed `null` delta withdrawn; **release sequence linearized** (FC-17): approval → PR review/merge → publish → registry-verify → re-pin.
