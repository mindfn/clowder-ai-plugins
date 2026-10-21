# 2026-10-21 隔离体验验收准备（阶段 4）

状态：调研完成，尚未起实例。球在 kimi（astra 已放行，要求交付可操作入口+步骤后等 lang 体验）。

## 已核实的环境事实（本轮一手验证）

1. **运行实例（不许动）**：`/Users/lang/workspace/github-lab/cat-cafe-develop-base`
   - 端口：FRONTEND_PORT=3001 / API_SERVER_PORT=3002 / PREVIEW_GATEWAY_PORT=4099 / REDIS_PORT=6099
   - 已装 feishu = **0.1.0-alpha.5，无 configurationVariants**（inventory.json packages[4] 核实）
   - `.env` 有 FEISHU_VERIFICATION_TOKEN / FEISHU_BOT_OPEN_ID / FEISHU_CONNECTION_MODE（env 兜底配置）
2. **Host worktree**：`/Users/lang/workspace/github-lab/cat-cafe-config-variants-host`，分支 feat/configuration-variants-host @ dcc267bd
   - 无 `.env`（只有 .env.example），node_modules 已存在
   - 启动器 `scripts/start-dev.sh`：先 source `.env` 再 source `.env.local`（后者覆盖前者）；注释说明**改 REDIS_PORT 会自动隔离数据目录**到 `~/.cat-cafe/redis-dev-<port>`
   - dev 脚本：`pnpm dev`（root，api+web 并行）；api dev 是 tsx watch，web dev 是 next dev
3. **契约仓**：`/Users/lang/workspace/github-lab/clowder-ai-plugins-config-variants` @ d473149
   - feishu `packages/connector-feishu/plugin.yaml` = 0.1.0-alpha.6，含 configurationVariants：discriminator=connectionMode；webhook 分支要 verificationToken；websocket 分支 fields 为空
   - video-generation `packages/video-generation/plugin.yaml` = 0.1.0-alpha.2，contractVersion=0.2.0，含 configurationVariants：discriminator=authType；apikey→[apiKey]；jwt-hs256 / hmac-sha256-v4→[accessKey, secretKey]
   - catalog.json **未收录**这两个新版本（feishu 只到 0.1.0-alpha.5）→ 体验装插件必须走 Host 本地包准入（`packages/api/src/domains/plugin/manager/local-package-admission.ts`），先用正式打包脚本产出 tgz（参考 `scripts/feishu-registry-install.test.mjs` 的 packs 流程，pack-publish-artifact.mjs 是正式入口）

## 下一步计划

1. 选空闲端口（拟 FRONTEND=3101 / API=3102 / PREVIEW=4199 / REDIS=6199，先 lsof 验证）
2. Host worktree 写 `.env.local`（只覆盖端口 + NEXT_PUBLIC_API_URL=http://localhost:3102）；先读 start-dev.sh 全文确认 redis 由谁拉起、.cat-cafe 数据根怎么定（CAT_CAFE_* 变量），保证隔离可证明
3. 起 dev 实例，验证 web/API 可访问（不碰运行实例端口与数据）
4. 用正式打包脚本产出 feishu-0.1.0-alpha.6 与 video-generation-0.1.0-alpha.2 的 tgz，经本地准入装进体验实例
5. 写验收步骤文档覆盖 astra 四场景：①模式切换（feishu webhook↔websocket 时 Verification Token 显示/必填切换）②已存凭据保留（Token 已存只显示掩码，改其他字段可保存，掩码不写回）③保存后重载（值与分支状态持久正确）④video-generation authType 三分支字段切换 + 必填校验
6. 带入口+步骤 @lang 验收；等确认后才推进 fork 合入与 soak（阶段 4→5 硬门禁）

## 未决问题（下轮先查）

- start-dev.sh 是否自动起 redis-server（还是要求外部 redis）；REDIS_DATA_DIR 在 .env.local 下如何解析
- 全新隔离 Redis 下无猫/无账号，插件设置页是否可直接访问（是否需最小初始化猫或 DEFAULT_CAT_ID）
- 本地包准入的 UI/API 入口具体路径（plugin_list 看到的 install: local-archive 流程）

---

## 验收入口与步骤（2026-10-21 11:30 UTC 落实，实例已就绪）

### 实例状态（已验证）

- 隔离实例运行中（后台任务 `bash-93mtzztd`，日志 `/tmp/variants-host-dev.log`）
- 启动命令（Host worktree 根）：`WORKTREE_PORT_OFFSET=-10 pnpm dev:direct --profile=opensource`
- 端口：Web **5112** / API **3112** / Redis **6388**；数据隔离在 Host worktree 内 `.cat-cafe/`（全新，与运行实例 3001/3002/6099 完全分离）
- 重启：同上命令；停止：`pnpm dev:stop` 或杀后台任务
- 首次访问页面是 next dev 编译，会慢几秒，属正常

### 已安装插件（local-archive 本地准入，正式 pack-publish-artifact 制品）

| 插件 | 版本 | 实例 |
|---|---|---|
| official.connector.feishu | 0.1.0-alpha.6 | pi_49ca9f8d-794d-47f7-901b-9a96caccd165 |
| dev.clowder.video-generation | 0.1.0-alpha.2 | pi_3cae781a-aea7-462c-8f7d-41314054518b |

- 两插件当前 `config: incomplete`、`intent: disabled`——这是预期初始态，保存完整配置后才能启用，正好覆盖验收路径
- API 已确认 `configFields[].configurationVariants` 按契约暴露（feishu: discriminator=connectionMode，webhook→[verificationToken]，websocket→[]；video-gen: discriminator=authType，apikey→[apiKey]，jwt/hmac→[accessKey, secretKey]）
- 注意：安装接口要求本地 Origin 头与会话 cookie（`GET /api/session` 获取），直接 curl 会 401/403

### 验收入口

**http://localhost:5112** → 插件管理（设置/能力页）→ Feishu / Lark Connector 的「设置」；同页找 dev.clowder.video-generation 的「设置」。

### 四场景操作与预期

**① 模式切换（feishu connectionMode）**
1. 打开 feishu 设置。连接模式默认 `webhook`，Verification Token 字段显示且必填（有未填提示）。
2. 切到 `websocket`：Verification Token 字段隐藏，保存不再要求它；appId/appSecret 仍必填。
3. 切回 `webhook`：Token 重新出现且必填。
4. 反向验证：未选模式时（若 UI 允许清除）不应让旧的首项值冒充模式。

**② 已存凭据保留（secret 掩码）**
1. webhook 模式下填 appId、appSecret、Verification Token，保存成功。
2. 重新打开设置：三个 secret 只显示掩码（如 `••••`），不回显明文。
3. 只改 appId（不动任何 secret 输入框），保存应成功——已存 secret 按「存在性」满足必填，掩码不参与条件比较、不写回。
4. 明确清空 Verification Token 输入框（显式删除）后再保存：校验应重新要求 Token（存在性被显式删除打破）。

**③ 保存后重载**
1. 保存 connectionMode=websocket + appId/appSecret 后，刷新页面/重进设置：模式仍是 websocket，Token 不出现，值持久。
2. 切回 webhook 并填 Token 保存，重载后模式、Token 存在性都正确。
3. 默认值恢复：清空 connectionMode（若可清除）保存后，契约默认 `webhook` 应生效并要求 Token。

**④ video-generation authType 三分支**
1. 打开 video-generation 设置：authType 必选（apikey / jwt-hs256 / hmac-sha256-v4）。
2. 选 `apikey`：只有 apiKey 是条件必填；accessKey/secretKey 不要求。
3. 选 `jwt-hs256` 或 `hmac-sha256-v4`：apiKey 隐藏/不要求，accessKey + secretKey 必填。
4. 切换分支时已填的另一分支值不串扰、不触发非本分支字段的必填报错。

### 验收后流程（阶段 4 硬门禁）

体验确认「可用、没问题」→ 才推进 fork 合入（develop_base）→ soak → 上游 PR。任何一步失败回阶段 2 修。

### 验证摘要（astra 复审 R6 独立验证）

前端 9/9、制品守护 32/32、真实制品安装验收 1/1（含 EINTEGRITY 篡改拒绝）。放行 HEAD：plugins `d473149`、Host `dcc267bd`。
