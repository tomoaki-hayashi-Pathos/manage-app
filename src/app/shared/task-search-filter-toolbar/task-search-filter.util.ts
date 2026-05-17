import type { AppService } from '../../app.service';
import type { ChildTask, ParentTask } from '../../core/interface';

export type TaskToolbarFilterState = {
    searchText: string;
    incompleteOnly: boolean;
    assigneeUid: string | null;
    pickParentId: string | null;
};

export function defaultToolbarFilterState(): TaskToolbarFilterState {
    return {
        searchText: '',
        incompleteOnly: false,
        assigneeUid: null,
        pickParentId: null
    };
}

export function isToolbarFilterDefault(o: TaskToolbarFilterState): boolean {
    return !o.searchText.trim() && !o.incompleteOnly && !o.assigneeUid && !o.pickParentId;
}

export function textSearchMatches(haystack: string, query: string): boolean {
    const t = query.trim().toLowerCase();
    if (!t) return true;
    return haystack.includes(t);
}

export function buildParentSearchHaystack(app: AppService, parent: ParentTask): string {
    const parts: string[] = [];
    parts.push(parent.title || '', parent.description || '');
    parts.push((parent.mentionUserIds ?? []).join(' '));
    parts.push(parent.status);
    for (const c of app.getChildTasksByParentId(parent.id)) {
        parts.push(c.title || '', c.status);
        const cm = app.getMemberById(c.assigneeId);
        if (cm) parts.push(cm.name, cm.email);
    }
    const lead = parent.leadAssigneeId ? app.getMemberById(parent.leadAssigneeId) : undefined;
    if (lead) parts.push(lead.name, lead.email);
    for (const uid of parent.memberIds ?? []) {
        const m = app.getMemberById(uid);
        if (m) parts.push(m.name, m.email);
    }
    return parts.join('\u0000').toLowerCase();
}

export function buildChildSearchHaystack(app: AppService, child: ChildTask): string {
    const parts: string[] = [child.title || '', child.status];
    const m = app.getMemberById(child.assigneeId);
    if (m) parts.push(m.name, m.email);
    return parts.join('\u0000').toLowerCase();
}

export function parentMatchesStructuralFilters(
    parent: ParentTask,
    o: Pick<TaskToolbarFilterState, 'incompleteOnly' | 'assigneeUid' | 'pickParentId'>
): boolean {
    if (o.pickParentId && parent.id !== o.pickParentId) return false;
    if (o.incompleteOnly && parent.status === '完了') return false;
    if (o.assigneeUid) {
        const uid = o.assigneeUid;
        if (parent.leadAssigneeId !== uid && !(parent.memberIds ?? []).includes(uid)) return false;
    }
    return true;
}

export function parentMatchesToolbarFilters(app: AppService, parent: ParentTask, o: TaskToolbarFilterState): boolean {
    if (!parentMatchesStructuralFilters(parent, o)) return false;
    return textSearchMatches(buildParentSearchHaystack(app, parent), o.searchText);
}

export function todayItemMatchesToolbar(
    app: AppService,
    item: { kind: 'parent' | 'child'; task: ParentTask | ChildTask; parent?: ParentTask },
    o: TaskToolbarFilterState
): boolean {
    const parent = item.kind === 'parent' ? (item.task as ParentTask) : item.parent!;
    if (!parentMatchesStructuralFilters(parent, o)) return false;
    if (!o.searchText.trim()) return true;
    if (textSearchMatches(buildParentSearchHaystack(app, parent), o.searchText)) return true;
    if (item.kind === 'child') {
        return textSearchMatches(buildChildSearchHaystack(app, item.task as ChildTask), o.searchText);
    }
    return false;
}
