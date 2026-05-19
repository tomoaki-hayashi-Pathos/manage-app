import { AppService } from '../../app.service';
import type { ChildTask, ParentTask, TaskStatus, TrashedTaskEntry } from '../../core/interface';

/** manage / shared / trash */
export type TaskToolbarFilterMode = 'manage' | 'member' | 'completed' | 'minimal';

export type TaskToolbarFilterState = {
    searchText: string;
    stagnation: boolean;
    deadlineOverdue: boolean;
    deadlineToday: boolean;
    deadlineWithin3: boolean;
    statusTodo: boolean;
    statusProgress: boolean;
    /** 親 lead のみ・複数 OR */
    leadAssigneeUids: string[];
    /** 親タスク id・複数 OR */
    taskParentIds: string[];
};

export type ToolbarFilterContext = {
    app: AppService;
    projectId: string;
    hasOpenStagnationForTask: (parentTaskId: string, childTaskId: string | null) => boolean;
};

export function defaultToolbarFilterState(): TaskToolbarFilterState {
    return {
        searchText: '',
        stagnation: false,
        deadlineOverdue: false,
        deadlineToday: false,
        deadlineWithin3: false,
        statusTodo: false,
        statusProgress: false,
        leadAssigneeUids: [],
        taskParentIds: []
    };
}

export function isToolbarFilterDefault(o: TaskToolbarFilterState): boolean {
    return (
        !o.searchText.trim() &&
        !o.stagnation &&
        !o.deadlineOverdue &&
        !o.deadlineToday &&
        !o.deadlineWithin3 &&
        !o.statusTodo &&
        !o.statusProgress &&
        o.leadAssigneeUids.length === 0 &&
        o.taskParentIds.length === 0
    );
}

/** 手動ドラッグ: 検索・タスク名絞り込み時は不可（停滞/期限/ステータス/担当のみでは可） */
export function canReorderList(o: TaskToolbarFilterState): boolean {
    return !o.searchText.trim() && o.taskParentIds.length === 0;
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

function hasAnyDeadlineFilter(o: TaskToolbarFilterState): boolean {
    return o.deadlineOverdue || o.deadlineToday || o.deadlineWithin3;
}

function hasAnyStatusFilter(o: TaskToolbarFilterState): boolean {
    return o.statusTodo || o.statusProgress;
}

function selectedStatuses(o: TaskToolbarFilterState): TaskStatus[] {
    const s: TaskStatus[] = [];
    if (o.statusTodo) s.push('未着手');
    if (o.statusProgress) s.push('進行中');
    return s;
}

function parentDeadlineDiffDays(deadline: ParentTask['deadline']): number | null {
    if (!deadline || AppService.deadlineUnset(deadline)) return null;
    const end = new Date(deadline as Date | string);
    if (Number.isNaN(end.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDay = new Date(end);
    dueDay.setHours(0, 0, 0, 0);
    return Math.round((dueDay.getTime() - today.getTime()) / 86400000);
}

function parentMatchesDeadlineBucket(parent: ParentTask, o: TaskToolbarFilterState): boolean {
    const diff = parentDeadlineDiffDays(parent.deadline);
    if (diff === null) return false;
    if (o.deadlineOverdue && diff < 0) return true;
    if (o.deadlineToday && diff === 0) return true;
    if (o.deadlineWithin3 && diff >= 0 && diff <= 3) return true;
    return false;
}

function parentHasOpenStagnation(ctx: ToolbarFilterContext, parent: ParentTask): boolean {
    if (ctx.hasOpenStagnationForTask(parent.id, null)) return true;
    for (const c of ctx.app.getChildTasksByParentId(parent.id)) {
        if (ctx.hasOpenStagnationForTask(parent.id, c.id)) return true;
    }
    return false;
}

function parentMatchesCheckboxFilters(
    ctx: ToolbarFilterContext,
    parent: ParentTask,
    o: TaskToolbarFilterState,
    mode: TaskToolbarFilterMode
): boolean {
    const useStagnation = mode === 'manage' || mode === 'member';
    const useDeadline = mode === 'manage' || mode === 'member';
    const useStatus = mode === 'manage' || mode === 'member';
    const useAssignee = mode === 'manage' || mode === 'completed';
    const useTaskName = mode === 'manage' || mode === 'member' || mode === 'completed' || mode === 'minimal';

    if (useStagnation && o.stagnation && !parentHasOpenStagnation(ctx, parent)) return false;

    if (useDeadline && hasAnyDeadlineFilter(o) && !parentMatchesDeadlineBucket(parent, o)) {
        return false;
    }

    if (useStatus && hasAnyStatusFilter(o)) {
        const statuses = selectedStatuses(o);
        if (!statuses.includes(parent.status)) return false;
    }

    if (useAssignee && o.leadAssigneeUids.length > 0) {
        const lead = parent.leadAssigneeId;
        if (!lead || !o.leadAssigneeUids.includes(lead)) return false;
    }

    if (useTaskName && o.taskParentIds.length > 0 && !o.taskParentIds.includes(parent.id)) {
        return false;
    }

    return true;
}

export function parentMatchesToolbarFilters(
    ctx: ToolbarFilterContext,
    parent: ParentTask,
    o: TaskToolbarFilterState,
    mode: TaskToolbarFilterMode
): boolean {
    if (!parentMatchesCheckboxFilters(ctx, parent, o, mode)) return false;
    return textSearchMatches(buildParentSearchHaystack(ctx.app, parent), o.searchText);
}

export function buildTrashedEntrySearchHaystack(app: AppService, entry: TrashedTaskEntry): string {
    const parts: string[] = [];
    parts.push(entry.parent.title || '', entry.parent.description || '', entry.parent.status);
    parts.push((entry.parent.mentionUserIds ?? []).join(' '));
    for (const c of entry.children) {
        parts.push(c.title || '', c.status);
        const cm = app.getMemberById(c.assigneeId);
        if (cm) parts.push(cm.name, cm.email);
    }
    const lead = entry.parent.leadAssigneeId ? app.getMemberById(entry.parent.leadAssigneeId) : undefined;
    if (lead) parts.push(lead.name, lead.email);
    for (const uid of entry.parent.memberIds ?? []) {
        const m = app.getMemberById(uid);
        if (m) parts.push(m.name, m.email);
    }
    if (entry.childOnly) parts.push('子タスク');
    return parts.join('\u0000').toLowerCase();
}

export function trashedEntryMatchesToolbar(
    ctx: ToolbarFilterContext,
    entry: TrashedTaskEntry,
    o: TaskToolbarFilterState
): boolean {
    if (!parentMatchesCheckboxFilters(ctx, entry.parent, o, 'manage')) return false;
    return textSearchMatches(buildTrashedEntrySearchHaystack(ctx.app, entry), o.searchText);
}

export function todayItemMatchesToolbar(
    ctx: ToolbarFilterContext,
    item: { kind: 'parent' | 'child'; task: ParentTask | ChildTask; parent?: ParentTask },
    o: TaskToolbarFilterState
): boolean {
    const parent = item.kind === 'parent' ? (item.task as ParentTask) : item.parent!;
    if (item.kind === 'parent') {
        return parentMatchesToolbarFilters(ctx, parent, o, 'member');
    }

    const child = item.task as ChildTask;

    if (o.taskParentIds.length > 0 && !o.taskParentIds.includes(parent.id)) return false;

    if (o.searchText.trim()) {
        const hitParent = textSearchMatches(buildParentSearchHaystack(ctx.app, parent), o.searchText);
        const hitChild = textSearchMatches(buildChildSearchHaystack(ctx.app, child), o.searchText);
        if (!hitParent && !hitChild) return false;
    }

    if (o.stagnation && !ctx.hasOpenStagnationForTask(parent.id, child.id)) return false;

    if (hasAnyStatusFilter(o)) {
        const statuses = selectedStatuses(o);
        if (!statuses.includes(child.status)) return false;
    }

    if (hasAnyDeadlineFilter(o) && !parentMatchesDeadlineBucket(parent, o)) return false;

    return true;
}

/** 親削除時: タスク名フィルタから id を除去 */
export function removeParentIdFromFilter(o: TaskToolbarFilterState, parentId: string): TaskToolbarFilterState {
    if (!o.taskParentIds.includes(parentId)) return o;
    return { ...o, taskParentIds: o.taskParentIds.filter((id) => id !== parentId) };
}
