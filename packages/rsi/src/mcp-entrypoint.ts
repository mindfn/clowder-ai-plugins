import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRsiMcpServer, type McpTransport, type RsiMcpActionClient } from './mcp-server.js';

type Credentials = { invocationId: string; callbackToken: string };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const denied = () => new Error('Plugin action credentials are unavailable for this exact turn');

function readProjection(file: string): Record<string, unknown> {
  try {
    if (statSync(file).size > 128_000) throw denied();
    return record(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw denied();
  }
}

function credentials(value: Record<string, unknown>): Credentials {
  if (!identifier(value.invocationId) || !identifier(value.callbackToken)) throw denied();
  return { invocationId: value.invocationId, callbackToken: value.callbackToken };
}

function nativeCredentials(env: NodeJS.ProcessEnv, meta: unknown): Credentials {
  const runtime = record(meta);
  const turn = record(runtime['x-codex-turn-metadata']);
  if (!identifier(runtime.threadId) || runtime.threadId !== turn.thread_id || !identifier(turn.turn_id)) throw denied();
  const projection = readProjection(env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE!);
  if (
    projection.v !== 1 ||
    !identifier(env.CAT_CAFE_NATIVE_CONNECTION_ID) ||
    projection.connectionId !== env.CAT_CAFE_NATIVE_CONNECTION_ID ||
    projection.nativeThreadId !== runtime.threadId ||
    !Array.isArray(projection.turns)
  )
    throw denied();
  const matches = projection.turns.map(record).filter((entry) => entry.nativeTurnId === turn.turn_id);
  if (matches.length !== 1) throw denied();
  return credentials(matches[0]!);
}

function createActionClient(env: NodeJS.ProcessEnv = process.env): RsiMcpActionClient {
  return {
    async invoke(method, input, call = {}) {
      const signal = AbortSignal.any([...(call.signal ? [call.signal] : []), AbortSignal.timeout(30_000)]);
      signal.throwIfAborted();
      if (
        !env.CAT_CAFE_API_URL ||
        !env.CLOWDER_PLUGIN_ACTION_TOKEN ||
        env.CLOWDER_PLUGIN_ACTION_PATH !== '/api/plugin-runtime/action'
      )
        throw denied();
      const url = new URL(env.CLOWDER_PLUGIN_ACTION_PATH, env.CAT_CAFE_API_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied();
      let auth: Credentials;
      if (env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
        auth = nativeCredentials(env, call._meta);
        const admission = await fetch(new URL('/api/callbacks/native-turn-admission', url), {
          headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          redirect: 'error',
        });
        if (admission.status !== 204) throw denied();
        signal.throwIfAborted();
        const latest = nativeCredentials(env, call._meta);
        if (latest.invocationId !== auth.invocationId || latest.callbackToken !== auth.callbackToken) throw denied();
      } else {
        auth = env.CAT_CAFE_CREDENTIAL_FILE
          ? credentials(readProjection(env.CAT_CAFE_CREDENTIAL_FILE))
          : credentials({ invocationId: env.CAT_CAFE_INVOCATION_ID, callbackToken: env.CAT_CAFE_CALLBACK_TOKEN });
      }
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-clowder-plugin-action-token': env.CLOWDER_PLUGIN_ACTION_TOKEN,
          'x-invocation-id': auth.invocationId,
          'x-callback-token': auth.callbackToken,
        },
        body: JSON.stringify({ method, input }),
      });
      if (!response.ok) throw new Error(`Plugin action failed (HTTP ${response.status}); result may be unknown`);
      const body = record(await response.json());
      if (!Object.hasOwn(body, 'result')) throw new Error('Plugin action returned an invalid response; result may be unknown');
      return body.result;
    },
  };
}

function createStdioTransport(): McpTransport {
  let rl: ReturnType<typeof createInterface> | undefined;
  const transport: McpTransport = {
    async start() {
      rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          transport.onmessage?.(JSON.parse(trimmed));
        } catch (err) {
          transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      });
      rl.on('close', () => transport.onclose?.());
    },
    async send(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      rl?.close();
    },
  };
  return transport;
}

await createRsiMcpServer(createActionClient()).connect(createStdioTransport());
