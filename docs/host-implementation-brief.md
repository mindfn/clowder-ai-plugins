# Host 侧 implementation brief — 飞书 Verification Token 条件配置（configuration variants 消费端）

写于 2026-10-21，由小狸（kimi/k3）交接给实现 subagent。目标读者：接手的 coder subagent（零上下文，请通读本文件 + 引用的设计文档后再动手）。

## 背景与真相源

- 设计文档（语义唯一真相源）：`/Users/lang/workspace/github-lab/clowder-ai-plugins-config-variants/docs/proposals/2026-10-21-plugin-config-variants-design.md`
  - §2.2：必填性唯一来源 = 字段自己的 `required`/`requiredWhen`；分支 `fields` 只管字段是否适用（活跃）。`when` 是受约束片段（只允许 `properties` 一个顶层 key，且只含 discriminator 的 const/enum，值必须 ∈ declared options，option 完备互斥）。不支持任意 JSON Schema。
  - §2.4：契约包拥有 `buildVariantValidationSchema` + `computeEffectiveConfiguration` + `resolveConfigurationVariant` + `evaluateFieldRequiredness`；Host 只消费，不得镜像实现。
  - §2.5：unselected/invalid 不回退、阻止启动；default 统一在 `computeEffectiveConfiguration` 内应用。
  - §3.x：四条消费路径（web 表单草稿、保存/就绪、启动投影+module getter、declared MCP env）。
- 契约包：`@clowder-ai/plugin-contract@0.2.0`，worktree `/Users/lang/workspace/github-lab/clowder-ai-plugins-config-variants`，分支 `feat/configuration-variants`，HEAD `18e5c60`（已 push）。
  - 重要：必填性语义在 `18e5c60` 被修正——`evaluateFieldRequiredness(field, values)` 是导出的唯一真实来源：`requiredWhen` 存在时**完全取代** `required`（严格 `===`，禁止字符串化），条件不满足即选填；不存在时看 `required === true`。`buildVariantValidationSchema` 把 common 字段编译到顶层、每个分支编译成一个 `oneOf` member，`requiredWhen` 编译成 `if/then`（按被引用字段的运行时值），string-like 约束带 `{type:'string',minLength:1}`（null/空串被拒）。
  - **已打包制品**：`/Users/lang/workspace/github-lab/clowder-ai-plugins-config-variants/packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz`（231,550 bytes，npm pack 自 18e5c60）。Host 用它做 file: 依赖，可追溯。
  - 契约测试 672/672 绿（含 reviewer 四反例 + `not:{}` 准入拒绝）。

## Host 仓库事实（已亲自核实）

- Host repo 主 checkout：`/Users/lang/workspace/github-lab/clowder-ai`，当前 `main` @ `1fc3e6921f`。remotes：`origin`=git@github.com:mindfn/clowder-ai.git（fork）、`upstream`=https://github.com/zts212653/clowder-ai.git。
- **禁止触碰**的旧 worktree：`/Users/lang/workspace/github-lab/cat-cafe-feishu-rwhen-visibility`（分支 `fix/feishu-required-when-visibility` @ `e6427096e0`，其父提交 `46dc0f8ffd` 是已作废的 requiredWhen 隐藏规则；operator 可能正在体验它）。不要清理、改写、rebase 它。
- 新 worktree：从 upstream/main（先 `git fetch upstream`）切出，如 `/Users/lang/workspace/github-lab/cat-cafe-config-variants-host`，分支名 `feat/configuration-variants-host` 或类似。基点是 upstream main 镜像（fork 规则：要提上游 PR 的从 main 切）。
- 运行实例（禁止重启、禁止连其 Redis）：`/Users/lang/workspace/github-lab/cat-cafe-develop-base`。测试用仓库既有隔离基建（`with-test-home` 之类），不得连运行实例的 Redis/端口（见其 .env 的 FRONTEND_PORT/API_SERVER_PORT/PREVIEW_GATEWAY_PORT，均为保留端口）。

## reviewer（astra）的硬性要求 — 必须全部满足

1. **Host 消费契约实现，不得复制语义**：删除 `packages/shared/src/plugin-configuration-variants.ts` 的镜像解析器（如果新基点里还没有该文件，则确认只从契约包 import）。禁止：字符串化匹配（strict ===）、用旧归一化把非法空值回退 default、把 malformed 声明当"无 variants"静默放行。**声明确实不存在**（undefined）才走 legacy 路径；声明存在但非法必须由契约校验拒绝（manifest 准入时报错）。
2. **移除已作废隐藏规则**：`46dc0f8ffd` 的设置页 requiredWhen 隐藏逻辑不得进入新分支。新基点的 main 应该本来就没有它——确认即可。
3. **贯通全部消费者**（设计 §3）：
   - §3.1 web 表单：用契约纯函数投影安全字段；草稿切换分支时即时增删活跃字段。
   - §3.2 保存/就绪：用 `buildVariantValidationSchema`（ajv）统一校验 effective 对象（`computeEffectiveConfiguration` 的产物）。
   - §3.3 启动投影：`resolveManifestConfiguration`（路径线索：`packages/api/src/domains/plugin/.../manifest-configuration-projection.ts`，自行定位）在 unselected/invalid 时 fail-closed 阻止启动；module getter `read()`（线索：`packages/api/src/domains/plugin/builtin-runtime/carriers/module-plugin-settings.ts`）消费契约函数——runtime fail-closed / management 接口放行（保留既有分层语义，但判断逻辑改为消费契约函数）。
   - §3.4 declared MCP env：env 占位符解析路径也要走有效配置投影。
   - 契约版本 allowlist：Host 目前只接受旧契约版本、不接受 `0.2.0`——找到 allowlist（自行 grep）并放行 `0.2.0`。
4. **fixture 修正**：现有 carrier fixture 的 discriminator 声明是 `kind: string`，不符合新契约（必须 `kind: select` 带 options）——修正。
5. **端到端验收**：用一个通过真实契约校验（`validateManifest`，0.2.0）的 manifest（feishu 形态：connectionMode select webhook/websocket，verificationToken 带 `requiredWhen: {key:'connectionMode', value:'webhook'}` 或 required:true 只在 webhook 分支 fields 里）走完整路径：安装 → 配置 → 启动 → 实际 getter 读取。证明：webhook 模式缺 Token 启动失败；websocket 模式无 Token 正常启动。
6. SDK 版本纪律：`@clowder-ai/plugin-contract` 依赖写 `file:../<path-to-tgz>` 或 vendored tgz 路径，不要写成已发布的 0.2.0（尚未发布）。最终发布时由发布流程核对。相关 shrinkwrap integrity 若变动必须基于实测。

## 交付物

- 新 worktree 分支 + commit(s)（conventional message + body 写 Why，签名 `[kimi/k3🐾]`——你是小狸的分身，签名用 `[kimi/k3🐾]`）。
- push 到 origin（mindfn/clowder-ai）。
- 报告：新分支名、HEAD SHA、每项消费者改动的文件路径、端到端验收证据（命令 + 关键输出）、全量测试结果。
- 不要开上游 PR（那是 co-creator 体验验收之后的阶段）。

## 飞书 manifest 目标形态（供 fixture/验收参考）

```json
{
  "contractVersion": "0.2.0",
  "configuration": [
    {"key":"appId","label":"App ID","kind":"string","required":true},
    {"key":"connectionMode","label":"Mode","kind":"select","required":true,"default":"websocket",
     "options":[{"value":"webhook","label":"Webhook"},{"value":"websocket","label":"Websocket"}]},
    {"key":"verificationToken","label":"Token","kind":"secret","required":false,
     "requiredWhen":{"key":"connectionMode","value":"webhook"}}
  ],
  "configurationVariants": {
    "discriminator":"connectionMode",
    "branches":[
      {"id":"webhook","when":{"properties":{"connectionMode":{"const":"webhook"}}},"fields":["verificationToken"]},
      {"id":"websocket","when":{"properties":{"connectionMode":{"const":"websocket"}}},"fields":[]}
    ]
  }
}
```
