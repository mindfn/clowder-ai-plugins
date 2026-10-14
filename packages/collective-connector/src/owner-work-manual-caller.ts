import { z } from "zod";

// Original ca5 strict DTOs are retained; parsing is not owner authorization.
export const ownerWorkInput = z
  .object({
    sourceMessageId: z.string().min(1).max(240),
    requestId: z.string().uuid(),
    businessDeadline: z.number().int().positive().optional(),
    threadId: z.string().min(1).max(240).optional(),
  })
  .strict();
export const ownerWorkResumeInput = z
  .object({
    taskId: z.string().min(1).max(240),
    observedRevision: z.number().int().positive(),
    requestId: z.string().uuid(),
  })
  .strict();
interface Options {
  readonly current: () => Promise<void>;
}
const unavailable = () =>
  Object.assign(
    new Error("Owner Work execution requires the approved durable first-basis and request-identity bridge"),
    { code: "OWNER_ADMISSION_UNAVAILABLE" },
  );

/** Unregistered owner entry refuses without private side effects.
 * Current records do not bind manual/standing first basis to protected admission,
 * Task/execution, nor owner requestId to a distinct resume execution. Caller mode,
 * createdBy, standing config and hashes cannot supply either missing fact.
 * Restore selection and dispatch together only against an actual approved bridge. */
export function createCollectiveOwnerWorkCaller(options: Options) {
  return Object.freeze({
    async admit(_ownerUserId: string, _connectionId: string, unsafe: unknown): Promise<never> {
      ownerWorkInput.parse(unsafe);
      await options.current();
      throw unavailable();
    },
    async resume(_ownerUserId: string, _connectionId: string, unsafe: unknown): Promise<never> {
      ownerWorkResumeInput.parse(unsafe);
      await options.current();
      throw unavailable();
    },
  });
}
