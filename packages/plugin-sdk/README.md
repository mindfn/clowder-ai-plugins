# @clowder-ai/plugin-sdk

Runtime helpers and typed Host boundaries for Clowder AI plugins.

`context.config.get` and `context.secrets.get` expose the plugin-activation snapshot. After an operation changes configuration, runtime paths must use the values currently held by the live process or adapter rather than rereading that snapshot.

`context.ownerThreads` is an optional strict owner webhook port. When supplied by the Host, all three methods are present: `get(threadId)`, `create({ title })`, and `addParticipants({ threadId, catIds })`. They return `{ id, createdBy, participants }`; `get` may return `null`. Reads require `thread.listMetadata`; writes require `thread.write`. The Host also requires its current authenticated owner webhook request and checks `createdBy` ownership. Plugin bindings, native callers and generic accessible `context.threads` are not substitutes.

Older carriers leave `ownerThreads` absent. Callers must report the missing port rather than fall back to a wider thread API. `create` is an ordinary write, not an idempotent ensure; failed writes are never automatically retried. The SDK preserves Host refusals, validates immutable projection snapshots, and refuses calls or late results after feature stop. It does not grant owner authority, supply participant eligibility, or introduce Work admission/dispatch ports.
