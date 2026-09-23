---
title: Train C1 Plugins aggregate migration plan
feature_ids: [P-1, F202]
topics: [plugin-migration, im-connectors, business-plugins, catalog, release]
doc_kind: plan
created: 2026-09-19
---

# Train C1 Plugins aggregate migration plan

## Outcome

One Plugins PR turns every remaining in-scope Core IM connector and repository-local business plugin into
package-owned, cataloged artifacts. Core then consumes those exact reviewed artifacts, maps existing
configuration/bindings/data, proves no double-run, switches the default path, and deletes the old business
implementations in its separate deletion-dominant C1 PR.

The machine-readable frozen inventory is
[`migration/f202-train-c1-inventory.json`](../../migration/f202-train-c1-inventory.json). It is pinned to
Plugins `123112c`, Core `9ab0eaf287381efcb209781463f38cc5f23870ea`, and accepted Core issue #1478.

## C1 Terminal Acceptance Contract

This section is the durable finish line for the two-PR C1 cutover. It supersedes earlier wording in this
document that generalized the M0 standalone/stdio carrier into the product topology or treated the eleven
migration rows as the whole repository compatibility surface.

1. **The package is the distribution unit; the carrier is an implementation detail.** Each installable
   package declares its runtime strategy in its canonical manifest. `builtin`, `stdio`, and any future
   supported carrier all enter the same Host-owned lifecycle/action boundary; one package does not imply one
   dedicated process, and provider business behavior never moves into Core merely because the Host chooses a
   carrier.
2. **The Host consumes one carrier-neutral lifecycle/action boundary.** The package module exposes declared
   feature activation, contribution action handlers, and idempotent disposal. The Host supplies grants,
   config, secrets, bindings, ingress, logging, state, scheduling, and lifecycle authority through public
   SDK adapters. Failed activation publishes no partial contribution; action failure is attributed and
   contained; disable/uninstall always disposes the active feature exactly once. A `builtin` runtime with a
   root `entrypoint` has exactly one discovery convention: the imported ESM module's `default` export must
   satisfy `PluginModuleEntrypoint` and pass `requirePluginModuleEntrypoint`; named-export probing is forbidden.
3. **PR #54 closes repository-wide compatibility.** Its terminal inventory classifies every package directory,
   not only the eleven migration rows. Every Manager-installable artifact must have one canonical
   `plugin.yaml`, the stable `contractVersion: 0.1.0` line, an explicit SDK compatibility disposition, an
   honest runtime declaration whose packed entrypoint exists when declared, catalog truth, deterministic
   pack evidence, and a fresh-consumer installation/import journey. Legacy `manifest.json` forms are either
   mechanically identical/generated from the canonical YAML or explicitly non-Manager baselines; they are
   never an independent source of truth.
4. **Core PR #1487 converges and deletes atomically.** Core maps the exact reviewed package actions into the
   generic Host lifecycle, proves no-double-run, switches the default, and deletes each legacy execution path
   in the same cutover. Core must not retain or introduce a package-id/provider-specific runtime branch.
5. **The dependency order is evidence-bearing.** Plugins produces exact Linux-packed artifacts first. Core
   consumes those exact coordinates in the install/configure/enable/use/disable/uninstall/restart journeys.
   #54 merges and publishes before #1487 can receive final acceptance; #1487 then pins registry-resolvable
   version, shasum, and integrity rather than a mutable branch or dist-tag.
6. **Recovery is part of compatibility.** Disable and uninstall revoke actions and restore the preserved Host
   baseline; a failed start exposes zero partial actions; restart restores only Host-owned durable state and
   resumes without double-run. Package-local ambient authority, package-local durable checkpoints, and
   synthetic Host identities are forbidden substitutes.
7. **C1 has no cleanup follow-up PR.** The aggregate Plugins and Core PRs close C1 together. The next phase is
   C2's front-end contribution work (including the deferred audio/managed-service surfaces and the retained
   StackChan physical-hardware limb product), not a third C1 PR for SDK/YAML/runtime/catalog debt left behind
   here. `physical-limb` does not include the agent-side `limb`/`skill` contribution consumption used by
   `wechat-visible-reader` and `weixin-mp`; those consumers remain part of C1 compatibility closure.

This contract was cross-read against Core PR #1487 exact HEAD
`f20cc2dcd0c6612b89bf57d10f39a7fee802d0df`, section **8. C1 Terminal Acceptance Contract**. The two durable
contracts are aligned with no substantive disagreement.

The repository-wide package ledger in the inventory is executable acceptance data. A package may remain a
retained external baseline, library, fixture, or C2-deferred product, but that classification must be explicit;
absence from the catalog is not itself a classification.

## Frozen boundary

### Migrated in C1

- IM connectors: DingTalk, Feishu, Telegram, WeCom Agent, WeCom Bot, Weixin, and XiaoYi.
- Repository-local business plugins: GitHub operations, video generation, WeChat visible reader, and Weixin
  Official Account.
- Existing external artifacts are census baselines rather than duplicate implementations:
  `@clowder-ai/video-analysis`, `@clowder-ai/personal-chrome-companion`, and
  `@clowder-ai/feishu-meeting-intake`.

### Not migrated in C1

- ASR, TTS, audio capture, embedding, and LLM post-processing managed services belong to Train C2.
- C1 does not add public UI slots, generic public hooks, or another Host authority layer.
- Artifact verification, grants, secret/config authority, inventory, connector/thread bindings, delivery
  retry/dead-letter policy, and lifecycle supervision remain Host-owned.

This supersedes the pre-#1478 sentence in the Train B plan that placed managed services in undifferentiated
Train C. The accepted split is C1 connectors/business plugins and C2 public extension seams/managed services.

## Code-derived consumer census

The inventory records the source roots, config/secrets, binding and data truth, current consumers, dedicated
journeys, target package/catalog identity, runtime needs, and rollback for each item. The census is derived
from Core source at the pinned commit rather than from UI labels or an old planning list.

The shared execution shape is:

```text
package-owned provider/business implementation
  ↕ public plugin contract + SDK
Host-owned install/grants/config/secrets/lifecycle/bindings/delivery
  ↕
existing Core Agent, Console, messaging, schedule and webhook consumers
```

The wire contract remains the frozen 13-row protocol. C1 completes the already-authorized, carrier-neutral
module/lifecycle/action SDK boundary needed to execute the declared contributions; it does not add a
provider-specific wire, package-local Host authority, or a D/E checkpoint escape hatch. Host-issued
`ConnectorBindingAddress`, `messaging.send`, `host.messaging.deliver`, and Host-owned `FeatureContext`
adapters remain the authority coordinates.

Work proceeds in two implementation lanes. Plugins completes provider adapters, runtime entrypoints,
schedule operations, preservation journeys, and exact artifacts. Core maps its existing Host-owned
configuration, secrets, bindings, state, schedules, webhooks, and delivery authority into those frozen
surfaces, proves no double-run, switches defaults, and deletes provider-specific implementations. A missing
composition path is implementation work in the owning lane, not authority to invent a package-local fallback
or a new public contract.

Connector ingress always sends to a Host-authenticated `connector_binding` handle. Packages neither mint nor
resolve that handle and never infer wake authority from message text. In particular, `@` inside a plain
`thread_handle` message remains opaque, non-waking content; only Core may derive admission/wake behavior from
an authenticated connector binding. Contract/SDK fixtures lock both the connector-binding positive path and
the ordinary-text negative path.

## Test-first implementation sequence

1. Freeze this inventory and make `scripts/train-c1-inventory.test.mjs` RED because the eleven target
   packages and catalog entries do not exist.
2. Reuse the existing SDK tests for ready handshake, outbound `messaging.send`, inbound
   `host.messaging.deliver`, grants change, ping, drain, and deterministic rejection after drain. Synthetic
   binding handles remain protocol-unit fixtures rather than production binding evidence.
3. Complete every package runtime against the carrier-neutral manifest/SDK module surface. Core performs the
   generic Host-side mapping and cutover in parallel; neither lane invents a provider-specific Host branch.
4. Migrate provider-neutral connector fixtures first, then each provider adapter. Every package gets
   `plugin.yaml`, README, icon, locked production dependencies, provider protocol tests, restart/drain tests,
   and an isolated fake-provider journey.
5. Migrate the four business plugins with their actual runtime surfaces: MCP for video generation, limb/skill
   for Weixin MP, limb plus the macOS native helper for visible reader, and schedule/event contributions for
   GitHub operations. Package code imports no Core private path.
6. Add all eleven packages to the deterministic catalog. Extend exact-pack validation and fresh-consumer
   installation to every artifact; catalog metadata must equal packed manifest truth.
7. Run the aggregate quality gate and obtain independent cross-individual review on the exact HEAD. Leave
   the PR unmerged and unpublished until maintainer authority acts.

## Implementation checkpoint

> **Current as of 2026-09-23. If you are picking this up without having followed the thread, read this
> section first.** The previous checkpoint text (2026-09-20) is recoverable from git history; parts of it are
> now stale and one sentence is actively misleading (see "Weixin QR login" under Known drift).

### Where things stand

PR #54 is a **draft** served from the fork (`mindfn/clowder-ai-plugins`, branch
`feat/f202-train-c1-plugins-migration`). **Do not merge or publish it** until the cutover gate below clears.
The contract is at `0.1.0-beta.19` and the SDK at `0.2.0-beta.2`; neither is published to npm, and neither
needs to be for the dev wave, because the Host now installs owner-supplied self-contained artifacts (Host S10).

| Wave | Scope | State |
|---|---|---|
| a / b step | contract + SDK; the seven connectors moved to the A2 shape (`message-subscription`, `context.messaging.*`, `{ params, invocation }` envelope) | done, cross-individually reviewed |
| W1 | video-generation, video-analysis, weixin-mp, enterprise-workflow (new package), wechat-visible-reader | **5/5 done on both sides**; Host copies deleted |
| W2 | the seven connectors + ChatGPT Pro | **in progress** — see below |
| W3 / W4 | GitHub cluster / collective + GenOffice docx | not started |

### W2 (in progress)

- **W2-1**: feishu + wecom-agent webhook actions aligned to the Host S6b forwarding contract (input arrives as
  `{ ...declaredParams, request }`, strict `{ status, headers, body }` response). Same slice makes the
  idempotency key a stable provider identifier on every accepted inbound path: feishu `header.event_id` on
  both webhook and WebSocket card callbacks; wecom-agent `MsgId`, with ordinary messages missing it rejected
  and logged instead of keyed by the clock. Followed by a Host-side wecom-agent local end-to-end run, which is
  the intended evidence for the cutover gate.
- **W2-2**: user-visible parity for weixin / feishu / wecom-bot (see Known drift).
- **W2-3**: ChatGPT Pro as an installable wrapper around the existing `personal-chrome-companion` closure,
  not a second copy of its code.
- **W2-4**: Host-side removal of the connector-specific framework and IM pages, plus a new generic
  thread-to-external-conversation binding list (it does not exist in the frontend today).

### Cutover gate on this PR

PR #54 must not merge or publish until **both** hold:

1. the Host cutover branch is actually running in the Host, and
2. **one of the seven connector packages** carries an external-origin `messaging.send` end to end on the real
   Host and it is accepted.

Condition 2 is deliberately narrow. Every W1 package installing and running cleanly does **not** satisfy it:
none of them is a connector, and none exercises the Host's external identity resolution. CI being green does
not satisfy it either — this PR was fully green at a point where inbound was broken end to end.

### Known drift (not yet fixed)

- **Weixin QR login**: the adapter code still contains QR credential acquisition, but the manifest declares
  no `weixin_qr_login` operation and exposes `botToken` as a hand-entered secret. An owner cannot reach QR
  login today. Feishu (`feishu_qr_login`) and wecom-bot (`wecom_validate`) have the same class of gap. W2-2.
- Weixin also exposes the Host-projected `apiBaseUrl` and env-only voice toggles as owner-editable fields.

### Dev-wave artifacts

Built outside the repo under `/Users/lang/workspace/github-lab/f202-w1-tarballs/`. Two kinds, kept apart on
purpose, because the Host's local admission does not compare catalog integrity and installing the wrong one
fails silently:

| | location | bytes | publishable |
|---|---|---|---|
| canonical npm tarball | top level | equal to the catalog pin (pinned toolchain) | yes |
| self-contained dev artifact | `self-contained/` | never equal to any pin; platform-bound | never |

Self-contained artifacts come only from `scripts/pack-self-contained-artifact.mjs`, which runs
`scripts/verify-self-contained-artifact.mjs` before publishing: `package/` layout per the Host staging rule,
zero symlinks, production closure equal to the shrinkwrap, and the Host `runtime.entrypoint` really loaded from
a relocated copy. Filenames carry a content digest and existing files are never overwritten. **Hand artifacts
over by full sha256, never by path.** Superseded ones live in `f202-w1-tarballs.superseded/`, outside the
delivery tree.

### Guards that must stay green

- install consent surface: a package README must disclose every capability any of its features declares
- offline shrinkwrap closure gate: the packed lock must contain the full transitive production closure
- packed-member guard (`scripts/catalog-check.mjs`, `scripts/catalog-runtime-entrypoints.test.mjs`): every
  declared runtime entrypoint must be an archive member, evaluated against archive members rather than source
  paths
- fresh-consumer default-export guard: the entrypoint must expose the Host-loadable module shape

### Merge-time step — companion version is provisional

PR #54 touches `packages/companion` only because its own install-consent gate requires the README change;
it is the only non-F202 package in this PR. The version it claims (`0.1.0-alpha.5`) is provisional:
companion is upstream-owned and actively developed. At merge time, check the registry; if upstream has
already published that version, re-bump to the next free version and re-pack before merging. CI cannot catch
this — `catalog:check` compares against the catalog pin, not the registry.

### Where the truth lives

- Host ledger (slice-by-slice status, wave table): `clowder-ai`, fork branch `feat/f202-c1-core-cutover`,
  `docs/plans/2026-09-21-f202-c1-contract.md`; Host PR zts212653/clowder-ai#1487
- Per-slice review records: the Cat Cafe thread "F202 Train C1 — Plugins aggregate migration"
- zts212653/clowder-ai-plugins#57 (git guards) is independent and can be merged first; its `package.json`
  overlap with this PR is two purely additive hunks, which will be carried over here
- `origin` (`zts212653`) still has three stale branches pushed by mistake — `feat/f202-train-c1-plugins-migration`
  at `839eaf8`, `feat/f202-c1-contract-sdk-a-step`, `feat/f202-c1-p1p2-wire-dispatch-into-contract`. This PR's
  real head is on the fork; those can be deleted.

## Preservation matrix and acceptance

Every migrated entry must prove:

- configuration values and secrets keep the same user meaning, sensitivity, required/conditional rules, and
  setup operation;
- binding identity and durable cursors remain Host-owned and survive package restart/rollback;
- inbound and outbound journeys cannot run in both package and Core implementations simultaneously;
- provider retry, formatting, upload/media, deduplication, credential scrubbing, and platform-specific
  behavior remain covered by the listed dedicated journeys;
- disable/drain/restart/resume/rollback settle honestly without losing acknowledged messages;
- package install works in a blank consumer using only public exports and isolated fixtures.

Terminal evidence for the aggregate PR is `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm conformance`, `pnpm catalog:check`, `pnpm test:fresh-consumer`, plus exact version/SHA-1/SHA-512 and
archive-member evidence for all new packages under Node 24.18.0, npm 11.16.0, zlib 1.3.1-e00f703.

## Release and rollback

The Plugins PR is additive. Its merge does not activate, cut over, or delete a Core implementation. Release
publishes one reviewed generation of contract/SDK (only if changed), all eleven packages, and the catalog.
Core pins the exact coordinates and performs per-item migration under a global no-double-run gate.

Rollback is therefore two-stage and recoverable: Core first drains/disables package runtimes and restores
the preserved Core routes against unchanged Host-owned config/bindings/checkpoints; only then may a bad
catalog generation be superseded. Published npm bytes are never rewritten or manually unpublished.
