# @clowder-ai/plugin-sdk

Runtime helpers and typed Host boundaries for Clowder AI plugins.

`context.config.get` and `context.secrets.get` expose the plugin-activation snapshot. After an operation changes configuration, runtime paths must use the values currently held by the live process or adapter rather than rereading that snapshot.

`context.ownerThreads` is an optional strict owner webhook port. When supplied by the Host, all three methods are present: `get(threadId)`, `create({ title })`, and `addParticipants({ threadId, catIds })`. They return `{ id, createdBy, participants }`; `get` may return `null`. Reads require `thread.listMetadata`; writes require `thread.write`. The Host also requires its current authenticated owner webhook request and checks `createdBy` ownership. Plugin bindings, native callers and generic accessible `context.threads` are not substitutes.

Older carriers leave `ownerThreads` absent. Callers must report the missing port rather than fall back to a wider thread API. `create` is an ordinary write, not an idempotent ensure; failed writes are never automatically retried. The SDK preserves Host refusals, validates immutable projection snapshots, and refuses calls or late results after feature stop. It does not grant owner authority, supply participant eligibility, or introduce Work admission/dispatch ports.

### Participant roster

`context.participantRoster?.listForNativeContribution({ contributionId })` mirrors the optional Host public participant roster. It accepts only a contribution coordinate; Host derives the admitted instance, action methods, caller authority and owning feature grants. Owner reads do not require a participation invocation; native reads require a verified same-owner invocation. Host refusals propagate without retries or catalog/available fallbacks.

Rows retain `catId`, `displayName`, `defaultModel`, `supported` and optional public nickname/variant/role/avatar. The facade validates and returns detached frozen rows. `supported` is provider enforcement capability, not availability or an invocation admission receipt; `false` stays false. Older carriers keep the port absent, supplied partial ports are rejected, and stopped feature sessions reject calls and late results. No provider policy, private avatar path or new capability is exposed.

### Exact source facts and native context

`context.sourceFacts?.read({ messageRef: 'message:<id>' })` and `context.nativeContext?.current()` are separate optional Host ports. Both require the existing `thread.readContent` feature grant. Source facts include only `id`, `userId`, `threadId`, nullable `catId`, `content`, `source.connector`/optional JSON `meta`, and `extra.pluginMessage.instanceId`. Native context adds authenticated `userId`, `threadId`, `catId`, `invocationId` and the exact `originTriggerMessageId` with its source fact; it accepts no body identity. Returned data is detached and deeply frozen.

Host permits an authenticated same-owner webhook to read same-instance plugin sources in owner-created threads; native reads are confined to the current exact origin. Deletion, recall, queued or invalid sources and currentness drift are refused. The SDK propagates refusals, performs no retry or generic-thread fallback, and rejects calls and late results after stop. Older carriers keep each missing port absent. This slice provides no Task/receipt/ancestor access, private Work binding, background/list operation or public invocation authority. Package-owned participation and Service rules still require their own validation.
