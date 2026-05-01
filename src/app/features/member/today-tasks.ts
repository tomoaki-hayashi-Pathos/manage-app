import { Component, HostListener, inject } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ParentTask, Member, TaskStatus, ChildTask } from '../../core/interface';

export type TodayItem =
    | { kind: 'parent'; task: ParentTask }
    | { kind: 'child'; task: ChildTask; parent: ParentTask };

type ParentEditDraft = {
    title: string;
    description: string;
    deadlineInput: string;
    selectionOrder: string[];
    isUrgent: boolean;
};

type ChildEditDraft = { title: string; assigneeId: string };

@Component({
    selector: 'app-today-tasks',
    standalone: true,
    imports: [FormsModule, CommonModule, RouterLink],
    templateUrl: './today-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './today-tasks.css']
})
export class TodayTasksComponent {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    readonly memberId = this.route.snapshot.params['memberId'] as string;

    projectName = this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';

    title = '';
    isUrgent = false;
    description = '';

    parentTaskFilterId: string | 'all' = 'all';

    /** 親カードの全表示 */
    expandedParents: Record<string, boolean> = {};

    rightMenuOpen = false;
    parentEditTaskId: string | null = null;
    parentEditDraft: ParentEditDraft | null = null;
    childEditId: string | null = null;
    childEditDraft: ChildEditDraft | null = null;

    childInputs: Record<string, { title: string; assigneeId: string }> = {};

    get users(): Member[] {
        return this.appService.getMembersByProjectId(this.projectId);
    }

    get memberDisplayName(): string {
        return this.appService.getMemberById(this.memberId)?.name ?? '';
    }

    isTaskVisibleToMember(t: ParentTask): boolean {
        if (t.leadAssigneeId === this.memberId) return true;
        if (t.memberIds.includes(this.memberId)) return true;
        return this.appService.getChildTasksByParentId(t.id).some((c) => c.assigneeId === this.memberId);
    }

    isMyParent(task: ParentTask): boolean {
        if (task.leadAssigneeId === this.memberId) return true;
        return task.createdById === this.memberId;
    }

    /** 「今日やるべきタスク」のリストを、親タスクと子タスクを混ぜ合わせた状態で作成し、優先度順に並べ替える処理 */
    get todayItems(): TodayItem[] {
        const items: TodayItem[] = [];
        const parents = this.appService
            .getSortedParentTasksForProject(this.projectId, false)
            .filter((t) => t.isTodayTask && this.isTaskVisibleToMember(t));
        for (const p of parents) {
            items.push({ kind: 'parent', task: p });
        }
        for (const c of this.appService.childTasks) {
            if (c.projectId !== this.projectId || !c.isTodayTask) continue;
            const parent = this.appService.parentTasks.find((pt) => pt.id === c.parentTaskId);
            if (!parent || parent.isDraft || !this.isTaskVisibleToMember(parent)) continue;
            items.push({ kind: 'child', task: c, parent });
        }
        const sorted = items.sort((a, b) => {
            const pa = a.kind === 'parent' ? a.task : a.parent;
            const pb = b.kind === 'parent' ? b.task : b.parent;
            const pr = pa.priority === '高' ? 0 : 1;
            const qr = pb.priority === '高' ? 0 : 1;
            if (pr !== qr) return pr - qr;
            const ad = pa.deadline ? new Date(pa.deadline).getTime() : Number.MAX_SAFE_INTEGER;
            const bd = pb.deadline ? new Date(pb.deadline).getTime() : Number.MAX_SAFE_INTEGER;
            return ad - bd;
        });
        if (this.parentTaskFilterId === 'all') return sorted;
        return sorted.filter((it) => {
            const pid = it.kind === 'parent' ? it.task.id : it.parent.id;
            return pid === this.parentTaskFilterId;
        });
    }

    get parentTasksForFilter(): ParentTask[] {
        const ids = new Set<string>();
        for (const p of this.appService.getSortedParentTasksForProject(this.projectId, false)) {
            if (p.isTodayTask && this.isTaskVisibleToMember(p)) ids.add(p.id);
        }
        for (const c of this.appService.childTasks) {
            if (c.projectId !== this.projectId || !c.isTodayTask) continue;
            const parent = this.appService.parentTasks.find((pt) => pt.id === c.parentTaskId);
            if (parent && this.isTaskVisibleToMember(parent)) ids.add(parent.id);
        }
        return [...this.appService.getAllParentTasksForProject(this.projectId)]
            .filter((t) => ids.has(t.id))
            .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
    }

    trackKey(item: TodayItem): string {
        return item.kind === 'parent' ? 'p-' + item.task.id : 'c-' + item.task.id;
    }

    createMyTodayTask(): void {
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        this.appService.CreateParentTask(
            this.projectId,
            this.title,
            end,
            this.isUrgent,
            this.memberId,
            [],
            false,
            this.description,
            true,
            this.memberId
        );
        this.title = '';
        this.isUrgent = false;
        this.description = '';
    }

    toggleExpand(parentId: string, ev: Event): void {
        ev.stopPropagation();
        this.expandedParents[parentId] = !this.expandedParents[parentId];
    }

    isExpanded(parentId: string): boolean {
        return !!this.expandedParents[parentId];
    }

    actionLabel(status: TaskStatus): string {
        switch (status) {
            case '未着手':
                return '未着手';
            case '進行中':
                return '進行中！';
            case '完了':
                return '完了！';
        }
    }

    cycleAction(item: TodayItem, ev: Event): void {
        ev.stopPropagation();
        if (item.kind === 'parent') {
            this.appService.cycleParentTaskStatus(item.task.id);
        } else {
            this.appService.cycleChildTaskStatus(item.task.id);
        }
    }

    //子タスクのステータスを切り換える
    cycleChildAction(child: ChildTask, ev: Event): void {
        ev.stopPropagation();
        this.appService.cycleChildTaskStatus(child.id);
    }

    parentTitleForChild(parent: ParentTask): string {
        return `(From: ${parent.title || '（無題）'})`;
    }

    formatDeadline(deadline: Date | string | null): string {
        if (!deadline) return '期限未設定';
        const d = new Date(deadline);
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時まで`;
    }

    remainingLabel(deadline: Date | string | null): string {
        if (!deadline) return '';
        const end = new Date(deadline);
        const now = new Date();
        const endDay = new Date(end);
        endDay.setHours(0, 0, 0, 0);
        const nowDay = new Date(now);
        nowDay.setHours(0, 0, 0, 0);
        if (endDay.getTime() === nowDay.getTime()) {
            const ms = end.getTime() - now.getTime();
            if (ms > 0) {
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                if (h > 0) return `（残り${h}時間）`;
                if (m > 0) return `（残り${m}分）`;
                return '（まもなく）';
            }
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dayStart = new Date(end);
        dayStart.setHours(0, 0, 0, 0);
        const diff = Math.round((dayStart.getTime() - today.getTime()) / 86400000);
        if (diff > 0) return `（残り${diff}日）`;
        if (diff === 0) return '（本日まで）';
        return `（期限超過${Math.abs(diff)}日）`;
    }

    deadlineForItem(item: TodayItem): Date | string | null {
        return item.kind === 'parent' ? item.task.deadline : item.parent.deadline;
    }

    tooltipDescription(item: TodayItem): string {
        if (item.kind === 'parent') {
            const d = (item.task.description || '').trim();
            return d ? d : '（備考なし）';
        }
        const d = (item.parent.description || '').trim();
        return d ? d : '（備考なし）';
    }

    titleForItem(item: TodayItem): string {
        return item.kind === 'parent' ? item.task.title : item.task.title;
    }

    statusForItem(item: TodayItem): TaskStatus {
        return item.kind === 'parent' ? item.task.status : item.task.status;
    }

    statusClass(status: TaskStatus): string {
        switch (status) {
            case '未着手':
                return 'badge badge--todo';
            case '進行中':
                return 'badge badge--prog';
            case '完了':
                return 'badge badge--done';
            default:
                return 'badge';
        }
    }

    statusDotClass(status: TaskStatus): string {
        switch (status) {
            case '未着手':
                return 'today-status-dot today-status-dot--todo';
            case '進行中':
                return 'today-status-dot today-status-dot--prog';
            case '完了':
                return 'today-status-dot today-status-dot--done';
            default:
                return 'today-status-dot';
        }
    }

    isDoneItem(item: TodayItem): boolean {
        return this.statusForItem(item) === '完了';
    }

    scrollToTop(): void {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        this.rightMenuOpen = false;
    }

    initials(name: string): string {
        return name.trim().slice(0, 2);
    }

    toDatetimeLocal(deadline: Date | string | null): string {
        if (!deadline) return '';
        const x = new Date(deadline);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
    }

    membersOrderedForAvatar(task: ParentTask): Member[] {
        const ids = task.leadAssigneeId ? [task.leadAssigneeId, ...task.memberIds] : [...task.memberIds];
        return this.appService.getMembersByUids(ids);
    }

    getChildInput(parentId: string): { title: string; assigneeId: string } {
        if (!this.childInputs[parentId]) {
            this.childInputs[parentId] = { title: '', assigneeId: '' };
        }
        return this.childInputs[parentId];
    }

    addChildTask(parentTask: ParentTask): void {
        const draft = this.getChildInput(parentTask.id);
        this.appService.CreateChildTask(this.projectId, parentTask.id, draft.title, draft.assigneeId, false);
        draft.title = '';
        draft.assigneeId = '';
    }

    deleteParentTask(taskId: string): void {
        const t = this.appService.parentTasks.find((p) => p.id === taskId);
        if (!t || !this.isMyParent(t)) return;
        if (!confirm('この親タスクと紐づく子タスクをすべて削除しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        this.appService.deleteParentTask(taskId);
        if (this.parentTaskFilterId === taskId) this.parentTaskFilterId = 'all';
    }

    enterParentEdit(task: ParentTask, ev?: Event): void {
        ev?.stopPropagation();
        if (this.childEditId) this.cancelChildEdit();
        this.parentEditTaskId = task.id;
        this.parentEditDraft = {
            title: task.title,
            description: task.description ?? '',
            deadlineInput: this.toDatetimeLocal(task.deadline),
            selectionOrder: task.leadAssigneeId ? [task.leadAssigneeId, ...task.memberIds] : [],
            isUrgent: task.priority === '高'
        };
    }

    cancelParentEdit(): void {
        this.parentEditTaskId = null;
        this.parentEditDraft = null;
    }

    saveParentEdit(taskId: string): void {
        const d = this.parentEditDraft;
        if (!d) return;
        if (!d.title.trim()) {
            alert('タイトルを入力してください');
            return;
        }
        this.appService.patchParentTask(taskId, {
            title: d.title,
            description: d.description,
            deadline: d.deadlineInput ? new Date(d.deadlineInput) : null,
            priority: d.isUrgent ? '高' : '通常'
        });
        this.appService.setParentMemberOrder(taskId, d.selectionOrder);
        this.cancelParentEdit();
    }

    onDraftMemberChange(uid: string, checked: boolean): void {
        const draft = this.parentEditDraft;
        if (!draft) return;
        if (checked) {
            if (!draft.selectionOrder.includes(uid)) draft.selectionOrder.push(uid);
        } else {
            draft.selectionOrder = draft.selectionOrder.filter((id) => id !== uid);
        }
    }

    toggleDraftUrgent(): void {
        const d = this.parentEditDraft;
        if (!d) return;
        d.isUrgent = !d.isUrgent;
    }

    isMemberCheckedInDraft(uid: string): boolean {
        return !!this.parentEditDraft?.selectionOrder.includes(uid);
    }

    enterChildEdit(c: ChildTask, ev?: Event): void {
        ev?.stopPropagation();
        if (this.parentEditTaskId) this.cancelParentEdit();
        this.childEditId = c.id;
        this.childEditDraft = { title: c.title, assigneeId: c.assigneeId };
    }

    cancelChildEdit(): void {
        this.childEditId = null;
        this.childEditDraft = null;
    }

    saveChildEdit(childId: string): void {
        const d = this.childEditDraft;
        if (!d || !d.title.trim()) {
            alert('子タスクのタイトルを入力してください');
            return;
        }
        if (!d.assigneeId) {
            alert('担当メンバーを選択してください');
            return;
        }
        this.appService.patchChildTask(childId, { title: d.title, assigneeId: d.assigneeId });
        this.cancelChildEdit();
    }

    deleteChildTask(childId: string): void {
        if (!confirm('この子タスクを削除しますか？')) return;
        if (this.childEditId === childId) this.cancelChildEdit();
        this.appService.deleteChildTask(childId);
    }

    toggleUrgent(): void {
        this.isUrgent = !this.isUrgent;
    }

    toggleRightMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.rightMenuOpen = !this.rightMenuOpen;
    }

    closeRightMenu(): void {
        this.rightMenuOpen = false;
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(ev: MouseEvent): void {
        if (!this.rightMenuOpen) return;
        const t = ev.target as HTMLElement;
        if (t.closest('.side-drawer') || t.closest('.icon-gear-wrap')) return;
        this.rightMenuOpen = false;
    }

    showSiren(item: TodayItem): boolean {
        return item.kind === 'parent' && item.task.priority === '高';
    }
}
