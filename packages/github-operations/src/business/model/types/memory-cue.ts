import { z } from 'zod';

const timestampSchema = z.number().int().nonnegative().finite();

/** Server-private transport frame; sourceMessageId and execution scope are rebound after queue admission. */
export const deliveryDecisionCueCarrierV1Schema = z
  .object({
    v: z.literal(1),
    producer: z.literal('github_ci'),
    producerProvenance: z.literal('server_github_ci'),
    repoFullName: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/)
      .max(240),
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    phase: z.literal('merge_gate'),
    gateOutcome: z.literal('source_evidence_complete'),
    externalCondition: z.literal('billing_spending_limit_zero_step'),
    candidateAction: z.literal('merge'),
    occurredAt: timestampSchema,
  })
  .strict();
export type DeliveryDecisionCueCarrierV1 = z.infer<typeof deliveryDecisionCueCarrierV1Schema>;
