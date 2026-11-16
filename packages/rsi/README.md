# RSI · 0.1.0-alpha.7

为项目创建评估项，成员完成初始化，插件按已确认的时段运行实验；评估成员交结论，你选方向，准备成员交版本。每周期包含当前默认版对照，改动先成为候选，下周期用新种子确认后才采用。演示项目保留原有数据和交互。

## 使用

1. 打开「RSI 能力进化」，新建评估项。选择项目、准备/评估成员，以及可组合的停止条件：目标、连续几个周期没进步、最多几个周期。留空就不设置这条。
2. 真实项目创建评估项对话并精确唤醒成员。成员先调用 `rsi.task`，按七步调查项目，用 `rsi.submit` 交内容。第 3 步登记执行器并提交 `window:"每晚 20:00–08:00"`；也可在 `cp-trigger` 条目的 value 中写明时段。第 4 步交指标与护栏阈值，第 5 步交组和种子计划。人工确认仍在页面完成。
3. 初始化就绪后点「开始评估」启用时段触发；`rsi.schedule` 每 3 分钟检查一次，按宿主机器本地时间处理跨午夜窗口。评估项正在运行、执行器空闲、上一周期已决定且没有等待新版本时才启动。也可保留手动「跑一轮」，不受时段限制。点「刷新进度」读取后台状态。
4. 全部运行结束后，评估成员从 `rsi.task.evaluate` 读取本周期的 `comparison`、原始 `runs` 和以前周期的 `library`，提交 `rsi.conclude`。结论卡与页面都显示结果。比较仅使用本周期的 `control`；每组同时提供均值、样本标准差和逐种子值。区间是 **均值 ± 样本标准差**，不是置信区间；只有一个有效种子时标准差/上下界为 null。
5. 首次胜出的组记为候选，默认版本保持不变。你作出决定后，下周期将候选和当前对照一起换新种子复验。保持改善且护栏通过才成为默认，版本记录保存确认周期和区间。复验真实失败就保留原默认；环境失败导致证据不足则保留候选再测。候选确认优先于新改动。
6. 其他方向会叫醒准备成员。先 `rsi.task` 读要求，再交 `rsi.version({change,commit?,config})`。`commit` 是真实的 7–40 位 git SHA，改代码时必须提供；纯配置版本可省略。提交版本本身不会改变默认版。选「照旧」可直接继续当前默认，无需生成版本。

每次结论后检查停止条件。目标使用 `指标 id 或完整名称 ≥ 数字`（也支持 `<=`、`>=`、`≤`、`<`、`>`），例如 `score >= 0.9`；按本周期默认对照或刚确认的版本判断，候选的首次胜出不会单独满足目标。目标/最多周期达到后为 `done`；停滞达到后为 `paused`，推送原因卡，手动与定时均停止启动新周期。停滞按同周期改善计数，环境失败不计为停滞；暂停后可明确恢复。无数值比较式的文字目标保留在目标卡中，不自动猜测。

每个结论周期写入资料库：试过的方向、结果和周期引用。评估成员的 `options:[{k,title,why,cites:[libraryId]}]` 在已有历史时必须引用至少一个历史周期条目；结论保留引用与评估成员署名。

## 执行方式

第 3 步先调 `rsi.task`，登记命令，例如：

```json
{
  "preflight": "python3 -c 'import json,platform; print(json.dumps({\"python\":platform.python_version()}))'",
  "submit": "python3 train.py --config {config} --out {run} --seed {seed}",
  "collect": "{run}/metrics.json",
  "failureField": "failed"
}
```

注册立即返回 `probing`；预检通过且第 3 步 items 已提交才完成。每个 run 还会在选定代码目录重新 preflight。可以先交 items，再登记执行器，也可把命令放在 `rsi.submit.executor`。失败可在页面重试。

带 commit 的版本使用插件 `dataPath/worktrees/` 下独立、可复用的 detached git worktree；配置文件路径相对该 worktree 读取，所有执行命令也在其中运行。初始版本在执行器预检通过时冻结项目的 HEAD（如果项目有 git 提交），因此项目之后提交新代码不会改掉基线。没有 commit 的配置版本继续在项目目录运行。代码 worktree 在评估项完成/退役时移除；运行目录、指标和记录保留。执行器需自行提供可在 worktree 使用的 Python/依赖；未跟踪的 `.venv` 不会复制进去。

模板占位符由插件做 shell 引号处理，不要再包引号：

- `{config}`：生成的 JSON 文件；版本 config、已确认变量、组 vars、seed 依次合并。
- `{run}`：项目内 `runs/<objective>/<cycle>/<group>-s<seed>` 的绝对目录。
- `{seed}`：种子整数。周期内各组相同，之后周期使用未运行过的新种子。
- `{job}`：异步执行器返回的原始 job id。

`collect` 可为无空格的 JSON 路径模板，或输出 JSON 的命令（如 `cat {run}/metrics.json`）。按量尺 id 从顶层或 `metrics` 对象取值；嵌套字段可用 `resultMap:[{metric:"score",field:"summary.score"}]`。每个 run 保存实际 commit、配置 SHA-256、seed、OS/arch/chip；preflight 可输出 JSON `{python,driver,dataVersion}`，collect 可报告顶层 `dataVersion`。缺少报告的 Python/驱动/数据版本不凭空填充。

护栏在第 4 步 metrics 中声明，例如：

```json
{"version":"E1","items":[
  {"id":"score","name":"Score","how":"metrics.score","dir":"up"},
  {"id":"cost","name":"Cost","how":"metrics.cost","dir":"down","guard":true,"threshold":2}
]}
```

第一个非护栏指标决定改善方向；不合成总分。护栏自动锁定，必须有有限数值 threshold，`down` 要求每个种子不超过阈值，`up` 要求不低于阈值。任一种子越线，该组不能成为赢家；结论输入列出每项检查。

非零退出、OOM、被杀、提交/轮询/收集过程失败是环境失败：自动重试一次，保留 attempts，仍失败发卡并继续其他组；不计入统计证据。运行结束后输出 NaN（裸 NaN 或字符串）、缺失指标、或 `failureField` 指定的非空失败字段，是实际结果：保留为 done、`error.kind:"real"`，不重试，也不能获胜。

不带 `get` 的 submit 持续在前台运行；每个插件实例串行执行。声明 `get` 后，submit stdout 返回 job id 字符串或 `{"jobId":"..."}`。插件每秒调用 get，要求输出 JSON `{"state":"queued|running|done|failed|cancelled","exitCode":0,"reason":"..."}`；done 且退出码为零/未设置时 collect，其余终态按环境失败处理。可选 `cancel` 在停止时接收同一 `{job}`。无 cancel 时保存 job id，重启后继续 get，不重复 submit。前台运行重启后标中断，手动「跑一轮」续跑。`analyze` 模板仍只保存，未自动调用。

## HTTP 与持久化

保留 `rsi.view` / `rsi.act` 及 `rsi/view` GET、`rsi/act` POST webhooks。输入为 `input.request = {method,query,body}`，输出 HTTP JSON，禁止缓存。HTTP 要求当前插件实例的 owner 上下文；所有状态写入使用 `rsi:<base64url(userId)>` 的同一 storage CAS，冲突返回 409，不投递失败写入的 outbox。工具使用相同 owner key/CAS；后台进程和投递确认只重试内部 CAS。

读 `query.view` 支持 `home/objective/exp/record/policy/todo/newExp/caps/cards/library/doc`。页面选择参数为 `project/pick/tab/selO/selE/selC/list`；`thread` 可解析既有评估项对话。record 使用 `objective/cycle/type/id`，doc 使用 `id`，cards 可用 `objective` 过滤。home 的项目来自完整分页的 `threads.list()`，按 `projectRef` 去重后附加演示项目。

写仍使用既有 `op`，包括 `new/newExp/life/prep/initRedo/initRetry/expDecide/decide/reeval/lock/addMetric/policy/docAdd/docConfirm/docRemove/renameGroup/go/goVersion`，新增 `runCycle`、`refresh`。写请求带同一页面选择，或直接传 `objective`。`life`、`prep` 的子操作放 `body.action`。新建写传 `project/thread/statement/prepare/evaluate/target/stall/rounds/cats`；`project:""` 用 `threads.get(thread).projectRef` 解析。真实新建返回 `{ok:true,act:"thread",args:{id}}`。

outbox 的消息 ID 同时作为宿主 `idempotencyKey`。线程绑定、投递确认和执行回报都持久化；启动时重新订阅全部真实评估项线程，并继续未投递 outbox。v2 `started.replyTo` 关联派发消息，再用 `executionId` 关联 settled；无需从展示名猜成员，也不依赖私有生命周期 ID 算法。

初始化继续使用 `src/init.ts` 的 `submitInitStep/recordInitExecution/bindObjectiveThread`。工具检查 task 的认领和依赖版本；依赖修改后提交被拒绝，再 task 会取得新执行和当前依据。用户确认项和现有 demo VM 形状保留。

## 验证

从仓库根目录运行：

```sh
pnpm --filter @clowder-ai/rsi typecheck
pnpm --filter @clowder-ai/rsi test
```

测试保留原型 VM 对照、初始化依赖/过期/重试、owner 隔离、CAS 与 outbox 检查。运行集成使用真实 Node/Python/sh 子进程：三周期、同周期对照、候选成功/拒绝/环境失败后再确认、阈值护栏、NaN/声明失败、环境指纹、目标/停滞/预算停止、假时钟窗口调度、异步 get/cancel/重启，以及有两次提交的临时 git 仓库验证代码隔离/复用/清理。未修改已通过隐私检查的演示 fixtures。宿主实机模型训练与其余 FLOW 边界见 [GAPS.md](GAPS.md)。
