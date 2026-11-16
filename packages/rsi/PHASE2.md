# RSI 插件第二阶段：真的跑起来（对齐稿，2026-11-15）

目标：在 develop_base 里装上插件，用一个真实小项目（`rsi-demo-arith`：Qwen2.5-0.5B 上做算术题 RL）从新建评估项走到第二个周期。砚砚（`codex`）负责初始化，小狸（`kimi`，`cat-b5ddoo9l`）负责评估。

## 宿主现在给的（已核对代码）

| 要做的 | 用什么 |
|---|---|
| 建评估项 thread | `host.threads.create({ title, projectRef: 项目目录, participants })` |
| 发卡片、@ 成员并叫醒 | `host.messaging.send({ threadId, payload, wake: { catId, exact: true } })`；只在文字里写 @ 叫不醒 |
| 成员调用插件 | manifest 的 `tool` 贡献，成员用通用的 `plugin_list_tools` / `plugin_call` 调；插件拿到 `catId / threadId / invocationId` |
| 知道成员停了 / 被打断 | `message-subscription` + `messaging.subscribe(threadId)`，收 `execution_status`（started / settled: completed·failed·cancelled） |
| 跑训练 | 插件自己起子进程（10–20 分钟）；插件负责记录和 `stop` 时清理 |
| 定时 | 先不用：测试时页面上点「跑一轮」；以后用 `schedule` 贡献 |

## 插件给成员的工具（`tool` 贡献，5 个）

1. **`rsi.task`**：我现在该做什么。按调用者的 `threadId`、`catId` 返回：评估项、轮到我的步骤（第几步、要填哪些项、每项的格式和例子、依据的前面步骤和版本）、项目目录。成员被 @ 后第一件事就是调它。
2. **`rsi.submit`**：提交一步。`{ step, items: [{ id, value, facts?, can?, rec?, tag? }], unknowns, next }`，第 3 步多带执行方式，第 4 步多带量尺，第 5 步多带第一轮计划。插件检查依据的版本没变，记下来，接着 @ 依赖已齐的下一步。
3. **`rsi.executor`**：登记执行方式。六个操作写成命令模板，比如 `submit = .venv/bin/python train.py --config {config} --out {run}`、`collect = 读 {run}/metrics.json`。插件立刻试跑 preflight，通过后第 3 步才算完成。
4. **`rsi.version`**：交一个新版本（第二轮起）。`{ change: 改了什么, commit, config }`，由准备成员在项目里改完代码或配置、提交 git 后调用。
5. **`rsi.conclude`**：交本周期结论（评估成员）。`{ cycle, verdict, findings, options: [{ k, title, why }] }`；插件把它做成结论卡发进 thread，你在页面上选方向。

## 一个周期怎么走

1. 你点「开始评估」（测试时是「跑一轮」）。插件按第 5 步的计划，对每组配置 × 种子起 `submit`，在页面「运行」里逐条显示，结束后 `collect` 出指标。
2. 全部跑完，插件 @ 小狸：「第 N 周期跑完了，指标在 rsi.task 里」。小狸读指标，和同轮对照比，调 `rsi.conclude`。
3. 结论卡出现在 thread 和页面。你选一个方向（调方向 / 改指标 / 改实现 / 加变量），或写意见。
4. 插件 @ 砚砚：「按『xxx』出下一个版本」。砚砚改项目、提交 git、调 `rsi.version`，下一周期就用这个版本。

失败：子进程非零退出或 OOM，自动重试一次，仍失败就发失败卡。成员被打断（settled: cancelled）：这一步标「中断」，页面给「重试」（第一阶段已经有）。

## 页面上的变化（尽量少）

- 项目：用宿主已有的项目，也就是你有对话的那些项目目录（插件用 `threads.list` 读每个 thread 的项目，按目录去重）。演示数据的项目留着，排在后面。
- 新建评估项：多一个「项目」下拉，第一项是「当前对话的项目」（默认），其余是上面那些项目。打开对话框时把当前 thread 的 id 带上，提交时插件用 `threads.get` 查它的项目。
- 「运行」：显示真实的每次运行（组、种子、状态、耗时、指标）。
- 头部多一个「跑一轮」（测试用）。

## 已定（2026-11-15 lang）

- 项目复用宿主已有的项目列表，默认当前 thread 的项目。
- 演示数据留着（不影响真实项目）。
- 走查至少 3 个周期；每周期 2 组（对照 + 一个改动）× 2 个种子。
