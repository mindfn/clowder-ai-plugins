# RSI backend

`official.rsi` exposes the `rsi.view` and `rsi.act` actions through the manifest's
`rsi/view` GET and `rsi/act` POST webhooks. Both accept
`input.request = { method, query, body }` and return an HTTP response with a JSON
body, `application/json; charset=utf-8`, and `cache-control: no-store`.

Requests require an owner HTTP context for the current plugin instance. GET uses
the `read` operation; POST uses `write`. State is retained through
`host.storage.get/compareAndSet` at `rsi:<base64url(userId)>`, seeded on first
access. A failed write CAS returns 409 without publishing its state or outbox.
Owners have independent fixtures, objectives, revisions, and pending work.

## Reads

The `view` query selects `home`, `objective`, `exp`, `record`, `policy`, `todo`,
`newExp`, `caps`, `cards`, `library`, or `doc`. Responses are the VM result itself,
without a data envelope. Project IDs are `cartpole` (cartpole-rl), `pd-infer`
(pd-ttft), `self`, `notes-agent`, `echo-router`, and `data-pipeline`.

| Query | Prototype state / default |
| --- | --- |
| `project` | `S.rsiProject`; `cartpole` |
| `pick` | `S.rsiPick`; `obj:cp-converge`, then the project's first leaf |
| `tab` | `S.rsiTab`; `version` |
| `selO`, `selE` | `S.rsiSelO`, `S.rsiSelE`; empty selection |
| `list` | `S.rsiPanelList`; false |
| `selC` | Additional state: `S.rsiSelC`; empty selection |
| `wide` | Optional `S.panelWide` input; false |
| `thread` | Optional current thread; `home` resolves its project/objective |
| `id` | `doc` dialog's document ID (`doc` is also accepted) |
| `objective` | `cards` dialog filter, or `record` objective ID |
| `type`, `cycle`, `id` | `record` dialog inputs; `type` is `run` or `trace` |

`list` and `wide` accept boolean true or the query string `"true"`. Without a
dialog selection, `record` and `doc` return null. Objective views on an empty
project return null; `home.pick.k` is `none`. A request for the passive
`objective` VM on a running experimental objective uses `exp`, since the
prototype only mounts the experimental VM there.

`tc('rsi.<key>', ...args)` becomes `{ t: 'rsi.<key>', args: [...] }`. The composed
`exp.next.by` value is an array of `rsi.exp.doingOf` descriptors so none are
stringified into `[object Object]`. Host rendering limitations are in GAPS.md.

`newExp.cats` is empty: the console must supply host member options. The
`prepare` and `evaluate` IDs submitted by the console are stored as `catId` and
used as the fallback `name`; the backend never looks up host display names.

## Writes

Send the same page-state query on POST so actions can resolve the selection.
An explicit `body.objective` selects an objective directly. `body.op` dispatches
the action. `life` and `prep` use `body.action` for the prototype's subordinate
`op` argument, avoiding the duplicate JSON key in the original contract.

| `op` | Body arguments |
| --- | --- |
| `new` / `newExp` | `statement`, `prepare`, `evaluate`, `target`, `stall`, `rounds`; passive projects use `name` |
| `life` | `action`: `start`, `pause`, `resume`, `retry`, `more`; optional `objective` |
| `prep` | `id`, `action`: `confirm`, `decide`, `edit`, `agent`; `decision`, `value`, `note` as applicable |
| `initRedo` / `initRetry` | Selected objective; retry also takes step key `k` |
| `expDecide` | `n`, `pick`, optional `directionId`, `note` |
| `decide` / `reeval` | `card`, `decision` (`apply` / `skip`); reevaluation takes `reason` |
| `lock` / `addMetric` | `metric`, `locked`; or `name`, `how` |
| `policy` | `key`, `v` (`value` also accepted); empty value restores inheritance |
| `docAdd` / `docConfirm` / `docRemove` | `title`, `url`, `body`; or document `id` |
| `renameGroup` | Capability `id`, `name` |
| `go` / `goVersion` | `objective`; or the prototype's `version\|row>step` `pick` |

Actions that open a dialog return `{ ok: true, act: 'dialog', args: ... }` before
the form is submitted. A `prep/edit` opening request has no `note`; saving the
form supplies a string `note`, including an empty string for a direct edit.
`go` and `goVersion` return one `plugSet` follow-up; other UI selections remain
console state. Successful writes otherwise return `{ ok: true }`. Creation
returns a `thread` follow-up only when an actual thread ID exists.

## Initialization and phase-2 submission hooks

`src/init.ts` exports the functions the future MCP and execution subscription
will call. They change the supplied owner state; callers must authenticate,
load/clone the retained state, call the function, and CAS that same state.

- `rsiExpKick(experiment, now)` is pure. It returns an experiment and outbox
  entries, starts only steps with submitted, current dependencies, and runs one
  step per member ID. It does not wait for human confirmation.
- `submitInitStep(state, objectiveId, submission, now)` accepts `section`, the
  current `executionId`, and all `items` for that section. Optional `goal`,
  `metrics`, `executor`, `docs`, `upcoming`, `unknowns`, and `next` are explicit
  agent output. User-owned goal/stop items remain intact. A changed dependency
  revision makes the submission stale. Replaced submissions invalidate
  downstream steps and schedule requested redo work.
- `recordInitExecution(state, objectiveId, section, executionId, status, now,
  detail)` records cancellation, blocked/failed work, or completion without a
  submission. Retry creates a fresh execution ID, rejecting late old replies.
- `bindObjectiveThread(state, objectiveId, threadId)` records a real created
  thread and fills pending outbox thread references.

`state.outbox` records thread creation, messages/cards, member dispatches,
schedules, runs, executor changes, and reevaluation requests. Entries carry an
ID and objective ID; unsent entries may have `thread: null`. No host messages,
threads, mentions, executions, timers, or MCP tools are created in phase 1.

Fixtures preserve the prototype's empty cartpole start, pending PD setup,
seven-step plan, five-night cartpole script, passive histories, docs, and cards.
The provided-document fixture's author is anonymized to `你`.

## Verification

From the repository root:

```sh
pnpm --filter @clowder-ai/rsi typecheck
pnpm --filter @clowder-ai/rsi test
```

Tests import `dist`, exercise storage through JSON round trips, cover all eleven
reads for both experimental projects, the seven-step stale/redo/ready flow,
retry/rewrite hooks, owner isolation, CAS conflicts, and stored writes.
`test/fixtures/prototype-views.json` records fields from twenty unmodified
prototype VM calls, executed with `node:vm` and small host stubs. Regenerate with
`node packages/rsi/test/record-prototype.mjs <prototype/rsi directory>`.
