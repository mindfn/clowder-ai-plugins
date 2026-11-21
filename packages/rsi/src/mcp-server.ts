export interface RsiMcpActionClient {
  invoke(
    method: string,
    input: unknown,
    call?: { readonly signal?: AbortSignal; readonly _meta?: unknown },
  ): Promise<unknown>;
}

export interface McpTransport {
  start?(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onmessage?: (message: unknown, extra?: unknown) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

export interface RsiMcpToolDef {
  readonly name: string;
  readonly method: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const RSI_MCP_VERSION = '0.1.0-alpha.85';

const OPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['k', 'title', 'why'],
  properties: {
    k: { type: 'string', minLength: 1, description: '方向唯一标识（同一周期内互异）。' },
    title: { type: 'string', minLength: 1, description: '一句话方向标题。' },
    why: { type: 'string', minLength: 1, description: '依据与预期收益说明。' },
    kind: { type: 'string', enum: ['code', 'variable', 'metric', 'goal', 'discriminate', 'execution'] },
    target: { type: 'string', minLength: 1, description: '要改的对象名（如 lr、serve_bge.py）。' },
    expect: { type: 'object', additionalProperties: true, description: '可选数值预测 { lo, hi, metric? }。' },
    cites: { type: 'array', items: { type: 'string', minLength: 1 }, description: '引用的历史周期资料库 id。' },
  },
};

export const RSI_MCP_TOOLS: readonly RsiMcpToolDef[] = [
  {
    name: 'rsi_task',
    method: 'rsi.task',
    description:
      '被 RSI 叫醒后首先调用 {}。只在评估项 thread 内、轮到你的成员身份下可用。返回项目目录、当前步骤、条目格式、依赖版本，以及评估/分析/出版本所需的全部上下文，并认领本轮任务。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'rsi_submit',
    method: 'rsi.submit',
    description:
      '提交 rsi_task 分给你的初始化步骤（1–7 或 goal/scope/run/rules/design/feedback/baseline）。推荐扁平 2–3 层 JSON：items 每项只需 { id, title?, value, facts?: ["依据：..."], rec?, can?, tag? }；已有条目也可用 2 层 values: { "<id>": "<值>" } 简写。unknowns/next 用字符串数组逐条列出。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['step'],
      properties: {
        step: {
          type: 'string',
          description: '步骤编号 "1"–"7" 或阶段名 goal/scope/run/rules/design/feedback/baseline。',
        },
        items: {
          type: 'array',
          minItems: 1,
          description: '本步提交条目列表（最多 3 层：items[] -> item -> facts[] 字符串）。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'value'],
            properties: {
              id: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              value: { type: 'string', minLength: 1 },
              facts: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: '扁平依据条目，如 ["依据：README", "代码：serve_bge.py"]。',
              },
              can: { type: 'string' },
              rec: { type: 'string', enum: ['explore', 'fixed', 'excluded'] },
              tag: { type: 'string' },
            },
          },
        },
        values: {
          type: 'object',
          additionalProperties: { type: 'string', minLength: 1 },
          description: '2 层快捷写法：对已有条目直接传 { "<itemId>": "<value>" }，可替代 items。',
        },
        unknowns: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: '本步尚未确认的未决项（逐条数组）。',
        },
        next: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: '本步推荐的下一步动作（逐条数组）。',
        },
        window: { type: 'string', description: '第 3 步运行时段，如 "不限制"、"20:00–08:00"。' },
        goal: { type: 'object', additionalProperties: true, description: '可选目标补充对象。' },
        executor: { type: 'object', additionalProperties: true, description: '第 3 步可选内联执行器命令对象。' },
        metrics: { type: 'object', additionalProperties: true, description: '第 4 步量尺定义 { version, items }。' },
        upcoming: { type: 'object', additionalProperties: true, description: '第 5/7 步下一周期计划 { groups, seeds }。' },
        docs: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选附带项目/参考文档。' },
      },
    },
  },
  {
    name: 'rsi_executor',
    method: 'rsi.executor',
    description:
      '第 3 步调用 rsi_task 后登记本机执行方式，必填 preflight / submit / collect，选填 get / cancel / analyze / resultMap / failureField / timeout / poll。提交后立即触发 preflight 预检。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'submit', 'collect'],
      properties: {
        preflight: { type: 'string', minLength: 1 },
        submit: { type: 'string', minLength: 1 },
        collect: { type: 'string', minLength: 1 },
        get: { type: 'string', minLength: 1 },
        cancel: { type: 'string', minLength: 1 },
        analyze: { type: 'string', minLength: 1 },
        failureField: { type: 'string', minLength: 1 },
        timeout: { type: 'integer', minimum: 1 },
        poll: { type: 'integer', minimum: 1 },
        resultMap: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'field'],
            properties: {
              metric: { type: 'string', minLength: 1 },
              field: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  },
  {
    name: 'rsi_version',
    method: 'rsi.version',
    description:
      '治理执行成员在选定方向或收到修复请求后提交新版本。改代码提交 git 后传 { change, commit?, config 或 configPath, changes? }；修复不了传 { cannot }。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        change: { type: 'string', minLength: 1, description: '一句话说明改动内容。' },
        commit: { type: 'string', pattern: '^[a-fA-F0-9]{7,40}$', description: '可选 7–40 位 git 提交号。' },
        config: { type: 'object', additionalProperties: true, description: '版本配置对象。' },
        configPath: { type: 'string', minLength: 1, description: '或者传项目内 JSON 配置文件路径。' },
        cannot: { type: 'string', minLength: 1, description: '修复失败时说明原因，转交评估成员。' },
        changes: { type: 'object', additionalProperties: true, description: '可选结构化变更摘要 { pr?, files?, items? }。' },
      },
    },
  },
  {
    name: 'rsi_conclude',
    method: 'rsi.conclude',
    description:
      '评估成员在本周期全部运行结束后提交结论 { cycle, verdict, findings, options?, comparisons? }。有方案讨论成员时可省略 options。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cycle', 'verdict', 'findings'],
      properties: {
        cycle: { type: 'integer', minimum: 1 },
        verdict: { type: 'string', enum: ['baseline', 'keep', 'tune', 'rollback', 'sunset', 'insufficient'] },
        findings: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: '逐条评估发现。',
        },
        options: { type: 'array', minItems: 1, items: OPTION_SCHEMA },
        comparisons: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '可选对照展示（图片/视频/文本）数组。',
        },
      },
    },
  },
  {
    name: 'rsi_propose',
    method: 'rsi.propose',
    description: '方案讨论成员收到周期结论后调用，提交下一轮改进方向 { cycle, options }。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cycle', 'options'],
      properties: {
        cycle: { type: 'integer', minimum: 1 },
        options: { type: 'array', minItems: 1, items: OPTION_SCHEMA },
      },
    },
  },
];

const TOOL_BY_NAME = new Map<string, RsiMcpToolDef>();
for (const tool of RSI_MCP_TOOLS) {
  TOOL_BY_NAME.set(tool.name, tool);
  TOOL_BY_NAME.set(tool.method, tool);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function createRsiMcpServer(client: RsiMcpActionClient) {
  let activeTransport: McpTransport | undefined;
  let closed = false;

  async function reply(transport: McpTransport, id: unknown, payload: { result?: unknown; error?: { code: number; message: string } }) {
    if (id === undefined || closed) return;
    await transport.send(
      payload.error
        ? { jsonrpc: '2.0', id, error: payload.error }
        : { jsonrpc: '2.0', id, result: payload.result },
    );
  }

  async function handleMessage(transport: McpTransport, raw: unknown) {
    if (!isRecord(raw) || typeof raw.method !== 'string') return;
    const id = raw.id;
    const params = isRecord(raw.params) ? raw.params : {};
    const method = raw.method;

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;

    if (method === 'initialize') {
      const protocolVersion = typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
        ? params.protocolVersion
        : '2024-11-05';
      await reply(transport, id, {
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'official-rsi', version: RSI_MCP_VERSION },
        },
      });
      return;
    }

    if (method === 'ping') {
      await reply(transport, id, { result: {} });
      return;
    }

    if (method === 'tools/list') {
      await reply(transport, id, {
        result: {
          tools: RSI_MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      });
      return;
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        await reply(transport, id, { error: { code: -32601, message: `Unknown RSI tool: ${name}` } });
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const res = await client.invoke(tool.method, args, params._meta !== undefined ? { _meta: params._meta } : undefined);
        const hasError = isRecord(res) && typeof res.error === 'string';
        await reply(transport, id, {
          result: {
            content: [{ type: 'text', text: JSON.stringify(res) }],
            ...(hasError ? { isError: true } : {}),
          },
        });
      } catch (err) {
        await reply(transport, id, {
          result: {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : 'RSI tool call failed' }],
          },
        });
      }
      return;
    }

    await reply(transport, id, { error: { code: -32601, message: `Method not found: ${method}` } });
  }

  return {
    async connect(transport: McpTransport): Promise<void> {
      closed = false;
      activeTransport = transport;
      transport.onmessage = (message: unknown) => {
        void handleMessage(transport, message).catch((err) => {
          transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
        });
      };
      if (typeof transport.start === 'function') await transport.start();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const t = activeTransport;
      activeTransport = undefined;
      if (t && typeof t.close === 'function') await t.close();
    },
  };
}
