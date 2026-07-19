---
feature_ids:
  - P-1
  - M0
topics:
  - roadmap
  - dev-tracker
  - cross-repo
doc_kind: dev-tracker
created: 2026-07-19
---

# M0 双仓开发路线图 & 状态跟踪（operator 视图）

> **用途**：lang 的单屏真相——现在到哪个阶段、谁在推进、哪里等 maintainer、哪里掉过球。
> **维护规则**：每次 maintainer verdict / PR 状态变化 / 掉球事件后由当值猫更新本文件（与 task 账本双写）。真相源优先级：GitHub live（issue/PR）> 本文件 > 聊天记录。
> **图例**：✅ 完成 · 🔄 进行中 · ⏸️ 等外部 · 💤 dormant（有唤醒条件）· ⬜ 未开始

## 一、全局地图（双仓 + 角色）

```
clowder-ai (core, upstream)               clowder-ai-plugins (本仓)
├─ K-1 messaging 域（maintainer 侧）        ├─ P-2  in-process conformance   ✅
├─ K-2 Host Broker（maintainer 侧）  ⬜     ├─ P-1a.0 shape co-sign (#1165)  ⏸️ rev6 等 R6 verdict
├─ #1165 shape 裁决权（K-2 maintainer）     ├─ P-1a  contract PR 机制化       💤 等 shape-approved
└─ K-1 producer attestation        ⬜      ├─ P-1b  wire-client + harness    ⬜
                                           ├─ P-1c  SDK author surface       ⬜
                                           └─ C-2/C-3 defers                 ⬜
联合闸门：M0 gate = P-1a/b/c ✅ + K-2 MVP ✅ + joint adversarial run
```

## 二、PR 台账（已发生 + 计划中）

| # | 仓 | 内容 | 状态 | 下一步归属 |
|---|---|---|---|---|
| plugins #3 | plugins | contract bootstrap（beta.1 发布） | ✅ merged | — |
| plugins #4 | plugins | governance bootstrap（ruleset/CODEOWNERS） | ✅ merged | — |
| plugins #6 | plugins | **P-2** messaging conformance（18 cases，beta.2） | ✅ merged `f52e820` | — |
| core #1168 | core | canonical byte-proof wording fix | ✅ merged `d606aab` | — |
| plugins #7 | plugins | P-1a wire truth modules（第一批工具层） | 💤 **draft**，CHANGES_REQUESTED 已分诊 | 等 #1165 shape-approved → terra 三张毛线球 schema-first 重建 |
| plugins（计划） | plugins | **P-1a 正式 contract PR**（codegen schemas + validators + 生成 byte proofs） | ⬜ | shape-approved 后我（宪宪）主笔 |
| plugins（计划） | plugins | **P-1b** wire-client core + test-host harness | ⬜ | P-1a 后 |
| plugins（计划） | plugins | **P-1c** SDK author surface（P14 三重锁） | ⬜ | P-1b 后 |
| core（计划） | core | **K-2 Host Broker MVP**（spawn/retry/dead-letter/reconcile） | ⬜ | maintainer 侧，与 P-1b 并行可 |
| core（计划） | core | K-1 mirror 删除 + exact re-pin | ⬜ | beta.3 registry-verified 后 |
| core（计划） | core | K-1 producer attestation（messageId/threadId/actor.id 界）+ valid-Date admission | ⬜ | **maintainer 侧 owner 动作**——reserved 字段解除的前置 |

## 三、#1165 shape 裁决线（当前主战场）

```
R1 verdict(07-17 06:11) → R2 五决策落定(09:22) → rev2 → R3 五P1(14:45)
→ rev3 → R4-intake: RequestId 拍定+P1#4(15:58) → rev4 → R5 两P1(07-18 15:34)
→ rev6 上线(07-19 08:05, SHA ee2ee48f…) → ⏸️ 等 R6 exact-body verdict
```

- **当前等**：maintainer R6 确认三件事——① 两 P1 修复（M7→RESERVED / Invalid Request 双 id arms）② 保留边界 H1/H3/H4/H5/H6+M1/M2/M5/M6/M7+I1 ③ **`shape-approved` 与否（终局信号）**
- **保障**：issue tracking（不可靠，见掉球史#3）+ hold_ball 30min 轮询兜底（08:43Z 首查）
- **approved 解锁链**：contract PR 授权 → PR #7 重建转 ready → beta.3 → registry 验证 → K-1/K-2 re-pin

## 四、掉球史（根因 + 已固化对策）

| # | 事件 | 根因 | 对策（已生效） |
|---|---|---|---|
| 1 | 07-17 10:32 sol 0-findings 后投递棒 4 分钟没人接 | 双 wake 合并，coordinate 转发盖掉关键球 | wake 合并时先扫 pending 球再处理转发 |
| 2 | 07-17 15:27 sol 接球声明后 session stall | reviewer/投递单点 | 双 reviewer 池（sol+terra），撞车条款 |
| 3 | 07-17 15:58 R4-intake comment 1 小时无人处理 | issue tracking 回调对 comment 不可靠 | 关键外部等待挂 hold_ball 轮询兜底（operator 08:12 指示固化） |
| 4 | 07-18 夜 平行 thread 读 R5 verdict 后 session 停 | session 生命周期无接力检测 | operator 手动发现→本 thread 接力；**待改进：跨 thread 断点自动检测** |
| 5 | 07-17 GitHub body edit 零通知 maintainer | 投递链缺显式 @ 步骤 | 两步投递 SOP（replace + 行首 @zts212653 comment）固化 |

## 五、沟通协作协议（现行）

- **maintainer 裁决**：K-1 thread 侧执行（起草 + Terra 独立复核 + zts212653 账号发 verdict）；lang 催审 = 去 K-1 thread 派球
- **plugins 侧 review**：本 thread 闭环（sol/terra finding-only），**先扫后投**铁律
- **投递协议**：两步不可拆 + 报 raw API-string hash/count packet；exact-body re-review on those bytes
- **授权边界常量**：shape-approved 前 no implementation / no beta.3 / no re-pin / no K-2 runtime；所有 12 rows `ready=false`（D0=A）
