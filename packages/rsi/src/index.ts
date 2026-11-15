import { createRsi } from './backend.js';
import type { OwnerContext, RsiStorage } from './types.js';

export default {
  create() {
    return {
      start(host: { pluginInstanceId: string; storage: RsiStorage }) {
        const handle = createRsi(host.storage);
        return {
          actions: {
            'rsi.view': (input: unknown, _native?: unknown, context?: OwnerContext) =>
              handle.view(input, context?.pluginInstanceId === host.pluginInstanceId ? context : undefined),
            'rsi.act': (input: unknown, _native?: unknown, context?: OwnerContext) =>
              handle.act(input, context?.pluginInstanceId === host.pluginInstanceId ? context : undefined),
          },
          stop() {},
        };
      },
    };
  },
};
