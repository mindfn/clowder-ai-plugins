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

## 二、统一开发台账（三态 × 双仓；v2 per lang 08:29 指令）

> **读法**：🟢 无依赖可并行（谁闲谁动）→ 🔍 已投出等外部审（有兜底，不用人肉盯）→ 🔒 真依赖串行（唯一硬闸 = shape-approved）。
> **核心结论（08:24 lang 纠偏）**：只有「contract PR 的 schema 内容 → beta.3 → re-pin」真正被 shape-approved 阻塞。其余都可并行——线性化是误把单点 gate 当成了全局 gate。

### 🟢 NOW——无依赖，可并行开动

| 仓 | 项 | 谁动 | 说明 |
|---|---|---|---|
| plugins | **byte-proof 计算引擎** 🔄 | terra | R1→R2 双轮 review 收敛（`04fd4e0`，113/113）；三 OQ 全按 plan canonical 裁决闭合；待推 fork + draft PR |
| plugins | **P-1b harness 骨架** | 我们 | 进程管理 / NDJSON 传输 / kill-9 隔离——不含最终 schema，不碰授权边界 |
| plugins | **DX 脚手架** create-clowder-plugin | 我们 | 与 contract 解耦 |
| plugins | C-2/C-3 fixture 设计稿 | 我们（可选） | 设计先行，不实现 |
| core | **K-1 上游化**（rebase + formal PR） | maintainer | 已在进行 🔄，K-2 prep 明文前置 |
| core | **K-1 producer attestation** | maintainer | messageId/threadId/actor.id 界 + valid-Date admission——**正是我们 M1/M2/M7 reserved 等的解锁件** |
| core | **K-2 Broker 非契约面** | maintainer | supervision/spawn/dead-letter/reconcile 骨架，不消费 wire schema |
| — | **#1165 R6 催审** | **lang** | 拿 <https://github.com/zts212653/clowder-ai/issues/1165> 找 maintainer；顺带把上面 core 三项并行提给他 |

### 🔍 IN-REVIEW——已投出，等外部审

| 仓 | 项 | 等什么 | 兜底 |
|---|---|---|---|
| core | #1165 **rev6**（SHA `ee2ee48f…`，comment `5014966821`） | maintainer R6 exact-body verdict（三确认：两 P1 修复 / 保留边界 / shape-approved 与否） | issue tracking + hold_ball 30min 轮询 |
| plugins | PR #7 draft（wire truth 首批，head `7b2a0d1`） | shape-approved 后 schema-first 重建转 ready | 三个 [P1] task 停靠 + PR tracking |

### 🔒 BLOCKED——真依赖串行链

```
shape-approved（唯一硬闸）
 ├─→ P-1a contract PR（schema 内容/validators/per-row byte proofs）─→ beta.3 on next ─→ registry 验证
 │                                                                      └─→ K-1 mirror 删除 + exact re-pin
 ├─→ PR #7 schema-first 重建 → ready
 └─→ P-1b 收尾（wire-conformance 六案 + FC-28 byte-proof 集）← 还需 P-1a validators
P-1c SDK surface ← P-1b + contract
M0 joint gate ← P-1a/b/c ✅ + K-2 MVP ✅ + joint adversarial run（§3.8 全集 ~15 项，18 cases 已在 P-2）
（K-3a/K-3b · #1047 联动：明文排除当前 scope）
```

## 三、#1165 shape 裁决线（当前主战场）

```
R1 verdict(07-17 06:11) → R2 五决策落定(09:22) → rev2 → R3 五P1(14:45)
→ rev3 → R4-intake: RequestId 拍定+P1#4(15:58) → rev4 → R5 两P1(07-18 15:34)
→ rev6 上线(07-19 08:05, SHA ee2ee48f…) → R6 verdict(08:58) = REQUEST_CHANGES
→ 🔄 R35/D20 吸收中 → rev7 投递（新 hash/count packet）
```

- **R6 结果（comment `5015117839`）**：R5 两 P1 **关闭** ✅（M7 RESERVED + 双 id arms 被接受，机械投影 22/22、12/12 全核验）；**新 P1** = detectable-but-profile-invalid ID（`id:1`/`id:null`/超长/grammar 不匹配）无确定性 disposition——JSON-RPC §4-5 禁止静默进 null arm
- **治理不变量（R6 拍定）**：每个 rejection class 恰好一个 disposition——closed byte-proved error 或 connection-close，无中间地带；要求完整 pre-dispatch disposition table，禁只补例子
- **R35 吸收方向**：采 maintainer 推荐 **strict-profile route**（close 无 response + 排除出 public error union/proofs）+ disposition table + conformance cases + 全量传播（task 见毛线球）
- **approved 解锁链不变**：rev7 → R7 verdict → shape-approved → contract PR → PR #7 重建 → beta.3 → registry 验证 → K-1/K-2 re-pin

## 四、掉球史（根因 + 已固化对策）

| # | 事件 | 根因 | 对策（已生效） |
|---|---|---|---|
| 1 | 07-17 10:32 sol 0-findings 后投递棒 4 分钟没人接 | 双 wake 合并，coordinate 转发盖掉关键球 | wake 合并时先扫 pending 球再处理转发 |
| 2 | 07-17 15:27 sol 接球声明后 session stall | reviewer/投递单点 | 双 reviewer 池（sol+terra），撞车条款 |
| 3 | 07-17 15:58 R4-intake comment 1 小时无人处理 | issue tracking 回调对 comment 不可靠 | 关键外部等待挂 hold_ball 轮询兜底（operator 08:12 指示固化） |
| 4 | 07-18 夜 平行 thread 读 R5 verdict 后 session 停 | session 生命周期无接力检测 | operator 手动发现→本 thread 接力；**待改进：跨 thread 断点自动检测** |
| 5 | 07-17 GitHub body edit 零通知 maintainer | 投递链缺显式 @ 步骤 | 两步投递 SOP（replace + 行首 @zts212653 comment）固化 |

## 五、沟通协作协议（现行）

- **双仓双 thread（operator 08:49 规范）**：仓库 ↔ thread 一一映射——plugins 仓 = 主 thread `thread_mrkn6povq4zzgh45`（能本 thread 闭环就本 thread 闭环）；core 仓 = K-1 thread `thread_mrkmxgdfqquounc9`。跨仓协调走 cross_post，不另开分支 thread（历史分支 thread `thread_mrq6n8fjq4bp426z` 已封口）
- **maintainer 裁决**：K-1 thread 侧执行（起草 + Terra 独立复核 + zts212653 账号发 verdict）；lang 催审 = 去 K-1 thread 派球
- **plugins 侧 review**：本 thread 闭环（sol/terra finding-only），**先扫后投**铁律
- **投递协议**：两步不可拆 + 报 raw API-string hash/count packet；exact-body re-review on those bytes
- **授权边界常量**：shape-approved 前 no implementation / no beta.3 / no re-pin / no K-2 runtime；所有 12 rows `ready=false`（D0=A）
