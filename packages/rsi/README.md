# RSI · 0.1.0-alpha.4

为项目创建评估项，成员完成初始化，插件在本机串行运行实验；评估成员交结论，你选方向，准备成员交新版本，再跑下一周期。演示项目保留原有数据和交互，不启动线程、成员或训练进程。

## 使用

1. 在宿主中启用插件，打开「RSI 能力进化」，新建评估项。项目默认「当前对话的项目」，也可选择宿主已有对话的项目目录或演示项目。准备成员默认 `codex`，评估成员默认 `cat-b5ddoo9l`（@kimi），仍可在对话框更换。
2. 真实项目会创建 `RSI · <目标>` 对话，加入两位成员并打开。成员被精确唤醒后先调 `rsi.task`，调查项目后用 `rsi.submit` 提交自己的步骤。步骤 3 登记并预检执行方式，步骤 4 提交量尺，步骤 5 提交组 × 种子计划。页面中的人工确认项仍需你确认。
3. 初始化就绪后点「开始评估」或「跑一轮」。运行记录包含组、种子、状态、耗时、配置、日志及各项实测指标。点「刷新进度」读取后台进展；当前宿主的 PDL 请求机制没有轮询或插件主动失效通知。
4. 全部运行完成后插件唤醒评估成员。成员调 `rsi.task` 查看本周期计划和真实指标，再调 `rsi.conclude`。结论以普通富卡片发到对话，也出现在页面的评估/方向区域。
5. 在页面选择方向或提交意见。插件叫醒准备成员，成员先调 `rsi.task`，修改项目并提交 git，再调 `rsi.version({change,commit,config})`。下一次「跑一轮」包含上一版本对照和新版本，沿用种子。

成员通过宿主通用的 `plugin_list_tools` / `plugin_call` 使用 `rsi.task`、`rsi.submit`、`rsi.executor`、`rsi.version`、`rsi.conclude`；每个工具的 manifest 描述包含字段、例子和下一步。工具只接受宿主提供的 `catId/threadId/userId/invocationId/assertCurrent`，按对话解析评估项、检查轮次和成员，不接受输入里冒充身份。

## 执行方式

第 3 步先调 `rsi.task`，登记命令，例如：

```json
{
  "preflight": "test -x .venv/bin/python && test -f train.py",
  "submit": ".venv/bin/python train.py --config {config} --out {run} --seed {seed}",
  "collect": "{run}/metrics.json"
}
```

`preflight` 立刻在项目目录运行；工具立即返回 `probing`，不等待长进程。预检通过且第 3 步的 items 已提交才完成该步。可以先交 items，再登记执行器；也可将同样的命令字段放在 `rsi.submit.executor`。失败会留在页面，点初始化「重试」后重新 task/executor。

`submit` 必须在前台运行到训练结束。每个插件实例同时最多运行一个子进程任务，训练依组和种子串行进行。模板替换会做 shell 引号处理，不要再给占位符加引号：

- `{config}`：本次运行的 `config.json`；版本的 config 合并组 vars，再写入 seed。
- `{run}`：项目内 `runs/<objective>/<cycle>/<group>-s<seed>` 的绝对目录。
- `{seed}`：本次种子整数。

`collect` 可为不含空格的 JSON 路径模板，或输出 JSON 的命令（例如 `cat {run}/metrics.json`）。默认从顶层或 `metrics` 对象按量尺 id 读取有限数值；嵌套字段可登记 `resultMap: [{metric:"score",field:"summary.score"}]`。量尺声明的指标都必须出现，否则本次运行失败。submit/collect 失败会自动重试一次，再失败则保留错误和失败卡，并将失败记录交给评估成员。

执行器也保存 `get/cancel/analyze` 模板；本阶段不自动调用它们。停止插件会杀死自有进程组；重启不会接管旧训练，原运行和排队项变为失败、可重试，点「跑一轮」继续该周期。初始化成员被取消、失败或结束但未交内容时，会显示中断、失败或缺少提交，页面可重试。

第 5 步的 `upcoming` 示例：

```json
{
  "groups": [
    {"id":"control","label":"对照","vars":{"lr":0.003},"control":true},
    {"id":"change","label":"降低学习率","vars":{"lr":0.001}}
  ],
  "seeds": [11,23]
}
```

`rsi.version.config` 是 JSON 对象或项目内 JSON 文件路径，`commit` 是准备成员实际提交的 git SHA。插件记录版本和配置，不切换项目 checkout；代码不同的对照需由训练命令或配置选择代码变体。尚未走查真实宿主中的模型训练，其他边界见 [GAPS.md](GAPS.md)。

## HTTP 与持久化

保留 `rsi.view` / `rsi.act` 及 `rsi/view` GET、`rsi/act` POST webhooks。输入为 `input.request = {method,query,body}`，输出 HTTP JSON，禁止缓存。HTTP 要求当前插件实例的 owner 上下文；所有状态写入使用 `rsi:<base64url(userId)>` 的同一 storage CAS，冲突返回 409，不投递失败写入的 outbox。工具使用相同 owner key/CAS；后台进程和投递确认只重试内部 CAS。

读 `query.view` 支持 `home/objective/exp/record/policy/todo/newExp/caps/cards/library/doc`。页面选择参数为 `project/pick/tab/selO/selE/selC/list`；`thread` 可解析既有评估项对话。record 使用 `objective/cycle/type/id`，doc 使用 `id`，cards 可用 `objective` 过滤。home 的项目来自完整分页的 `threads.list()`，按 `projectRef` 去重后附加演示项目。

写仍使用既有 `op`，包括 `new/newExp/life/prep/initRedo/initRetry/expDecide/decide/reeval/lock/addMetric/policy/docAdd/docConfirm/docRemove/renameGroup/go/goVersion`，新增 `runCycle`、`refresh`。写请求带同一页面选择，或直接传 `objective`。`life`、`prep` 的子操作放 `body.action`。新建写传 `project/thread/statement/prepare/evaluate/target/stall/rounds/cats`；`project:""` 用 `threads.get(thread).projectRef` 解析。真实新建返回 `{ok:true,act:"thread",args:{id}}`。

outbox 的消息 ID 同时作为宿主 `idempotencyKey`。线程绑定、投递确认和执行回报都持久化；启动时重新订阅全部真实评估项线程，并继续未投递 outbox。v2 `started.replyTo` 关联派发消息，再用 `executionId` 关联 settled；无需从展示名猜成员，也不依赖私有生命周期 ID 算法。

初始化继续使用 `src/init.ts` 的 `submitInitStep/recordInitExecution/bindObjectiveThread`。工具检查 task 的认领和依赖版本；依赖修改后提交被拒绝，再 task 会取得新执行和当前依据。用户确认项和现有 demo VM 形状保留。

## 验证

```sh
pnpm --filter @clowder-ai/rsi typecheck
pnpm --filter @clowder-ai/rsi test
```

测试保留原型 VM 对照、初始化依赖/过期/重试、owner 隔离和 CAS 检查；新增宿主桩和真实本地子进程集成，走三周期（各 2 组 × 2 种子）、结论/决策/版本、自动重试、预检失败、嵌套指标收集、执行事件竞态、停止与重启恢复。测试项目使用临时目录，演示 fixtures 没有真实目录或个人姓名。
