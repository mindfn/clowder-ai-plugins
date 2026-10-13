---
feature_ids: [F202]
topics: [plugins, feishu, meeting-intake]
doc_kind: guide
created: 2026-10-13
---

# Feishu Meeting Intake

A generated meeting artifact becomes a retained record and one ordinary thread notification.
The installed MCP lets a cat read the source in that same authenticated thread. People retain
account authorization, destination choice and the interpretation of the meeting.

The current alpha.11 C1 candidate is under review. Local fixtures and a packed consumer do not
certify an actual Feishu account, Host installation or completion of C1.

## Settings journey

1. Select the approved local archive in Manager, grant the capabilities below, then enable it.
   First enable starts only the control plane: no login, CLI process, collection or provider request.
2. Save your Feishu app ID and secret and an existing accessible notification thread.
3. Select **Authorize Feishu**, open its Feishu URL, then **Check authorization**.
   Authorization alone does not start collection. Each check has a fresh owner operation.
4. Select **Start collection**. **Pause collection** stops it without removing records or credentials.
   Restart keeps the requested intent but remains stopped until you explicitly start again.
5. To import an existing Minute, save its token/Minutes URL and select **Import Minutes reference**.
   **Meeting records** shows retained metadata and retry actions for unsettled notifications.
6. For an interrupted/ambiguous authorization, use **Verify existing account** first.
   The previous exchange is not silently repeated. The explicit reset action preserves its evidence
   and pauses collection before a fresh attempt. A corrupted credential compartment is refused.
   Confirmed account refusal is durably `expired` before the error; uncertain checks are `unknown`.
   An expired device challenge is `unknown`, since it does not prove the old credentials expired.
7. Historical catch-up requires a preview and an explicit future-only or replay decision tied to
   that exact preview; opening status never starts collection or historical replay.

No specialized Host meeting-intake/Needs Me/sourceGrant backend or external stdio broker is used
by the production module. Credentials and records remain in the Host-provisioned private instance
directory. No TTL is applied. Stop/revoke cancels owned process groups and rejects late commits.

## Install consent

- `data.directory`: private account, cursor, source records, notification receipts and recovery evidence.
- `plugin.config.read`: your app ID, notification destination and saved Minutes reference.
- `secret.read`: the app secret saved through Settings; never returned to MCP or process arguments.
- `thread.readContent`: Host-filtered verification of the saved notification destination.
- `messaging.send`: one ordinary notification using a durable fixed target/body/idempotency key.

The pinned official CLI1.0.85 runner is checksum-verified at build and packaged with this local
platform artifact. Its declared binary member retains executable permissions in the archive and installed consumer.
Runtime does not download a runner or borrow the operator's HOME/profile.
macOS uses an owned fallback file master; Linux uses its owned file backend. Existing encrypted
credentials must authenticate locally before starting any CLI. Windows credential isolation is
not supported by this module. Artifact platform/architecture must match the Host.

## Installed MCP

`cat_cafe_meeting_records_list` accepts only bounded pagination. `cat_cafe_meeting_records_read`
accepts only recordId/offset/limit. Host supplies user/thread/cat/invocation separately; a body
cannot supply identity, URL, filesystem path or destination. The MCP child gets no account home
or record-directory access and calls only the two declared module methods.

The original normalized revision denotes artifact generation, not a transcript edit version.
Reads verify that generation and current Feishu authorization, report a separate text SHA-256 and
read time, and label source text as untrusted data. They do not invent immutable historical text.

## Verification

`pnpm --filter @clowder-ai/feishu-meeting-intake test` includes the retained source/cursor/catch-up
regressions plus the actual module/credential/process fixtures. `node --test
packages/feishu-meeting-intake/test/installed-directory.test.mjs` uses the repository's canonical
packer and an empty consumer, then starts the actual MCP and packaged runner's local version
probe. Provider I/O and Host identity in the module journey are controlled fixtures, not dogfood.
