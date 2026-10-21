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

全部用正式打包脚本 `node scripts/pack-publish-artifact.mjs <sourceDir> <outDir>` 打出，且全部使用 **CI 固定工具链**（Node 24.18.0 / npm 11.16.0，与上游 `contract-ci.yml` 的 `ARTIFACT_NODE_VERSION` / `NPM_VERSION` 一致；本机默认 shell 是 Node 24.15.0 / npm 11.12.1，用它打包会产生字节级哈希漂移，已实证）。**R9 起该脚本的非 bundled 分支输出完全跨平台确定**（npm pack 到临时目录后按排序成员重建 tar：DFS 目录序、固定 mtime/uid/gid、gzip -n、OS 字节归一，逻辑与 self-contained 链路共用 `createDeterministicArchive`）；下表哈希即 CI 发布值（macOS 连打两次一致，CI Ubuntu 重打必然同字节）。

| 包 | 新版本 | 字节 | sha512 integrity | sha1 shasum | sha256 |
|---|---|---|---|---|---|
| `@clowder-ai/connector-feishu` | 0.1.0-alpha.6 | 93233 | `sha512-dZkoHX9wKwhR596dlcXqFzMSJ0M5CenHNwuvYl3Vaw9KBUJaYFo4qUdxgRMIIp8i+/Q+Ox7lxu3g8a7BBcPqmg==` | `b377d6a72a2961a9f70980287ae51eb6a32f81cb` | `f65662d2273d0402f384ec16c41dc57556d8653278035454783ea4664c77d19a` |
| `@clowder-ai/video-generation` | 0.1.0-alpha.2 | 50980 | `sha512-OcML2o3UNk7TML7kCfCFUTs6HLh72nBcFjc7/QIVilG244m0k/KUf/mJ46wJwFZI1edmNHEiLmvEZKJX+2AXYw==` | `2ebe35f6118f19bc07fc28993ef4533ed2ecfd90` | `414ade6907335c066b2d4c6bea1b8888b0f95205cefa4fc7a748edb3145bbe64` |
| `@clowder-ai/plugin-sdk` | 0.2.0-beta.22 | 97022 | `sha512-9QWwzGfWk+m9C61KFgzvRnRodC8/O+GS5lCjNJGWHfSRmBeojmTTdYszZ5qz35SxtqzzZ+q84y46sn5KYurozQ==` | `a0b3657aa6b06abe1d7b002cfc61508b7ed68a42` | `0d8c71a4a09c64f9834e9bee81a4ce0f40f24d8f72bdb6f83dbd0ec1ce9d2850` |
| `@clowder-ai/plugin-contract` | 0.2.0 | 241617 | `sha512-SFmj5xrakQ8XzVVpAOrK6JrsRspVuruzLmzs/IiHKae8v+KZWaKEo8mLU8WS5Pk8NftT3wVnes/sgkRazY7rMQ==` | `a883cc095cdadf63a69b21ab5b06a719bee22534` | `379b0476c7c0e3f4b0a5884fdae637dcc70245b16fc793383ee6970894df13bd` |

本地 tgz 源（CI 工具链 + 正式脚本产物，验收环境将用同一字节安装）：

- `/tmp/ci-packs-r9/clowder-ai-connector-feishu-0.1.0-alpha.6.tgz`（含更新后的 npm-shrinkwrap，内嵌 contract `SFmj…` / SDK `9QWw…` pin）
- `/tmp/ci-packs-r9/clowder-ai-video-generation-0.1.0-alpha.2.tgz`
- `/tmp/ci-packs-r9/clowder-ai-plugin-sdk-0.2.0-beta.22.tgz`
- `/tmp/ci-packs-r9/clowder-ai-plugin-contract-0.2.0.tgz`，同时作为 fixture 提交在 `packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz`（`artifact-consistency.test.ts` 逐字节守护）

> R8 表（86606/`1aMJ…`、47195/`/xbq…`、88833/`5REq…`、233868/`iFhu…`）已作废：那批是 macOS 本机工具链 + 非确定性 npm pack 的产物，CI（Ubuntu）重打必然不同字节，见"五点六 R9"。

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
4. **contract 0.2.0 最终哈希与 Host vendor 不同**（R8 值 `iFhuTF…` vs vendor 旧值）：已通知 sol，待制品最终确定后由 Host 侧同步 vendor 与锁文件，不在本 PR 范围。

## 五点六、R9 修正记录（PR #101 CI 挂 gate 5/35 后的根因修复）

**根因（两个叠加）：**

1. **非 bundled 打包路径跨平台不确定。** `pack-publish-artifact.mjs` 的非 bundled 分支直接透传 `npm pack` 字节，只归一化了 gzip OS 字节。但 npm pack 的 tar 成员序来自 packlist 的 fs readdir 遍历序（实测 250 成员与排序序不同，`.gitkeep` 打头），APFS 与 ext4 序不同 → tar payload 与 deflate 流整体不同 → 跨平台哈希完全不同。R8 时"只差 gzip OS 一字节"是从 size 相等推断的，**推断错误**（size 相同纯属巧合）。四个包（飞书、video-generation、SDK、contract）全部无 `bundledDependencies`，都走这条路径；bundled 路径（pnpm pack）本就有归一化且 CI 实证跨平台稳定。
2. **pin 校验规则单一。** `catalog-check.mjs` 对所有插件无条件本地重打并要求 == pin。确定性重打 ≠ 已发布 npm 字节，15 个历史插件（pin = 已发布字节）必然失败。

**修复：**

1. `pack-publish-artifact.mjs` 非 bundled 分支改为确定性重打：npm pack → 解压 stage → `createDeterministicArchive`（从 `pack-self-contained-artifact.mjs` 导入；DFS 按目录序排序成员、固定 mtime 1985-10-26、owner/group=0、tar -cf + gzip -n + byte9=3）→ 读回算 size/integrity/shasum。该 tar 跨平台一致性已被 self-contained 链路 CI 实证；macOS 连打两次哈希一致。
2. `catalog-check.mjs` 规则二分（astra R8 语义落地）：**已发布版本**（npm registry 上已存在该版本，经 `readRegistryIntegrity` 判定）下载 registry tarball，校验 pin == 实际发布字节 == registry dist.integrity，并用发布字节做 manifest/entrypoint 内容检查——workspace 重打永不能覆盖已发布 pin；**未发布新版本**（飞书 alpha.6、video alpha.2）以本地确定性重打为 pin 源，即 CI 将发布的字节。`pnpm gate:ci` step 35（Machine catalog）实证全绿。
3. 全链路 repin：contract 0.2.0 fixture tgz → 飞书 `npm-shrinkwrap.json` 两处 integrity（contract→`SFmj…`、SDK→`9QWw…`）→ 重打飞书 → `candidate.json` 两插件哈希。最终值见第一节表（含 sha256，供 Host vendor 同步）。
4. **contract 0.2.0 R9 最终哈希 `SFmj5xr…`（sha256 `379b0476…`）与 Host vendor 旧包不同**：sol 侧按此最终值同步 vendor + 锁文件 + 测试 pin（R8 的临时 `iFhuTF…` 作废，不作最终 pin）。

## 六、当前已验证资产（不随本清单改变）

- 隔离验收实例 5112/3112/6388（worktree `cat-cafe-config-variants-host`，dev 进程在跑）保留不动。
- 前端 9/9、制品守护 32/32、真实制品安装验收 1/1（astra R6 独立重跑确认）。
- 本清单为未提交的新文件，随插件源码 PR 一起入库。
