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
**真相源**：`docs/plans/2026-07-17-m0-standalone-io-plan.md` @ `34a9070`（R18 = maintainer R2 吸收：五决策全落定 D0=A/D1a=c/D1b=a/D1c=a/D2=b，stable foundation co-signed，rows 6/8/9 closed shapes 本轮闭合）。本 draft 执行 R2 六项 required revision 清单的 body 侧呈现。
**状态**：D3（DECISION 0/1/2 → resolved 记录；新增 shared DTO family / Row 6 closed schemas / snapshot closed shapes / row 9 bounded / cross-cutting invariant；ready=false 全表；approval marker unchecked），pending sol fresh narrow scan——**先扫后投**（sol R18 球明确要求任何 live issue edit 之前送 exact SHA 扫）。
**忠实性边界**：unmarked = canonical-decided（maintainer 已决，呈现仅确认吸收正确）；★ = our proposal pending co-sign；★★ = decision packet（owner 拍板）。原 body 的 "K-1 remains pinned to beta.1" 错误陈述在本版修正（R5 grounding correction）。

---

## BODY（verbatim replace begins below）

## Status and request — revision 2: your R2 decisions absorbed; rows 6/8/9 closed for fresh review

This remains a **shape-only K-2 / P-1a.0 co-sign anchor**. It does not authorize implementation, publication, dependency re-pin, or K-2 runtime work.

Your R2 decision ([comment 5001381702](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5001381702)) resolved every open decision variable and co-signed the complete-and-stable foundation as written. This revision executes your six-item list: the former DECISION sections are replaced by your decisions as decided, and rows 6/8/9 now carry **exact closed bounded schemas** on those terms.

**Your R2 decisions — absorbed as decided (no re-answer needed):**

| # | Decision | Your pick | Absorbed where |
|---|---|---|---|
| D0 | proofs-vs-shape lifecycle | **Option A — reservation-only** | lifecycle rule below + per-row `ready=false` in the registry |
| D1a | snapshot view coordinates | **(c) causally fenced two-coordinate capture** | snapshot section |
| D1b | completion authorization | **(a) replay-safe Host entitlement via existing `messaging.ack`** | snapshot section |
| D1c | item shape | **(a) semantically complete bounded DTO** | shared DTO family section |
| D2 | `messaging.read` paging | **(b) row 6 closed in this round** | Row 6 section |

**What this revision asks of you:** a **fresh review of the closed rows 6/8/9 schemas** (Row 6 / snapshot / Row 9 sections below) and the cross-cutting progress invariant. Per your item 6, the approval marker below stays **unchecked** until that review confirms.

The confirmed cross-repository order is unchanged:

```
core interface shape-approved
→ contract PR co-signed
→ exact artifact published and registry-verified
→ each consumer explicitly re-pins
```

**Reservation-only lifecycle (your D0 = Option A, absorbed):** the co-sign covers the closed field-level/reservation shape and authorizes only the contract PR; **every row is `ready=false`, unpublished, and unadvertised** until its exact UTF-8/JSON validators, generated `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes`, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass; proof failure returns as a shape delta and never silently raises the v0 cap.

**Cross-cutting progress invariant (your R2 wording, absorbed; rows 6/8/9):** a response may authorize cursor, lease, or settlement progress **only through a Host-minted entitlement produced after both causal completeness and the final wire-byte proof**; any stale, capture, or proof failure emits no entitlement and mutates no progress state.

## Corrections from your verdict/addendum — absorbed, confirmation requested

1. **Row 6 publication gate absorbed.** Your proof (a contract-valid compact `messaging.read` frame reaches 1,049,033 bytes — 457 over the 1,048,576 ceiling) is recorded; per your R2 D2 = (b) the bounded `SubscriptionReadPageRequest/Response` shape is now closed in this revision (Row 6 section below), and row 6 stays `ready=false` until its generated proofs and raw-byte conformance pass.
2. **Registry-wide `wireBounds` invariant pinned from the merged canonical doc** (`d606aab`, semantically equivalent restatement; the merged doc is the literal truth source): one generated `wireBounds` truth whose frame cap is v0 `maxFrameBytes`; a row may be marked ready only when ① every variable-length request/result/notification/acknowledgement/public-error field has a structural limit **plus an exact UTF-8/JSON byte validator** (`maxLength` counts characters, not encoded bytes), ② the row declares `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes`, each ≤ `maxFrameBytes` under the v0 compact profile incl. shared `CallMeta` and escaping, ③ collection assemblers admit an item only if the encoded page stays within the row's result budget, preserve continuation/watermark state when the next item does not fit, and prove one individually valid item fits, ④ request validation + row proofs are checked before authorization-visible business dispatch, dynamic page assembly completes within budget before advancing any delivered watermark, callback lease, or settlement state, and the final encoded frame is re-checked before write-queue mutation — an over-budget value is a contract violation, never a partially emitted success. Proof coverage spans requestId, plugin/package/version/session identifiers, `bindingNonce`, message/thread/subscription identifiers, handles, cursors, `deliveryId`, callback acknowledgements, and closed public error data. A method name may be reserved without proof, but cannot be published or advertised as ready.
3. **Grounding correction to the original anchor (our error, now fixed):** the original body claimed "K-1 remains pinned to exact `@clowder-ai/plugin-contract@0.1.0-beta.1`". That was wrong — K-1 branch `9fb37310` has **no plugin-contract package dependency and no pin**; it owns a hand-written mirror that already drifts from beta.2. The corrected later gate: co-signed contract PR → exact registry-verified artifact → K-1/K-2 explicitly re-pin that exact version → **K-1 removes its mirror before merge**. Neither consumer ever follows `next` or any mutable dist-tag.

## Shared bounded envelope/event DTO family (your D1c = (a), closed; payload truth for rows 6/8/9)

One contract-owned family of bounded wire DTOs carries every message payload crossing the wire: **`BoundedMessageEnvelope`** (snapshot items, row-9 delivery payloads) and **`BoundedMessageEvent`** (row-6 read pages: the envelope plus its event coordinates, at minimum the event sequence). Rules:

- field-for-field carry of every canonical `MessageEnvelope` member — including actor, audience, occurredAt, replyTo, provenance, correlation, and **causation** (your R2 list) — per the frozen beta.2 `$defs`; the P-1a generator derives the member list from the frozen schema, never by hand;
- every copied variable-length field carries an exact structural cap **plus** a generated UTF-8/JSON byte validator (bounds live on the DTO; frozen `$defs` untouched);
- item/page ceilings derive from generated full-frame proofs strictly below `maxFrameBytes` (numbers provisional);
- the same family is the payload type for rows 6, 8, and 9 — **no per-row envelope variants**.

## Row 6 — `messaging.read` bounded paging (your D2 = (b), closed this round)

**`SubscriptionReadPageRequest`** (closed, `additionalProperties: false`): `subscriptionId` — string ≤128; `limit` — integer 1..64 (provisional cap pending generated proof). **No page token** — a read always resumes from Host-side `ackedSequence`; a page token may only be added by a later proposal proving a semantic need (your R2 ruling).

**`SubscriptionReadPageResponse`** — closed variants discriminated by `status`, exact presence rules, no fourth combination:

- *events*: `{ status: "events", events: BoundedMessageEvent[] (1..limit), lastEmittedSequence: integer, readAckToken: string(≤512) }`;
- *empty*: `{ status: "empty" }` — nothing at or above the read start; no token, no cursor movement;
- *stale*: `{ status: "stale" }` — zero events, no ack token, both cursors unchanged (retention floor has passed the reader; recovery path = `messaging.snapshot` catch-up).

(Read uses an explicit three-way `status` discriminator because three variants cannot be encoded by two nullable-field presence rules without a fourth illegal combination; snapshot keeps its two-variant presence discrimination, which your R2 left unchanged.)

**Host read algorithm (your R2 decision, absorbed):**

1. A read begins at `A = ackedSequence` (Host state; never caller-supplied).
2. The Host assembles a candidate page under the generated byte budget, stopping before the first non-fitting event, and proves one individually valid event fits.
3. The final retention-floor check runs **after** candidate assembly and byte proof but **before** any response, token, or cursor mutation.
4. If `A < currentFloor - 1` → the closed *stale* variant: zero events, no ack token, both cursors unchanged.
5. Otherwise the Host mints a kind-tagged read-page ack entitlement bound at least to the plugin instance, subscription, the page's last emitted sequence, and the closed shape. Only after the final encoded-page proof may `lastDeliveredSequence` advance monotonically through the page's last emitted event.
6. `messaging.ack` validates the entitlement and advances `ackedSequence` monotonically only to its issued sequence; malformed, forged, cross-subscription, wrong-kind, or expired tokens fail before any mutation. Response loss re-reads from acked state.

Row 6 is `ready=false` until its generated byte proofs and N/N+1 raw-byte conformance pass.

## Row 8 — snapshot sub-protocol (your D1a/D1b/D1c, resolved and closed)

**Fixed invariants (hold under the resolved design):**

- No snapshot page response ever moves a cursor (response-loss safety); completion is client-explicit. (Row-6 read pages differ by canonical design: emission advances `lastDeliveredSequence` post-proof, only ack advances `ackedSequence`.)
- Completion authorization is **Host-verifiable** — plugin-presented tokens alone cannot authorize cursor movement past `lastDeliveredSequence` (K-1's `q <= lastDeliveredSequence` guard stays load-bearing against forgery).
- Pages bounded: page and item ceilings are **derived from generated full-frame proofs** and land strictly below `maxFrameBytes`. The specific values (`maxItems` 1..64, `pageByteBudget = 786_432`, `maxSerializedItemBytes = 393_216`) are **provisional candidates only**, adjusted without ceremony if the generated proof rejects them. Oversize stored item = system fault (`SNAPSHOT_UNAVAILABLE`), never caller `VALIDATION`, never silent skip.
- Page/completion tokens opaquely bind their full issuance context; cross-context presentation → `VALIDATION` fail-closed. (Your R2 fixes the completion-token binding set exactly: plugin instance, subscription, `viewVersion`, shape digest, final-page status, `resumeAfterSequence = H`.)
- All snapshot strings carry exact `maxLength` on their own request/response fields (`subscriptionId` ≤ 128; `pageToken`/`nextPageToken`/`snapshotAckToken` ≤ 512).

**Your D1a — (c) causally fenced two-coordinate capture (absorbed):** a snapshot capture has one Host linearization point. The Host may mint an immutable view entitlement `(viewVersion, resumeAfterSequence = H)` only after proving that the view contains the cumulative effect of every snapshot-visible output event with sequence ≤ H; a message/revision lacking its matching output watermark, or any relevant write racing capture, aborts/retries the capture and issues no page or completion token. `viewVersion` governs membership and pagination only; `H` is the sole cursor catch-up target; one integer is never reused for both coordinate systems.

**Your D1b — (a) replay-safe Host entitlement through existing `messaging.ack` (absorbed):** the final-page completion token is kind-tagged and Host-verifiable, bound to the exact plugin instance, subscription, `viewVersion`, shape digest, final-page status, and `resumeAfterSequence = H`; it is not a caller-chosen kind string and does not relax the ordinary delivered-watermark guard. In one atomic transaction, completion validates all bindings, monotonic-max advances both `lastDeliveredSequence` and `ackedSequence` to `H`, and records terminal success. Forged, cross-context, non-final, or expired tokens mutate neither cursor; replay of the same terminal token returns the same success within the entitlement retention window. **No thirteenth public method.** Regression set: forged token, cross-subscription token, response loss, final-page replay, concurrent read/snapshot.

**Your D1c — (a) semantically complete bounded DTO (absorbed):** snapshot items preserve every canonical `MessageEnvelope` member via the shared bounded DTO family above; bounds live on the DTO, frozen `$defs` untouched, no K-1 parity migration.

**Closed shapes (on the resolved terms; row 8 `ready=false` until generated proofs pass):**

- `SnapshotPageRequest` (closed, `additionalProperties: false`): `subscriptionId` (≤128); `pageToken` (≤512, absent = first page); `maxItems` (1..64, provisional cap pending generated proof).
- `SnapshotPageResponse` as closed discriminated variants: *intermediate* = `{ items, nextPageToken: string(≤512), snapshotAckToken: null }`; *final* = `{ items, nextPageToken: null, snapshotAckToken: string(≤512) }` — presence rules exact, no third combination; `items` = `BoundedMessageEnvelope[]`; same-token replay re-serves the equivalent page; token expiry bound to the view anchor's lifetime (Host GC policy over the D1a view entitlement).
- Completion rides your D1b through existing `messaging.ack`; cursor advance targets `resumeAfterSequence = H` per your D1a.
- Oversize-vs-immutable-traversal: an `OVERSIZED_ITEM` fault poisons and expires the traversal's view anchor — the same `pageToken` thereafter returns `SNAPSHOT_UNAVAILABLE { reason: "VIEW_EXPIRED" }`; after Host-side repair the caller starts a **new** snapshot; repair never mutates an existing view.

## Complete and stable — CO-SIGNED at your R2 (as written; text unchanged in this revision)

Your R2 co-signed this eight-item foundation as written: handshake authority direction and closed rejection taxonomy; compact NDJSON framing, 1 MiB hard cap, and single SRI package digest; attempt-only request IDs and per-row settlement keys; no-resume v0 reconnect semantics; the twelve reserved production names and directions; `GrantSnapshot` fields; the `-32090..-32094` closed wire-error mapping; delivery-rejection reasons, Host-owned retry policy, and exact `deliveryId` echo semantics. Items formerly marked ★ within this portion are therefore now signed (markers updated below). **The co-sign does not close the field-level shapes for rows 6, 8, or 9 — those are the closed schemas above, awaiting your fresh review.**

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

### Production method registry (12 reserved names; your canonical base matrix from `b32170a8` with inline marked overlays — merged settlement-mapping column, gate/lifecycle annotations)

| # | Method | Direction | Grant | Input → Result | Error set | Settlement key source |
|---|---|---|---|---|---|---|
| 1 | `broker.hello` | plugin → Host | protocol-intrinsic | `CandidateHello` → `SessionBinding` | `HANDSHAKE_REJECTED` | — |
| 2 | `broker.ready` | plugin → Host | protocol-intrinsic | `bindingNonce` → `null` | `HANDSHAKE_REJECTED` | — |
| 3 | `messaging.send` | plugin → Host | `messaging.send` | `MessageDraft` → `SendReceipt` **with `messageHandle`** | `MessagingErrorCode` + deadline | `input.idempotencyKey` |
| 4 | `messaging.appendElements` | plugin → Host | `messaging.appendElements` | `AppendElementsRequest` → `AppendReceipt` | `MessagingErrorCode` + deadline | `(Host-resolved messageId from input.handle, input.operationId)` |
| 5 | `messaging.subscribe` | plugin → Host | `message.event.subscribe` | handle → subscriptionId | `MessagingErrorCode` + deadline | Host-resolved `input.handle` identity (K-1 create-or-get authoritative) |
| 6 | `messaging.read` | plugin → Host | `message.event.subscribe` | `SubscriptionReadPageRequest` → status-discriminated events/empty/stale variants — **closed this round (your D2 = (b); Row 6 section above); `ready=false` pending generated proofs** | `MessagingErrorCode` + deadline | none (at-least-once; bounded page assembly advances `lastDeliveredSequence` only through the last emitted event; only ack advances `ackedSequence` — via the kind-tagged read-page entitlement) |
| 7 | `messaging.ack` | plugin → Host | `message.event.subscribe` | subscriptionId + ackToken → `null` | `MessagingErrorCode` + deadline | `(input.subscriptionId, input.ackToken)` |
| 8 | `messaging.snapshot` | plugin → Host | `message.event.subscribe` | bounded `SnapshotPageRequest` → `SnapshotPageResponse` (**closed per your D1a/b/c — Row 8 section above**) | `DOMAIN_ERROR`/`DEADLINE_EXPIRED`/`SNAPSHOT_UNAVAILABLE` per wire mapping (co-signed R2) | none for traversal; completion = your D1b Host entitlement through existing `messaging.ack` (atomic dual-cursor advance to `H`); **`ready=false` pending generated proofs** |
| 9 | `host.messaging.deliver` | Host → plugin | `onMessage` | deliveryId + threadHandle + `BoundedMessageEnvelope` → **`deliveryId` ack (canonical; echoed value must byte-equal the Host request identity — co-signed R2; mismatch = protocol violation)** | `DELIVERY_REJECTED` per wire mapping (co-signed R2) — **bounded schemas closed this round (shared DTO family); `ready=false` until callback request/ack/rejection byte proofs close** | `input.deliveryId` (Host-side authoritative) |
| 10 | `host.grants.changed` | Host → plugin | protocol-intrinsic | `GrantSnapshot` notification | none | (grantRevision monotonic) |
| 11 | `host.lifecycle.ping` | Host → plugin | protocol-intrinsic | nonce → nonce | protocol errors only | — |
| 12 | `host.lifecycle.drain` | Host → plugin | protocol-intrinsic | deadlineUnixMs → `null` | deadline | — |

No production method exists for fixture setup/observe, grant presets, revocation, permission-matrix inspection, or replay deletion; and **no grant-introspection RPC** — `SessionBinding` and `host.grants.changed` are the authoritative grant snapshots (your ruling). Fixture words never become production RPCs; capability ≠ semantic operation ≠ fixture op ≠ production method; identity is Host-bound (`pluginInstanceId` never accepted from params).

**Reservation-only lifecycle marker (your D0 = A):** every row above is `ready=false`, unpublished, and unadvertised until its exact UTF-8/JSON validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass.

### Concrete wire types

**`GrantSnapshot`** (closed; **co-signed R2** — the *name* was canonical, this exact field set was our proposal, now signed): `grantRevision` — integer, strictly monotonic per instance; `effectiveGrants` — unique `Capability[]`. `SessionBinding` embeds these same two fields; `host.grants.changed` params = `GrantSnapshot`. Stale-revision notifications are discarded by revision comparison.

**`SendReceipt` beta.3 delta**: adds `messageHandle` typed as the **existing frozen `MessageHandle` $def** (`{kind:"message", token}`) — no new shape invented. Conformance oracle: `messageHandle.token !== messageId`. Fixture updates accompany the schema change (additive, disclosed).

### Delivery rejection (row 9) — reasons, Host-owned policy, and echo semantics co-signed R2; bounded schemas closed this round

- *Error class:* public **`DELIVERY_REJECTED`** wire error with `error.data = { reason }` — sole data field; closed enum `UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL`.
- *Identity:* resolved **exclusively from the JSON-RPC correlation**; `error.data` carries no `deliveryId`.
- *Retry policy is Host-owned:* contract-fixed mapping — `UNSUPPORTED_PAYLOAD`/`NO_HANDLER` → dead-letter; `PLUGIN_BUSY`/`PLUGIN_INTERNAL` → bounded retry. The runtime reports facts, never selects Broker behavior; any other error shape on a deliver call is a connection-level protocol violation.
- *Success (canonical, equality target disambiguated):* result = `deliveryId` ack exactly as your matrix states, with the strengthening you co-signed at R2: the echoed value **must byte-equal `params.input.deliveryId`** of the originating request — never compared against the JSON-RPC `id`/`requestId`; mismatch is a connection-level protocol violation. The error path remains correlation-only and echoes nothing.
- *Bounded schemas (this revision, your six-item list #4 — shared DTO family):* the deliver request (`deliveryId` string ≤128 provisional, bounded `threadHandle`, payload = `BoundedMessageEnvelope`), the result's `deliveryId` echo (same bound, byte-equality oracle), and the closed `DELIVERY_REJECTED` `error.data` are exact closed bounded schemas; row 9 stays `ready=false` until its callback request/acknowledgement/rejection byte proofs and raw-byte conformance close.

### Wire error envelope mapping (co-signed R2; JSON-RPC 2.0 requires integer `error.code`)

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

- [x] authority direction for every handshake field — verdict absorbed; **co-signed R2**
- [x] production method registry — 12 reserved names / directions / base matrix **co-signed R2**; rows 6/8/9 field-level shapes closed this revision (fresh review requested)
- [x] session-injected identity boundary — Host-bound, fail-closed; **co-signed R2**
- [x] idempotency/settlement identity single truth source — per-row `settlementKeySource`; **co-signed R2**
- [x] receipt-to-handle relationship — explicit `messageHandle`; **co-signed R2**
- [x] framing and rejection semantics — v0 compact profile + `wireBounds` invariant; wire-error mapping and delivery-rejection semantics **co-signed R2**
- [x] **DECISION 0 / 1a / 1b / 1c / 2** — resolved by your R2 (**A / c / a / a / b**), absorbed above
- [x] **CO-SIGN** — complete-and-stable eight-item foundation co-signed at R2 as written
- [ ] **rows 6/8/9 closed bounded schemas + cross-cutting progress invariant — fresh review requested (this revision)**
- [ ] per-row `ready=true` — only after exact validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass (reservation-only lifecycle, your D0 = A)
- [ ] K-2 maintainer records `shape-approved`

No production implementation, no `beta.3` publication, no consumer re-pin, and no K-2 runtime work begins before your explicit approval, in the order you set.
