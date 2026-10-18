---
feature_ids: [F202]
topics: [github-operations, c1-migration]
doc_kind: implementation-status
created: 2026-10-08
---

# GitHub 插件的实现边界

插件负责仓库观察、跟踪计划、Community 业务数据、草稿和 GitHub 操作。`gh` 执行仓库操作；声明的 MCP 工具调用同一模块业务。凭据、配置和插件私有数据经普通 SDK 端口访问。

跟踪使用插件持久状态和普通 Task 等待数据。通知通过 `messaging.send` 进入 Host 普通会话队列；成员选择和执行调度由 Host 普通路由负责。插件不预判目标可用性，也不维护另一份部署目录。

审查提交记录外部仓库、当前 HEAD、审查结论和结果来源。它不修改 Host 的 lease、generation 或任务终态，不提供完成谓词回调。Guardian 邀请要求显式 `guardianCatId`；签署核验当前调用身份，保留业务邀请和检查清单。

`github.draft.create` 和已认证 owner POST `github/community-issue-drafts` 接收显式 `requestId`、`repo`、`title`、`bodyMarkdown` 和可选 `labels`，返回同一私有草稿。配置 GET 的 `defaultRepo` 和 `repos` 提供默认目标。后续草稿管理归插件存储；Host 不持久化反馈与草稿的关联，也不查询反馈源。

## 验证

在仓根运行包的 `build`、`typecheck`、`test` 和完整 `pnpm gate:ci`。源映射的原始 SHA 与当前去留说明位于 `source-map.json`；`scripts/audit-github-migration.mjs` 检查文件去留、源码对比和静态可达性。静态可达性不能证明业务旅程。

安装验证应使用同批 Contract/SDK 与实际插件归档，覆盖模块启动、停用、配置更新、持久跟踪恢复、普通消息通知、显式草稿创建和调用身份。真实账号、Host 页面、公开发行和长期使用分别验收；源码测试或归档校验不能代替它们。插件不自动迁移旧 Host 私有状态，也不删除已有用户数据。

公共接口和管理生命周期以[插件开发基线](../../../docs/plugin-development.md)为准；安装用法见包 README。原始迁移来源与旧实现可从 Git 历史核对。
