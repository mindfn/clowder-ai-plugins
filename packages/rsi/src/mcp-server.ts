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
      '第 3 步调用 rsi_task 后登记本机执行方式，必填 preflight / submit / collect，选填 get / cancel / analyze / resultMap / failureField / timeout / poll。带 commit 的版本在独立 git worktree（cwd）运行，建议使用相对路径并传 {config}/{run}/{seed}；同步前台 submit 省略 get（get 仅用于异步作业轮询），analyze 仅用于失败诊断。提交后立即触发 preflight 预检。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'submit', 'collect'],
      properties: {
        preflight: { type: 'string', minLength: 1, description: '预检命令。' },
        submit: { type: 'string', minLength: 1, description: '执行命令，支持占位符 {config}、{run}、{seed}。' },
        collect: { type: 'string', minLength: 1, description: '无空格 JSON 路径模板（如 {run}/metrics.json）或输出 JSON 的采集命令。' },
        get: { type: 'string', minLength: 1, description: '仅异步作业轮询用（使用 {job}）；同步前台 submit 请省略。' },
        cancel: { type: 'string', minLength: 1, description: '超时/失败/停止时的清理命令（支持 {job} 或 {run}）。' },
        analyze: { type: 'string', minLength: 1, description: '仅失败后调用的错误诊断命令（输出短文本，勿填 collect）。' },
        failureField: { type: 'string', minLength: 1, description: '可选 JSON 失败字段路径。' },
        timeout: { type: 'integer', minimum: 1, description: '单次运行超时秒数。' },
        poll: { type: 'integer', minimum: 1, description: '异步轮询间隔秒数。' },
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
        tier: { type: 'string', enum: ['explore', 'confirm'], description: '可选本轮验证档位：explore（快筛，不直接晋级）或 confirm（正式确认，强保留对照与满血确认种子数）；会透传进 config.json。' },
        seeds: { type: 'integer', minimum: 1, maximum: 20, description: '可选覆盖本轮种子/样本批次数（1–20）；进入确认轮自动恢复完整确认种子数。' },
        reservedSeeds: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 20, description: '仅当 tier="explore" 时可用：可选登记单次运行内部额外消耗的种子号（仅填附加种子，不得内部重复、不得与历史种子或本轮自动分配种子重叠）；下一周期自动分配新种子时一并避开。' },
        skipControl: { type: 'boolean', description: '仅当 tier="explore" 时可用：跳过外层重复 control 组（如 run 内置配对或复用冻结基线），不直接晋级默认版本。' },
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
  {
    name: 'rsi_status',
    method: 'rsi.status',
    description:
      '纯只读查询评估项的真实状态与数据（零副作用、不受回合轮次限制）。在评估项线程内传 {} 查当前评估项；跨线程可传 { objectiveId, cycle? }，不传 objectiveId 则列出当前 owner 下全部真实评估项。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectiveId: { type: 'string', minLength: 1, description: '可选评估项 ID（跨线程查询时传入）。' },
        cycle: { type: 'integer', minimum: 1, description: '可选查看指定周期号的运行/结论详情；省略则返回最新周期。' },
      },
    },
  },
  {
    name: 'rsi_operate',
    method: 'rsi.operate',
    description:
      '受托管理操作工具：仅当评估项的委托负责人（policy.manager）被主人指定为当前成员时可用。支持代为采纳方向（expDecide）、确认准备项（prepConfirm）、重做步骤（initStepRefresh/initRetry）、切换步骤成员（stepMember）、暂停/恢复/开始/重试（life）、手动跑一轮（runCycle）以及重新触发阶段（evalAgain/discussAgain/versionAgain）；不可修改委托负责人或停机/删除策略。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['op'],
      properties: {
        op: {
          type: 'string',
          enum: ['expDecide', 'prepConfirm', 'initStepRefresh', 'initRetry', 'stepMember', 'life', 'runCycle', 'evalAgain', 'discussAgain', 'versionAgain'],
          description: '要执行的受托管理操作。',
        },
        objectiveId: { type: 'string', minLength: 1, description: '可选评估项 ID（跨线程代操作时传入）。' },
        n: { type: 'integer', minimum: 1, description: '周期号（expDecide 必填，evalAgain 可选）。' },
        pick: { type: 'string', enum: ['direction', 'same', 'info', 'addVar', 'metric', 'goal'], description: 'expDecide 的决策类型。' },
        directionId: { type: 'string', minLength: 1, description: 'expDecide pick="direction" 时的方向 ID。' },
        note: { type: 'string', description: 'expDecide 的说明（info/addVar/metric/goal 必填）。' },
        itemId: { type: 'string', minLength: 1, description: 'prepConfirm 确认单个待确认条目 ID。' },
        section: { type: 'string', minLength: 1, description: 'prepConfirm 批量确认某步全部待确认项，或作为步骤编号/名称。' },
        k: { type: 'string', minLength: 1, description: 'initStepRefresh / initRetry / stepMember 的步骤名或编号（1–7 / goal/scope/run/rules/design/feedback/baseline）。' },
        catId: { type: 'string', minLength: 1, description: 'stepMember 要切换的目标成员 catId。' },
        action: { type: 'string', enum: ['start', 'pause', 'resume', 'retry'], description: 'life 生命周期动作。' },
        force: { type: 'boolean', description: 'initRetry 强制重新叫醒。' },
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
