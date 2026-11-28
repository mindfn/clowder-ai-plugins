# RSI

RSI 为一个真实项目建立可追溯的评估循环：按同周期对照运行实验，由不同成员准备、判断和执行方向；改动先成为候选，再用新重复确认后才采用。插件管流程、调度和记录，项目成员决定命令里实际做什么。

## 成员

- **初始化**：调查项目并完成七步初始化，登记执行器、量尺和首轮计划。
- **评估**：读取同周期对照、逐次结果和历史资料，提交结论与方向。
- **治理执行**：按选中的方向提交版本；夜间运行失败时负责修好执行问题并让原计划重跑。
- **方案讨论**：可选、多位。每人独立提交带署名的方向；插件并列展示，并判断第一方向是否一致。

评估项建好后，三个单人角色都能更换，正在等待的工作会转给新成员；方案讨论成员用标签后的 `+` 添加、`×` 移出。

## 建立评估项

新建时确定：

1. 项目和要改善的目标；
2. 三个单人角色及可选的方案讨论成员；
3. 达到什么数值目标就停（可留空，之后也可设置周期上限）；
4. 每晚最多自动修几次运行失败，默认 5，`0` 表示关闭；
5. 夜里可自动采纳哪些方向：执行修复和调变量（默认）、仅执行修复，或全部等人决定。

之后成员通过 `rsi.task` 认领七步初始化，并用 `rsi.submit` 提交事实。初始化会确认范围、目标、执行方式与运行时段、量尺、实验计划、反馈和首轮基线；用户拥有的条目仍在页面确认。

第 4 步的第一个非护栏指标是主指标。它可以选择一种判断口径：

- `minDelta`：至少比同周期对照改善这么多才算赢；
- `margin`：不比同周期对照差超过这么多就算过（非劣效）。

两者都是非负数，不能同时设置。`dir:"up"` 时 `margin` 允许结果最低到 `control - margin`；`dir:"down"` 时允许最高到 `control + margin`。护栏指标用 `guard:true` 和数值 `threshold`，任一次越线都不能成为候选。

## 夜间循环

开始评估后，调度只在已确认的本地运行时段内启动周期。每个计划按组 × 重复串行运行；同一重复用于各组，之后周期换新重复。几个评估项同时可以开周期时轮流来：最久没开过周期的先开，开不了的让给下一个；运行按周期开始的先后排队。首次通过口径且护栏合格的版本成为候选，默认版本不变；下一周期以新重复复验，仍通过才采用。

夜间按声明自动推进：

- **出错自动修**：环境失败先自动重试一次；仍失败时运行 `analyze` 抽取错误特征并交给治理执行成员。修复版本直接成为默认，原计划重跑。次数用完、同一错误第 3 次、成员回复修不了或 60 分钟未修好时，转给评估成员。
- **按规则采纳**：结论的第一方向属于允许类别时，插件直接采纳；有一位方案讨论成员时看其首选，多位时首选必须一致，没有时看评估成员的首选。启用任一自动类别时，候选直接复验；其他情况等人在页面决定。
- **到点照旧**：结论等待决定超过 30 分钟，就沿当前计划换新重复继续；有候选时继续复验。
- **交还机器**：调度启动的运行在时段结束时停止或取消，留在队列中下一晚继续；页面手动“跑一轮”不受时段限制。
- **夜间总结**：运行窗口结束后的第一次调度检查会按记录发送一张总结卡，列出周期、结论、自动决定、修复和仍待处理的事项。

评估成员用 `rsi.conclude` 提交结论；方案讨论成员用 `rsi.propose` 提交方向；治理执行成员先读 `rsi.task.version`，再用 `rsi.version({change,commit?,config})` 登记版本。代码改动必须给真实 git commit；纯配置版本可以省略。执行修复版本不参与 A/B，对照条件和变量沿用当前默认版本。

## 执行器

初始化第 3 步由初始化成员调用 `rsi.executor`。命令使用 Host 系统 shell（macOS/Linux 为 `sh`，Windows 为 `cmd`）；占位符由插件按该 shell 引号处理，命令中不要再自行加引号。

| 字段 | 必填 | 含义 |
|---|---:|---|
| `preflight` | 是 | 登记时和每次运行前检查环境；登记时可输出 `{python,driver,dataVersion}` JSON。 |
| `submit` | 是 | 启动本地任务；异步模式下 stdout 返回 job id 或 `{"jobId":"..."}`。 |
| `collect` | 是 | 无空格的 JSON 文件路径模板，或输出 JSON 的命令；从顶层或 `metrics` 对象读取量尺。 |
| `get` | 否 | 查询异步任务，输出 `{"state":"queued|running|done|failed|cancelled","exitCode":0,"reason":"..."}`。 |
| `cancel` | 否 | 停止、超时或最终失败时清理异步任务。 |
| `analyze` | 否 | 最终环境失败后抽取错误特征，供自动修复与重复错误判断。 |
| `timeout` | 否 | 秒数；限制前台 `submit`，也限制异步任务从提交到完成的总时长。未填时按最长成功运行的 3 倍、至少 10 分钟推导；尚无成功运行时不限。 |
| `poll` | 否 | 异步 `get` 的查询间隔秒数，默认 1。 |
| `failureField` | 否 | collect JSON 中表示实际失败的字段；非空时保留为结果，不按环境失败重试。 |
| `resultMap` | 否 | `[{metric,field}]`，把嵌套结果字段映射到量尺 id。 |

运行命令可用这些占位符：

| 占位符 | 值 |
|---|---|
| `{config}` | 插件生成的 JSON 配置文件；依次合并版本 config、已确认变量、组 vars 和重复值。 |
| `{run}` | `runs/<objective>/<cycle>/<group>-s<repeat>` 的绝对目录。 |
| `{seed}` | 当前重复的整数标识；即使项目本身固定随机种子，也可把它当作重复编号。 |
| `{job}` | 异步 submit 返回的原始 job id。 |
| `{start}` | 本次尝试开始的 epoch 秒；恢复既有 job 时沿用原开始时间。 |
| `{end}` | submit/get 结束的 epoch 秒，仅供 `collect` 和 `analyze` 切取本次日志。 |

示例：

```json
{
  "preflight": "python3 -c 'import json; print(json.dumps({\"driver\":\"local\"}))'",
  "submit": "python3 train.py --config {config} --out {run} --repeat {seed}",
  "collect": "{run}/metrics.json",
  "analyze": "python3 first_error.py --from {start} --to {end}",
  "timeout": 1800,
  "failureField": "failed",
  "resultMap": [{"metric":"score","field":"summary.score"}]
}
```

不带 `get` 时 submit 在前台运行；带 `get` 时插件按 `poll` 查询，到 `done` 后 collect。非零退出、OOM、被杀和命令失败属于环境失败，自动重试一次；NaN、缺失量尺或 `failureField` 指定的失败属于实际结果，不重试。每次尝试写独立运行目录，旧尝试保留为 `.attempt-N`；状态只保留日志尾部，完整日志在运行目录的 `rsi.log`。

## 验证

```sh
cd packages/rsi
npm test
```

未完成范围和实机走查记录见 [GAPS.md](GAPS.md)，夜间连续推进的设计见 [PHASE3.md](PHASE3.md)。


### alpha.138: hypotheses and experiment tiers

Hypotheses are persisted on the objective shard. Analysis directions (`code`, `variable`, `discriminate`) enter automatically by provenance; owner Console and delegated `rsi_operate(op="hypothesis")` support creation, editing and archiving. Status is projected from associated evidence, with environment failures distinct from negative findings.

Step 5 accepts an experiment specification (`tiers`, optional `scenarios`). `progress()` applies tier requirements and prerequisite evidence to both manual and scheduled starts. Cycles freeze their tier rules and associations; old records remain unlinked. The default is the unchanged explore/confirm behavior. See `skills/rsi/SKILL.md` for the complete schema and same-version tier advancement workflow. Parallel cycles and the validation matrix remain out of this release.
