


/**
 * threadKind: Thread 字段扩展（F229 / F167）
 * concierge = 专属前台猫对话载体（per-user，sidebar 默认隐藏）
 * gate-keeping = 守门 thread（per-repo inbox / community ops 看板载体）。F167
 *   trigger-time guard 在 register_pr_tracking / register_issue_tracking / hold_ball
 *   端点 default-block 守门 thread 调用，避免「已 cross_post / propose 后还在守门
 *   thread 替下游 hold/挂 tracking」的双 owner、球权死锁事故。
 */
export type ConciergeThreadKind = 'concierge';
export type GateKeepingThreadKind = 'gate-keeping';
export type ThreadKind = ConciergeThreadKind | GateKeepingThreadKind;
