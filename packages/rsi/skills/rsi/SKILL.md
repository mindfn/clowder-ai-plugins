---
name: rsi
description: Participate in a Clowder AI RSI (capability evolution) objective thread using the installed official.rsi plugin. Use whenever woken for initialization steps (1–7), executor registration, cycle evaluation, direction discussion, or version/repair delivery.
---

# RSI (Capability Evolution)

The installed `official.rsi` plugin registers a native MCP server (`rsi-native`) with eight strongly typed tools:

- `rsi_task` — Claim your current turn and read the objective, project path, active step(s), dependency versions, or evaluation/discussion/version context.
- `rsi_submit` — Submit an initialization step (`"1"`–`"7"` or `goal`/`scope`/`run`/`rules`/`design`/`feedback`/`baseline`).
- `rsi_executor` — Register local execution commands (`preflight`, `submit`, `collect`, plus optional `get`/`cancel`/`analyze`/`resultMap`/`failureField`/`timeout`/`poll`) during Step 3.
- `rsi_conclude` — Submit a cycle evaluation (`cycle`, `verdict`, `findings`, optional `disposition: "advance" | "dead_end"`, optional `tag` (≤32 chars), optional `options` / `comparisons`).
- `rsi_propose` — Submit direction proposals during cycle discussion (`cycle`, `options`).
- `rsi_version` — Deliver a new version or execution repair (`change`, optional `commit`, optional `baseVersion`, `config` or `configPath`, optional `aspects` (`["object" | "observability" | "rubric"]`), optional `changes`; or `cannot` when a repair or direction request cannot be satisfied). When `commit` is provided without `baseVersion`, the plugin derives `parent` from the nearest registered git-ancestor version automatically.
- `rsi_status` — Pure read-only inspection (`{}` inside an objective thread, `{ objectiveId, cycle?, scope?: "brief" | "full", sinceVersion?, versionsLimit? }` cross-thread, or `{}` outside an objective thread to list real objectives). Prefer `scope: "brief"` or `sinceVersion` for routine polling to keep context slim. Never open a browser just to inspect RSI state.
- `rsi_operate` — Delegated operator control (`expDecide`, `prepConfirm`, `initStepRefresh`, `initRetry`, `stepMember`, `life`, `runCycle`, `evalAgain`, `discussAgain`, `versionAgain`, `lineageFix`), strictly gated to the owner-designated `policy.manager`. Cannot modify `policy.manager`, stop conditions, or delete objectives.

## Core Rules

1. **Always use the native MCP tools directly (match by tool suffix).** Different CLIs prepend their own server prefix to `rsi-native` (for example `mcp__plugin_official_rsi_rsi-native__rsi_task` on Kimi, `mcp__plugin__official_rsi__rsi_native__rsi_task` on Codex, or server `p_rsi-nati_*` on Antigravity). Match whichever tool in your tool list ends with `rsi_task`, `rsi_submit`, `rsi_executor`, `rsi_conclude`, `rsi_propose`, or `rsi_version`. The Host automatically authenticates your `catId` and `threadId` from request headers—never pass identity fields manually, and never read credential files or hand-call Host HTTP routes.
2. **Always call `rsi_task({})` first** on every woken turn so the plugin binds your turn to the current dependency versions.
3. **Keep `rsi_submit` JSON flat (2–3 levels):**
   - Pass `step` as `"1"`–`"7"` (or section name).
   - Pass `items` as `[{ id, title?, value, facts?: ["依据：README"], rec?, can?, tag? }]` — prefer flat string entries in `facts` (avoid deep nested objects).
   - You may also use the 2-level `values` shorthand on any step (including steps with newly created items): `{ step: "2", values: { "<id or title>": "<value>" }, unknowns: ["..."], next: ["..."] }`.
   - Pass `unknowns` and `next` as arrays of concise, self-contained bullet points so the console renders them as structured cards.
4. **Stage-specific payloads:**
   - **Step 3 (`run`)**: register commands with `rsi_executor` (preflight runs automatically) and submit `window` + Step 3 items with `rsi_submit`. For async remote jobs (`get` + `cancel` with `{job}`), make `get` emit a terminal JSON state (e.g. `{"state":"cancelled"}`) for unknown/already-cleaned jobs and make `cancel` exit 0 idempotently when already stopped so orphan-job guards clear cleanly. For deterministic non-environment rejections (config validation errors, precision/correctness gate rejections), emit `{"retryable":false,"reason":"..."}` (or `errorKind: "real"`) on `get`/`submit` output so the plugin records it as experimental evidence without wasting an env retry.
   - **Step 4 (`rules`)**: include `metrics: { version, items, slices? }` with one primary metric and finite numeric `threshold` on every guardrail. When an objective evaluates across operating points or slices (e.g., load/concurrency levels, dataset splits, sequence lengths, or scenarios), declare optional `slices: [{ id, name, axis, axisUnit?, stats: [{ id, name, unit?, dir: "up"|"down", threshold?, primary? }] }]` and emit matching `slices: { "<id>": [{ at, values: { "<stat>": number }, pass? }] }` from `collect` — the plugin then automatically aggregates across seeds, checks per-slice thresholds, renders the user-adjustable comparison table in the console, and generates the concise Markdown table + rolled-up guardrail summary in the chat conclusion card (so `findings` can stay focused on root cause and next steps instead of hand-formatted tables).
   - **Step 5 (`design`) / Step 7 (`baseline`)**: include `upcoming: { groups, seeds }`.
   - **Evaluation (`rsi_conclude`)**: when a candidate branch is clearly falsified / retired (even in an `explore` tier where `verdict` is `tune` or `insufficient`), pass `disposition: "dead_end"` and a concise `tag` (≤32 chars) so the lineage overview marks the dead branch explicitly without altering nightly policy state machines.
   - **Governance / Repair (`rsi_version`)**: edit and commit in an isolated git worktree/branch (never mutate the user's dirty working tree), pass `aspects` (`["object"]`, `["observability"]`, `["rubric"]`, or combinations) honestly, pass `config` (object) or `configPath` (project-relative JSON path), and optionally pass `baseVersion` if branching back from a non-current version without a git commit.
