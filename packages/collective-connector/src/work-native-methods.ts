import { z } from 'zod';

export const COLLECTIVE_WORK_NATIVE_ID = 'collective-work-native';
export const collectiveWorkNativeTools = [
  {method: 'collective.work.context.current', name: 'cat_cafe_collective_work_current_context',
    description: 'Use when starting or reopening this authenticated private Collective Task. Returns its original source, Work coordinates and current context/return/progress references. Not for public participation, granting permission or completing Work.',
    schema: z.object({}).strict()},
  {method: 'collective.work.context.read', name: 'cat_cafe_collective_work_read_context',
    description: 'Use when this private Collective Task needs its original source or surrounding context. Supply contextRef from Work current context; returns bounded source context. Not for public participation or historical result artifact reading, which remains unavailable.',
    schema: z.object({contextRef: z.string().min(1).max(256).describe('Opaque contextRef returned by Work current context.'),
      afterSequence: z.number().int().nonnegative().optional().describe('Return events after this Service sequence number; defaults to 0.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum context events, 1–100; defaults to 30.')}).strict()},
  {method: 'collective.work.progress', name: 'cat_cafe_collective_progress',
    description: 'Use when reporting progress on this current private Collective Task. Publishes body to the original Service using returnRef and progressOperationRef from Work current context, returning its receipt. Reuse the same references and body after response loss. Not for result publication or completing Work.',
    schema: z.object({returnRef: z.string().min(1).max(256).describe('Opaque returnRef from this Work current context.'),
      progressOperationRef: z.string().min(1).max(256).describe('Opaque progress reference; reuse it with the same body after response loss.'),
      body: z.string().trim().min(1).max(20000).describe('Progress text, 1–20000 characters; does not complete Work.')}).strict()},
] as const;
export const COLLECTIVE_WORK_METHODS = Object.freeze(collectiveWorkNativeTools.map(tool => tool.method));
