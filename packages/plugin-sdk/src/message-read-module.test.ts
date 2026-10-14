import assert from "node:assert/strict";
import test from "node:test";
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from "./feature-context.js";
import { definePluginModule } from "./module-plugin.js";
import type { ModulePluginHostShape } from "./module-host.js";
const fact = () => ({
  id: "original",
  threadId: "thread",
  userId: "owner",
  catId: "cat",
  content: "Original body",
  mentions: ["cat"],
  timestamp: 1,
  sourceRevision: "revision:1",
  origin: "callback" as const,
  extra: {
    stream: { turnInvocationId: "invocation" },
    causal: { kind: "invocation_reply" as const, triggerMessageId: "trigger" },
    rich: {
      v: 1 as const,
      blocks: [{ id: "file", kind: "file", v: 1, url: "artifact:original", fileName: "report.md" }],
    },
  },
});
async function fixture(get?: (id: string) => Promise<unknown>, capabilities = ["thread.readContent"]) {
  let context!: FeatureContext;
  const manifest = {
    pluginId: "dev.message-read-proof",
    version: "0.1.0",
    contractVersion: "0.1.0-beta.36",
    name: "Read proof",
    runtime: { transport: "builtin", entrypoint: "dist/index.js" },
    features: [{ id: "read", name: "Read", resources: [], capabilities }],
  };
  const module = definePluginModule((input) =>
    definePlugin({
      manifest: input,
      activate: {
        read: (value) => {
          context = value;
          return { actions: {} };
        },
      },
    }),
  );
  const activation = await module
    .create(manifest)
    .start({
      config: { get: async () => undefined },
      secrets: { get: async () => undefined },
      storage: {},
      tasks: {},
      threads: {},
      messaging: get ? { get } : {},
      media: {},
      log() {},
    } as unknown as ModulePluginHostShape);
  const read = (context.messaging as unknown as { get?: (id: string) => Promise<unknown> }).get;
  return { context, activation, read };
}
test("approved generic get reaches a feature as detached frozen public facts, preserving absence and null", async () => {
  const old = await fixture();
  assert.equal(old.read, undefined);
  await old.activation.stop();
  const original = fact();
  let reply: unknown = original;
  const f = await fixture(async (id) => {
    assert.equal(id, "original");
    return reply;
  });
  try {
    assert.ok(f.read, "Host generic message get must reach the module feature");
    const result = await f.read("original");
    assert.deepEqual(result, original);
    assert.notEqual(result, original);
    assert.ok(Object.isFrozen((result as ReturnType<typeof fact>).extra.rich.blocks));
    original.extra.stream.turnInvocationId = "changed";
    assert.equal((result as ReturnType<typeof fact>).extra.stream.turnInvocationId, "invocation");
    reply = null;
    assert.equal(await f.read("original"), null);
  } finally {
    await f.activation.stop();
  }
});
test("read requires thread.readContent, has no write grant, and refuses malformed selectors before Host effects", async () => {
  let calls = 0;
  const denied = await fixture(async () => {
    calls++;
    return fact();
  }, []);
  assert.ok(denied.read);
  await assert.rejects(denied.read("original"), /thread.readContent/);
  assert.equal(calls, 0);
  await denied.activation.stop();
  const f = await fixture(async () => {
    calls++;
    return fact();
  });
  try {
    assert.ok(f.read);
    for (const id of ["", " original ", "x".repeat(501)]) await assert.rejects(f.read(id), TypeError);
    assert.equal(calls, 0);
    await f.read("original");
    assert.equal(calls, 1);
  } finally {
    await f.activation.stop();
  }
});
test("wrong-message, expanded private extra, custody, nested getters and malformed facts fail closed", async () => {
  let reply: unknown = fact(),
    reads = 0;
  const f = await fixture(async () => reply);
  try {
    assert.ok(f.read);
    const getter = Object.defineProperty(fact().extra.stream, "turnInvocationId", {
      enumerable: true,
      get() {
        reads++;
        return "forged";
      },
    });
    for (const value of [
      { ...fact(), id: "other" },
      { ...fact(), queueCustody: {} },
      { ...fact(), extra: { ...fact().extra, callbackToken: "secret" } },
      { ...fact(), extra: { ...fact().extra, stream: getter } },
      { ...fact(), mentions: [5] },
      { ...fact(), sourceRevision: "" },
      { ...fact(), origin: "owner" },
    ]) {
      reply = value;
      await assert.rejects(f.read("original"), TypeError);
    }
    assert.equal(reads, 0);
  } finally {
    await f.activation.stop();
  }
});
test("an activation stopped during get never accepts the late read and never retries", async () => {
  let resolve!: (value: unknown) => void,
    calls = 0;
  const f = await fixture(async () => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  });
  assert.ok(f.read);
  const pending = f.read("original");
  await f.activation.stop();
  resolve(fact());
  await assert.rejects(pending, FeatureContextRevokedError);
  assert.equal(calls, 1);
});
