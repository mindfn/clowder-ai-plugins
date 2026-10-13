import { z } from 'zod';

export const COLLECTIVE_NATIVE_ID = 'collective-native';
export const collectivePublicNativeTools = [
  { method: 'collective.context.current', name: 'cat_cafe_collective_current_context',
    description: 'Read the current Collective request and its reply references from this authenticated native origin.',
    schema: z.object({}).strict() },
  { method: 'collective.context.read', name: 'cat_cafe_collective_read_context',
    description: 'Read bounded original Collective context using the contextRef returned by current context.',
    schema: z.object({ contextRef: z.string().min(1).max(256), afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { method: 'collective.participation.set-interest', name: 'cat_cafe_collective_set_interest',
    description: 'Set this named participant’s listening interest for the current channel; this does not grant Work authority.',
    schema: z.object({ contextRef: z.string().min(1).max(256), state: z.enum(['listen', 'withdraw']) }).strict() },
  { method: 'collective.reply.submit', name: 'cat_cafe_collective_submit_reply',
    description: 'Return the original reply to the current Collective request. Reuse its returnRef and replyOperationRef after response loss.',
    schema: z.object({ returnRef: z.string().min(1).max(256), replyOperationRef: z.string().min(1).max(256), body: z.string().trim().min(1).max(20000) }).strict() },
] as const;
export const COLLECTIVE_PUBLIC_METHODS = Object.freeze(collectivePublicNativeTools.map(tool => tool.method));
