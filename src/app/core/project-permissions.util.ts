import type { ParentTask, Project } from './interface';

export type ProjectMemberRole = 'member' | 'guest';

export type ProjectRole = 'admin' | ProjectMemberRole;

/** プロジェクト内の役割（責任者 / メンバー / ゲスト / 非参加） */
export function getProjectRole(project: Project | undefined, uid: string | null | undefined): ProjectRole | null {
    if (!project || !uid?.trim()) return null;
    if (project.adminId === uid) return 'admin';
    if (!project.memberIds.includes(uid)) return null;
    return project.memberRoles?.[uid] ?? 'member';
}

export function isProjectGuest(project: Project | undefined, uid: string | null | undefined): boolean {
    return getProjectRole(project, uid) === 'guest';
}

export function isProjectGuestById(
    projects: Project[],
    projectId: string,
    uid: string | null | undefined
): boolean {
    const p = projects.find((x) => x.id === projectId);
    return isProjectGuest(p, uid);
}

/** メンバーが親タスクに関与しているか（limit-tasks の「関与のみ」） */
export function memberIsInvolvedInParent(
    parent: ParentTask,
    memberId: string,
    childAssigneeIds: string[]
): boolean {
    if (parent.leadAssigneeId === memberId) return true;
    if (parent.memberIds.includes(memberId)) return true;
    return childAssigneeIds.some((id) => id === memberId);
}

/** チームプロジェクトでタスクを変更できるか（ゲストは常に不可） */
export function canMutateTasksInProject(project: Project | undefined, uid: string | null | undefined): boolean {
    if (!project || project.isPersonal || !uid?.trim()) return true;
    return !isProjectGuest(project, uid);
}
