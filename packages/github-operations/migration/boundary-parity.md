---
feature_ids: [F202]
topics: [github-operations, migration, authority]
doc_kind: implementation-evidence
created: 2026-10-08
---

# GitHub 业务归属与验证边界

| 行为 | 插件职责 | Host 职责 |
| --- | --- | --- |
| 仓库跟踪与 CI、评论、审查观察 | 分页读取、分类、私有游标、去重与持久通知 | 普通 Task、消息和会话路由 |
| 外部审查记录 | 核当前 GitHub HEAD、保留外部结果与来源 | 普通调用身份、权限与 Task CAS |
| Guardian 邀请与签署 | 显式 guardianCatId、业务邀请、检查清单和当前签署身份 | 普通成员事实和通知路由 |
| 草稿创建与发布 | 显式输入、私有存储、仓库白名单、gh 操作与发布结果核验 | 认证 owner HTTP 或 native action 调用 |
| Narrator 通知 | 生成业务简报、持久发送记录、调用 messaging.send | 成员选择、执行队列与普通协作 |

插件不管理 Host 部署策略、lease 或任务完成协议。公共调用面和生命周期见[开发基线](../../../docs/plugin-development.md)。MCP 只暴露声明的工具；网页通过既有已认证 owner webhook 创建草稿，不构造 native invocation 凭据。

## 保留的业务约束

GitHub 观察使用明确的仓库、PR、评论和审查身份；完整分页、当前 HEAD、时间边界及响应大小限制决定结果是否可用。缺页、超时或格式错误不能解释成无问题。重复轮询保持静默，新的同 HEAD 状态转换仍可形成新通知。

发布响应丢失后，只能先读取外部事实核验；缺失、变化、重复或作者不符的结果不能授权另一笔写入。已发布或取消的私有历史不设 TTL。插件不读 Host 反馈源或保存 Host 草稿关联。

模块停止应中止 provider 读取并等待清理；停用后的旧调用不能产生新效果。通知通过普通消息端口，不复制 Host 对无效 @ 的路由算法。

## 验证方式与限制

包测试覆盖 provider 分页、当前 HEAD、超时、停止清理、跟踪持久化、显式草稿重试与冲突、Guardian 身份、普通通知和外部审查事实。空消费者检查实际依赖闭包，Host 制品验收检查同批归档的真实调用链。静态源映射、类型通过或 fake provider 结果均不等于真实账号或浏览器验收。

`source-map.json` 保留迁移源 SHA 和当前去留；Git 历史保留原始实现。旧状态导入、公开发布、完整体验与长期使用只有在相应旅程实际验收后才能确认。
