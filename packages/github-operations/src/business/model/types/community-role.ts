
/**
 * Community Role Registry Types (F168 Phase C — Narrator + Role Registry)
 *
 * The community-ops engine routes work by ROLE, never by cat name. A RoleResolver
 * (injected, deployment-owned) maps an abstract CommunityRole → a concrete RoleExecutor
 * (which cat, which model, which prompt). This decouples the engine from the roster
 * (终态设计 §4) and keeps "who narrates" a config concern, not a code constant (INV-6).
 *
 * Invariants anchored here:
 *   - INV-4: CommunityRole is a CLOSED set; unknown role → fail-closed (resolve returns null).
 *            isCommunityRole is the runtime membership primitive enabling fail-closed resolution.
 *   - INV-2: RoleCapability deliberately EXCLUDES 'code' / 'merge' / 'worktree'. Community roles
 *            (narrator/case-owner/reconciler) triage, recommend routes, and reply — they never
 *            write code. The type makes the capability ceiling unrepresentable, not just unenforced.
 */

/** The closed set of engine roles. Single runtime source for the CommunityRole union. */
export const COMMUNITY_ROLES = ['narrator', 'case-owner', 'reconciler'] as const;

/** Abstract role the community engine resolves to an executor (never a cat name). */
export type CommunityRole = (typeof COMMUNITY_ROLES)[number];
