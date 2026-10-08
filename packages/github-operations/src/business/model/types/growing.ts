import { z } from 'zod';
import { preparedArtifactSnapshotV1Schema } from './growing-artifact.js';
import { developmentScopeV1Schema, developmentTaskRefSchema } from './growing-development.js';


const boundedRef = z.string().trim().min(1).max(1_000);
const boundedText = z.string().trim().min(1).max(4_000);
const revisionSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative().finite();
const sourceRefsSchema = z.array(boundedRef).min(1).max(64);

const entrustedAdmissionBase = {
  sourceRefs: sourceRefsSchema,
  idempotencyKey: boundedRef,
  receiptRef: boundedRef,
  admittedAt: timestampSchema,
};

const entrustedAdmissionSchema = z.discriminatedUnion('basis', [
  z.object({ ...entrustedAdmissionBase, basis: z.literal('explicit_entrustment') }).strict(),
  z.object({ ...entrustedAdmissionBase, basis: z.literal('accepted_offer') }).strict(),
  z
    .object({
      ...entrustedAdmissionBase,
      basis: z.literal('authorized_source'),
      authorityRef: boundedRef,
    })
    .strict(),
]);

const businessTimeFactSchema = z
  .object({
    value: timestampSchema,
    sourceRef: boundedRef,
  })
  .strict();

const closureBase = {
  condition: boundedText,
  expectedSignal: boundedRef,
};

const terminalClosureDisposition = (kind: 'cancelled' | 'abandoned') =>
  z
    .object({
      kind: z.literal(kind),
      actorKind: z.enum(['human', 'owner']),
      actorRef: boundedRef,
      authorityRef: boundedRef,
      dispositionRef: boundedRef,
      disposedAt: timestampSchema,
    })
    .strict();

const entrustedClosureSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...closureBase,
      state: z.literal('open'),
      evidenceRefs: z.array(boundedRef).max(64),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('satisfied'),
      evidenceRefs: z.array(boundedRef).min(1).max(64),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('cancelled'),
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: terminalClosureDisposition('cancelled'),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('abandoned'),
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: terminalClosureDisposition('abandoned'),
    })
    .strict(),
]);

/** Task-owned durable responsibility contract. It intentionally has no attention judgment fields. */
export const entrustedWorkV1Schema = z
  .object({
    revision: revisionSchema,
    admission: entrustedAdmissionSchema,
    developmentScope: developmentScopeV1Schema.optional(),
    parentTaskRef: developmentTaskRefSchema.optional(),
    predecessorTaskRef: developmentTaskRefSchema.optional(),
    intendedOutcome: boundedText,
    time: z
      .object({
        businessDeadline: businessTimeFactSchema.optional(),
        reviewBy: businessTimeFactSchema.optional(),
        plannedStart: businessTimeFactSchema.optional(),
        actualStart: businessTimeFactSchema.optional(),
        estimatedCompletion: businessTimeFactSchema.optional(),
      })
      .strict(),
    progress: z
      .object({
        summary: z.string().trim().min(1).max(600),
        nextStep: z.string().trim().min(1).max(600).optional(),
        blockerReason: z.string().trim().min(1).max(600).optional(),
        sourceRef: boundedRef,
      })
      .strict()
      .optional(),
    artifactRefs: z.array(boundedRef).max(64),
    completion: z
      .object({
        recordedAt: timestampSchema,
        artifactSnapshot: preparedArtifactSnapshotV1Schema.optional(),
      })
      .strict()
      .optional(),
    closure: entrustedClosureSchema,
  })
  .strict();
export type EntrustedWorkV1 = z.infer<typeof entrustedWorkV1Schema>;
