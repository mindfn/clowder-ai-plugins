# 目录安装发布清单 — 飞书 / video-generation 条件配置修复

日期：2026-10-21 · 作者：小狸（kimi/k3）· 复核：astra（gpt-6-astra）· 状态：**源码 PR 准备就绪，顺序已澄清，无需再决策**

代码 HEAD（astra R6 已复审放行）：

- 插件仓：`d473149570dc50e3298c05e6bc3876ec6686c1d6`（feat/configuration-variants）
- Host 仓：`dcc267bdf86a8077c6d5de1aad127cc59b05069b`

## 〇、已澄清的发布顺序（operator 2026-10-21 拍板，astra R7 复述确认）

1. Host fork 合入（sol 的组合修复 + review 通过后）
2. lang 重启本地 Host 实例
3. **插件源码 PR 合入上游（插件源码只合这一次）** — `catalog/candidate.json` 条目随本 PR 一起入库
4. CI 自动发布 npm 制品（plugins 上游 `contract-ci.yml` 的 publish job）
5. 独立 catalog PR：发布成功后 `catalog:activate` 核验已发布制品并提升 live catalog
6. 从插件目录安装验收（此时目录才有新版条目；Host 目录 URL 硬编码指向上游 main 的 catalog.json，无覆盖，已核实）

## 一、待发布制品（npm 上均尚不存在，已用 `npm view` 核实）

全部用正式打包脚本 `node scripts/pack-publish-artifact.mjs <sourceDir> <outDir>` 打出，且全部使用 **CI 固定工具链**（Node 24.18.0 / npm 11.16.0，与上游 `contract-ci.yml` 的 `ARTIFACT_NODE_VERSION` / `NPM_VERSION` 一致；本机默认 shell 是 Node 24.15.0 / npm 11.12.1，用它打包会产生字节级哈希漂移，已实证）。该脚本将 gzip OS 字节规范化为 Ubuntu 发布机值，同工具链下输出跨机器确定；下表哈希即 CI 发布值（astra 用同一脚本重打验证通过）。

| 包 | 新版本 | 字节 | sha512 integrity | sha1 shasum |
|---|---|---|---|---|
| `@clowder-ai/connector-feishu` | 0.1.0-alpha.6 | 86606 | `sha512-1aMJ5GwW9PzmR0pj4kuAUf5NbE0Wq8Ca/DnkDX+iWitaf2AKB4esX1u3cl02/B8GBizt9GO+vm+H96gLOsL3fA==` | `6a01b9e30cb86fdb4c73a25fd0e8e03e19785dfc` |
| `@clowder-ai/video-generation` | 0.1.0-alpha.2 | 47195 | `sha512-/xbqkgYvby+8zPLJT2IGXN1ANgl9TnWd4G5MXo1hGM14sWRWwrGS0UB0EDhugu6GGx7MuxntZBFOqFGPMRT3kA==` | `6cb3b7a51bc91a4f05a1fc32d21c9c7f3f3c6ada` |
| `@clowder-ai/plugin-sdk` | 0.2.0-beta.22 | 88833 | `sha512-5REqBhJbwJ3iLSRgfLufV7y48RpKv1h2Rc9KfkGjx0bv9mvyqw/X44Bik7L0vqwS/5u45U+MFoHlWxbn/Re1DQ==` | `ffac91a777736b4370643fad7bfabef71463a956` |
| `@clowder-ai/plugin-contract` | 0.2.0 | 233868 | `sha512-iFhuTFs/ol09W3n5iF583LuFaLGBQ8nBkdaGrntILSf6Zk40ghKU+lFw1uo97z/NUddoZLDp6x+rkGlHsPYbJg==` | `cadacf79b6dbef0a83c1580978479b079774964b` |

本地 tgz 源（CI 工具链 + 正式脚本产物，验收环境将用同一字节安装）：

- `/tmp/ci-packs-final/clowder-ai-connector-feishu-0.1.0-alpha.6.tgz`（含更新后的 npm-shrinkwrap）
- `/tmp/ci-packs/clowder-ai-video-generation-0.1.0-alpha.2.tgz`
- `/tmp/ci-packs/clowder-ai-plugin-sdk-0.2.0-beta.22.tgz`
- contract 0.2.0 制品同时作为 fixture 提交在 `packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz`（`artifact-consistency.test.ts` 逐字节守护）

plugin-sdk / plugin-contract 是库，不进 catalog（catalog 只列 17 个插件）；但它们是飞书 alpha.6 的运行时依赖，必须随源码 PR 的 CI 一并发布。

## 二、依赖链（CI publish job 会随上游 main 一并发）

- `@clowder-ai/connector-feishu@0.1.0-alpha.6` → `@clowder-ai/plugin-sdk@0.2.0-beta.22` → `@clowder-ai/plugin-contract@0.2.0`
- `@clowder-ai/video-generation@0.1.0-alpha.2` → 无 clowder 运行时依赖
- `plugin-sdk@0.2.0-beta.22` 与 `plugin-contract@0.2.0` 在 npm 上也尚不存在（已核实）
- 发布通道：plugins 上游 `.github/workflows/contract-ci.yml` 的 `publish` job（push 到 upstream main 触发，provenance id-token）。**本机无 npm 凭据，不能也不应本机发布。**

## 三、candidate 条目（已写入 `catalog/candidate.json`，随源码 PR 入库）

`official.connector.feishu` 与 `dev.clowder.video-generation` 的版本条目已插入各自 `versions` 数组头部（contractVersion `0.2.0`，格式与现有条目一致，通过 contract schema 校验）。写入后 `catalog:check` 对这两个插件的 integrity 逐字节重打包比对**通过**——条目哈希 = 正式脚本重打包哈希 = CI 发布值，无"发布后发现字节不同再换哈希"的中间态。

`catalog:activate` 的职责边界：只核验 npm 上已发布制品与 candidate pins 一致并提升 live catalog；candidate 内容本身随源码 PR 刷新，不留给 activate 时填。

## 四、兼容性事实（修正此前表述）

- 旧 Host 对 contract 0.2.0 的 `configurationVariants` 新契约是**拒绝**，不是"忽略新字段无破坏性"。
- 目录安装时 Host 选择目录中的最高版本，**没有**按 Host 兼容版本自动回退的逻辑。
- 因此：已安装旧插件在旧 Host 上继续可用 ≠ 旧 Host 能安装新插件。新版插件的目录安装验收必须在合入新 Host 能力（dcc267bd）的实例上进行——这正是第〇节把 Host fork 合入 + 重启排在目录验收之前的第二个原因。

## 五、catalog:check 结果（feat 仓 @ d473149 + 本清单改动）— R8 修正后**全绿**

- 飞书 alpha.6、video-generation alpha.2 条目：schema + integrity + 全部闭包检查**通过**（哈希为 CI 工具链最终值，见第一节）。
- R8 前曾出现 11 个 legacy 插件 shrinkwrap 失败 + 15 个历史 pin 漂移，两个根因均已修复（见下节"R8 修正记录"），现在整个 catalog 检查 0 失败。

## 五点五、R8 修正记录（astra 2026-10-21 R8 指令的落地）

1. **撤回 15 个历史 pin 改写。** `catalog/candidate.json` 相对 HEAD 恢复为纯新增：只加飞书 0.1.0-alpha.6 与 video-generation 0.1.0-alpha.2 两个版本条目，其余插件历史 pin 一律不动。正确工具链（Node 24.18.0/npm 11.16.0）下重打包验证：15 个历史 pin 与声明一致（如 dingtalk 与 npm 已发布字节相符），漂移纯属本机默认工具链（24.15.0/11.12.1）造成。
2. **统一依赖兼容校验规则。** 根因是 `catalog-check.mjs` 无条件强制所有插件使用 workspace SDK β22，而 11 个已发布插件合法固定 legacy 组合（SDK β21 / contract β37）。现抽出共享函数 `lastPublishedSdkContractPair` + `assertSdkContractPair`（`scripts/catalog-package-shrinkwrap.mjs`）：workspace SDK 条目走严格闭包；否则必须恰好是 legacy 对（β21/β37）。`catalog-check.mjs` 与测试文件均改调该函数，并新增 3 个测试（未知 SDK 拒 / legacy SDK 配错 contract 拒 / legacy 正确对收），保留错误组合的拒绝测试。`node --test scripts/catalog-package-shrinkwrap.test.mjs` 35/35 通过。
3. **全部制品改用 CI 固定工具链按依赖顺序重打。** contract 0.2.0 → SDK β22 → 更新飞书 `npm-shrinkwrap.json` 两处 integrity（contract→iFhuTF…、SDK→5REqBh…）→ 重打飞书 alpha.6 → candidate 哈希更新为最终值。`packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz` fixture 同步替换为 CI 工具链字节（`artifact-consistency.test.ts` 守护通过）。weixin-mp 的 manifest 测试原本也强制插件依赖等于 workspace SDK β22，与 legacy 固定 β21 矛盾，已改为与共享规则同源的"workspace 版本或冻结 legacy 对"断言。
4. **contract 0.2.0 最终哈希与 Host vendor 不同**（`iFhuTF…` vs vendor 旧值）：已通知 sol，待制品最终确定后由 Host 侧同步 vendor 与锁文件，不在本 PR 范围。

## 六、当前已验证资产（不随本清单改变）

- 隔离验收实例 5112/3112/6388（worktree `cat-cafe-config-variants-host`，dev 进程在跑）保留不动。
- 前端 9/9、制品守护 32/32、真实制品安装验收 1/1（astra R6 独立重跑确认）。
- 本清单为未提交的新文件，随插件源码 PR 一起入库。
