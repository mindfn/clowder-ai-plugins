import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginStorageHost } from "@clowder-ai/plugin-sdk";
import { z } from "zod";
import { collectiveSourceIdentitySchema } from "./business/contracts/index.js";

const ref = z.string().min(1).max(1_000);
const revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  taskRef: ref.regex(/^task:work:/), taskRevision: revision, threadId: ref,
  admissionRef: ref.regex(/^message:/), executionRef: ref.regex(/^message:/), refScope: ref,
}).strict();
const firstReceiptSchema = z.object({
  v: z.literal(1),
  // The package chooses manual explicitly for a human owner click. The Host
  // descriptor authenticates that click; it does not issue this business basis.
  basis: z.object({kind: z.literal("manual_owner_write")}).strict(),
  ownerUserId: ref, pluginInstanceId: ref,
  source: z.object({id: ref, revision: ref, threadId: ref, bodyDigest: digest,
    identity: collectiveSourceIdentitySchema}).strict(),
  work: z.object({workId: ref, assignmentEventId: ref, resultRevision: revision,
    executionRevision: revision, intendedOutcomeDigest: digest}).strict(),
  firstRequest: z.object({requestId: ref, contributionId: ref, method: ref, path: ref,
    bodyDigest: digest, queryDigest: digest}).strict(),
  binding: bindingSchema.optional(),
}).strict();
export type ManualWorkFirstReceipt = z.infer<typeof firstReceiptSchema>;
export type ManualWorkExecutionBinding = z.infer<typeof bindingSchema>;
export const workReceiptDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const conflict = () => Object.assign(new Error("The first owner Work receipt names another choice or execution"), {
  code: "OWNER_ADMISSION_CONFLICT",
});

/** Move the original immutable first-source/Cat receipt into the existing private
 * storage container. Hashes only bound its key/content; no hash issues permission.
 * Canonical Connector v3, Service hostAdmissions and Host Task records are untouched. */
export function manualWorkFirstReceiptKey(owner: string, source: string, cat: string) {
  // The Host already scopes this container to the plugin. A new authenticated
  // instance must find the original choice, not create a parallel first receipt.
  return "collective-owner-admission:" + workReceiptDigest(JSON.stringify([owner, source, cat]));
}

/** A private native consumer reads the original package receipt, never infers a
 * business basis from the Host's entry provenance or Task.createdBy. */
export async function readManualWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get">,
  instance: string,
  owner: string,
  source: string,
  cat: string,
) {
  const entry = await storage.get(manualWorkFirstReceiptKey(owner, source, cat));
  if (!entry) return undefined;
  const parsed = firstReceiptSchema.safeParse(entry.value);
  if (!parsed.success || parsed.data.pluginInstanceId !== instance || parsed.data.ownerUserId !== owner ||
    parsed.data.source.id !== source || parsed.data.source.identity.catId !== cat) throw conflict();
  return parsed.data;
}

export async function retainManualWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  selected: Omit<ManualWorkFirstReceipt, "binding">,
  current: () => Promise<void>,
  hasExistingTask: boolean,
) {
  const expected = firstReceiptSchema.parse(selected);
  const key = manualWorkFirstReceiptKey(expected.ownerUserId, expected.source.id, expected.source.identity.catId);
  const read = async () => {
    await current();
    const entry = await storage.get(key);
    await current();
    if (!entry) return undefined;
    const parsed = firstReceiptSchema.safeParse(entry.value);
    if (!parsed.success) throw conflict();
    const {binding: _binding, firstRequest: _firstRequest, ...facts} = parsed.data;
    const {firstRequest: _request, ...selectedFacts} = expected;
    // A later authenticated HTTP descriptor never rewrites the first descriptor.
    if (!isDeepStrictEqual(facts, selectedFacts)) throw conflict();
    return {entry, receipt: parsed.data};
  };
  let first = await read();
  if (!first) {
    // A surviving Task without its original receipt is a migration/recovery gap,
    // never evidence that its original basis was manual.
    if (hasExistingTask) throw conflict();
    await current();
    await storage.compareAndSet(key, null, expected);
    first = await read();
    if (!first) throw conflict();
  }
  return Object.freeze({
    async readBinding() {
      const actual = await read();
      if (!actual) throw conflict();
      return actual.receipt.binding;
    },
    async bind(raw: ManualWorkExecutionBinding) {
      const binding = bindingSchema.parse(raw);
      const before = await read();
      if (!before) throw conflict();
      if (!before.receipt.binding) {
        await current();
        await storage.compareAndSet(key, before.entry.revision, {...before.receipt, binding});
      }
      const bound = await read();
      if (!bound || !isDeepStrictEqual(bound.receipt.binding, binding)) throw conflict();
      return bound.receipt;
    },
    async assertBound(binding: ManualWorkExecutionBinding) {
      const actual = await read();
      if (!actual || !isDeepStrictEqual(actual.receipt.binding, binding)) throw conflict();
    },
  });
}
