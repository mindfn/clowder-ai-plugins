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
**真相源**：`docs/plans/2026-07-17-m0-standalone-io-plan.md` R31（maintainer revision-4 audit `5008567649` + three dual fresh-context/fix-confirmation scans；以 exhaustive raw-frame/lexeme/leaf matrix 为唯一 closure truth）。
**状态**：D17（revision 6 body），R5 两 P1 已修——pending 本 thread 双猫窄扫（sol/terra finding-only）——**先扫后投**；投递报新 raw API-string hash/count packet，maintainer exact-body re-review（不 route Terra pre-verdict）。
**忠实性边界**：R2 已签语义决策不重开；本次只纠正“哪些 leaf/row 已 closed”的事实与其机械推导。`CLOSED`/`RESERVED` 仅由下方 matrix 决定；任何旧 prose “closed” 标签与 matrix 冲突时一律以 matrix 为准。PR #7 保持 draft 且不改代码。

---

## BODY（verbatim replace begins below）

## Status and request — revision 6: your R5 exact-body audit absorbed — M7 reserved, Invalid Request dual id arms

This remains a **shape-only K-2 / P-1a.0 co-sign anchor**. It does not authorize implementation, publication, dependency re-pin, or K-2 runtime work.

Your revision-4 audit ([5008567649](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5008567649)) found that our prose sweep omitted handshake/session/grant leaves and non-deadline integers. **That completeness claim is withdrawn.** Revision 5 installs one authoritative matrix for all 12 shapes. Three dual scans extended raw proof to canonical strings/numbers, integer consts, ten public errors, SRI pad bits, duplicate names, and scalar-only Unicode. Exact K-1 has no Unicode-scalar admission or stored-value migration proof, so M1/M2 are reserved. The checklist, five-axis sweep, and row statuses are matrix projections, not separate claims.

Your R5 exact-body audit ([5011835675](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5011835675)) accepted the matrix, projection, prior reservations, and named profiles, and found two P1 closure errors. **Both are fixed in this revision:** M7 `occurredAt` moves **CLOSED → RESERVED** (your K-1 source-path evidence adopted verbatim: a target-output validator is not compatible-source evidence — the same failure mode we already handle in M1/M2/I1), and the standard-error union's `Invalid Request` now has **two closed id arms** (valid-id byte echo vs `null` on failed detection, per JSON-RPC 2.0 §5).

**Revision-4 disposition in one view:**

| Item | Revision-5 treatment |
|---|---|
| Prior revision-4 closures | retained: exact `RequestId`; fixed public error literals; frozen payload byte limits; source-grounded `replyTo` bound and `occurredAt`; explicit reservation of M1/M2 scalar compatibility, `messageId`/`threadId`/`actor.id`, and derived handle/event fields |
| Handshake/session/grant omission | `packageDigest` closed as exact 95-byte SRI; `grantRevision` uses the one canonical integer profile; finite grants/nonce closed; `pluginId`, `contractVersion`, `wireVersion`, `pluginInstanceId`, `brokerSessionId` explicitly `RESERVED` |
| Non-deadline integer omission | one `WireUInt53` raw-number profile defined; small new/public controls close under it; existing K-1 revision/sequence families stay `RESERVED` because exact K-1 has no safe-integer admission or stored-value migration invariant |
| Root correction | one raw-frame/leaf matrix; scalar-only canonical strings/numbers and all ten public errors; M1/M2 reserved pending K-1 scalar admission + attestation/migration; seven rows reserved, five leaf-closed, all `ready=false` |

**Your R2 decisions — absorbed as decided (no re-answer needed):**

| # | Decision | Your pick | Absorbed where |
|---|---|---|---|
| D0 | proofs-vs-shape lifecycle | **Option A — reservation-only** | lifecycle rule below + per-row `ready=false` in the registry |
| D1a | snapshot view coordinates | **(c) causally fenced two-coordinate capture** | snapshot section |
| D1b | completion authorization | **(a) replay-safe Host entitlement via existing `messaging.ack`** | snapshot section |
| D1c | item shape | **(a) semantically complete bounded DTO** | shared DTO family section |
| D2 | `messaging.read` paging | **(b) keep row 6 in this round; semantics/topology resolved** | Row 6 section; variable-leaf status comes from the matrix and is currently `RESERVED` |

**What this revision asks of you:** review the exhaustive matrix and confirm its reservation boundary. In particular, please confirm that H1/H3/H4/H5/H6, M1/M2/M5/M6/**M7**, and I1 may remain explicitly reserved under D0 instead of being guessed closed (M7 joins per your R5 P1-1). The approval marker stays **unchecked**.

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

1. **Row 6 semantic direction absorbed; closure overclaim withdrawn.** Your proof (a contract-valid compact `messaging.read` frame reaches 1,049,033 bytes — 457 over the 1,048,576 ceiling) is recorded; per your R2 D2 = (b), the bounded request/response topology remains in this round. The leaf matrix now correctly marks row 6 `RESERVED` through M1/M2/M5/M6/I1; it cannot become `ready=true` until those entries close and its generated proofs/raw-byte conformance pass.
2. **Registry-wide `wireBounds` invariant pinned from the merged canonical doc** (`d606aab`, semantically equivalent restatement; the merged doc is the literal truth source): one generated `wireBounds` truth whose frame cap is v0 `maxFrameBytes`; a row may be marked ready only when ① every variable-length request/result/notification/acknowledgement/public-error field has a structural limit **plus an exact UTF-8/JSON byte validator** (`maxLength` counts characters, not encoded bytes), ② the row declares `maxEncodedRequestBytes`/`maxEncodedResultBytes`/`maxEncodedErrorBytes`, each ≤ `maxFrameBytes` under the v0 compact profile incl. shared `CallMeta` and escaping, ③ collection assemblers admit an item only if the encoded page stays within the row's result budget, preserve continuation/watermark state when the next item does not fit, and prove one individually valid item fits, ④ request validation + row proofs are checked before authorization-visible business dispatch, dynamic page assembly completes within budget before advancing any delivered watermark, callback lease, or settlement state, and the final encoded frame is re-checked before write-queue mutation — an over-budget value is a contract violation, never a partially emitted success. Proof coverage spans requestId, plugin/package/version/session identifiers, `bindingNonce`, message/thread/subscription identifiers, handles, cursors, `deliveryId`, callback acknowledgements, and closed public error data. A method name may be reserved without proof, but cannot be published or advertised as ready.
3. **Grounding correction to the original anchor (our error, now fixed):** the original body claimed "K-1 remains pinned to exact `@clowder-ai/plugin-contract@0.1.0-beta.1`". That was wrong — K-1 branch `9fb37310` has **no plugin-contract package dependency and no pin**; it owns a hand-written mirror that already drifts from beta.2. The corrected later gate: co-signed contract PR → exact registry-verified artifact → K-1/K-2 explicitly re-pin that exact version → **K-1 removes its mirror before merge**. Neither consumer ever follows `next` or any mutable dist-tag.

## Shared bounded envelope/event DTO family (your D1c = (a), topology resolved; leaf closure comes only from the matrix)

The family **mirrors the frozen beta.2 `$defs` structurally** — same members, same required sets, same closed unions and `const` discriminators; `additionalProperties: false` **wherever frozen is closed**. Bounds follow the **frozen-compatible rule** below (your R3 P1#4): frozen-existing bounds verbatim, no added structural narrowing on anything K-1 has historically admitted, exact closed bounds only on contract-minted wire fields with no historical data. Frozen-**open** payload objects (`MediaRefElementPayload` / `RichBlockElementPayload`, `{type: "object", additionalProperties: true}` by canonical design) **stay open-membered and structurally unconstrained**, bounded by the frozen byte caps alone (`x-clowder-bounds`: `maxElementPayloadBytes` = 65,536 per element payload, `maxTotalPayloadBytes` = 262,144 per message — already enforced by the K-1 semantic validator, landed as exact wire byte validators). The generator derives member/required/const sets from the frozen schema mechanically; **it may land frozen bounds and byte validators, never members and never sub-frozen narrowing**. Types:

- **`BoundedMessageEnvelope`** — field-for-field carry of frozen `MessageEnvelope`: `messageId`, `revision`, `threadId`, `replyTo?`, `actor`, `audience`, `occurredAt`, `payload`. Your R2 provenance/correlation/causation members are frozen members of `payload` (`payload.provenance`, `payload.correlationId` ≤256, `payload.causationId` ≤256) — carried, not re-modeled.
- **`BoundedMessageOutputEvent` = `BoundedMessagePublishEvent | BoundedMessageElementsAppendEvent`** — mirroring frozen `MessageOutputEvent`'s closed union exactly: *publish* = `{ eventId, sequence, type: "message.publish" (const), envelope: BoundedMessageEnvelope }`, all required; *elements-append* = `{ eventId, sequence, type: "message.elements.append" (const), messageId, threadId, operationId, baseRevision?, revision, elements (1..32) }` — **no envelope on the append arm** (canonical frozen shape).

**Bounding rule (frozen-compatible; supersedes revision 2's uniform class caps, which created valid-write/unencodable-read paths against K-1's byte-only admission — your R3 P1#4):**

| Field class | Rule | Instances |
|---|---|---|
| frozen-bounded domain fields | **frozen bounds verbatim** — the write-side (draft) bound is the historical admission ceiling and the DTO carries exactly it | `operationId` 1..200; `correlationId`/`causationId` 1..256; `elementId`/`derivedFromElementId` 1..128; **`replyTo` 1..256 (= frozen `MessageDraft.replyTo`; revision 2's 128 narrowing withdrawn)**; `PluginOrigin.instanceId`/`ExternalOrigin.connectorId`/`WhisperAudience.targets[]`/`ConnectorBindingAddress.handle` 1..256; `sourceEventId`/`ExternalSourceAddress.chatId`/`.messageId` 1..512; `ThreadHandleAddress.handle` 1..256; append `elements` maxItems 32; payload `elements` maxItems 128 |
| frozen-unbounded fields **inside byte-bounded payloads** | no added per-field cap — the frozen payload byte ceilings (65,536 / 262,144) are the exact wire bound for everything living inside an element payload | closed-def free text (e.g. `TextElementPayload.text`); minLength stays exactly as frozen |
| frozen-unbounded fields **outside the payload ceilings** | **source-owned wire bound per field** (your intake P1#4: the payload ceilings do not reach envelope-level identifiers/timestamps/tokens, and no finite proof derives from an unbounded string — our earlier "transitively bounded" claim is withdrawn as false). Each bound is grounded in its producer/admission truth, never a uniform cap; **a field whose source has no proven bound stays reserved and unclosed** (consistent with your D0 = A: every row is already `ready=false`) | producer inventory below |

**Source-owned evidence index (producer truths read first-hand from K-1 exact `9fb37310`; inputs to the authoritative matrix, not a second closure ledger):**

| Field | Producer truth | Wire bound |
|---|---|---|
| `subscriptionId` | K-1 mints `sub_` + UUID = 40 chars fixed (`event-stream.ts:112`) | 1..128 (your `MessagingAckRequest` value; covers the mint) |
| `occurredAt` | K-1 emits `new Date(msg.timestamp).toISOString()` (`envelope.ts:305`); `toISOString()` yields 24 chars for years 0000..9999 but **27 for expanded ISO years** (`+010000-01-01T00:00:00.000Z`), and K-1 admission stores `timestamp: number` with no range check | **1..27 raw UTF-8** — the full valid-Date `toISOString()` output domain — with an RFC3339/expanded-ISO UTC grammar validator; narrowing to four-digit years (⇒ exact 24) would be your separately reviewed shape delta |
| `ThreadHandleAddress.handle` | K-1 mints `th_` + UUID = 39 chars (`handles.ts:47`; `cb_` variant `:61`) | frozen 1..256 verbatim (covers the mint) |
| `eventId` | two distinct producers: publish arm `ev_pub_${messageId}_1` = 7 + \|messageId\| + 2 (`send-service.ts:194`); append arm `ev_app_${messageId}_${operationId}` = 7 + \|messageId\| + 1 + \|operationId ≤ 200\| (`append-output.ts:211`) | both branch formulas finite **once the `messageId` attestation lands**; both stay reserved until then |
| `messageId`, `threadId` | minted inside K-1's core message store (`messageStore.append`), outside the messaging domain — not attestable from this repo | **pending your K-1 producer attestation** (an attested bound or admission gate, entering as a shape delta); until then these fields — and therefore `eventId` and `MessageHandle.token` — stay reserved/unclosed per your intake rule |
| `actor.id` | actor identity registry (`catRegistry` domain) — outside this repo's attestation reach | **pending attestation**, same rule |
| `MessageHandle.token` | canonical: derived from `messageId` | follows the `messageId` attestation |
| contract-minted wire fields (new in this shape; no historical data) | **exact closed bounds** | `ackToken`/`pageToken`/`nextPageToken`/`snapshotAckToken` 1..512; `deliveryId` 1..128; `subscriptionId` 1..128 (**your `MessagingAckRequest` specification**); `bindingNonce` and row-11 ping `nonce` 1..512 (sweep) |
| frozen-open payloads | **frozen byte caps only** — `MediaRefElementPayload`/`RichBlockElementPayload` stay `additionalProperties: true` with the frozen 65,536 encoded-bytes element validator and 262,144 per-message validator as the exact wire bound. **Revision 2's `BoundedOpenPayload` structural grammar (64 properties / depth 8 / per-key and per-string caps) is withdrawn** — K-1 admits these payloads under byte ceilings alone, so any structural narrowing is a valid-write/unencodable-read path. If you later want structural limits, that is a reviewed shape delta with a migration/admission proof — not presumed here | — |

An incompatible stored event (should the byte ceilings themselves ever be exceeded by legacy data) is an explicit **Host fault with a reconciliation path and zero cursor/lease/settlement movement** — never a silent skip, never caller validation (your addendum). The full-frame proof rests on the frozen byte ceilings plus each row's generated `maxEncoded{Request,Result,Error}Bytes` under the v0 compact profile — exact wire bounds without structural narrowing of canonical data. Item/page ceilings derive from generated full-frame proofs strictly below `maxFrameBytes`; the same family is the payload type for rows 6, 8, and 9 — **no per-row envelope variants**.

## Exhaustive raw-frame, raw-lexeme, and variable-width leaf closure matrix (authoritative)

A row/DTO/envelope is closed only when every reachable pre-parse frame structure, variable-width leaf, and raw JSON lexeme whose information would be lost or normalized by parsing maps to a `CLOSED` entry here. Grouped entries enumerate every schema path they cover. Exact sources: **T1** = plugins beta.2 `f52e820` manifest/messaging schemas; **T2** = K-1 exact `9fb37310` producer/admission code; **T3** = K-2 canonical `d606aab`; **T4** = your revision-4 audit `5008567649`; **T5** = [JSON-RPC 2.0 §5/§5.1](https://www.jsonrpc.org/specification#response_object) + [RFC 4648 §3.5](https://www.rfc-editor.org/rfc/rfc4648.html#section-3.5) + [RFC 8259 §§2, 4, 6, 8.2](https://www.rfc-editor.org/rfc/rfc8259.html#section-8.2).

Pre-parse raw-frame acceptance grammar:

| Component | Rule | Closure consequence |
|---|---|---|
| frame | one UTF-8 non-batch object, no BOM/insignificant whitespace, LF outside the byte count | raw framing cannot inflate a generated compact-frame proof |
| object | canonical-decoded member names pairwise unique at every object depth; member order unconstrained | duplicate names cannot collapse after parse or multiply a closed member's byte contribution |
| string token | `UnicodeScalarString` then `CanonicalStringToken` at every name/value position | escape aliases cannot normalize after parse; lone surrogates cannot cross runtimes as parser-dependent pseudo-characters |
| number token | every path selects `WireUInt53`, `WireIntConst`, or M2 `CanonicalNumberToken` | exponent, sign, precision, and negative-zero aliases cannot normalize after parse |
| `true` / `false` / `null` | exact lowercase JSON literals | finite by JSON grammar |

Validator profiles:

- `UnicodeScalarString`: decoded names/values contain no isolated UTF-16 surrogate; lone `"\ud800"`/`"\udc00"` reject before token comparison (RFC 8259 §8.2).
- `CanonicalStringToken`: after that scalar check, the inbound raw lexeme byte-equals the production compact encoding before parsed-value/schema validation; outbound uses the same encoder. Alternate `\u` spellings reject; equality alone is not a scalar proof.
- `CanonicalNumberToken`: an M2 raw numeric lexeme must byte-equal the production compact encoder's scalar serialization of the same parsed **finite** numeric value, recursively at every object/array depth before schema validation. This rejects `1e2` for `100`, `-0` for `0`, exponent padding, and values outside the encoder's finite numeric domain.
- `JSONString(N)`: `UnicodeScalarString` + `CanonicalStringToken` + schema `maxLength: N` in Unicode code points and compact-leaf check `utf8(JSON.stringify(value)).length <= 6N + 2` bytes (quotes included); full frames use the same production compact encoder and actual bytes.
- `ASCII(N)`: `UnicodeScalarString` + `CanonicalStringToken` plus ASCII grammar of at most N chars; compact leaf ≤ `N + 2` bytes including quotes.
- `WireUInt53(min,max)`: raw lexeme `0|[1-9][0-9]{0,15}`, length 1..16, no sign/point/exponent/leading zero, checked pre-parse; parsed value must be a safe integer inside the field range, maximum `9_007_199_254_740_991`.
- `WireIntConst(S)`: the inbound numeric lexeme must byte-equal the signed canonical decimal literal `S` before parse; parsed equality alone is insufficient.
- `PayloadBytes(65_536,262_144)`: pre-parse raw payload slices are checked at the frozen per-element/per-message limits after W0 token/uniqueness acceptance; parsed/outbound compact encodings are re-checked at the same limits before dispatch/state mutation or write.
- `CLOSED` = finite shape + exact raw-byte validator + compatible source/admission evidence, pending your co-sign. `RESERVED` = at least one is absent; a reaching row may expose only its reserved method name, never an advertised request/result schema.

| ID | Rows and exact raw-lexeme / variable-width leaf paths | Representation | Structural bound | Exact raw-token / byte validator | Producer / admission source | Status |
|---|---|---|---|---|---|---|
| W0 | all rows, every object depth and raw frame token | compact UTF-8 JSON frame | one non-batch object; no whitespace; scalar-only decoded strings; unique decoded member names/object; member order unconstrained | streaming/pre-parse grammar gate; lone surrogates, duplicate names, and unprofiled string/number tokens reject before schema/dispatch | T3 framing + T5 JSON grammar/interoperability + R30/R31 fix-confirmation REDs; historical compatibility remains leaf-owned | **CLOSED** |
| W1 | rows 1–9, 11–12 request/response/error `id` | ASCII `RequestId` | 1..128; `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; in-flight unique/session | `ASCII(128)` = 3..130 encoded bytes; response echo byte-equal | T4 exact owner value | **CLOSED** |
| W2 | rows 1–9, 11–12 `params.meta.deadlineUnixMs`; row-10 common notification meta; row-12 `params.input.deadlineUnixMs` | JSON integer | `WireUInt53(1, 9_007_199_254_740_991)` | canonical raw lexeme 1..16 bytes, pre-parse | existing deadline rule + T3 Host cap | **CLOSED** |
| W3 | every finite literal leaf: outer `jsonrpc`/`method`; five application + five JSON-RPC standard error code/message pairs; application error data; beta.2 actor/element/epistemic/error enums and all address/origin/audience/event/handle consts; capability values | closed string const/enum + signed integer error-code const | exact finite sets: 12 methods, ten public code/message pairs across **eleven closed variants** (Invalid Request has two id arms), every schema enum/const; standard errors have no data, application errors have closed data | strings pass `UnicodeScalarString` + `CanonicalStringToken`; codes pass `WireIntConst`; generator measures every complete error variant | T1 enum/consts + T3 registry + R2 application errors + T5 standard errors | **CLOSED** |
| H1 | row-1 hello/result `pluginId` | Unicode string | beta.2 min 1, **no max** | none finite | T1; installed-record equality does not bound the manifest | **RESERVED** |
| H2 | row-1 hello/result `packageDigest` | SHA-512 SRI ASCII | exactly 95; `^sha512-[A-Za-z0-9+/]{85}[AQgw]==$` | `ASCII(95)` = exactly 97 bytes; decode → re-encode equality proves zero pad bits | T3/T4 + T5 canonical Base64 | **CLOSED** |
| H3 | row-1 hello/result `contractVersion` | SemVer 2 string | T1 grammar, min 1, **no max** | none finite | T1; installed equality is semantic, not admission | **RESERVED** |
| H4 | row-1 hello/result `wireVersion` | owner representation pending | none | none | T3 names compatibility only | **RESERVED** |
| H5 | row-1 result `pluginInstanceId` | Host ID, grammar pending | none | none | new K-2 value; no owner bound | **RESERVED** |
| H6 | row-1 result `brokerSessionId` | Host ID, grammar pending | none | none | new K-2 value; no owner bound | **RESERVED** |
| H7 | row-1 result + row-10 `grantRevision` | JSON integer | `WireUInt53(0, 9_007_199_254_740_991)`; monotonic/instance; overflow refused | canonical raw 1..16 bytes, pre-parse/pre-emit | new Host state; T3/K-2 admission rule | **CLOSED** |
| H8 | row-1 result + row-10 `effectiveGrants[]` | unique Capability enum array | 0..17, derived from T1's 17-value enum | generated longest legal array; duplicate/non-enum rejected | T1 + Host authority | **CLOSED** |
| H9 | row-1 result / row-2 input `bindingNonce` | opaque Unicode | 1..512 | `JSONString(512)` ≤3,074 bytes | new Host one-use value; cap is admission | **CLOSED** |
| M1 | row-3 bounded draft strings; row-4 operation/element IDs; row-6/8/9 copies | target scalar strings | T1: 128 element IDs; 200 idempotency/operation; 256 handles/provenance/audience/correlation/causation/replyTo; 512 source/external IDs | target `JSONString(N)`; exact bytes, unattested source compatibility | T1/T2 admit bounded JS strings without scalar guard/stored-value proof | **RESERVED** pending K-1 Unicode-scalar admission + stored-value attestation/migration invariant |
| M2 | rows 3/4 inputs + rows 6/8/9 copies: text and all open media/rich names/values/nesting | target scalar compact JSON | `PayloadBytes(65_536,262_144)`; no invented grammar | target W0 scalar strings/uniqueness + recursive canonical strings/numbers; raw + re-encode caps | T1/T2 lack scalar guard; R30/R31 REDs | **RESERVED** pending K-1 Unicode-scalar admission + stored-value attestation/migration invariant |
| M3 | arrays: draft elements 1..32; whisper targets 1..16; append input/event elements 1..32; applied IDs 1..32; read events 0..32; snapshot items 0..64; envelope elements 1..128 | JSON arrays | listed bounds; applied IDs derive from input; `items <= maxItems` remains a cross-document oracle | compact array + per-item validation; assembler checks full frame before admit | T1/T2 + R2 snapshot choice | **CLOSED for cardinality**; containing row inherits any reserved item leaf |
| M4 | row-5 input `handle`; rows 5 result/6/7/8 input `subscriptionId`; row-6/7 ack token; row-8 page/next/ack tokens; row-9 input/result `deliveryId`; row-11 input/result `nonce` | opaque Unicode | handle 1..256; subscription/delivery 1..128; tokens/nonces 1..512 | `JSONString(N)` | T2 handle/subscription mints (39/40 chars); new Host values use public cap as admission | **CLOSED** |
| M5 | row-3 result; row-4 request/result; rows 6/8 results; row-9 input: `messageId`, `threadId`, `actor.id`, `MessageHandle.token` | Unicode, grammar pending | beta.2 min 1 only | none | T2 core stores/identity registry; your audit accepts reservation | **RESERVED** |
| M6 | row-6 publish/append `eventId` | derived Unicode | publish `7+\|messageId\|+2`; append `7+\|messageId\|+1+\|operationId\|`, operation ≤200; unbounded while M5 is | none until M5 closes | T2 send/append producers | **RESERVED** |
| M7 | rows 6/8/9 envelope `occurredAt` | ASCII UTC timestamp | 1..27, RFC3339/expanded-year UTC grammar **as the target validator only** | `ASCII(27)` ≤29 encoded bytes | your R5 P1-1: `toISOString()` bounds the output only after conversion succeeds — not compatible-source evidence; exact K-1 stores `timestamp: number` with no valid-Date invariant, transcript imports copy `evt.t` unchecked, imported messages pass `isSnapshotVisible`, and `projectEnvelope` converts unguarded — a JSON-safe `8_640_000_000_000_001` throws `RangeError` before any wire value exists | **RESERVED** — pending your K-1 valid-Date admission invariant plus stored-data attestation/migration; an invalid stored timestamp takes the explicit zero-progress Host fault/reconciliation path |
| I1 | row-3 result revision/publishSequence; row-4 baseRevision/revision/appendSequence; rows 6/8/9 envelope/event revision/sequence/baseRevision; legacy snapshot resumeSequence and new entitlement source `H` | target `WireUInt53` (revision min1, sequence min0) | target max safe integer, **not yet admitted** | target canonical 1..16 bytes, but source guard absent | T2 uses `Number.isInteger`; Redis `INCR` is converted directly with `Number`; persisted increments have no safe guard | **RESERVED** pending K-1 admission + stored-value attestation/migration invariant |
| I2 | row-6 `limit`; row-8 `maxItems` | JSON integer | `WireUInt53(1,32)` / `WireUInt53(1,64)` | canonical raw + parsed range; ≤2 bytes | frozen read bound / R2 snapshot shape | **CLOSED** |

Beta.2 snapshot arrays become bounded pages; their sequence source remains I1-reserved. Opaque token provenance is Host-stored and M4 bounds its carrier. W0 covers frame structure, scalar strings, and duplicate names. Numeric tokens join W2/H7/I1/I2, W3, or M2; strings are scalar-checked then canonical. M1/M2 stay reserved because target rejection does not prove K-1 historical compatibility. Booleans/null are finite.

### Derived row closure projection

| Row | Matrix join | Field-level status | Publication |
|---|---|---|---|
| 1 `broker.hello` | W0/W1/W2/W3 + H1–H9 | **RESERVED** — H1/H3/H4/H5/H6 | `ready=false` |
| 2 `broker.ready` | W0/W1/W2/W3 + H9; row-1 dependency | **RESERVED** — no activation without closed binding | `ready=false` |
| 3 `messaging.send` | W0/W1/W2/W3 + M1/M2/M3/M5 + I1 | **RESERVED** — legacy string/payload admission + IDs/handle/integer result | `ready=false` |
| 4 `messaging.appendElements` | W0/W1/W2/W3 + M1/M2/M3/M5 + I1 | **RESERVED** — legacy string/payload admission + handle/IDs/integers | `ready=false` |
| 5 `messaging.subscribe` | W0/W1/W2/W3 + M4 | **CLOSED leaf shape** | `ready=false` pending proofs/runtime gates |
| 6 `messaging.read` | W0/W1/W2/W3 + M1–M7 + I1/I2 | **RESERVED** — legacy string/payload admission + event/envelope IDs/integers + timestamp admission (M7) | `ready=false` |
| 7 `messaging.ack` | W0/W1/W2/W3 + M4 | **CLOSED leaf shape** | `ready=false` pending proofs/runtime gates |
| 8 `messaging.snapshot` | W0/W1/W2/W3 + M1/M2/M3/M4/M5/M7 + I1/I2 | **RESERVED** — legacy string/payload admission + envelope IDs/revision + Host sequence + timestamp admission (M7) | `ready=false` |
| 9 `host.messaging.deliver` | W0/W1/W2/W3 + M1/M2/M3/M4/M5/M7 + I1 | **RESERVED** — legacy string/payload admission + envelope IDs/revision + timestamp admission (M7) | `ready=false` |
| 10 `host.grants.changed` | W0/W2/W3 + H7/H8 | **CLOSED leaf shape** | `ready=false` pending proofs/runtime gates |
| 11 `host.lifecycle.ping` | W0/W1/W2/W3 + M4 | **CLOSED leaf shape** | `ready=false` pending proofs/runtime gates |
| 12 `host.lifecycle.drain` | W0/W1/W2/W3 | **CLOSED leaf shape** | `ready=false` pending proofs/runtime gates |

No row inherits closure from prose. Moving any `RESERVED` entry to `CLOSED` requires a reviewed source/admission delta and simultaneous recomputation of this projection, the sweep/checklist, schemas, and byte fixtures.

## Row 6 — `messaging.read` bounded paging (your D2 = (b), semantics/topology resolved; matrix status `RESERVED`)

Frozen beta.2 already fixes the read-result discrimination: `SubscriptionReadResponse = SubscriptionNormalResponse | SubscriptionEmptyResponse | SubscriptionStaleResponse`, discriminated by `stale` (`const`) + `ackToken` nullability + `events` cardinality — the `oneOf` plus `const` locks make a fourth combination unrepresentable. **The bounded page family mirrors that frozen discrimination exactly.**

- **`SubscriptionReadPageRequest`** (closed, `additionalProperties: false`, all fields required): `subscriptionId` — string, minLength 1, maxLength 128; `limit` — integer 1..32 (aligned to frozen `events` maxItems 32; a **public schema bound** — change = reviewed shape delta). **No page token** — a read always resumes from Host-side `ackedSequence`; a page token may only be added by a later proposal proving a semantic need (your R2 ruling).
- **`BoundedSubscriptionReadPageResponse`** — structurally closed `oneOf` (member/discriminator topology), mirroring the frozen variants; contained leaves inherit M1–M7/I1. Every variant: required = `[events, ackToken, stale]` exactly (frozen mirror), `additionalProperties: false`:
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

Row 6 remains structurally `RESERVED` until matrix M1/M2/M5/M6/I1 close; after that it is still `ready=false` until generated byte proofs and N/N+1 raw-byte conformance pass.

## Shared ack carrier — `MessagingAckRequest` (closed; your R3 addendum P1#3 specification)

**`MessagingAckRequest`** (closed, `additionalProperties: false`, all fields required, no additions): `{ subscriptionId: string (minLength 1, maxLength 128), ackToken: string (minLength 1, maxLength 512) }` — the single `params.input` schema for `messaging.ack` (row 7), shared by read-page and snapshot-completion acknowledgements.

**Host-resolved token kind — caller text never selects the kind:** the Host resolves the minted token's kind from **stored provenance**, never from any caller-supplied field. A **read-page token** may advance only `ackedSequence`, monotonically, to its issued sequence. A **snapshot-completion token** performs the already-decided atomic dual advance (`lastDeliveredSequence` and `ackedSequence` monotonic-max to `H`) with terminal replay semantics. Missing, forged, cross-kind, cross-binding, or expired tokens **fail before any mutation**.

## Row 8 — snapshot sub-protocol (your D1a/D1b/D1c semantics/topology resolved; matrix status `RESERVED`)

**Fixed invariants (hold under the resolved design):**

- No snapshot page response ever moves a cursor (response-loss safety); completion is client-explicit. (Row-6 read pages differ by canonical design: emission advances `lastDeliveredSequence` post-proof, only ack advances `ackedSequence`.)
- Completion authorization is **Host-verifiable** — plugin-presented tokens alone cannot authorize cursor movement past `lastDeliveredSequence` (K-1's `q <= lastDeliveredSequence` guard stays load-bearing against forgery).
- Pages bounded, with your R3 public/internal split: `maxItems` 1..64 is a **public schema bound** — fixed by co-sign, changeable only as a reviewed shape delta; `pageByteBudget = 786_432` and `maxSerializedItemBytes = 393_216` are **internal assembler budgets** — generator-derived, adjustable without touching the public schema so long as every public bound and the strictly-below-`maxFrameBytes` proof still hold. Oversize stored item = system fault (`SNAPSHOT_UNAVAILABLE`), never caller `VALIDATION`, never silent skip.
- Token binding sets are **enumerated, not described** (your R3 P1#2). Completion token (your R2, exact): plugin instance, subscription, `viewVersion`, shape digest, final-page status, `resumeAfterSequence = H`. **Page token (your R3, exact): plugin instance, subscription, `viewVersion`, shape/budget digest, next page position, and the effective page profile/`maxItems`** — a continuation request whose caller-supplied value mismatches the token-bound value **fails before any page, token, or cursor mutation**; replay of the same valid token returns the same immutable-view page semantics: **identical items, identical continuation, identical final status**. Cross-context presentation → `VALIDATION` fail-closed.
- All snapshot strings carry exact `maxLength` on their own request/response fields (`subscriptionId` ≤ 128; `pageToken`/`nextPageToken`/`snapshotAckToken` ≤ 512).

**Your D1a — (c) causally fenced two-coordinate capture (absorbed):** a snapshot capture has one Host linearization point. The Host may mint an immutable view entitlement `(viewVersion, resumeAfterSequence = H)` only after proving that the view contains the cumulative effect of every snapshot-visible output event with sequence ≤ H; a message/revision lacking its matching output watermark, or any relevant write racing capture, aborts/retries the capture and issues no page or completion token. `viewVersion` governs membership and pagination only; `H` is the sole cursor catch-up target; one integer is never reused for both coordinate systems.

**Your D1b — (a) replay-safe Host entitlement through existing `messaging.ack` (absorbed):** the final-page completion token is kind-tagged and Host-verifiable, bound to the exact plugin instance, subscription, `viewVersion`, shape digest, final-page status, and `resumeAfterSequence = H`; it is not a caller-chosen kind string and does not relax the ordinary delivered-watermark guard. In one atomic transaction, completion validates all bindings, monotonic-max advances both `lastDeliveredSequence` and `ackedSequence` to `H`, and records terminal success. Forged, cross-context, non-final, or expired tokens mutate neither cursor; replay of the same terminal token returns the same success within the entitlement retention window. **No thirteenth public method.** Regression set: forged token, cross-subscription token, response loss, final-page replay, concurrent read/snapshot.

**Your D1c — (a) semantically complete bounded DTO (absorbed):** snapshot items preserve every canonical `MessageEnvelope` member via the shared bounded DTO family above; bounds live on the DTO, frozen `$defs` untouched, no K-1 parity migration.

**Resolved topology (variable leaves still inherit M1/M2/M5/I1 `RESERVED`; row 8 stays `ready=false`):**

- `SnapshotPageRequest` (closed, `additionalProperties: false`; required = `[subscriptionId, maxItems]`, `pageToken` optional): `subscriptionId` (string, minLength 1, maxLength 128); `pageToken` (string, minLength 1, maxLength 512 — absent = first page; when present it is never empty); `maxItems` (1..64 — a **public schema bound**; change = reviewed shape delta).
- `SnapshotPageResponse` as structurally closed discriminated variants; contained envelope leaves inherit M1/M2/M5/I1 `RESERVED`. Both variants: required = `[items, nextPageToken, snapshotAckToken]` exactly, `additionalProperties: false`, `items` = `BoundedMessageEnvelope[]`:
  - *intermediate* = `{ items — minItems 1, maxItems 64, nextPageToken: string (minLength 1, maxLength 512), snapshotAckToken: null }`;
  - *final* = `{ items — minItems 0, maxItems 64 (an empty snapshot is a single empty final page), nextPageToken: null, snapshotAckToken: string (minLength 1, maxLength 512) }`;
  - no third combination; structural `maxItems` fixed at 64 (a **public schema bound**), request-relative bound as a **conformance oracle**: `items.length ≤ params.input.maxItems`;
  - same-token replay re-serves the equivalent page; token expiry bound to the view anchor's lifetime (Host GC policy over the D1a view entitlement).
- Completion rides your D1b through existing `messaging.ack`; cursor advance targets `resumeAfterSequence = H` per your D1a.
- Oversize-vs-immutable-traversal: an `OVERSIZED_ITEM` fault poisons and expires the traversal's view anchor — the same `pageToken` thereafter returns `SNAPSHOT_UNAVAILABLE { reason: "VIEW_EXPIRED" }`; after Host-side repair the caller starts a **new** snapshot; repair never mutates an existing view.

## Complete and stable — CO-SIGNED at your R2 (as written; text unchanged in this revision)

Your R2 co-signed this eight-item semantic foundation as written: handshake authority direction and closed rejection taxonomy; compact NDJSON framing, 1 MiB hard cap, and single SRI package digest; attempt-only request IDs and per-row settlement keys; no-resume v0 reconnect semantics; the twelve reserved production names and directions; `GrantSnapshot` fields; the `-32090..-32094` closed wire-error mapping; delivery-rejection reasons, Host-owned retry policy, and exact `deliveryId` echo semantics. **The co-sign does not imply variable-leaf closure; rows 6/8/9 are `RESERVED` exactly as the matrix projects.**

### Handshake (contract-generated structures)

| Structure | Fields | Authority |
|---|---|---|
| `CandidateHello` (plugin → Host, *candidate claims only*) | `pluginId`, `packageDigest`, `contractVersion`, `wireVersion` | plugin self-report, validated against the exact installed record |
| `SessionBinding` (Host → plugin, *authoritative*) | the four hello fields + Host-minted `pluginInstanceId`, `brokerSessionId`, `grantRevision`, `effectiveGrants`, one-use connection-bound `bindingNonce` | Host |
| `broker.ready` params | **only** `bindingNonce` (activation-only; not a resume carrier) | plugin |

`CandidateHello` and ready params **reject** any additional identity/instance/grant/session fields — caller-supplied authority fails as `AUTHORITY_VIOLATION`. The runtime never selects authority by echoing plugin-supplied fields.

### Framing

JSON-RPC 2.0 over UTF-8 NDJSON; one non-batch object per LF-delimited frame; stdout protocol-only (logs → stderr); **v0 compact encoding profile (canonical, merged `d606aab`)**: compact UTF-8 JSON, no BOM, no insignificant whitespace, LF terminator; every inbound string token must byte-equal the production compact encoder's serialization of its parsed value (alternate `\u` spellings are rejected); non-control Unicode encoded directly as UTF-8; required JSON escaping counts toward the budget. **Pre-parse R31 closure on top of that merged profile:** the scanner first requires `UnicodeScalarString` for every decoded member name and string value, canonical-decoded member names are pairwise unique at every object depth, and every numeric token is checked against its path's canonical numeric profile before parsed-value/schema validation. Object member order is deliberately unconstrained because it changes neither semantics nor encoded length; whole-frame JS `JSON.stringify` equality is not a cross-language ABI. Batch arrays, compression, blank frames, invalid UTF-8, trailing non-whitespace all rejected in v0. **`maxFrameBytes = 1_048_576`** counted on raw UTF-8 bytes excluding LF; an unterminated frame crossing the ceiling → stop buffering, close connection — the decoder ceiling is the last fail-closed defense, never the normal rejection path for schema-valid values (inbound checked pre-dispatch, outbound pre-write-queue); oversized domain results are never transport-split — method schemas paginate below the ceiling or negotiate a later wireVersion. M1/M2 remain reserved because this target rejection is not historical compatibility evidence.

### Package digest

Exactly **one** canonical `sha512-<base64>` SRI token over the exact staged archive bytes, for every package source: ASCII string length exactly **95**, pattern `^sha512-[A-Za-z0-9+/]{85}[AQgw]==$`, compact-JSON encoded length exactly **97** bytes including quotes. The final data character restriction is the RFC 4648 zero-pad-bit rule for a 64-byte SHA-512 digest; decode → re-encode equality is the equivalent conformance oracle. npm artifacts additionally pass registry integrity; local packages become an exact archive before install. An unpacked-tree normalization is not a second digest truth.

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
- **`WireErrorResponse`** is a closed `oneOf`: application errors are `{ jsonrpc: "2.0", id: RequestId, error: { code, message, data } }`; JSON-RPC standard errors are `{ jsonrpc: "2.0", id: RequestId | null, error: { code, message } }` with no `data`. Both forbid `result` and additional members. **A valid, uniquely extracted, profile-compliant `id` is echoed byte-for-byte on every standard error that has one — including `Invalid Request`; `id: null` is restricted to the arms where id detection failed** (Parse error; the Invalid-Request no-usable-id arm) per JSON-RPC 2.0 §5 — never a Host choice on a valid request (your R5 P1-2). Result/error mutual exclusivity and per-error member sets are structural.
- **`RequestId` — your value, absorbed verbatim:** `type: string`, `minLength 1`, `maxLength 128`, `pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, raw UTF-8 byte length 1..128. The ASCII grammar plus canonical raw-token equality makes the token exactly 3..130 bytes including quotes; `"\u0061"` is rejected rather than normalized to `"a"`. **String-only: numeric and `null` request IDs are protocol violations before dispatch** — `null` exists only in the pre-id `WireErrorResponse` branch. In-flight uniqueness per `brokerSessionId` (collision fails before dispatch); **a retry is a new attempt with a fresh RequestId** (attempt-only, non-authoritative for settlement); success/error responses echo the originating valid ID **byte-for-byte**.
- **`deadlineUnixMs` wire numeric grammar (raw-token level, not parsed-value):** the raw JSON lexeme must match canonical decimal digits `0|[1-9][0-9]*` — no sign, no decimal point, **no exponent**, no leading zeros — with raw token length ≤ 16 characters (the decimal digit count of 2^53 − 1, a derived structural fact, not a policy number), validated **pre-parse/pre-dispatch**; exponent-padding and every other non-canonical numeric encoding is rejected before dispatch. The parsed value must additionally be a positive integer ≤ 2^53 − 1. The **operational Host deadline cap policy stays yours (K-2)**.
- The outer members (`jsonrpc`, `id`, `method`, braces and separators) are **included in every generated `maxEncoded{Request,Result,Error}Bytes` proof** — your RequestId value above is now fixed, and the proofs include its surrounding JSON quotes per your intake — with mutation and N/N+1 conformance cases proving oversize/malformed-envelope/non-canonical-string/non-canonical-numeric/duplicate-member/non-scalar-string/non-string-id rejection **before authorization-visible dispatch**. Duplicate-member mutations cover the outer envelope, a nested closed DTO, and a nested frozen-open payload; numeric-alias mutations cover both object and array positions inside M2; lone high- and low-surrogate mutations cover member names, bounded string values, and object/array positions inside open payloads.

### Production method registry (12 reserved names; your canonical base matrix from `b32170a8` with inline marked overlays — merged settlement-mapping column, gate/lifecycle annotations)

| # | Method | Direction | Grant | Input → Result | Error set | Settlement key source |
|---|---|---|---|---|---|---|
| 1 | `broker.hello` | plugin → Host | protocol-intrinsic | `CandidateHello` → `SessionBinding` | `HANDSHAKE_REJECTED` | — |
| 2 | `broker.ready` | plugin → Host | protocol-intrinsic | `bindingNonce` → `null` | `HANDSHAKE_REJECTED` | — |
| 3 | `messaging.send` | plugin → Host | `messaging.send` | `MessageDraft` → `SendReceipt` **with `messageHandle`** | `MessagingErrorCode` + deadline | `input.idempotencyKey` |
| 4 | `messaging.appendElements` | plugin → Host | `messaging.appendElements` | `AppendElementsRequest` → `AppendReceipt` | `MessagingErrorCode` + deadline | `(Host-resolved messageId from input.handle, input.operationId)` |
| 5 | `messaging.subscribe` | plugin → Host | `message.event.subscribe` | handle → subscriptionId | `MessagingErrorCode` + deadline | Host-resolved `input.handle` identity (K-1 create-or-get authoritative) |
| 6 | `messaging.read` | plugin → Host | `message.event.subscribe` | `SubscriptionReadPageRequest` → `BoundedSubscriptionReadPageResponse` (normal/empty/stale, frozen-mirroring discrimination); semantics/topology resolved, **matrix status RESERVED** | `MessagingErrorCode` + deadline | none (at-least-once; bounded page assembly advances `lastDeliveredSequence` only through the last emitted event; only ack advances `ackedSequence` — via the kind-tagged read-page entitlement) |
| 7 | `messaging.ack` | plugin → Host | `message.event.subscribe` | subscriptionId + ackToken → `null` (= closed `MessagingAckRequest`; Host-resolved token kind) | `MessagingErrorCode` + deadline | `(input.subscriptionId, input.ackToken)` |
| 8 | `messaging.snapshot` | plugin → Host | `message.event.subscribe` | bounded `SnapshotPageRequest` → `SnapshotPageResponse`; semantics/topology resolved, **matrix status RESERVED** | `DOMAIN_ERROR`/`DEADLINE_EXPIRED`/`SNAPSHOT_UNAVAILABLE` per wire mapping (co-signed R2) | none for traversal; completion = your D1b Host entitlement through existing `messaging.ack` (atomic dual-cursor advance to `H`); `ready=false` |
| 9 | `host.messaging.deliver` | Host → plugin | `onMessage` | `HostMessagingDeliverRequest` (deliveryId + frozen `ThreadHandleAddress` + `BoundedMessageEnvelope`) → **`deliveryId` ack**; **matrix status RESERVED** through envelope leaves | `DELIVERY_REJECTED` per wire mapping (co-signed R2) | `input.deliveryId` (Host-side authoritative) |
| 10 | `host.grants.changed` | Host → plugin | protocol-intrinsic | `GrantSnapshot` notification | none | (grantRevision monotonic) |
| 11 | `host.lifecycle.ping` | Host → plugin | protocol-intrinsic | nonce → nonce | protocol errors only | — |
| 12 | `host.lifecycle.drain` | Host → plugin | protocol-intrinsic | deadlineUnixMs → `null` | deadline | — |

No production method exists for fixture setup/observe, grant presets, revocation, permission-matrix inspection, or replay deletion; and **no grant-introspection RPC** — `SessionBinding` and `host.grants.changed` are the authoritative grant snapshots (your ruling). Fixture words never become production RPCs; capability ≠ semantic operation ≠ fixture op ≠ production method; identity is Host-bound (`pluginInstanceId` never accepted from params).

**Reservation-only lifecycle marker (your D0 = A):** every row above is `ready=false`, unpublished, and unadvertised until its exact UTF-8/JSON validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass.

**Contract-minted opaque tokens:** `bindingNonce` and ping `nonce` are strings 1..512; Matrix H9/M4 owns their exact compact-JSON validator (`JSONString(512)` = `UnicodeScalarString` + canonical token + ≤3,074 bytes). The authority direction and semantics are unchanged.

### Concrete wire types

**`GrantSnapshot`** (member set co-signed R2; variable-width closure = H7/H8): `grantRevision` — `WireUInt53(0, 9_007_199_254_740_991)`, strictly monotonic per instance, Host refuses overflow; `effectiveGrants` — unique `Capability[]`, 0..17 items. `SessionBinding` embeds both; row 10 params = `GrantSnapshot`. Stale revisions are discarded.

**`SendReceipt` beta.3 delta**: adds `messageHandle` typed as the **existing frozen `MessageHandle` $def** (`{kind:"message", token}`) — no new shape invented. Conformance oracle: `messageHandle.token !== messageId`. Fixture updates accompany the schema change (additive, disclosed).

### Delivery rejection (row 9) — semantics co-signed R2; topology resolved; matrix status `RESERVED`

- *Error class:* public **`DELIVERY_REJECTED`** wire error with `error.data = { reason }` — sole data field; closed enum `UNSUPPORTED_PAYLOAD | NO_HANDLER | PLUGIN_BUSY | PLUGIN_INTERNAL`.
- *Identity:* resolved **exclusively from the JSON-RPC correlation**; `error.data` carries no `deliveryId`.
- *Retry policy is Host-owned:* contract-fixed mapping — `UNSUPPORTED_PAYLOAD`/`NO_HANDLER` → dead-letter; `PLUGIN_BUSY`/`PLUGIN_INTERNAL` → bounded retry. The runtime reports facts, never selects Broker behavior; any other error shape on a deliver call is a connection-level protocol violation.
- *Success (canonical, equality target disambiguated):* result = `deliveryId` ack exactly as your matrix states, with the strengthening you co-signed at R2: the echoed value **must byte-equal `params.input.deliveryId`** of the originating request — never compared against the JSON-RPC `id`/`requestId`; mismatch is a connection-level protocol violation. The error path remains correlation-only and echoes nothing.
- *Resolved callback topology (variable leaves inherit the matrix):*
  - **request** — `HostMessagingDeliverRequest` has a closed member set (`additionalProperties: false`, all fields required) but inherits M1/M2/M5/I1 `RESERVED` through its envelope; carried in `params.input` under the standard `params.meta` deadline: `{ deliveryId: string (minLength 1, maxLength 128), threadHandle: ThreadHandleAddress, envelope: BoundedMessageEnvelope }`. `ThreadHandleAddress` is the **existing frozen `$def`** — `{ kind: "thread_handle" (const), handle: string 1..256 }`, already bounded; its scalar-value compatibility status follows M1. No new handle type is invented.
  - **acknowledgement** — the result schema is exactly `deliveryId: string (minLength 1, maxLength 128)`, byte-equal to `params.input.deliveryId` (mismatch = connection-level protocol violation; the equality oracle is a conformance case, the bound is the schema).
  - **rejection** — `DELIVERY_REJECTED` `error.data = { reason }`, closed 4-value enum (below).
  - Row 9 is structurally `RESERVED` through M1/M2/M5/I1 and stays `ready=false`; only after those sources close can callback byte proofs/N+1 conformance run.

### Application wire-error mapping (co-signed R2; JSON-RPC 2.0 requires integer `error.code`)

| Named class | `error.code` (proposed reserved range) | `error.message` (**required per JSON-RPC 2.0 §5.1; exact per-class `const` — your R3 P1#1**) | `error.data` (closed; all fields `required`; `additionalProperties: false`) |
|---|---|---|---|
| `HANDSHAKE_REJECTED` | `-32090` | `"handshake rejected"` (const) | `{ reason: HandshakeRejectReason }` — closed 7-value enum below |
| `DELIVERY_REJECTED` | `-32091` | `"delivery rejected"` (const) | `{ reason: "UNSUPPORTED_PAYLOAD" \| "NO_HANDLER" \| "PLUGIN_BUSY" \| "PLUGIN_INTERNAL" }` |
| `DOMAIN_ERROR` | `-32092` | `"domain error"` (const) | `{ code: MessagingErrorCode }` — frozen 6-value enum |
| `DEADLINE_EXPIRED` | `-32093` | `"deadline expired"` (const) | `{}` (empty object, exactly) |
| `SNAPSHOT_UNAVAILABLE` | `-32094` | `"snapshot unavailable"` (const) | `{ reason: "OVERSIZED_ITEM" \| "VIEW_EXPIRED" \| "STORE_UNAVAILABLE" }` — closed enum |

### JSON-RPC standard-error mapping (closes the outer/pre-id branches omitted by revision 4)

| Standard class | `error.code` | `error.message` | `id` | `error.data` |
|---|---|---|---|---|
| Parse error | `-32700` | `"Parse error"` | `null` | absent |
| Invalid Request — valid id arm | `-32600` | `"Invalid Request"` | **valid `RequestId` echo** (uniquely extracted, profile-compliant — a structurally invalid request can still carry an unambiguous id, e.g. missing `method` with `id: "r1"`; your R5 P1-2) | absent |
| Invalid Request — no-usable-id arm | `-32600` | `"Invalid Request"` | `null` (absent, malformed, ambiguous, or unparseable id) | absent |
| Method not found | `-32601` | `"Method not found"` | valid `RequestId` echo | absent |
| Invalid params | `-32602` | `"Invalid params"` | valid `RequestId` echo | absent |
| Internal error | `-32603` | `"Internal error"` | valid `RequestId` echo | absent |

The full public error union is closed: five application variants require `{ code, message, data }`; six standard variants (five classes, `Invalid Request` split into its two closed id arms) require `{ code, message }` and forbid `data`; all have `additionalProperties: false`. Every raw code token byte-equals its canonical signed decimal literal before parse, every message passes `UnicodeScalarString` + `CanonicalStringToken`, and the generator measures all **eleven** complete variants for exact error proofs, with conformance cases for both Invalid-Request id arms. Diagnostics remain private.

Every registry row's application error set resolves through the first table; the standard table is outer-envelope-wide and supplies row 11's named protocol errors without inventing a row-specific shape. No string appears as a top-level JSON-RPC `code`; new classes/reasons require a contract delta.

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

## Five-axis failure-mode sweep (derived from the matrix)

| Axis | Matrix derivation |
|---|---|
| complete request/result/notification/**full error** object | raw frame/object grammar = W0; outer/fixed leaves = W1–W3; each row payload = its H/M/I join in the row projection. Errors have no free string branch beyond W1 because messages/data are W3 finite literals. Rows reaching reserved leaves are called reserved, not closed. |
| every caller-supplied value that can change dispatch/replay output | every caller input enters through its row's W/H/M/I join. The control subset is W2 deadlines, M1 idempotency/operation strings, M2 payload values, M4 entitlements, M5 caller handles that resolve settlement identity, and I2 page controls. M1/M2/M5 reservations propagate through their reaching rows; no bounded carrier claim overrides a reserved row. |
| every entitlement carrier and Host-only kind transition | public carriers = M4. Kind/view/sequence/position are Host-stored provenance rather than caller-selectable JSON leaves; progress mutation remains after causal completeness + final full-frame proof. |
| current plus historical producer values vs DTO | T1/T2 source every M/I entry. Bounded strings/payloads without scalar-value admission and stored-value proof are M1/M2 `RESERVED`; unattested IDs and unsafe counters are M5/M6/I1 `RESERVED`. No byte ceiling, JS string/number type, or target-side rejection is treated as a source admission invariant. |
| public schema bounds vs internal generated budgets | H/M/I maxima are **proposed public values pending this shape co-sign**; once co-signed, editing one reopens shape review and recomputes every dependent artifact. `maxEncoded*`, assembler budgets, and encoder measurements are generated internal outputs. |

## Shape gate checklist (current state)

- [x] authority direction for every handshake field — verdict absorbed; **co-signed R2**
- [x] production method registry — 12 reserved names / directions / base matrix **co-signed R2**
- [x] session-injected identity boundary — Host-bound, fail-closed; **co-signed R2**
- [x] idempotency/settlement identity single truth source — per-row `settlementKeySource`; **co-signed R2**
- [x] receipt-to-handle relationship — explicit `messageHandle`; **co-signed R2**
- [x] framing and rejection semantics — v0 compact profile + `wireBounds` invariant; wire-error mapping and delivery-rejection semantics **co-signed R2**
- [x] **DECISION 0 / 1a / 1b / 1c / 2** — resolved by your R2 (**A / c / a / a / b**), absorbed above
- [x] **CO-SIGN** — complete-and-stable eight-item foundation co-signed at R2 as written
- [x] **rows 6/8/9 semantic direction/topology — accepted at your R3/R2 decisions**; variable-leaf closure is not inferred
- [x] **`RequestId` exact owner value** — W1 `CLOSED`
- [x] **complete canonical numeric coverage** — bounded integers use `WireUInt53`, fixed codes use `WireIntConst`, and arbitrary M2 numbers use recursive `CanonicalNumberToken`
- [x] **complete target string-token coverage** — `UnicodeScalarString` precedes canonical equality; lone high/low surrogates reject in member names and values
- [x] **all 12 shapes joined through one exhaustive raw-frame/lexeme/variable-width leaf matrix** — W0 rejects non-scalar strings and duplicate members before parse; no prose-only or parsed-value-only closure path
- [ ] **maintainer accepts the explicit reservation boundary** — H1/H3/H4/H5/H6, M1/M2/M5/M6/**M7**, I1 (M7 joins per your R5 P1-1); affected rows stay reserved under D0
- [ ] **fresh review on revision-5 exact live bytes** (raw API-string SHA-256/counts reported in delivery comment)
- [ ] per-row `ready=true` — only after exact validators, generated byte proofs, N/N+1 raw-byte conformance, and three-stage runtime enforcement pass (reservation-only lifecycle, your D0 = A)
- [ ] K-2 maintainer records `shape-approved`

No production implementation, no `beta.3` publication, no consumer re-pin, and no K-2 runtime work begins before your explicit approval, in the order you set.
