import { Component, HostListener, inject } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ParentTask, Member, TaskStatus, ChildTask } from '../../core/interface';

type ParentEditDraft = {
    title: string;
    description: string;
    deadlineInput: string;
    selectionOrder: string[];
    isUrgent: boolean;
};

type ChildEditDraft = { title: string; assigneeId: string };

@Component({
    selector: 'app-limit-tasks',
    standalone: true,
    imports: [FormsModule, CommonModule, RouterLink],
    templateUrl: './limit-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css']
})
export class LimitTasksComponent {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    readonly memberId = this.route.snapshot.params['memberId'] as string;

    projectName = this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';

    title = '';
    deadlineInput = '';
    isUrgent = false;
    description = '';
    /** 左フォーム：確定時に親の isTodayTask に反映 */
    isCreateToday = false;

    parentTaskFilterId: string | 'all' = 'all';
    viewMode = 0;
    incompleteSectionOpen = false;

    childInputs: Record<string, { title: string; assigneeId: string; isTodayForNew: boolean }> = {};

    rightMenuOpen = false;
    parentEditTaskId: string | null = null;
    parentEditDraft: ParentEditDraft | null = null;
    childEditId: string | null = null;
    childEditDraft: ChildEditDraft | null = null;
    sidebarIncompleteEditId: string | null = null;
    sidebarIncompleteDraft: ParentEditDraft | null = null;

    get users(): Member[] {
        return this.appService.getMembersByProjectId(this.projectId);
    }

    get memberDisplayName(): string {
        return this.appService.getMemberById(this.memberId)?.name ?? '';
    }

    /** このメンバーが関与する親タスクのみ */
    isTaskVisibleToMember(t: ParentTask): boolean {
        if (t.leadAssigneeId === this.memberId) return true;
        if (t.memberIds.includes(this.memberId)) return true;
        return this.appService.getChildTasksByParentId(t.id).some((c) => c.assigneeId === this.memberId);
    }

    /** MY = 担当責任者 or 作成者 */
    isMyTask(task: ParentTask): boolean {
        if (task.leadAssigneeId === this.memberId) return true;
        return task.createdById === this.memberId;
    }

    get parentTasksForFilter(): ParentTask[] {
        return [...this.appService.getAllParentTasksForProject(this.projectId)]
            .filter((t) => this.isTaskVisibleToMember(t))
            .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
    }

    get visibleParentTasks(): ParentTask[] {
        let tasks = this.appService
            .getSortedParentTasksForProject(this.projectId, false)
            .filter((t) => this.isTaskVisibleToMember(t));
        if (this.parentTaskFilterId !== 'all') {
            tasks = tasks.filter((t) => t.id === this.parentTaskFilterId);
        }
        return tasks;
    }

    get viewModeLabel(): string {
        const labels = ['全未入力タスク一覧', '期限未入力タスク', '担当者未入力タスク'];
        return labels[this.viewMode];
    }

    get filteredIncompleteTasks(): ParentTask[] {
        const pool = this.appService.parentTasks.filter(
            (t) =>
                t.projectId === this.projectId &&
                t.isDraft &&
                (t.leadAssigneeId === this.memberId || t.createdById === this.memberId)
        );
        if (this.viewMode === 1) return pool.filter((t) => !t.deadline);
        if (this.viewMode === 2) return pool.filter((t) => !t.leadAssigneeId);
        return pool;
    }

    toggleViewMode(): void {
        this.viewMode = (this.viewMode + 1) % 3;
    }

    toggleUrgent(): void {
        this.isUrgent = !this.isUrgent;
    }

    toggleCreateToday(): void {
        this.isCreateToday = !this.isCreateToday;
    }

    toggleChildInputToday(parentId: string): void {
        const d = this.getChildInput(parentId);
        d.isTodayForNew = !d.isTodayForNew;
    }

    getChildInput(parentId: string): { title: string; assigneeId: string; isTodayForNew: boolean } {
        if (!this.childInputs[parentId]) {
            this.childInputs[parentId] = { title: '', assigneeId: '', isTodayForNew: false };
        }
        return this.childInputs[parentId];
    }

    createParentTask(): void {
        const deadline = this.deadlineInput ? new Date(this.deadlineInput) : null;
        if(!deadline){
            alert('期限を入力してください');
            return;
        }
        this.appService.CreateParentTask(
            this.projectId,
            this.title,
            deadline,
            this.isUrgent,
            this.memberId,
            [],
            false,
            this.description,
            this.isCreateToday,
            this.memberId
        );
        this.title = '';
        this.deadlineInput = '';
        this.isUrgent = false;
        this.description = '';
        this.isCreateToday = false;
    }

    addChildTask(parentTask: ParentTask): void {
        const draft = this.getChildInput(parentTask.id);
        this.appService.CreateChildTask(
            this.projectId,
            parentTask.id,
            draft.title,
            draft.assigneeId,
            draft.isTodayForNew
        );
        draft.title = '';
        draft.assigneeId = '';
        draft.isTodayForNew = false;
    }

    leadMember(task: ParentTask): Member | undefined {
        return this.appService.getMemberById(task.leadAssigneeId);
    }

    memberList(task: ParentTask): Member[] {
        return this.appService.getMembersByUids(task.memberIds);
    }

    membersOrderedForAvatar(task: ParentTask): Member[] {
        const ids = task.leadAssigneeId ? [task.leadAssigneeId, ...task.memberIds] : [...task.memberIds];
        return this.appService.getMembersByUids(ids);
    }

    formatDeadline(deadline: Date | string | null): string {
        if (!deadline) return '期限未設定';
        const d = new Date(deadline);
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時まで`;
    }

    /** 当日なら残り時間、それ以外は日数ベース */
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

    tooltipDescription(task: ParentTask): string {
        const d = (task.description || '').trim();
        return d ? d : '（備考なし）';
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

    childStatusChipClass(status: TaskStatus): string {
        return `subtask-status-readonly ${this.statusClass(status)}`;
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

    private buildParentDraft(task: ParentTask): ParentEditDraft {
        return {
            title: task.title,
            description: task.description ?? '',
            deadlineInput: this.toDatetimeLocal(task.deadline),
            selectionOrder: task.leadAssigneeId ? [task.leadAssigneeId, ...task.memberIds] : [],
            isUrgent: task.priority === '高'
        };
    }

    enterParentEdit(task: ParentTask, ev?: Event): void {
        ev?.stopPropagation();
        if (this.childEditId) this.cancelChildEdit();
        this.sidebarIncompleteEditId = null;
        this.sidebarIncompleteDraft = null;
        this.parentEditTaskId = task.id;
        this.parentEditDraft = this.buildParentDraft(task);
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

    onDraftMemberChange(ctx: 'main' | 'sidebar', uid: string, checked: boolean): void {
        const draft = ctx === 'main' ? this.parentEditDraft : this.sidebarIncompleteDraft;
        if (!draft) return;
        if (checked) {
            if (!draft.selectionOrder.includes(uid)) draft.selectionOrder.push(uid);
        } else {
            draft.selectionOrder = draft.selectionOrder.filter((id) => id !== uid);
        }
    }

    toggleDraftUrgent(ctx: 'main' | 'sidebar'): void {
        const d = ctx === 'main' ? this.parentEditDraft : this.sidebarIncompleteDraft;
        if (!d) return;
        d.isUrgent = !d.isUrgent;
    }

    deleteParentTask(taskId: string): void {
        const t = this.appService.parentTasks.find((p) => p.id === taskId);
        if (!t || !this.isMyTask(t)) return;
        if (!confirm('この親タスクと紐づく子タスクをすべて削除しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        this.appService.deleteParentTask(taskId);
        if (this.parentTaskFilterId === taskId) this.parentTaskFilterId = 'all';
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

    toggleParentToday(task: ParentTask, ev: MouseEvent): void {
        ev.stopPropagation();
        this.appService.toggleParentTodayTask(task.id);
    }

    toggleChildToday(c: ChildTask, ev: MouseEvent): void {
        ev.stopPropagation();
        this.appService.toggleChildTodayTask(c.id);
    }

    startSidebarIncompleteEdit(task: ParentTask): void {
        this.parentEditTaskId = null;
        this.parentEditDraft = null;
        this.sidebarIncompleteEditId = task.id;
        this.sidebarIncompleteDraft = this.buildParentDraft(task);
    }

    cancelSidebarIncompleteEdit(): void {
        this.sidebarIncompleteEditId = null;
        this.sidebarIncompleteDraft = null;
    }

    saveSidebarIncomplete(taskId: string): void {
        const d = this.sidebarIncompleteDraft;
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
        this.cancelSidebarIncompleteEdit();
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

    isMemberCheckedInDraft(draft: ParentEditDraft | null, uid: string): boolean {
        return !!draft?.selectionOrder.includes(uid);
    }
}
