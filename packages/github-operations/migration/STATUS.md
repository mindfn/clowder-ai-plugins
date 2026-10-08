---
feature_ids: [F202]
topics: [github-operations, c1-migration]
doc_kind: implementation-status
created: 2026-10-08
---

# W3 migration — in progress, not an installable candidate

Authority: task 0001791444624720-000204-90f02d10, source thread
thread_mrkn6povq4zzgh45. Scope corrections 243 and 256 take precedence over
the initial mechanical copy of Host orchestration. Source is frozen at Host
496e24089ffb5f99fa241e04c7ee0850df227be4; package baseline is
80e26fc4bc2c337449c80e3f32184db1a96f07cf. Commit 6636763 records the untouched
93-file source copy so later business and boundary differences remain reviewable.

The enabled builtin owns its lifetime, registrations, cursors and terminal
unregistration. It uses existing SDK storage, thread bindings and messaging with
optional wake. No tracking or configured repository means no GitHub requests.
Stop aborts provider work and waits for cleanup. No new SDK action context, wait
framework, caller protocol, task automation state or Host private imports are
part of the intended runtime.

## Current evidence

- Real manifest and SDK carrier tests cover tracking registration, filtering,
  durable pending delivery, restart, terminal notification and stop cleanup.
- Seven schedule methods are wired. Repository registration, initial baseline,
  scan dedup, comment collection and reconciliation run within the same builtin.
- Community event log, projections, repository configuration and findings use
  private SDK storage. Events are persistent; a bounded append reservation
  recovers interrupted materialization. No Host Redis migration is executed.
- Twelve frozen source test files (181 tests) are copied with import-edge changes
  only; provenance is in test-source-map.json. Whole-package clean build and
  259/259 tests pass at this checkpoint, including provider projection, CI
  rerun/delivery, review pacing, bounded polling, cleanup and batched CI. The
  changed behaviors have individual RED/GREEN evidence; this is not full parity.
- Whole-package source and test typechecks pass. Source hashes/declaration
  provenance are in source-map.json and shared-model-map.json. Superseded Host
  orchestration copies were removed with per-file replacement dispositions,
  never hidden with typecheck exclusions. Compilation is not parity acceptance.
- Boundary ruling 286 retains typed external-review verdict submission in Host.
  Package observations now reach the private HEAD/CI projection through the real
  SDK builtin, while ordinary notifications use SDK messaging. There is no
  package verdict, lease, admission or callback-principal action.
- The shared repository/CI gate now runs GitHub source/test typechecks, clean
  build, tests and lint explicitly. The frozen machine inventory remains in its
  pending checkpoint; implementationProgress records actual implementation
  evidence separately, preserving the existing single catalog exception.
- The previous clean checkpoint `b3906de` passed all 29 repository gate steps
  in 257.461 seconds with unchanged HEAD and clean worktree. New source changes
  have separate targeted/typecheck/build/package evidence; that old gate is not
  claimed for this new tree.
- Ruling338 removes the copied assignment-writing TriageOrchestrator. Pure triage
  recommendations are available through a declared generic tool and do not
  authenticate observations or mutate governance. Private issue metadata refuses
  governance fields. Repository polling uses bounded reads, awaited cleanup and
  persistent fairness; reconciliation baselines successful subjects independently.
- Cloud classification now uses complete provider facts and explicit request
  correlation, without Host wait state. Timeout messages use the existing outbox.
  Three real carrier projection-failure cases and reconciler recovery are covered;
  failed projection cannot be silently retired by delivery/scan dedup.
- Ruling404: new installation-private drafts are reachable through generic tools;
  publication is an owner-local declared operation with explicit confirmation.
  Sanitization, repository allowlist and a durable publication-attempt journal
  precede the single gh POST. Restart only reconciles the original exact marker,
  authenticated GitHub author and content; uncertain results never repeat POST.
  Storage-failure recovery, concurrent carriers, cancellation, corrupt outcome
  identity and awaited stop are tested with isolated providers, not real GitHub.
  The legacy userId/confirmed draft pipeline is removed from the package copy
  and retained in Host. Its old GET/cancel/publish/from-frustration paths are not
  covered by native draft verification or authorized for deletion.
- Repository observations expose bounded pages of provider-only journal facts,
  including webhook-only subjects. They do not replace Host governance boards.

## Remaining implementation and verification

Current additional evidence: the owner-confirmed legacy issue metadata operation
validates bounded raw snapshots before insert-only CAS. Concurrent imports,
partial failure, restart and preservation of owner edits are verified. Governance
fields are excluded; the Host export adapter remains pending.

Ruling463 separates bounded provider briefings through ordinary SDK messaging
from Host role bindings and authenticated callbacks. Those copied consumers and
automatic rebase/push are absent from the package; Host consumers remain intact.
Static comparison verifies 13 byte-identical runtime files and nine with only
type-import path changes. This is not full parity for all 96 source entries.

Integration order478 reserves SDK beta.13 and seven connector alpha.3 candidates
to Sol/task296. W3 consumes that exact candidate before GitHub alpha.1 package,
shrinkwrap and fresh-consumer closure; no second SDK identity is generated here.

1. Complete the Community business comparison and legacy-state disposition;
   native draft/read-model carrier tests do not prove full old-route replacement.
2. Complete per-file business comparison. Remove superseded copied Host
   orchestration only after accounting for its business behavior. Old wait/
   custody producers are retirement candidates, not a new plugin prerequisite.
3. Complete notification/event convergence, fairness/failure/cancellation tests,
   validated inputs and corrupted-state tests across the full runtime.
4. Final whole-package typecheck/build/test, fresh-consumer, deterministic canonical
   packaging, catalog/version/pins, full repository gate and independent review.
5. Host consumes the complete candidate and proves no double-run before deleting
   old GitHub producers/consumers. Preserve deployment/hold-ball common guards.

## Installation acceptance matrix

| Source | Package evidence | Host install → enable → run evidence |
| --- | --- | --- |
| npm | Pending complete candidate; no npm publish authorized | Pending Host consumption |
| Local directory | Pending clean built directory | Pending Host consumption |
| Fixed Git repository/revision | Pending approved exact HEAD | Pending Host consumption |
| Canonical/self-contained archive | Pending W3 closure | Does not substitute for any row above |

Full C1 acceptance also requires generic bidirectional Host interfaces, business
inside the SDK-consuming package, generic MCP/skill registration, and complete
package YAML/configuration/capability declarations. Passing a partial runtime or
an official release archive proves none of the missing installation sources.

No Host worktree writes, old-state deletion, release, npm publication, PR merge,
operator HOME mutation or production instance restart occurred in this work.
