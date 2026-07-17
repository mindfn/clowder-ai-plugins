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
**真相源**：`docs/plans/2026-07-17-m0-standalone-io-plan.md` @ `9fe711c`（R26 = R4-intake 吸收：RequestId verbatim + source-owned bound inventory【transitively-bounded 声明撤回，K-1 producer 一手引证，未可证字段显式 reserved】）。
**状态**：D11（revision 4 body），R4-intake 两项已吸收——pending terra 内部窄扫——**先扫后投**；投递报新 raw API-string SHA-256，maintainer 将路由 exact bytes 给 Terra re-review。
**忠实性边界（R21 更新）**：rows 6/8/9 closure sections 内**仅 R2 之后新增的显式 field-level closure blocks（schema/grammar/cap 定义块）待 fresh review**；同 section 内标为 R2-absorbed/resolved/co-signed 的文字保持既决、不重开。其外 unmarked = canonical-decided 或 co-signed R2；★ = 单独标记的 open proposal。原 body 的 "K-1 remains pinned to beta.1" 错误陈述在本版修正（R5 grounding correction）。

---

## BODY（verbatim replace begins below）

## Status and request — revision 4: your R4-intake absorbed (RequestId verbatim; source-owned bound inventory); fresh review on these exact bytes requested

This remains a **shape-only K-2 / P-1a.0 co-sign anchor**. It does not authorize implementation, publication, dependency re-pin, or K-2 runtime work.

Your R3 verdict ([5004451129](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5004451129)) and addendum ([5004519194](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5004519194)) accepted the rows-6/8/9 field-level direction and identified five P1 closure gaps. **This revision fixes all five and answers the root failure mode you named** (closure claimed wider than closure proven) **with the five-axis row-by-row sweep below.** Your decisions remain unchanged (D0/D1a/D1b/D1c/D2 = A/c/a/a/b); the R2 complete-and-stable co-sign is not reopened.

**The five corrections in one view:**

| R3 P1 | Fix in this revision |
|---|---|
| 1 — `error.message` missing from the closed error object | per-class `const` messages added; full `{code, message, data}` object closed (wire-error table below) |
| 2 — page-token binding "full issuance context" not executable | binding set enumerated exactly (Row 8 invariants) |
| 3 — shared ack carrier not field-level closed | closed `MessagingAckRequest` + Host-resolved token kind (own section below) |
| 4 — bounded DTO narrowings vs K-1 byte-only admission | **frozen-compatible bounding rule**: R19–R21 narrowings withdrawn — `replyTo` restored to 1..256, uniform identifier caps and the `BoundedOpenPayload` structural grammar removed; no valid-write/unencodable-read path remains (DTO family section) |
| 5 — public bounds "adjusted without ceremony" | public schema bounds vs internal generated budgets split; entitlements bind an immutable shape/budget digest (rule below) |
| + (your R4-intake, this revision) | **RequestId absorbed verbatim** + the P1#4 "transitively bounded" claim replaced by the **source-owned bound inventory** (producer truths cited file:line; unattestable fields explicitly reserved) |
| + (internal review, earlier this revision) | the sweep's first axis was itself incomplete — the **outer JSON-RPC envelope** (`jsonrpc`, `id`, `method`, response correlation, result/error exclusivity) was undefined, letting a sub-frame request with an oversized `id` evade every DTO cap; an envelope family was defined with the `RequestId` representation left for your decision — **resolved by your intake, previous row** (envelope now closed, own section below) |

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

**Public bounds vs internal budgets (your R3 P1#5 — supersedes every earlier "provisional / adjusted without ceremony" phrasing):** a **public schema bound** (any request/result/error field cap, enum, grammar rule, or page limit visible in the contract schema) is fixed by co-sign; a proof-driven change to a public bound **reopens the shape gate as a reviewed contract delta** and never inherits the co-sign automatically. **Internal generator/assembler budgets** (`pageByteBudget`, `maxSerializedItemBytes`, per-row `maxEncoded{Request,Result,Error}Bytes` values) are generator-derived and may change without touching the public schema, provided every public bound still holds. Issued entitlements bind an **immutable shape/budget digest** — a budget change invalidates continuation across it rather than silently altering replay output.

## Corrections from your verdict/addendum — absorbed, confirmation requested

1. **Row 6 publication gate absorbed.** Your proof (a contract-valid compact `messaging.read` frame reaches 1,049,033 bytes — 457 over the 1,048,576 ceiling) is recorded; per your R2 D2 = (b) the bounded `SubscriptionReadPageRequest/Response` shape is now closed in this revision (Row 6 section below), and row 6 stays `ready=false` until its generated proofs and raw-byte conformance pass.
2. **Registry-wide `wireBounds` invariant pinned from the merged canonical doc** (`d606aab`, semantically equivalent restatement; the merged doc is the literal truth source): one generated `wireBounds` truth whose frame cap is v0 `maxFrameBytes`; a row may be marked ready only when ① every variable-length request/result/notification/acknowledgement/public-error field has a structural limit **plus an exact UTF-8/JSON byte validator** (`maxLength` counts characters, not encoded bytes), ② the row declares `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes`, each ≤ `maxFrameBytes` under the v0 compact profile incl. shared `CallMeta` and escaping, ③ collection assemblers admit an item only if the encoded page stays within the row's result budget, preserve continuation/watermark state when the next item does not fit, and prove one individually valid item fits, ④ request validation + row proofs are checked before authorization-visible business dispatch, dynamic page assembly completes within budget before advancing any delivered watermark, callback lease, or settlement state, and the final encoded frame is re-checked before write-queue mutation — an over-budget value is a contract violation, never a partially emitted success. Proof coverage spans requestId, plugin/package/version/session identifiers, `bindingNonce`, message/thread/subscription identifiers, handles, cursors, `deliveryId`, callback acknowledgements, and closed public error data. A method name may be reserved without proof, but cannot be published or advertised as ready.
3. **Grounding correction to the original anchor (our error, now fixed):** the original body claimed "K-1 remains pinned to exact `@clowder-ai/plugin-contract@0.1.0-beta.1`". That was wrong — K-1 branch `9fb37310` has **no plugin-contract package dependency and no pin**; it owns a hand-written mirror that already drifts from beta.2. The corrected later gate: co-signed contract PR → exact registry-verified artifact → K-1/K-2 explicitly re-pin that exact version → **K-1 removes its mirror before merge**. Neither consumer ever follows `next` or any mutable dist-tag.

## Shared bounded envelope/event DTO family (your D1c = (a), closed; payload truth for rows 6/8/9)

The family **mirrors the frozen beta.2 `$defs` structurally** — same members, same required sets, same closed unions and `const` discriminators; `additionalProperties: false` **wherever frozen is closed**. Bounds follow the **frozen-compatible rule** below (your R3 P1#4): frozen-existing bounds verbatim, no added structural narrowing on anything K-1 has historically admitted, exact closed bounds only on contract-minted wire fields with no historical data. Frozen-**open** payload objects (`MediaRefElementPayload` / `RichBlockElementPayload`, `{type: "object", additionalProperties: true}` by canonical design) **stay open-membered and structurally unconstrained**, bounded by the frozen byte caps alone (`x-clowder-bounds`: `maxElementPayloadBytes` = 65,536 per element payload, `maxTotalPayloadBytes` = 262,144 per message — already enforced by the K-1 semantic validator, landed as exact wire byte validators). The generator derives member/required/const sets from the frozen schema mechanically; **it may land frozen bounds and byte validators, never members and never sub-frozen narrowing**. Types:

- **`BoundedMessageEnvelope`** — field-for-field carry of frozen `MessageEnvelope`: `messageId`, `revision`, `threadId`, `replyTo?`, `actor`, `audience`, `occurredAt`, `payload`. Your R2 provenance/correlation/causation members are frozen members of `payload` (`payload.provenance`, `payload.correlationId` ≤256, `payload.causationId` ≤256) — carried, not re-modeled.
- **`BoundedMessageOutputEvent` = `BoundedMessagePublishEvent | BoundedMessageElementsAppendEvent`** — mirroring frozen `MessageOutputEvent`'s closed union exactly: *publish* = `{ eventId, sequence, type: "message.publish" (const), envelope: BoundedMessageEnvelope }`, all required; *elements-append* = `{ eventId, sequence, type: "message.elements.append" (const), messageId, threadId, operationId, baseRevision?, revision, elements (1..32) }` — **no envelope on the append arm** (canonical frozen shape).

**Bounding rule (frozen-compatible; supersedes revision 2's uniform class caps, which created valid-write/unencodable-read paths against K-1's byte-only admission — your R3 P1#4):**

| Field class | Rule | Instances |
|---|---|---|
| frozen-bounded domain fields | **frozen bounds verbatim** — the write-side (draft) bound is the historical admission ceiling and the DTO carries exactly it | `operationId` 1..200; `correlationId`/`causationId` 1..256; `elementId`/`derivedFromElementId` 1..128; **`replyTo` 1..256 (= frozen `MessageDraft.replyTo`; revision 2's 128 narrowing withdrawn)**; `PluginOrigin.instanceId`/`ExternalOrigin.connectorId`/`WhisperAudience.targets[]`/`ConnectorBindingAddress.handle` 1..256; `sourceEventId`/`ExternalSourceAddress.chatId`/`.messageId` 1..512; `ThreadHandleAddress.handle` 1..256; append `elements` maxItems 32; payload `elements` maxItems 128 |
| frozen-unbounded fields **inside byte-bounded payloads** | no added per-field cap — the frozen payload byte ceilings (65,536 / 262,144) are the exact wire bound for everything living inside an element payload | closed-def free text (e.g. `TextElementPayload.text`); minLength stays exactly as frozen |
| frozen-unbounded fields **outside the payload ceilings** | **source-owned wire bound per field** (your intake P1#4: the payload ceilings do not reach envelope-level identifiers/timestamps/tokens, and no finite proof derives from an unbounded string — our earlier "transitively bounded" claim is withdrawn as false). Each bound is grounded in its producer/admission truth, never a uniform cap; **a field whose source has no proven bound stays reserved and unclosed** (consistent with your D0 = A: every row is already `ready=false`) | producer inventory below |

**Source-owned bound inventory (producer truths read first-hand from K-1 exact `9fb37310`):**

| Field | Producer truth | Wire bound |
|---|---|---|
| `subscriptionId` | K-1 mints `sub_` + UUID = 40 chars fixed (`event-stream.ts:112`) | 1..128 (your `MessagingAckRequest` value; covers the mint) |
| `occurredAt` | K-1 emits `toISOString()` = 24 chars fixed, RFC3339 UTC ms `Z` (`envelope.ts:305`) | **exactly 24** (producer invariant; validator pins format and length) |
| `ThreadHandleAddress.handle` | K-1 mints `th_` + UUID = 39 chars (`handles.ts:47`; `cb_` variant `:61`) | frozen 1..256 verbatim (covers the mint) |
| `eventId` | K-1 composes `ev_pub_${messageId}_1` / `ev_app_${messageId}_${operationId}` (`send-service.ts:194`, `append-output.ts:211`) | composite: 7 + \|messageId\| + 1 + \|operationId ≤ 200\| — finite **once the `messageId` attestation lands** |
| `messageId`, `threadId` | minted inside K-1's core message store (`messageStore.append`), outside the messaging domain — not attestable from this repo | **pending your K-1 producer attestation** (an attested bound or admission gate, entering as a shape delta); until then these fields — and therefore `eventId` and `MessageHandle.token` — stay reserved/unclosed per your intake rule |
| `actor.id` | actor identity registry (`catRegistry` domain) — outside this repo's attestation reach | **pending attestation**, same rule |
| `MessageHandle.token` | canonical: derived from `messageId` | follows the `messageId` attestation |
| contract-minted wire fields (new in this shape; no historical data) | **exact closed bounds** | `ackToken`/`pageToken`/`nextPageToken`/`snapshotAckToken` 1..512; `deliveryId` 1..128; `subscriptionId` 1..128 (**your `MessagingAckRequest` specification**); `bindingNonce` and row-11 ping `nonce` 1..512 (sweep) |
| frozen-open payloads | **frozen byte caps only** — `MediaRefElementPayload`/`RichBlockElementPayload` stay `additionalProperties: true` with the frozen 65,536 encoded-bytes element validator and 262,144 per-message validator as the exact wire bound. **Revision 2's `BoundedOpenPayload` structural grammar (64 properties / depth 8 / per-key and per-string caps) is withdrawn** — K-1 admits these payloads under byte ceilings alone, so any structural narrowing is a valid-write/unencodable-read path. If you later want structural limits, that is a reviewed shape delta with a migration/admission proof — not presumed here | — |

An incompatible stored event (should the byte ceilings themselves ever be exceeded by legacy data) is an explicit **Host fault with a reconciliation path and zero cursor/lease/settlement movement** — never a silent skip, never caller validation (your addendum). The full-frame proof rests on the frozen byte ceilings plus each row's generated `maxEncoded{Request,Result,Error}Bytes` under the v0 compact profile — exact wire bounds without structural narrowing of canonical data. Item/page ceilings derive from generated full-frame proofs strictly below `maxFrameBytes`; the same family is the payload type for rows 6, 8, and 9 — **no per-row envelope variants**.

## Row 6 — `messaging.read` bounded paging (your D2 = (b), closed this round)

Frozen beta.2 already fixes the read-result discrimination: `SubscriptionReadResponse = SubscriptionNormalResponse | SubscriptionEmptyResponse | SubscriptionStaleResponse`, discriminated by `stale` (`const`) + `ackToken` nullability + `events` cardinality — the `oneOf` plus `const` locks make a fourth combination unrepresentable. **The bounded page family mirrors that frozen discrimination exactly.**

- **`SubscriptionReadPageRequest`** (closed, `additionalProperties: false`, all fields required): `subscriptionId` — string, minLength 1, maxLength 128; `limit` — integer 1..32 (aligned to frozen `events` maxItems 32; a **public schema bound** — change = reviewed shape delta). **No page token** — a read always resumes from Host-side `ackedSequence`; a page token may only be added by a later proposal proving a semantic need (your R2 ruling).
- **`BoundedSubscriptionReadPageResponse`** — closed `oneOf`, mirroring the frozen variants with bounded payloads. Every variant: required = `[events, ackToken, stale]` exactly (frozen mirror), `additionalProperties: false`:
  - *normal*: `{ events: BoundedMessageOutputEvent[] — minItems 1, maxItems 32 (frozen literal), ackToken: string (minLength 1 — frozen `SubscriptionCursor` mirror — maxLength 512), stale: false (const) }` — `ackToken` carries your kind-tagged read-page entitlement; disclosed delta vs frozen: frozen `SubscriptionCursor` was `minLength 1` with no upper bound, the bounded form adds maxLength 512 and your R2 kind tag;
  - *empty*: `{ events: [] (maxItems 0), ackToken: null, stale: false (const) }`;
  - *stale*: `{ events: [] (maxItems 0), ackToken: null, stale: true (const) }` — retention floor has passed the reader; recovery = `messaging.snapshot` catch-up.
  - Request-relative bound is a **conformance oracle**, not a schema constraint (JSON Schema cannot reference the request's `limit`): `events.length ≤ params.input.limit`, executed by the generated validator suite alongside the schema check.
  - No `lastEmittedSequence` response field: frozen has none, and the page's last emitted sequence lives inside the entitlement binding — a response copy would be an unconstrained second truth source.

**Host read algorithm (your R2 semantics; the empty branch is made explicit — your three-variant requirement implies the algorithm must produce it, a coherence completion, not a new decision):**

1. A read begins at `A = ackedSequence` (Host state; never caller-supplied).
2. The Host assembles a candidate page under the generated byte budget, stopping before the first non-fitting event, and proves one individually valid event fits.
3. The final retention-floor check runs **after** candidate assembly and byte proof but **before** any response, token, or cursor mutation.
4. If `A < currentFloor - 1` → the *stale* variant: zero events, null token, both cursors unchanged.
5. Else if the candidate page is **empty** → the *empty* variant: null token, **no entitlement minted, no cursor movement**.
6. Else (*normal*) → the Host mints the kind-tagged read-page ack entitlement bound at least to the plugin instance, subscription, the page's last emitted sequence, and the closed shape. Only after the final encoded-page proof may `lastDeliveredSequence` advance monotonically through that sequence.
7. `messaging.ack` validates the entitlement and advances `ackedSequence` monotonically only to its issued sequence; malformed, forged, cross-subscription, wrong-kind, or expired tokens fail before any mutation. Response loss re-reads from acked state.

Row 6 is `ready=false` until its generated byte proofs and N/N+1 raw-byte conformance pass.

## Shared ack carrier — `MessagingAckRequest` (closed; your R3 addendum P1#3 specification)

**`MessagingAckRequest`** (closed, `additionalProperties: false`, all fields required, no additions): `{ subscriptionId: string (minLength 1, maxLength 128), ackToken: string (minLength 1, maxLength 512) }` — the single `params.input` schema for `messaging.ack` (row 7), shared by read-page and snapshot-completion acknowledgements.

**Host-resolved token kind — caller text never selects the kind:** the Host resolves the minted token's kind from **stored provenance**, never from any caller-supplied field. A **read-page token** may advance only `ackedSequence`, monotonically, to its issued sequence. A **snapshot-completion token** performs the already-decided atomic dual advance (`lastDeliveredSequence` and `ackedSequence` monotonic-max to `H`) with terminal replay semantics. Missing, forged, cross-kind, cross-binding, or expired tokens **fail before any mutation**.

## Row 8 — snapshot sub-protocol (your D1a/D1b/D1c, resolved and closed)

**Fixed invariants (hold under the resolved design):**

- No snapshot page response ever moves a cursor (response-loss safety); completion is client-explicit. (Row-6 read pages differ by canonical design: emission advances `lastDeliveredSequence` post-proof, only ack advances `ackedSequence`.)
- Completion authorization is **Host-verifiable** — plugin-presented tokens alone cannot authorize cursor movement past `lastDeliveredSequence` (K-1's `q <= lastDeliveredSequence` guard stays load-bearing against forgery).
- Pages bounded, with your R3 public/internal split: `maxItems` 1..64 is a **public schema bound** — fixed by co-sign, changeable only as a reviewed shape delta; `pageByteBudget = 786_432` and `maxSerializedItemBytes = 393_216` are **internal assembler budgets** — generator-derived, adjustable without touching the public schema so long as every public bound and the strictly-below-`maxFrameBytes` proof still hold. Oversize stored item = system fault (`SNAPSHOT_UNAVAILABLE`), never caller `VALIDATION`, never silent skip.
- Token binding sets are **enumerated, not described** (your R3 P1#2). Completion token (your R2, exact): plugin instance, subscription, `viewVersion`, shape digest, final-page status, `resumeAfterSequence = H`. **Page token (your R3, exact): plugin instance, subscription, `viewVersion`, shape/budget digest, next page position, and the effective page profile/`maxItems`** — a continuation request whose caller-supplied value mismatches the token-bound value **fails before any page, token, or cursor mutation**; replay of the same valid token returns the same immutable-view page semantics: **identical items, identical continuation, identical final status**. Cross-context presentation → `VALIDATION` fail-closed.
- All snapshot strings carry exact `maxLength` on their own request/response fields (`subscriptionId` ≤ 128; `pageToken`/`nextPageToken`/`snapshotAckToken` ≤ 512).

**Your D1a — (c) causally fenced two-coordinate capture (absorbed):** a snapshot capture has one Host linearization point. The Host may mint an immutable view entitlement `(viewVersion, resumeAfterSequence = H)` only after proving that the view contains the cumulative effect of every snapshot-visible output event with sequence ≤ H; a message/revision lacking its matching output watermark, or any relevant write racing capture, aborts/retries the capture and issues no page or completion token. `viewVersion` governs membership and pagination only; `H` is the sole cursor catch-up target; one integer is never reused for both coordinate systems.

**Your D1b — (a) replay-safe Host entitlement through existing `messaging.ack` (absorbed):** the final-page completion token is kind-tagged and Host-verifiable, bound to the exact plugin instance, subscription, `viewVersion`, shape digest, final-page status, and `resumeAfterSequence = H`; it is not a caller-chosen kind string and does not relax the ordinary delivered-watermark guard. In one atomic transaction, completion validates all bindings, monotonic-max advances both `lastDeliveredSequence` and `ackedSequence` to `H`, and records terminal success. Forged, cross-context, non-final, or expired tokens mutate neither cursor; replay of the same terminal token returns the same success within the entitlement retention window. **No thirteenth public method.** Regression set: forged token, cross-subscription token, response loss, final-page replay, concurrent read/snapshot.

**Your D1c — (a) semantically complete bounded DTO (absorbed):** snapshot items preserve every canonical `MessageEnvelope` member via the shared bounded DTO family above; bounds live on the DTO, frozen `$defs` untouched, no K-1 parity migration.

**Closed shapes (on the resolved terms; row 8 `ready=false` until generated proofs pass):**

- `SnapshotPageRequest` (closed, `additionalProperties: false`; required = `[subscriptionId, maxItems]`, `pageToken` optional): `subscriptionId` (string, minLength 1, maxLength 128); `pageToken` (string, minLength 1, maxLength 512 — absent = first page; when present it is never empty); `maxItems` (1..64 — a **public schema bound**; change = reviewed shape delta).
- `SnapshotPageResponse` as closed discriminated variants. Both variants: required = `[items, nextPageToken, snapshotAckToken]` exactly, `additionalProperties: false`, `items` = `BoundedMessageEnvelope[]`:
  - *intermediate* = `{ items — minItems 1, maxItems 64, nextPageToken: string (minLength 1, maxLength 512), snapshotAckToken: null }`;
  - *final* = `{ items — minItems 0, maxItems 64 (an empty snapshot is a single empty final page), nextPageToken: null, snapshotAckToken: string (minLength 1, maxLength 512) }`;
  - no third combination; structural `maxItems` fixed at 64 (a **public schema bound**), request-relative bound as a **conformance oracle**: `items.length ≤ params.input.maxItems`;
  - same-token replay re-serves the equivalent page; token expiry bound to the view anchor's lifetime (Host GC policy over the D1a view entitlement).
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

### Outer JSON-RPC envelope (closed — your RequestId value absorbed verbatim; the frame level the DTO caps cannot see)

Without a contract-owned outer envelope, a sub-frame request with an enormous `id` or numeric deadline evades every method DTO cap while the decoder ceiling stays the last defense — which your merged canonical text forbids as a normal rejection path, and whose proof coverage explicitly spans `requestId`. The envelope family is contract-owned and closed (`additionalProperties: false`, all listed members required):

- **`WireRequest`** = `{ jsonrpc: "2.0" (const), id: RequestId, method: <the 12-name enum, direction-checked against the registry>, params: { meta: CallMeta, input: <the row's input schema> } (closed, exactly two keys) }`.
- **`WireNotification`** = same shape **without `id`** — legal only for registry rows declared as notifications (row 10 `host.grants.changed`); a notification with an `id`, or a request without one, is a connection-level protocol violation.
- **`WireSuccessResponse`** = `{ jsonrpc: "2.0" (const), id: RequestId (byte-equal echo of the originating request `id`), result: <the row's result schema> }` — no `error` member.
- **`WireErrorResponse`** = `{ jsonrpc: "2.0" (const), id: RequestId | null, error: { code (const int), message (const string), data (closed) } }` — no `result` member; **`id` is typed `RequestId` and must byte-equal the valid originating request `id`; the sole `null` branch is the closed pre-id failure case** (a frame whose `id` could not be validly extracted, per JSON-RPC 2.0 §5), never a Host choice on a valid request. Result/error mutual exclusivity is structural (`oneOf` of the two closed variants), never a runtime convention.
- **`RequestId` — your value, absorbed verbatim:** `type: string`, `minLength 1`, `maxLength 128`, `pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, raw UTF-8 byte length 1..128 (ASCII grammar ⇒ character count = byte count; JSON escaping cannot create a second size truth). **String-only: numeric and `null` request IDs are protocol violations before dispatch** — `null` exists only in the pre-id `WireErrorResponse` branch. In-flight uniqueness per `brokerSessionId` (collision fails before dispatch); **a retry is a new attempt with a fresh RequestId** (attempt-only, non-authoritative for settlement); success/error responses echo the originating valid ID **byte-for-byte**.
- **`deadlineUnixMs` wire numeric grammar (raw-token level, not parsed-value):** the raw JSON lexeme must match canonical decimal digits `0|[1-9][0-9]*` — no sign, no decimal point, **no exponent**, no leading zeros — with raw token length ≤ 16 characters (the decimal digit count of 2^53 − 1, a derived structural fact, not a policy number), validated **pre-parse/pre-dispatch**; exponent-padding and every other non-canonical numeric encoding is rejected before dispatch. The parsed value must additionally be a positive integer ≤ 2^53 − 1. The **operational Host deadline cap policy stays yours (K-2)**.
- The outer members (`jsonrpc`, `id`, `method`, braces and separators) are **included in every generated `maxEncoded{Request,Result,Error}Bytes` proof** — your RequestId value above is now fixed, and the proofs include its surrounding JSON quotes per your intake — with mutation and N/N+1 conformance cases proving oversize/malformed-envelope/non-canonical-numeric/non-string-id rejection **before authorization-visible dispatch**.

### Production method registry (12 reserved names; your canonical base matrix from `b32170a8` with inline marked overlays — merged settlement-mapping column, gate/lifecycle annotations)

| # | Method | Direction | Grant | Input → Result | Error set | Settlement key source |
|---|---|---|---|---|---|---|
| 1 | `broker.hello` | plugin → Host | protocol-intrinsic | `CandidateHello` → `SessionBinding` | `HANDSHAKE_REJECTED` | — |
| 2 | `broker.ready` | plugin → Host | protocol-intrinsic | `bindingNonce` → `null` | `HANDSHAKE_REJECTED` | — |
| 3 | `messaging.send` | plugin → Host | `messaging.send` | `MessageDraft` → `SendReceipt` **with `messageHandle`** | `MessagingErrorCode` + deadline | `input.idempotencyKey` |
| 4 | `messaging.appendElements` | plugin → Host | `messaging.appendElements` | `AppendElementsRequest` → `AppendReceipt` | `MessagingErrorCode` + deadline | `(Host-resolved messageId from input.handle, input.operationId)` |
| 5 | `messaging.subscribe` | plugin → Host | `message.event.subscribe` | handle → subscriptionId | `MessagingErrorCode` + deadline | Host-resolved `input.handle` identity (K-1 create-or-get authoritative) |
| 6 | `messaging.read` | plugin → Host | `message.event.subscribe` | `SubscriptionReadPageRequest` → `BoundedSubscriptionReadPageResponse` (normal/empty/stale, frozen-mirroring discrimination) — **closed this round (your D2 = (b); Row 6 section above); `ready=false` pending generated proofs** | `MessagingErrorCode` + deadline | none (at-least-once; bounded page assembly advances `lastDeliveredSequence` only through the last emitted event; only ack advances `ackedSequence` — via the kind-tagged read-page entitlement) |
| 7 | `messaging.ack` | plugin → Host | `message.event.subscribe` | subscriptionId + ackToken → `null` (= closed `MessagingAckRequest`; Host-resolved token kind) | `MessagingErrorCode` + deadline | `(input.subscriptionId, input.ackToken)` |
| 8 | `messaging.snapshot` | plugin → Host | `message.event.subscribe` | bounded `SnapshotPageRequest` → `SnapshotPageResponse` (**closed per your D1a/b/c — Row 8 section above**) | `DOMAIN_ERROR`/`DEADLINE_EXPIRED`/`SNAPSHOT_UNAVAILABLE` per wire mapping (co-signed R2) | none for traversal; completion = your D1b Host entitlement through existing `messaging.ack` (atomic dual-cursor advance to `H`); **`ready=false` pending generated proofs** |
| 9 | `host.messaging.deliver` | Host → plugin | `onMessage` | `HostMessagingDeliverRequest` (deliveryId + frozen `ThreadHandleAddress` + `BoundedMessageEnvelope`) → **`deliveryId` ack (canonical; echoed value must byte-equal the Host request identity — co-signed R2; mismatch = protocol violation)** | `DELIVERY_REJECTED` per wire mapping (co-signed R2) — **exact closed schemas this round; `ready=false` until callback request/ack/rejection byte proofs close** | `input.deliveryId` (Host-side authoritative) |
| 10 | `host.grants.changed` | Host → plugin | protocol-intrinsic | `GrantSnapshot` notification | none | (grantRevision monotonic) |
| 11 | `host.lifecycle.ping` | Host → plugin | protocol-intrinsic | nonce → nonce | protocol errors only | — |
| 12 | `host.lifecycle.drain` | Host → plugin | protocol-intrinsic | deadlineUnixMs → `null` | deadline | — |

No production method exists for fixture setup/observe, grant presets, revocation, permission-matrix inspection, or replay deletion; and **no grant-introspection RPC** — `SessionBinding` and `host.grants.changed` are the authoritative grant snapshots (your ruling). Fixture words never become production RPCs; capability ≠ semantic operation ≠ fixture op ≠ production method; identity is Host-bound (`pluginInstanceId` never accepted from params).

**Reservation-only lifecycle marker (your D0 = A):** every row above is `ready=false`, unpublished, and unadvertised until its exact UTF-8/JSON validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass.

**Contract-minted opaque tokens in handshake/lifecycle rows (sweep):** `bindingNonce` (rows 1–2) and the row-11 ping `nonce` are strings, minLength 1, maxLength 512 — closure-block bounds on contract-minted values with no historical data; the co-signed authority direction and semantics are unchanged.

### Concrete wire types

**`GrantSnapshot`** (closed; **co-signed R2** — the *name* was canonical, this exact field set was our proposal, now signed): `grantRevision` — integer, strictly monotonic per instance; `effectiveGrants` — unique `Capability[]`. `SessionBinding` embeds these same two fields; `host.grants.changed` params = `GrantSnapshot`. Stale-revision notifications are discarded by revision comparison.

**`SendReceipt` beta.3 delta**: adds `messageHandle` typed as the **existing frozen `MessageHandle` $def** (`{kind:"message", token}`) — no new shape invented. Conformance oracle: `messageHandle.token !== messageId`. Fixture updates accompany the schema change (additive, disclosed).

### Delivery rejection (row 9) — reasons, Host-owned policy, and echo semantics co-signed R2; bounded schemas closed this round

- *Error class:* public **`DELIVERY_REJECTED`** wire error with `error.data = { reason }` — sole data field; closed enum `UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL`.
- *Identity:* resolved **exclusively from the JSON-RPC correlation**; `error.data` carries no `deliveryId`.
- *Retry policy is Host-owned:* contract-fixed mapping — `UNSUPPORTED_PAYLOAD`/`NO_HANDLER` → dead-letter; `PLUGIN_BUSY`/`PLUGIN_INTERNAL` → bounded retry. The runtime reports facts, never selects Broker behavior; any other error shape on a deliver call is a connection-level protocol violation.
- *Success (canonical, equality target disambiguated):* result = `deliveryId` ack exactly as your matrix states, with the strengthening you co-signed at R2: the echoed value **must byte-equal `params.input.deliveryId`** of the originating request — never compared against the JSON-RPC `id`/`requestId`; mismatch is a connection-level protocol violation. The error path remains correlation-only and echoes nothing.
- *Exact closed callback schemas (this revision, your six-item list #4):*
  - **request** — `HostMessagingDeliverRequest` (closed, `additionalProperties: false`, all fields required), carried in `params.input` under the standard `params.meta` deadline: `{ deliveryId: string (minLength 1, maxLength 128), threadHandle: ThreadHandleAddress, envelope: BoundedMessageEnvelope }`. `ThreadHandleAddress` is the **existing frozen `$def`** — `{ kind: "thread_handle" (const), handle: string 1..256 }`, already closed and bounded; no new handle type is invented.
  - **acknowledgement** — the result schema is exactly `deliveryId: string (minLength 1, maxLength 128)`, byte-equal to `params.input.deliveryId` (mismatch = connection-level protocol violation; the equality oracle is a conformance case, the bound is the schema).
  - **rejection** — `DELIVERY_REJECTED` `error.data = { reason }`, closed 4-value enum (below).
  - Row 9 stays `ready=false` until its callback request/acknowledgement/rejection byte proofs and N/N+1 raw-byte conformance close.

### Wire error envelope mapping (co-signed R2; JSON-RPC 2.0 requires integer `error.code`)

| Named class | `error.code` (proposed reserved range) | `error.message` (**required per JSON-RPC 2.0 §5.1; exact per-class `const` — your R3 P1#1**) | `error.data` (closed; all fields `required`; `additionalProperties: false`) |
|---|---|---|---|
| `HANDSHAKE_REJECTED` | `-32090` | `"handshake rejected"` (const) | `{ reason: HandshakeRejectReason }` — closed 7-value enum below |
| `DELIVERY_REJECTED` | `-32091` | `"delivery rejected"` (const) | `{ reason: "UNSUPPORTED_PAYLOAD" \| "NO_HANDLER" \| "PLUGIN_BUSY" \| "PLUGIN_INTERNAL" }` |
| `DOMAIN_ERROR` | `-32092` | `"domain error"` (const) | `{ code: MessagingErrorCode }` — frozen 6-value enum |
| `DEADLINE_EXPIRED` | `-32093` | `"deadline expired"` (const) | `{}` (empty object, exactly) |
| `SNAPSHOT_UNAVAILABLE` | `-32094` | `"snapshot unavailable"` (const) | `{ reason: "OVERSIZED_ITEM" \| "VIEW_EXPIRED" \| "STORE_UNAVAILABLE" }` — closed enum |

The full public error object is therefore closed: `{ code (const integer), message (const string), data (closed object) }`, `additionalProperties: false`; per-class `const` messages make the `maxEncodedErrorBytes` and N/N+1 error-byte proofs exact (human-readable diagnostics stay in private Host logs, never on the wire).

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

## Five-axis failure-mode sweep (your R3 addendum requirement, executed row-by-row)

| Axis | Sweep result |
|---|---|
| complete JSON-RPC request / result / **full error** object | **outer envelope closed — your `RequestId` value absorbed verbatim** (`WireRequest`/`WireNotification`/`WireSuccessResponse`/`WireErrorResponse`; error-`id` typed with byte-equality, `null` only for the closed pre-id failure branch; structural result/error exclusivity; `deadlineUnixMs` raw-token canonical-decimal grammar ≤16 chars; deadline cap yours) + `params.meta` (closed `CallMeta`) + `params.input` (per-row named closed schema or frozen `$def`, rows 1–12) + error `{code const, message const, data closed}`; outer members (incl. the id and its quotes) enter every `maxEncoded*` proof. The sweep additionally bounded `bindingNonce` and row-11 ping `nonce` (1..512) |
| every caller-supplied value that can change replay output | read `limit` — no token; at-least-once re-read from acked state per the canonical row-6 settlement, page re-assembled from current state by design; snapshot `maxItems` — bound into the page token, mismatch fails before mutation; ack `subscriptionId`/`ackToken` — validated against the token's stored binding |
| every entitlement carrier and Host-only kind transition | single carrier = `MessagingAckRequest`; exactly two kinds (read-page / snapshot-completion), resolved from stored provenance only; per-kind cursor effects enumerated in the ack-carrier section; no caller-selectable kind exists |
| current plus historical producer values vs the bounded DTO | frozen-compatible rule: frozen-bounded fields verbatim (incl. `replyTo` 1..256), frozen-unbounded fields uncapped (byte ceilings govern), open payloads byte-only — no valid-write/unencodable-read path remains; incompatible stored data = explicit Host fault + reconciliation, zero progress movement |
| public schema bounds vs internal generated budgets | split rule above; public-bound changes reopen the gate as reviewed shape deltas; entitlements bind an immutable shape/budget digest |

## Shape gate checklist (current state)

- [x] authority direction for every handshake field — verdict absorbed; **co-signed R2**
- [x] production method registry — 12 reserved names / directions / base matrix **co-signed R2**; rows 6/8/9 field-level shapes closed this revision (fresh review requested)
- [x] session-injected identity boundary — Host-bound, fail-closed; **co-signed R2**
- [x] idempotency/settlement identity single truth source — per-row `settlementKeySource`; **co-signed R2**
- [x] receipt-to-handle relationship — explicit `messageHandle`; **co-signed R2**
- [x] framing and rejection semantics — v0 compact profile + `wireBounds` invariant; wire-error mapping and delivery-rejection semantics **co-signed R2**
- [x] **DECISION 0 / 1a / 1b / 1c / 2** — resolved by your R2 (**A / c / a / a / b**), absorbed above
- [x] **CO-SIGN** — complete-and-stable eight-item foundation co-signed at R2 as written
- [x] **rows 6/8/9 field-level direction — accepted at your R3** (pending the five P1 fixes)
- [x] **R3 five-P1 ledger + five-axis sweep — executed in this revision** (error `message` const · page-token binding set · `MessagingAckRequest` · frozen-compatible bounds · public/internal split)
- [x] **`RequestId` representation + byte bound — your value, absorbed verbatim this revision**
- [ ] **`messageId`/`threadId`/`actor.id` producer attestation — your attested bound or admission gate** (affected fields stay reserved until it lands; consistent with D0 = A)
- [ ] **fresh review on these exact live bytes** (raw API-string SHA-256 reported in the delivery comment)
- [ ] per-row `ready=true` — only after exact validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass (reservation-only lifecycle, your D0 = A)
- [ ] K-2 maintainer records `shape-approved`

No production implementation, no `beta.3` publication, no consumer re-pin, and no K-2 runtime work begins before your explicit approval, in the order you set.
