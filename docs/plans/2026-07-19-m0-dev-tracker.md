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
├─ K-2 Host Broker（maintainer 侧）  ⬜     ├─ P-1a.0 shape co-sign (#1165)  ✅ **shape-approved**（R11 APPROVE）
├─ #1165 shape 裁决权（K-2 maintainer）     ├─ P-1a  contract PR 机制化       💤 等 shape-approved
└─ K-1 producer attestation        ⬜      ├─ P-1b  wire-client + harness    🔄 骨架 PR #9
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
| plugins | **DX 脚手架** create-clowder-plugin | 我们 | 与 contract 解耦 |
| plugins | C-2/C-3 fixture 设计稿 | 我们（可选） | 设计先行，不实现 |
| core | **K-1 上游化**（rebase + formal PR） | maintainer | 已在进行 🔄，K-2 prep 明文前置 |
| core | **K-1 producer attestation** | maintainer | messageId/threadId/actor.id 界 + valid-Date admission——**正是我们 M1/M2/M7 reserved 等的解锁件** |
| plugins | **P-1a contract PR 机制化** | **opus**（新分工） | shape-approved 落地——mechanize frozen rev11 shape verbatim，reservation-only（全 rows ready=false） |

### 🔍 IN-REVIEW——已投出，等外部审

| 仓 | 项 | 等什么 | 兜底 |
|---|---|---|---|
| plugins | **PR #8** byte-proof 引擎（`1ad6323`，maintainer P1【dist 漂移】已修：byte-proof 移出发布 build + integrity fail-closed 校验；云端复审 no-major-issues） | maintainer 新 verdict 覆盖旧 CHANGES_REQUESTED | PR tracking intent=review |
| plugins | **PR #9** P-1b harness 骨架（`6edc277`，云端 R1-R4 全修：R4 = taskkill 非 success 无后代存活证据即 fail-closed，150/150 + CI 绿） | 云端 R5 verdict（packet `5017573376`） | PR tracking intent=review |
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
**K-2 Broker 全部 runtime work（含 supervision/spawn/dead-letter/reconcile "骨架"）← #1165 explicit approval + K-2 runtime authorization**——live body 明文 "no K-2 runtime work begins before explicit approval"，零 wire-schema 消费不改变授权边界（K-1 thread 14:09 更正，曾误标 🟢；lang 提并行时 K-2 只可"预备排期"不可"已在做"）
（K-3a/K-3b · #1047 联动：明文排除当前 scope）
```

## 三、#1165 shape 裁决线（当前主战场）

```
R1 verdict(07-17 06:11) → R2 五决策落定(09:22) → rev2 → R3 五P1(14:45)
→ rev3 → R4-intake: RequestId 拍定+P1#4(15:58) → rev4 → R5 两P1(07-18 15:34)
→ rev6 上线(07-19 08:05) → R6 = REQUEST_CHANGES(08:58) → R35..R38 吸收（terra 四轮扫收敛）
→ rev7 上线(12:42) → R7 = REQUEST_CHANGES(12:46, T-D 回了合法 Notification)
→ R39..R41 吸收（六维 state partition + T-J/T-K + terra 三轮扫收敛）
→ rev8 上线(13:04) → R8 = REQUEST_CHANGES(13:09, W2 值路由与 T-K 双 disposition)
→ R42..R43 吸收（值路由 = ID/Notification 状态投影；gates/W2 修）
→ rev9 上线(13:20) → R9 = REQUEST_CHANGES(14:10, response 形态帧 T-D/T-H 双路由)
→ R44..R48 吸收（response-candidate precedence + T-L accept lane + terra 五轮扫收敛）
→ rev10 上线(21:51) → R10 = REQUEST_CHANGES(00:01, 表已 accept、三处 derived projection 滞后)
→ R49..R51 吸收（四终态句/checklist T-A…T-L/计数 5+4 + 坐标 sweep 两轮）
→ rev11 上线(02:35) → **R11 = APPROVE（02:38，`shape-approved` reservation-only，comment `5018275437`）🎉 主线关桌**
```

- **R7 → rev8 吸收链**：R7 唯一 P1（T-D 把合法 Notification 打回 null，违反 §4.1 MUST-NOT-reply）→ 表重构为**六维 state partition 投影**（T-A…T-K）：T-D 收窄真 detection failure、T-J 合法 row-10 accept、T-K 一切 idless v0 违规 close、Notification invariant 逐字采纳。内部扫三轮（R40 残留段+idless envelope 类；R41 计数）收敛，链终态 `c79f83a`，我方独立核验 live body 逐字节吻合。累计：R6→rev7（T-A…T-I 表）、R7→rev8（partition 化）——两轮 verdict 均确认既有推导、每轮 finding 数=1
- **APPROVED 范围（精确）**：授权 = 开 contract PR + 按 frozen shape（rev11 body `7e26e5af…`）review。**仍不授权** = 任何 row ready=true / beta.3 发布 / registry-tag 变更 / re-pin / K-1 mirror 删除 / **K-2 runtime work**。失效条款：issue body 任何编辑使 approval 作废——#1165 body 从此冻结
- **解锁链激活**：contract PR（opus 写，新分工）→ PR #7 schema-first 重建（三 [P1] task 解锁）→ review 收敛 → merge 授权 → beta.3（另批）→ registry 验证 → re-pin（另批）

## 四、掉球史（根因 + 已固化对策）

| # | 事件 | 根因 | 对策（已生效） |
|---|---|---|---|
| 1 | 07-17 10:32 sol 0-findings 后投递棒 4 分钟没人接 | 双 wake 合并，coordinate 转发盖掉关键球 | wake 合并时先扫 pending 球再处理转发 |
| 2 | 07-17 15:27 sol 接球声明后 session stall | reviewer/投递单点 | 双 reviewer 池（sol+terra），撞车条款 |
| 3 | 07-17 15:58 R4-intake comment 1 小时无人处理 | issue tracking 回调对 comment 不可靠 | 关键外部等待挂 hold_ball 轮询兜底（operator 08:12 指示固化） |
| 4 | 07-18 夜 平行 thread 读 R5 verdict 后 session 停 | session 生命周期无接力检测 | operator 手动发现→本 thread 接力；**待改进：跨 thread 断点自动检测** |
| 5 | 07-17 GitHub body edit 零通知 maintainer | 投递链缺显式 @ 步骤 | 两步投递 SOP（replace + 行首 @zts212653 comment）固化 |
| 6 | 07-19 13:13-13:51 P-1b 误判掉球：sol 09:02 已接球并完工推 fork，但接球声明/review 请求消息未路由到派球者 + 未 update_task 认领 → 派球者误判超时，两次错误改派（含池外猫，spark 三轮上下文错乱） | ① 接球方漏 task 双写 ② A2A 消息路由丢失 ③ 派球方宣布掉球前未查物理证据（git worktree/fork 分支） | ① 接球必须 update_task（双写铁律）② **宣布掉球前必查 `git worktree list` + fork 分支**（物理证据 > 账本/消息推断）③ 派工池 = thread 既定池（terra+sol），不是全家名册（operator 13:51 拍定） |

## 五、沟通协作协议（现行）

- **双仓双 thread（operator 08:49 规范）**：仓库 ↔ thread 一一映射——plugins 仓 = 主 thread `thread_mrkn6povq4zzgh45`（能本 thread 闭环就本 thread 闭环）；core 仓 = K-1 thread `thread_mrkmxgdfqquounc9`。跨仓协调走 cross_post，不另开分支 thread（历史分支 thread `thread_mrq6n8fjq4bp426z` 已封口）
- **maintainer 裁决**：K-1 thread 侧执行（起草 + Terra 独立复核 + zts212653 账号发 verdict）；lang 催审 = 去 K-1 thread 派球
- **plugins 侧 review**：本 thread 闭环（sol/terra finding-only），**先扫后投**铁律
- **投递协议**：两步不可拆 + 报 raw API-string hash/count packet；exact-body re-review on those bytes
- **授权边界常量**：shape-approved 前 no implementation / no beta.3 / no re-pin / no K-2 runtime；所有 12 rows `ready=false`（D0=A）
