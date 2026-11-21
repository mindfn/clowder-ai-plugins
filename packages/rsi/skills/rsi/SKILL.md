---
name: rsi
description: Participate in a Clowder AI RSI (capability evolution) objective thread using the installed official.rsi plugin. Use whenever woken for initialization steps (1–7), executor registration, cycle evaluation, direction discussion, or version/repair delivery.
---

# RSI (Capability Evolution)

The installed `official.rsi` plugin registers a native MCP server (`rsi-native`) with six strongly typed tools:

- `rsi_task` — Claim your current turn and read the objective, project path, active step(s), dependency versions, or evaluation/discussion/version context.
- `rsi_submit` — Submit an initialization step (`"1"`–`"7"` or `goal`/`scope`/`run`/`rules`/`design`/`feedback`/`baseline`).
- `rsi_executor` — Register local execution commands (`preflight`, `submit`, `collect`, plus optional `get`/`cancel`/`analyze`/`resultMap`/`failureField`/`timeout`/`poll`) during Step 3.
- `rsi_conclude` — Submit a cycle evaluation (`cycle`, `verdict`, `findings`, optional `options` / `comparisons`).
- `rsi_propose` — Submit direction proposals during cycle discussion (`cycle`, `options`).
- `rsi_version` — Deliver a new version or execution repair (`change`, optional `commit`, `config` or `configPath`, optional `changes`; or `cannot` when a repair is impossible).

## Core Rules

1. **Use the native MCP tools directly.** The Host automatically authenticates your current `catId` and `threadId` from request headers—never pass identity fields manually, and never read credential files or hand-call Host HTTP routes.
2. **Always call `rsi_task({})` first** on every woken turn so the plugin binds your turn to the current dependency versions.
3. **Keep `rsi_submit` JSON flat (2–3 levels):**
   - Pass `step` as `"1"`–`"7"` (or section name).
   - Pass `items` as `[{ id, title?, value, facts?: ["依据：README"], rec?, can?, tag? }]` — prefer flat string entries in `facts` (avoid deep nested objects).
   - For steps that only fill existing item IDs (e.g. Step 1), you may use the 2-level `values` shorthand: `{ step: "1", values: { "<id>": "<value>" }, unknowns: ["..."], next: ["..."] }`.
   - Pass `unknowns` and `next` as arrays of concise, self-contained bullet points so the console renders them as structured cards.
4. **Stage-specific payloads:**
   - **Step 3 (`run`)**: register commands with `rsi_executor` (preflight runs automatically) and submit `window` + Step 3 items with `rsi_submit`.
   - **Step 4 (`rules`)**: include `metrics: { version, items }` with one primary metric and finite numeric `threshold` on every guardrail.
   - **Step 5 (`design`) / Step 7 (`baseline`)**: include `upcoming: { groups, seeds }`.
   - **Governance / Repair (`rsi_version`)**: edit and commit in an isolated git worktree/branch (never mutate the user's dirty working tree), then pass `config` (object) or `configPath` (project-relative JSON path).
5. **Compatibility fallback:** Only if an older session has not mounted `rsi-native`, you may call the same methods (`rsi.task`, `rsi.submit`, etc.) through `plugin_call` with `pluginId: "official.rsi"`.
