# 插件模式化配置契约设计 v2（configurationVariants）

日期：2026-10-21
作者：小狸（设计草案，astra 复审中）
状态：**v2 草案，待 astra 复审，未进入实现**
前置：v1（`configurationVariants` 初稿）已被 astra 驳回；本文档逐条回应其 P1/P2 与五个已拍板决策点。

## 1. 问题与目标

插件交给 Host 一张平铺字段表，只能表达"何时必填"（`requiredWhen`），无法表达"当前选择的是哪套配置"。飞书 Verification Token（webhook 模式必填、websocket 模式不存在）与 video-generation 的三模式凭据是同一类问题。显示、保存、就绪、运行四处各自猜测，必然分叉。

v2 目标：用**标准 JSON Schema 组合结构**表达模式单选，Host 通用解释，四条消费路径（表单 / 保存+就绪 / 运行时投影 / declared MCP）消费**同一份解析结果**。

## 2. 契约形状（plugin-contract，新 contractVersion `0.2.0`）

### 2.1 字段表保持平铺，新增 `configurationVariants`

字段定义只维护一份，仍在顶层 `configuration` 中；分支只**引用**字段 key，不内联字段定义、不覆写 label/description。

```yaml
contractVersion: 0.2.0
configuration:
  - key: appId            # 公共字段
    kind: string
    required: true
  - key: connectionMode   # discriminator：普通 select，无 secret
    kind: select
    required: true
    options: [{ value: webhook }, { value: websocket }]
  - key: verificationToken
    kind: secret
    required: false       # 分支内再判必填
configurationVariants:
  discriminator: connectionMode
  branches:
    - id: webhook
      when:
        properties:
          connectionMode: { const: webhook }
      fields: [verificationToken]
    - id: websocket
      when:
        properties:
          connectionMode: { const: websocket }
      fields: []
```

### 2.2 `when` 是标准 JSON Schema 片段，但受约束

- `when` 原样是 JSON Schema（`properties` + `const`/`enum`），**服务端装配**时把它组合进标准 `oneOf` 校验 stored 配置对象：

```json
{
  "type": "object",
  "oneOf": [
    { "properties": { "connectionMode": { "const": "webhook" } },
      "required": ["connectionMode", "verificationToken"] },
    { "properties": { "connectionMode": { "const": "websocket" } },
      "required": ["connectionMode"] }
  ]
}
```

  `required` 由 Host 装配：discriminator key + 该分支 `fields` 中**未标 `required: false` 语义**的字段（即分支内字段默认必填，字段上可显式 `optionalInVariant: true` 保留选填——见 §2.5）。stored 配置对象校验走这一条标准 oneOf，即"标准验证结构"。

- 契约语义校验（`validation/manifest.ts`）对 `when` 施加**结构化约束**，使其只承担"模式单选"，而不是任意 JSON Schema：
  1. `when.properties` 只允许出现 discriminator 这一个 key；
  2. discriminator 的约束只允许 `const`（单值）或 `enum`（值列表），且每个值必须是该 select 字段**已声明的 option**；
  3. 每个 option 值**恰被一个分支命中**（完备 + 互斥）。用 ajv 对每个 option 值逐分支试算 `when` 得出结论，不靠字符串比对。
- 明确边界：我们支持的是"可明确选出分支的模式表单"，**不是**支持任意 JSON Schema 自动生成界面。跨字段条件（"mode=webhook 且开启加密"）、无判别字段的"至少填一组"（真正的 anyOf），本期不做；条件模型演进时接到同一入口。

### 2.3 `fields` 是表单元数据，不是验证结构

- `fields: string[]` 引用顶层 `configuration` 已声明的 key，契约校验引用存在性。
- **一个字段可以属于多个分支**（分支互斥不要求字段集合互斥）。video-generation 的 accessKey/secretKey 同时属于 jwt 与 hmac 分支即合法用例。
- 分支不覆写字段的 label/description/kind——展示定义单一来源。

### 2.4 三态解析：`resolveConfigurationVariant`

plugin-contract 新增**纯函数、浏览器安全**的子路径导出（如 `@clowder-ai/plugin-contract/variant`）：

```ts
type VariantResolution =
  | { status: 'selected'; branchId: string }
  | { status: 'unselected' }            // discriminator 无值
  | { status: 'invalid'; value: unknown } // 有值但不匹配任何分支 when
```

- 实现只做 `const`/`enum` 等值匹配，**不依赖 ajv / Node validator**，浏览器与服务器共用同一份代码。
- 主包入口（含 ajv 的校验器）不进入浏览器依赖图；子路径独立导出。

### 2.5 无有效模式时的行为（统一规则）

| 场景 | 行为 |
|---|---|
| 设置页 | 仍显示公共字段 + discriminator 选择器，让用户修正；不显示任何分支字段 |
| 就绪检查 | 返回未就绪 |
| 运行时 | 拒绝启动（fail-closed） |
| stored 无 discriminator 值 | 可用字段声明的 `default`（default 在保存时物化，解析器只看 stored 值） |
| stored 有非法值 | **不得悄悄回退 default**；不回退任何值 |
| 隐式默认 | **禁止**把 select 第一项当作隐式默认 |

分支内字段的必填性：进入 `fields` 默认视为该模式下必填；字段上可加 `optionalInVariant: true` 声明"此字段在该分支内仍为选填"（保留旧式选填语义）。

## 3. 四条消费路径消费同一模型

### 3.1 设置页表单（web）

web 不自行解释分支，调用 §2.4 的同一个纯函数，输入为**已存配置的安全投影**（secret 字段掩码或仅给 mode 字段的真实值——判别字段都是普通 select，不含 secret，安全投影足够）**+ 当前表单草稿**。切换模式即时得到当前应显示的字段集，**无需保存、无需等服务端 `activeNow`**。逐字段校验（格式/必填）在同一草稿上本地即时反馈；最终权威校验仍在保存时由服务端完成。

### 3.2 保存与就绪（api）

- 保存：API 接受对已声明字段的**显式更新**并做格式校验；普通表单只提交当前活跃分支字段的修改，**其余草稿字段原样保留**；discriminator 与该分支字段**一次保存**（同一次请求内完成装配校验）。非活跃分支的已存值**保留在存储中**，不删除。
- 就绪：`requiredFieldsReady` 等就绪判断消费 §2.2 装配出的标准 oneOf：stored 配置对象整体通过 oneOf 且公共必填字段齐全 ⇒ 就绪。`unselected`/`invalid` ⇒ 未就绪。
- operation 字段（kind: operation）的 `configured` 语义**不变**：仍是"该 operation 全部 target 是否已有值"，不感知分支、不过滤 target；空 target 集合不视为成功。

### 3.3 运行时投影（module / external runtime）

`resolveManifestConfiguration`（`packages/api/src/domains/plugin/.../manifest-configuration-projection.ts`）已同时服务 in-process 与 external runtime 两条路径。扩展为：先跑 `resolveConfigurationVariant`，`selected` ⇒ 只投递**公共字段 + 当前分支字段**的有效值（非活跃分支的已存值不投递）；`unselected`/`invalid` ⇒ fail-closed 拒绝启动。无 `configurationVariants` 的插件走原路径，行为逐字节不变。

### 3.4 declared MCP 环境变量（第三条真实路径，v1 遗漏项）

`declared-mcp-resources.ts` 的 `mcpEnvironment`/`environmentValue` 目前独立读 `contribution.environment` 并直接查 `field.required`，**绕过运行时配置解析**——v1 方案下改 `required: true` 会让 apikey 模式因缺 Access/Secret Key 启动失败，旧值又会把非活跃凭据传进 MCP 进程。

v2 改法：declared MCP 绑定映射前**先消费 §3.3 同一份有效配置解析结果**，再做环境变量映射：

- binding 指向的字段在**当前活跃分支**（或是公共字段）⇒ 保留现有 grant + required 语义，从有效配置取值投递；
- binding 指向**非活跃分支字段** ⇒ **不投递该 env 项**（不报错、不要求 grant）；
- `unselected`/`invalid` ⇒ 拒绝启动 MCP contribution。

验收必须覆盖 module、external runtime、declared MCP 三条路径，各自权限边界（grant、secret.read）保持现状。

## 4. 完整示例（可直接过契约校验）

### 4.1 connector-feishu（contractVersion 0.2.0）

```yaml
pluginId: official.connector.feishu
version: 0.1.0-alpha.6
contractVersion: 0.2.0
name: Feishu / Lark Connector
description:
  default: Receive and send Feishu or Lark messages through a Host-owned connector binding.
  translations:
    zh-CN: 通过宿主所有的连接器绑定接收和发送飞书或 Lark 消息。
icon:
  type: svg
  src: assets/icon.svg
configuration:
  - key: appId
    label: App ID
    kind: string
    required: true
  - key: appSecret
    label: App Secret
    kind: secret
    required: true
  - key: connectionMode
    label: 连接模式
    kind: select
    required: true
    default: webhook
    options:
      - value: webhook
        label: Webhook（需公网 URL）
      - value: websocket
        label: WebSocket（无需公网，推荐内网）
  - key: verificationToken
    label: Verification Token
    kind: secret
    required: false
  - key: groupBotMentionsJson
    label: Group Bot Mentions (JSON, .env-only)
    kind: string
    required: false
    hidden: true
  - key: feishu_qr_login
    label: 飞书扫码授权
    kind: operation
    required: false
    target: [appId, appSecret, connectionMode]
    actions:
      - id: qr-generate
        label: 生成二维码
        render: button
        resultRender: img
        action:
          method: feishu.qr-generate
        next: qr-status
      - id: qr-status
        label: 等待扫码
        render: polling
        action:
          method: feishu.qr-status
        timeout: 600
        rollback: qr-generate
        next: disconnect
      - id: disconnect
        label: 断开连接
        render: button
        action:
          method: feishu.disconnect
        next: qr-generate
configurationVariants:
  discriminator: connectionMode
  branches:
    - id: webhook
      when:
        properties:
          connectionMode: { const: webhook }
      fields: [verificationToken]
    - id: websocket
      when:
        properties:
          connectionMode: { const: websocket }
      fields: []
test:
  action:
    method: feishu.test
permissions:
  label: 飞书
steps:
  - text: "在飞书开放平台创建企业自建应用，获取 App ID 和 App Secret"
  - text: "选择连接模式：Webhook（需公网 URL）或 WebSocket（无需公网，推荐内网环境）"
  - text: "在「事件订阅」中配置请求地址并获取 Verification Token"
    mode: webhook
  - text: "在「事件订阅」中选择「使用长连接接收事件」，无需 Verification Token"
    mode: websocket
contributions:
  - type: identity
    id: feishu-bot
    displayName: Feishu bot
  - type: message-subscription
    id: feishu
    binding: feishu-bot
    action:
      method: feishu.outbound
    presentation: v2
  - type: media-source
    id: feishu-media
    binding: feishu-bot
  - type: webhook
    id: feishu-events
    path: feishu/events
    methods: [POST]
    action:
      method: feishu.webhook
    verificationSecretRef: verificationToken
features:
  - id: feishu-messaging
    name: Feishu messaging
    resources: []
    contributions:
      - type: identity
        id: feishu-bot
      - type: message-subscription
        id: feishu
      - type: media-source
        id: feishu-media
      - type: webhook
        id: feishu-events
    capabilities: [plugin.config.read, plugin.state.get, plugin.state.set, streams.read, message.event.subscribe, messaging.send, secret.read, thread.readContent, thread.listMetadata, thread.write]
runtime:
  transport: builtin
  entrypoint: dist/plugin-entrypoint.js
```

变化点：`requiredWhen` 移除（0.2.0 下由 variants 接管必填语义）；`connectionMode` 改 `required: true`（discriminator 必须显式）；其余结构与 alpha.5 逐字段对齐。

**遗留开放点（提交 astra 决定）**：webhook contribution 的 `verificationSecretRef: verificationToken` 与模式联动——websocket 模式下该 contribution 无可用 secret。候选：(a) 运行时对该 contribution 明确报错/禁用并给出可读原因；(b) 契约允许 contributions 复用 `when` 形状声明条件启用。不在本草案擅自选定。

### 4.2 video-generation（contractVersion 0.2.0，演示字段跨分支共享）

```yaml
pluginId: dev.clowder.video-generation
version: 0.1.0-alpha.2
contractVersion: 0.2.0
name: Video Generation
description:
  default: Submit and track image or video generation jobs through a configured provider.
  translations:
    zh-CN: 通过已配置的提供商提交并跟踪图片或视频生成任务。
icon:
  type: svg
  src: assets/icon.svg
configuration:
  - key: provider
    label: 视频协议
    kind: select
    required: true
    options:
      - value: zhipu
        label: 智谱
        hint: 在智谱开放平台注册，获取 API Key
        docsUrl: https://docs.bigmodel.cn/cn/guide/models/video-generation
      - value: kling
        label: 可灵
        hint: 在可灵 AI 开放平台注册，获取 Access Key + Secret Key
        docsUrl: https://klingapi.com/docs
      - value: jimeng
        label: 即梦 (火山引擎)
        hint: 在火山引擎控制台注册，获取 Access Key + Secret Key
        docsUrl: https://www.volcengine.com/docs/85621/1777001
  - key: authType
    label: 认证方式
    kind: select
    required: true
    options:
      - value: apikey
        label: API Key
      - value: jwt-hs256
        label: JWT (Access Key + Secret)
      - value: hmac-sha256-v4
        label: HMAC-SHA256 V4
  - key: apiKey
    label: API Key
    kind: secret
    required: false
  - key: accessKey
    label: Access Key
    kind: secret
    required: false
  - key: secretKey
    label: Secret Key
    kind: secret
    required: false
  - key: baseUrl
    label: Base URL
    kind: url
    required: false
  - key: model
    label: 模型名称
    kind: string
    required: false
configurationVariants:
  discriminator: authType
  branches:
    - id: apikey
      when:
        properties:
          authType: { const: apikey }
      fields: [apiKey]
    - id: jwt
      when:
        properties:
          authType: { enum: [jwt-hs256] }
      fields: [accessKey, secretKey]
    - id: hmac
      when:
        properties:
          authType: { enum: [hmac-sha256-v4] }
      fields: [accessKey, secretKey]
contributions:
  - type: mcp
    id: video-generation-toolset
    runtime:
      transport: stdio
      entrypoint: dist/mcp-entrypoint.js
    environment:
      VIDEO_GEN_PROVIDER:
        source: config
        key: provider
      VIDEO_GEN_AUTH_TYPE:
        source: config
        key: authType
      VIDEO_GEN_API_KEY:
        source: secret
        key: apiKey
      VIDEO_GEN_ACCESS_KEY:
        source: secret
        key: accessKey
      VIDEO_GEN_SECRET_KEY:
        source: secret
        key: secretKey
      VIDEO_GEN_BASE_URL:
        source: config
        key: baseUrl
      VIDEO_GEN_MODEL:
        source: config
        key: model
features:
  - id: generate-media
    name: Generate media
    resources: []
    contributions:
      - type: mcp
        id: video-generation-toolset
    capabilities:
      - plugin.config.read
      - secret.read
runtime:
  transport: builtin
```

`accessKey`/`secretKey` 同时属于 jwt 与 hmac 两个分支——示范"字段跨分支共享"合法。`environment` 映射保持不变，投递语义由 §3.4 接管。

## 5. 两条关键数据流

### 5.1 未保存切换模式（设置页）

```
用户把 connectionMode 从 websocket 切到 webhook（尚未点保存）
  │
  ├─ web 本地调用 resolveConfigurationVariant(manifest,
  │     stored 安全投影 + { ...草稿, connectionMode: webhook })
  │     → { status: 'selected', branchId: 'webhook' }
  │
  ├─ 表单立即渲染公共字段 + verificationToken 输入框
  │   （本地同一草稿上做必填/格式即时反馈）
  │
  └─ 用户填 Token 点保存
        → 一次请求提交 { connectionMode: webhook, verificationToken: *** }
        → 服务端用装配后的标准 oneOf 校验 stored 对象
        → 保存成功；切回 websocket 时 Token 仍留存于存储，
          表单与运行时均不显示/不投递，再切回 webhook 恢复生效
```

### 5.2 declared MCP 启动（video-generation，authType=apikey）

```
Host 启动 contribution video-generation-toolset（stdio MCP）
  │
  ├─ 跑 resolveConfigurationVariant(manifest, stored)
  │     → { status: 'selected', branchId: 'apikey' }
  │
  ├─ 有效配置 = 公共字段 + apiKey 分支字段
  │
  └─ 映射 environment：
       VIDEO_GEN_PROVIDER / VIDEO_GEN_AUTH_TYPE / VIDEO_GEN_BASE_URL /
       VIDEO_GEN_MODEL / VIDEO_GEN_API_KEY → 按原 grant（config/secret）投递
       VIDEO_GEN_ACCESS_KEY / VIDEO_GEN_SECRET_KEY
         → 指向非活跃分支字段 → 不投递（不要求 secret.read grant）
```

若 stored 的 authType 非法或缺失：拒绝启动该 MCP contribution，设置页保留修复入口。

## 6. 兼容与版本

- **新 Host + 旧插件**：manifest 无 `configurationVariants` ⇒ 走原 `requiredWhen` 路径，显示/保存/就绪/运行行为逐字节不变（验收项）。
- **旧 Host + 新插件**：`host-inventory/contract-policy.ts` 的 `PLUGIN_MANIFEST_CONTRACT_VERSIONS` 精确 allowlist 不含 `0.2.0` ⇒ 安装即拒，明确失败。
- 新能力绑定契约版本 `0.2.0` 发布，**不只靠 Host allowlist**：schema 层面 `configurationVariants` 只在 0.2.0 schema 中出现，0.1.0 manifest 携带该键即校验失败。
- `requiredWhen` 在 0.2.0 中保留原语义（只管必填），旧式插件可继续只用它。
- 版本迁移：契约包发 `0.2.0`；SDK 跟随；feishu 与 video-generation 按 §4 迁移后发新版。这是**正常发版链**，不走 hotfix。

## 7. 验收清单（贯穿真实路径）

1. 新装插件，逐模式选择 → 表单只显示对应字段；缺必填项保存被拒并指出缺项。
2. 填完保存 → 就绪；切换模式（未保存）→ 字段即时跟随；保存 → 运行时只收到当前分支值。
3. 重载页面 / 重启 Host → 状态恢复；切回旧模式 → 旧值恢复生效。
4. 插件实际收到的配置（module / external runtime / declared MCP 三条路径逐一验证）只含公共 + 当前分支字段。
5. 当前模式下分支内选填字段（`optionalInVariant: true`）仍可编辑、保存、投递。
6. 反例：非法/缺失 discriminator → 设置页可修复、就绪=未就绪、运行时拒绝启动、不悄悄回退 default。
7. 旧插件（无 variants）在新 Host 上行为不变。
8. 旧 Host 装 0.2.0 插件被拒。

## 8. 对 astra v1 驳回的逐条回应

| astra 意见 | v2 回应 |
|---|---|
| P1 不能只读服务端 activeNow（未保存切换不生效） | §2.4 + §3.1：前后端共用同一纯解析函数，前端输入安全投影+草稿即时得出字段集 |
| P1 遗漏 declared MCP env 路径 | §3.4：三条路径统一消费有效配置解析；非活跃分支 env 不投递；验收覆盖三路径 |
| P2 不是标准 oneOf | §2.2：`when` 为标准 JSON Schema 片段，服务端装配成标准 `oneOf` 用 ajv 校验 stored 对象；`when` 施结构化约束（只限 discriminator + const/enum + option 完备互斥机检）；明确不支持任意 JSON Schema 生成界面 |
| P2 删除"一字段最多一分支" | §2.3：允许跨分支共享，video-gen 示例即共享场景 |
| P2 三态解析 + 无有效模式行为 | §2.4/§2.5：selected/unselected/invalid；不回退、不隐式默认、可修复、阻止启动 |
| 决策：命名 | `configurationVariants` 作领域名；标准结构（oneOf/when）与表单元数据（fields/discriminator）边界见 §2 |
| 决策：非活跃分支预填/保存 | §3.2：API 允许显式更新并校验格式；表单只提交活跃字段修改、其余草稿保留；模式+分支字段一次保存 |
| 决策：非法模式值 | §2.5：不回退；可打开设置修复；阻止启动 |
| 决策：分支覆写 label/description | 不允许（§2.1），展示定义单一来源 |
| 决策：operation configured | §3.2 保持原义，不按分支过滤 target |
| 验收：新 Host+旧插件不变 / 版本绑定 | §6 两条均列为硬验收 |
| 删除"旧插件依赖模式外值就是 bug" | 本文不出现该论断；旧契约允许即合法 |
