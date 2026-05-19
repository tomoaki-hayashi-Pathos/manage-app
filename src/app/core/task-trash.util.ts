import type { ChildTask, ParentTask, TrashedTaskEntry } from './interface';

export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isPersonalProjectId(projectId: string): boolean {
    return projectId.startsWith('__personal_');
}

export function cloneParentForTrash(p: ParentTask): ParentTask {
    return JSON.parse(JSON.stringify(p)) as ParentTask;
}

export function cloneChildForTrash(c: ChildTask): ChildTask {
    return JSON.parse(JSON.stringify(c)) as ChildTask;
}

/** 方針 C: 個人WSは作成者のみ。チームは管理・リード・メンバー。 */
export function canDeleteParentTask(
    parent: ParentTask,
    actorUid: string | null | undefined,
    projectAdminId: string | undefined
): boolean {
    if (!actorUid?.trim()) return false;
    const pid = parent.projectId;
    if (isPersonalProjectId(pid)) {
        return parent.createdById === actorUid;
    }
    if (projectAdminId === actorUid) return true;
    if (parent.leadAssigneeId === actorUid) return true;
    if (parent.memberIds?.includes(actorUid)) return true;
    return false;
}

export function canDeleteChildTask(
    parent: ParentTask,
    child: ChildTask,
    actorUid: string | null | undefined,
    projectAdminId: string | undefined
): boolean {
    if (!actorUid?.trim()) return false;
    if (child.assigneeId === actorUid) return true;
    return canDeleteParentTask(parent, actorUid, projectAdminId);
}

export function canActOnTrashedEntry(
    entry: TrashedTaskEntry,
    actorUid: string | null | undefined,
    projectAdminId: string | undefined
): boolean {
    return canDeleteParentTask(entry.parent, actorUid, projectAdminId);
}

export function trashEntryLabel(entry: TrashedTaskEntry): string {
    if (entry.childOnly && entry.children.length === 1) {
        const c = entry.children[0];
        const pt = (entry.parent.title || '').trim() || '（無題）';
        const ct = (c.title || '').trim() || '（無題）';
        return `${pt} › ${ct}`;
    }
    return (entry.parent.title || '').trim() || '（無題）';
}
