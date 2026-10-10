---
title: Collective business move and module lifecycle checkpoint
feature_ids: [F202, F290]
topics: [collective, migration, lifecycle, local-directory-install, authority]
doc_kind: implementation-plan
created: 2026-10-10
tips_exempt: Private migration checkpoint with no released Settings capability; owner onboarding and delivery remain in original aggregate1843.
---

# Original aggregate1843 implementation checkpoint

The original aggregate continues under Sol/cat-eqdvbcxw. This is an internal implementation/review
checkpoint, with no W4/Collective/C1 completion, publication, catalog admission, or operator acceptance.
The package remains private. Subsequent work extends this module and its moved business implementation.

## Accepted sources and writer boundary

Original Task: `0001789822127811-001843-1c2133b0`. The requirement is whole-business migration,
then adaptation at named generic Host/SDK edges. Custom Client UI/C2 and Host Task/custody/principal
authority remain in their original lanes. Host removal already happened under operator Host043;
the original September19 delete-after wording does not authorize restoring old Host business.

Source correction264 pins the pre-deletion feature commit `ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`.
Codex's typed332 approved only the R3 reverse-consumer census P1, with 1664 scoped dispositions,
125 retained Client/C2 rows, 14 shared declaration candidates, and 21 pending browser rows.
It did not approve implementation or public SDK types.

Existing-owner writer continuation344 is
`thread_mrkn6povq4zzgh45#0001791628175747-000344-6c7e88b4` (accepted revision is that immutable message).
It releases the frozen W3 package sequence to original aggregate owner, explicitly asks for the first
module start/stop/disable/failed-start cleanup sample and local-directory installation, and keeps all
remaining acceptance in1843. It does not revive215 or transfer W3/browser work.

Writer checkout: `/Users/lang/workspace/github-lab/clowder-ai-plugins-collective-sol`,
branch `feat/f202-collective-module-sol`, base `5dd199e5d3637e7650f4f9b98333c48ac72f0ab7`.
W3 and Host checkouts are read-only dependencies, frozen at5dd199e and
`93fee4342cf7296e5ec8def9d9cc8ae2754be49f` respectively. All development/build/validation uses this
feature checkout; fresh consumer/inventory/data directories are disposable test outputs, not other code
checkouts. Reserved runtime ports and production Redis are untouched.

## Move first, then adapt

Pure move commit `4952f27c9306d34cae35cd44b672803f11ed4f48` preserves 127 source blobs:
113 connector/service source and tests, plus14 domain declarations. The
[move record](../../migration/collective-source-move.json) pins source paths, modes, Git blobs, and SHA256.
It deliberately copies no125 Client/C2 files or generic reverse-consumer Host context.

The adaptation uses package-local domain imports. It removes generic Host entrusted-work schema imports
from the moved declaration and retains only the standing-work domain schema actually consumed here.
No Host schema is reimplemented, no shared/SDK public type is added, and no SDK/contract version is changed.
The source continuity guard separates62 unchanged blobs,52 mechanical import moves, and13 explicitly named
semantic/test edges. The13 edges require independent judgment; the guard does not approve their semantics.

Named production edges are Client-free backend HTTP, package-local GitHub setup result type, C2 protocol
label injection, actual-listener OAuth callback configuration, private startup credential escrow, and
retirement of the ambient HOME/env CLI. Seven regression-fixture adaptations preserve business assertions
and replace retained Client-only expectations with explicit C2-unavailable behavior.

## Lifecycle and recovery contract

`plugin.yaml` declares a builtin module, canonical default `create()` entrypoint, one backend feature,
`plugin.config.read` and `data.directory`, and a generic status action. Settings config supplies service
port/origins/public URL. The module receives its directory only from SDK authority. It binds loopback;
invalid configuration and reserved3001/3002 reject before service-state creation.

Activation owns the listener until returning a disposer. A later bootstrap-link failure closes that
listener before rejecting and publishes no actions. Stop/disable revoke actions and close the listener;
SDK stop is idempotent. Re-enable opens the same service identity/state. No Host principal or Task identity
is fabricated; service/human/Collective identities are the original business domain's persisted identities.

The initial bootstrap factory escrows its one unclaimed credential in a0600 private file and fsyncs it
before state creation. Existing store defaults and authentication transitions are unchanged. A failed
start can retry with the same service identity and credential; it does not rotate or reopen a consumed
owner bootstrap. The link is atomically replaced for the actual listener/public URL, and the private
credential is removed on stop or startup after consumption. Status never returns the credential.
Expiration follows the original domain policy; this checkpoint does not introduce an owner reset API.

Architecture cell: **Collective package-owned service/connector business + existing generic Host module
carrier**. Map delta: **package ownership moves out of removed Host; no new Host/SDK authority cell**.
Why: existing carrier lifecycle can own the in-process service; provider-neutral services supervision is
not necessary for this backend. The new composition extends the moved service rather than another manager.

## Evidence and risk coverage

- `typecheck`: production and all moved regression fixtures.
- `test`:3 real lifecycle/failure/recovery tests and124 business tests in29 suites, zero skip.
- `test:source`: all127 move hashes and mechanical-import/named-edge classification.
- `test:installed`: exact local SDK/contract tarballs plus actual directory installation into an empty npm
  consumer; physical package/dependency imports, manifest/default entrypoint, every built JS module,
  backend bootstrap/create/disable/re-enable, retained C2 response, private modes and listener release.
- With explicit `F202_COLLECTIVE_HOST_ROOT`: actual production local-directory admission, actual file
  inventory reload, local/untrusted source provenance and shipped dependencies, production builtin module
  carrier's failed-start/retry/bootstrap/disable/re-enable using fresh temporary Host state. This is a
  component integration, not the running Host or Settings/browser acceptance.

Behavior risk is runtime composition; data risk is fresh private business state and startup recovery;
security risk is bootstrap escrow and existing HTTP authentication; contract risk is default entrypoint,
canonical manifest and exact dependency closure; irreversible risk is none in this local private checkpoint.
Targeted tests cover these claims. No shared SDK/contract/core code changes occur. A whole-repository release
gate is not substituted by this package gate. Plugins-specific fallback/architecture/tips checker scripts
do not exist in this checkout; the ownership and exemption above are explicit review inputs.

## Original aggregate stays open

Host route/tool adapters, SDK messaging/storage projection, retained Client UI launch/HTTP forwarding,
source provenance displayed in Settings, no-double-execution across the full installed journey, and all
21 browser/journey dispositions are still work in1843. The first module and actual local-directory
composition are ready for independent review; they do not silently close those requirements.
Any concrete missing neutral Host edge returns with caller/source evidence to the original Host writer;
this checkpoint grants no edits to the frozen Host tree.

The original missing-package2-fail RED is preserved as historical prerequisite evidence. Actual behavior
REDs separately demonstrate leaked post-listen ports and lost retry bootstrap; new GREENs prove their fixes.
Latest logs, hashes, paired Host coordinates and gate report are in the original handoff evidence directory.
Operator experience, fork soak, Linux release packing, publication and merging remain distinct later gates.
