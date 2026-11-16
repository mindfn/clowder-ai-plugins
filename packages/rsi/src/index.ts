import { createRsi } from './backend.js';
import type { OwnerContext, RsiHost, ToolContext } from './types.js';

export default {
  create() {
    return {
      start(host: RsiHost) {
        const handle = createRsi(host);
        return {
          actions: {
            'rsi.view': (input: unknown, _native?: unknown, context?: OwnerContext) =>
              handle.view(input, context?.pluginInstanceId === host.pluginInstanceId ? context : undefined),
            'rsi.act': (input: unknown, _native?: unknown, context?: OwnerContext) =>
              handle.act(input, context?.pluginInstanceId === host.pluginInstanceId ? context : undefined),
            'rsi.task': (input: unknown, ctx?: ToolContext) => handle.tool('rsi.task', input, ctx),
            'rsi.submit': (input: unknown, ctx?: ToolContext) => handle.tool('rsi.submit', input, ctx),
            'rsi.executor': (input: unknown, ctx?: ToolContext) => handle.tool('rsi.executor', input, ctx),
            'rsi.version': (input: unknown, ctx?: ToolContext) => handle.tool('rsi.version', input, ctx),
            'rsi.conclude': (input: unknown, ctx?: ToolContext) => handle.tool('rsi.conclude', input, ctx),
            'rsi.delivery': (input: unknown) => handle.deliver(input),
          },
          deliver: handle.deliver,
          stop: handle.stop,
        };
      },
    };
  },
};
