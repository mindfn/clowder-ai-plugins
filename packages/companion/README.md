# 猫猫球 (Companion)

`@clowder-ai/companion` is the desktop voice body for a Clowder AI companion: a small
always-on-top desktop window (`renderer/index.html`) through which you talk, think, and
find your shared history together. It ships as a Manager-installable builtin plugin
(`runtime.transport: builtin`) and contributes a single `desktop-window` surface named
`companion`.

## What the plugin declares

- One feature, `companion`, contributing the `companion` desktop window
  (330×350, frameless, transparent, always-on-top, skip-taskbar, bridge version 1.0.0,
  with an integrity-bound entrypoint).
- `manifest.json` is a generated package export and must remain mechanically identical
  to `plugin.yaml`.

## Authority boundary

The Host owns installation, grants, configuration and secrets, window/admission policy,
and lifecycle supervision. The package declares a window surface and ships only
renderer assets; it never mints handles and never reads ambient Host state.

## Exposed capability

This package requests this Host capability, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `windows.create`.

## Surface interaction

At rest the desktop shows only your selected cat. Click the cat for voice or text;
right-click for history, screen sharing, household access, sound and hiding.
Dragging moves the cat and folds its controls. Escape folds a panel without
ending the conversation or clearing its draft.

Voice requires an explicit **语音聊** click. An active microphone badge remains
visible and ends the call in one click. Screen sharing has its own explicit
picker and termination badge. There is no microphone action on a double-click,
page load, body tap or drag.

Typing works with voice off. The Host uses the existing owner conversation,
configured duty cat, ordinary message routing and idempotency. The small history
view reads a bounded recent subset; **完整聊天** opens the canonical conversation.
No second transcript database, credentials or selectable Host identity live here.

## Verification

Run the repository's contract and SDK builds, then `pnpm --filter
@clowder-ai/companion test` and `pnpm --filter @clowder-ai/companion lint`.
`node packages/companion/scripts/preview.mjs` serves the accepted interaction
spike at `/spike/` and the actual built renderer with an explicitly simulated
bridge at `/previous`. The latter covers visual states and text controls; it
does not prove native movement, real capture or model delivery.
