import { Component, effect, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ParentTask, Member, TaskStatus, ChildTask, MENTION_ALL, MENTION_ADMIN } from '../../core/interface';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MemberNavLinksComponent } from './member-nav-links';
import { ProgressReportingService } from '../../services/progress-reporting.service';
import { AiChatService } from '../../services/ai-chat.service';
import { StorageService } from '../../services/storage.service';
import {
    confirmMemberTaskChangeBubble,
    readPendingMemberTaskChangeBubble,
    watchMemberTaskChangeBundle
} from './member-task-change-bubble';
import { AuthSessionService } from '../../services/auth-session.service';
import { Router } from '@angular/router';
import { MemberTaskRouteContext } from './member-task-route-context';
import { MemberAccessService } from '../../services/member-access.service';
import { ProgressMemberShellComponent } from '../../shared/progress-member-shell/progress-member-shell.component';
import { MemberProgressBubblesComponent } from '../../shared/member-progress-bubbles/member-progress-bubbles.component';
import { ParentTeamProgressStripComponent } from '../../shared/parent-team-progress-strip/parent-team-progress-strip.component';
import {
    TaskSearchFilterToolbarComponent,
    type TaskListScopeMode
} from '../../shared/task-search-filter-toolbar/task-search-filter-toolbar.component';
import { memberIsInvolvedInParent } from '../../core/project-permissions.util';
import { ProjectTopMenuComponent } from '../../shared/project-top-menu/project-top-menu';
import { DrawerLogoutComponent } from '../../shared/drawer-logout/drawer-logout';
import { CharacterVideoDockComponent } from '../../shared/character-video-dock/character-video-dock.component';
import { showProjectTopMemberEdit } from '../../shared/project-top-menu/project-top-menu.util';
import {
    canReorderList,
    defaultToolbarFilterState,
    parentMatchesToolbarFilters,
    removeParentIdFromFilter,
    type TaskToolbarFilterState,
    type ToolbarFilterContext
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';

type ParentEditDraft = {
    title: string;
    description: string;
    deadlineInput: string;
    selectionOrder: string[];
    isUrgent: boolean;
    mentionUserIds: string[];
};

type ChildEditDraft = { title: string; assigneeId: string; scheduledDateStr: string };

@Component({
    selector: 'app-limit-tasks',
    standalone: true,
    imports: [
        FormsModule,
        CommonModule,
        DragDropModule,
        MemberNavLinksComponent,
        ProgressMemberShellComponent,
        MemberProgressBubblesComponent,
        ParentTeamProgressStripComponent,
        TaskSearchFilterToolbarComponent,
        ProjectTopMenuComponent,
        DrawerLogoutComponent,
        CharacterVideoDockComponent
    ],
    templateUrl: './limit-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', '../../progress-ai.css']
})
export class LimitTasksComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    readonly progress = inject(ProgressReportingService);
    readonly aiChat = inject(AiChatService);
    private readonly storage = inject(StorageService);
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);
    private readonly memberAccess = inject(MemberAccessService);

    private readonly ctx = new MemberTaskRouteContext(this.route, this.appService, this.auth, this.router);

    private readonly memberRouteGuardEffect = effect(() => {
        void this.appService.ready();
        void this.appService.notificationTick();
        this.ctx.ensureMemberAccess(this.memberAccess);
    });

    get projectId(): string {
        return this.ctx.projectId;
    }

    get memberId(): string {
        return this.ctx.memberId;
    }

    navLinkMode(): 'member' | 'adminSelf' | 'personal' {
        if (this.ctx.mode === 'personal') return 'personal';
        if (this.ctx.mode === 'adminSelf') return 'adminSelf';
        return 'member';
    }

    suppressMemberProgressChrome(): boolean {
        if (this.ctx.mode === 'personal') return true;
        if (this.ctx.mode === 'adminSelf') {
            return !this.appService.memberHasInProgressTaskInvolvement(this.projectId, this.memberId);
        }
        return false;
    }

    hideStagnationInToolbar(): boolean {
        return this.ctx.mode === 'personal';
    }

    showMyTaskMentionToolbar(): boolean {
        return this.ctx.mode !== 'personal';
    }

    showAdminMentionOption(): boolean {
        return this.ctx.mode === 'team';
    }

    get projectName(): string {
        if (this.ctx.mode === 'personal') {
            return this.appService.getProjectDisplayName(this.projectId);
        }
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get limitPageMainTitle(): string {
        return this.ctx.mode === 'personal' ? '自分用ToDo一覧' : '担当するタスク一覧';
    }

    get characterDockBubbleOpen(): boolean {
        return this.characterBubbleVisible || this.characterHoverHint;
    }

    get characterDockBubbleLine(): string {
        if (this.characterBubbleVisible) return this.characterBubbleText;
        if (this.characterHoverHint) return LimitTasksComponent.CHARACTER_HOVER_HINT;
        return '';
    }

    onCharacterDockPointerEnter(): void {
        if (this.characterBubbleVisible) return;
        this.characterHoverHint = true;
    }

    onCharacterDockPointerLeave(): void {
        this.characterHoverHint = false;
    }

    readonly characterVideoSrc = 'assets/character-typing.mp4';
    private static readonly CHARACTER_HOVER_HINT = '話し聞くよ？';
    characterBubbleVisible = false;
    characterBubbleText = '';
    characterHoverHint = false;
    memberTaskChangeConfirm = false;
    private characterShowTimerId: number | null = null;
    private characterHideTimerId: number | null = null;
    private taskChangeUnsub: (() => void) | null = null;

    title = '';
    deadlineInput = '';
    isUrgent = false;
    description = '';

    mentionPopoverOpen = false;
    mentionUserIds: string[] = [];
    readonly TOK_ALL = MENTION_ALL;
    readonly TOK_ADMIN = MENTION_ADMIN;

    toolbarFilter: TaskToolbarFilterState = defaultToolbarFilterState();
    /** チーム limit-tasks: デフォルトは関与のみ（訪問ごとにリセット） */
    taskListScope: TaskListScopeMode = 'involved';
    viewMode = 0;
    incompleteSectionOpen = false;

    childInputs: Record<string, { title: string; assigneeId: string; isTodayForNew: boolean; scheduledDateStr: string }> = {};

    /** 親の子一覧が 3 件以上のときの折りたたみ（today と同仕様） */
    expandedSubChildren: Record<string, boolean> = {};

    ngOnInit(): void {
        if (!this.ctx.ensureMemberAccess(this.memberAccess)) return;
        this.taskListScope = this.isTeamGuestViewer() ? 'all' : 'involved';
        this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, 'limit');
        this.appService.clearMemberPageNotifications(this.projectId, this.memberId, 'limit');
        this.progress.ensureProgressRoundForProject(this.projectId);
        this.taskChangeUnsub = watchMemberTaskChangeBundle(this.storage, this.projectId, this.memberId, () => {
            this.refreshMemberTaskChangeBubbleFromStorage();
        });
        this.refreshMemberTaskChangeBubbleFromStorage();
        this.startCharacterBubbleLoop();
    }

    ngOnDestroy(): void {
        this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, null);
        this.taskChangeUnsub?.();
        this.taskChangeUnsub = null;
        this.clearCharacterBubbleTimers();
    }

    openCharacterOlChat(): void {
        this.aiChat.openChat(this.projectId, this.memberId);
        this.progress.onAiSessionStarted(this.projectId, this.memberId);
    }

    progressBubblesForChild(task: ParentTask, child: ChildTask) {
        return this.progress.bubblesForChildRow(this.projectId, task, child.id, null, child.assigneeId ?? null);
    }

    progressAssigneeBubbleForChild(_task: ParentTask, child: ChildTask) {
        return this.progress.bubblesForChildAssigneeDisplay(this.projectId, child);
    }

    progressBubblesParentOnly(task: ParentTask) {
        return this.progress.bubblesForParentOnly(this.projectId, task, null);
    }


    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        return this.appService.getMemberGearNotificationTotal(this.projectId, this.memberId);
    }

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

    get mentionableUsers(): Member[] {
        return this.users.filter((u) => u.uid !== this.memberId);
    }

    get headerSelfBubbles() {
        return this.progress.bubblesForMemberHeaderDisplay(this.projectId, this.memberId);
    }

    isTeamGuestViewer(): boolean {
        return this.ctx.mode === 'team' && this.appService.isProjectGuest(this.projectId, this.memberId);
    }

    showTaskListScopeFilter(): boolean {
        return this.ctx.mode === 'team' && !this.isTeamGuestViewer();
    }

    onTaskListScopeChange(scope: TaskListScopeMode): void {
        this.taskListScope = scope;
    }

    /** このメンバーが関与する親タスクのみ */
    isTaskVisibleToMember(t: ParentTask): boolean {
        if (this.appService.isPrivateMyHiddenFromOtherMember(t, this.memberId)) return false;
        const childIds = this.appService.getChildTasksByParentId(t.id).map((c) => c.assigneeId);
        return memberIsInvolvedInParent(t, this.memberId, childIds);
    }

    /** 一覧上で編集・操作できるか（ゲスト／非関与は閲覧のみ） */
    canEditTaskOnPage(task: ParentTask): boolean {
        if (this.isTeamGuestViewer()) return false;
        if (this.ctx.mode === 'personal' || this.ctx.mode === 'adminSelf') return true;
        if (this.taskListScope === 'all' && !this.isTaskVisibleToMember(task)) return false;
        return true;
    }

    isParentReadOnlyOnPage(task: ParentTask): boolean {
        return !this.canEditTaskOnPage(task);
    }

    /** MY = 作成者(createdById)のみ */
    isMyTask(task: ParentTask): boolean {
        return task.createdById === this.memberId;
    }

    get baseVisibleParentTasks(): ParentTask[] {
        const sorted = this.appService.getActiveSortedParentTasksForProject(this.projectId);
        if (this.ctx.mode === 'team' && (this.taskListScope === 'all' || this.isTeamGuestViewer())) {
            return sorted.filter((t) => !this.appService.isPrivateMyHiddenFromOtherMember(t, this.memberId));
        }
        return sorted.filter((t) => this.isTaskVisibleToMember(t));
    }

    get visibleParentTasks(): ParentTask[] {
        return this.baseVisibleParentTasks.filter((t) =>
            parentMatchesToolbarFilters(this.toolbarFilterCtx(), t, this.toolbarFilter, 'member')
        );
    }

    get toolbarCandidateParents(): ParentTask[] {
        return this.baseVisibleParentTasks;
    }

    private toolbarFilterCtx(): ToolbarFilterContext {
        return {
            app: this.appService,
            projectId: this.projectId,
            hasOpenStagnationForTask: (parentTaskId, childTaskId) =>
                this.progress.hasOpenStagnationForTask(this.projectId, parentTaskId, childTaskId)
        };
    }

    /** 個人ワークスペースのみ: 進捗アイコン・吹き出し・担当UIを非表示 */
    get showProjectTopMemberEdit(): boolean {
        return showProjectTopMemberEdit(this.appService, this.ctx.mode, this.projectId, this.memberId);
    }

    hideTeamTaskChrome(): boolean {
        return this.ctx.mode === 'personal';
    }

    parentListDragEnabled(): boolean {
        if (this.taskListScope === 'all') return false;
        return canReorderList(this.toolbarFilter);
    }

    onParentSortPick(kind: 'deadline' | 'status'): void {
        if (kind === 'deadline') {
            this.appService.resetParentListSortToDeadline(this.projectId);
        } else {
            this.appService.resetParentListSortToStatus(this.projectId);
        }
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

    toggleChildInputToday(parentId: string): void {
        const d = this.getChildInput(parentId);
        d.isTodayForNew = !d.isTodayForNew;
    }

    toggleSubtasksExpand(parentId: string, ev: Event): void {
        ev.stopPropagation();
        this.expandedSubChildren[parentId] = !this.expandedSubChildren[parentId];
    }

    isSubtasksExpanded(parentId: string): boolean {
        return !!this.expandedSubChildren[parentId];
    }

    visibleChildRowsForParent(parent: ParentTask): ChildTask[] {
        const all = this.appService.getWorkViewChildTasksByParentId(parent.id);
        if (all.length < 3) return all;
        if (this.isSubtasksExpanded(parent.id)) return all;
        return all.slice(0, 2);
    }

    moreSubtasksHiddenCount(parent: ParentTask): number {
        const n = this.appService.getWorkViewChildTasksByParentId(parent.id).length;
        return n >= 3 ? n - 2 : 0;
    }

    childAssigneeMember(c: ChildTask): Member | undefined {
        return c.assigneeId ? this.appService.getMemberById(c.assigneeId) : undefined;
    }

    revertChildFromComplete(c: ChildTask, ev?: Event): void {
        ev?.stopPropagation();
        if (this.isTeamGuestViewer()) return;
        this.appService.revertChildTaskFromComplete(c.id, this.memberId);
    }

    getChildInput(parentId: string): {
        title: string;
        assigneeId: string;
        isTodayForNew: boolean;
        scheduledDateStr: string;
    } {
        if (!this.childInputs[parentId]) {
            this.childInputs[parentId] = {
                title: '',
                assigneeId: this.hideTeamTaskChrome() ? this.memberId : '',
                isTodayForNew: false,
                scheduledDateStr: ''
            };
        }
        return this.childInputs[parentId];
    }

    /** 個人ワークスペース：本日 23:59:59（not-set / today-tasks と同じ） */
    private personalEndOfToday(): Date {
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        return end;
    }

    private resetCreateForm(): void {
        this.title = '';
        this.deadlineInput = '';
        this.isUrgent = false;
        this.description = '';
        this.mentionUserIds = [];
        this.mentionPopoverOpen = false;
    }

    /** 個人のみ：期限未入力可。期限ありは通常の MY タスクとして登録 */
    createParentTask(): void {
        const deadline = this.deadlineInput?.trim() ? new Date(this.deadlineInput) : null;
        if (!this.hideTeamTaskChrome() && !deadline) {
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
            this.description,
            false,
            this.memberId,
            this.mentionUserIds
        );
        this.resetCreateForm();
    }

    /** 個人のみ：期限を今日にして今日やることへ（入力欄の期限は使わない） */
    createParentTaskAsToday(): void {
        if (!this.hideTeamTaskChrome()) return;
        this.appService.CreateParentTask(
            this.projectId,
            this.title,
            this.personalEndOfToday(),
            this.isUrgent,
            this.memberId,
            [],
            this.description,
            true,
            this.memberId,
            this.mentionUserIds
        );
        this.resetCreateForm();
    }

    toggleCreateMention(id: string, checked: boolean): void {
        if (checked) {
            if (!this.mentionUserIds.includes(id)) this.mentionUserIds.push(id);
        } else {
            this.mentionUserIds = this.mentionUserIds.filter((x) => x !== id);
        }
    }

    isCreateMentionOn(id: string): boolean {
        return this.mentionUserIds.includes(id);
    }

    newChildTodayPillOn(parentId: string): boolean {
        const d = this.getChildInput(parentId);
        return d.isTodayForNew || this.appService.isIsoDateStringToday(d.scheduledDateStr);
    }

    addChildTask(parentTask: ParentTask): void {
        const draft = this.getChildInput(parentTask.id);
        const assigneeId = this.hideTeamTaskChrome() ? this.memberId : draft.assigneeId;
        if (!this.hideTeamTaskChrome() && !this.getAssignableMemberIds(parentTask).includes(assigneeId)) {
            alert('親タスクの担当・メンバーから担当者を選択してください');
            return;
        }
        const sd = draft.scheduledDateStr?.trim() ? draft.scheduledDateStr : null;
        const effToday = draft.isTodayForNew || this.appService.isIsoDateStringToday(draft.scheduledDateStr);

        this.appService.CreateChildTask(
            this.projectId,
            parentTask.id,
            draft.title,
            assigneeId,
            effToday,
            sd,
            this.memberId
        );
        draft.title = '';
        draft.assigneeId = '';
        draft.isTodayForNew = false;
        draft.scheduledDateStr = '';
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

    getAssignableMemberIds(parentTask: ParentTask): string[] {
        const ids = parentTask.leadAssigneeId ? [parentTask.leadAssigneeId, ...parentTask.memberIds] : [...parentTask.memberIds];
        return [...new Set(ids)];
    }

    getAssignableMembers(parentTask: ParentTask): Member[] {
        return this.appService.getMembersByUids(this.getAssignableMemberIds(parentTask));
    }

    getAssignableMembersByParentId(parentTaskId: string): Member[] {
        const parent = this.appService.parentTasks.find((p) => p.id === parentTaskId);
        if (!parent) return [];
        return this.getAssignableMembers(parent);
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

    parentDlClass(task: ParentTask): string {
        return this.appService.parentDeadlineCardClass(task.deadline);
    }

    childSchedRange(task: ParentTask): { min: string; max: string } | null {
        return this.appService.childScheduledDateRangeIso(task);
    }

    toDateOnlyIso(val: Date | string | null | undefined): string {
        if (val === null || val === undefined) return '';
        const x = new Date(val);
        if (Number.isNaN(x.getTime())) return '';
        const p = (n: number) => String(n).padStart(2, '0');
        return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
    }

    formatScheduledShort(val: Date | string | null | undefined): string {
        const s = this.toDateOnlyIso(val);
        return s ? s.replace(/-/g, '/') : '';
    }

    onParentDrop(ev: CdkDragDrop<void>): void {
        const base = [...this.baseVisibleParentTasks];
        const visible = this.visibleParentTasks;
        if (ev.previousIndex === ev.currentIndex) return;
        const dragged = visible[ev.previousIndex];
        if (!dragged) return;
        const fromIdx = base.findIndex((p) => p.id === dragged.id);
        const target = visible[ev.currentIndex];
        const toIdx = target ? base.findIndex((p) => p.id === target.id) : base.length - 1;
        if (fromIdx < 0 || toIdx < 0) return;
        moveItemInArray(base, fromIdx, toIdx);
        this.appService.applyParentTaskReorder(this.projectId, base);
        this.appService.notifyTaskListReordered(this.projectId, this.memberId);
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
            isUrgent: task.priority === '高',
            mentionUserIds: [...(task.mentionUserIds ?? [])]
        };
    }

    enterParentEdit(task: ParentTask, ev?: Event): void {
        ev?.stopPropagation();
        if (this.isParentReadOnlyOnPage(task)) return;
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
        this.appService.saveParentTaskEditBundle(
            taskId,
            {
                title: d.title,
                description: d.description,
                deadline: d.deadlineInput ? new Date(d.deadlineInput) : null,
                priority: d.isUrgent ? '高' : '通常',
                mentionUserIds: [...d.mentionUserIds],
                selectionOrder: [...d.selectionOrder]
            },
            this.memberId
        );
        this.cancelParentEdit();
    }

    toggleDraftMention(ctx: 'main' | 'sidebar', id: string, checked: boolean): void {
        const draft = ctx === 'main' ? this.parentEditDraft : this.sidebarIncompleteDraft;
        if (!draft) return;
        if (checked) {
            if (!draft.mentionUserIds.includes(id)) draft.mentionUserIds.push(id);
        } else {
            draft.mentionUserIds = draft.mentionUserIds.filter((x) => x !== id);
        }
    }

    isDraftMentionOn(draft: ParentEditDraft | null, id: string): boolean {
        return !!draft?.mentionUserIds.includes(id);
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
        if (!t || !this.appService.memberCanDeleteParent(t, this.memberId)) return;
        if (!confirm('この親タスクと紐づく子タスクをすべてゴミ箱に移しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        this.appService.trashParentTask(taskId, this.memberId);
        this.toolbarFilter = removeParentIdFromFilter(this.toolbarFilter, taskId);
    }

    enterChildEdit(c: ChildTask, ev?: Event): void {
        ev?.stopPropagation();
        if (c.status === '完了') return;
        const parent = this.appService.parentTasks.find((p) => p.id === c.parentTaskId);
        if (!parent || this.isParentReadOnlyOnPage(parent)) return;
        if (this.parentEditTaskId) this.cancelParentEdit();
        this.childEditId = c.id;
        this.childEditDraft = {
            title: c.title,
            assigneeId: c.assigneeId,
            scheduledDateStr: this.toDateOnlyIso(c.scheduledDate)
        };
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
        const assigneeId = this.hideTeamTaskChrome() ? this.memberId : d.assigneeId;
        if (!this.hideTeamTaskChrome()) {
            if (!assigneeId) {
                alert('担当メンバーを選択してください');
                return;
            }
            const child = this.appService.childTasks.find((c) => c.id === childId);
            if (!child || !this.getAssignableMembersByParentId(child.parentTaskId).some((m) => m.uid === assigneeId)) {
                alert('親タスクの担当・メンバーから担当者を選択してください');
                return;
            }
        }
        this.appService.patchChildTask(
            childId,
            {
                title: d.title,
                assigneeId,
                scheduledDate: d.scheduledDateStr?.trim() ? d.scheduledDateStr : null
            },
            { actorMemberUid: this.memberId }
        );
        this.cancelChildEdit();
    }

    deleteChildTask(childId: string): void {
        const c = this.appService.childTasks.find((x) => x.id === childId);
        const parent = c ? this.appService.parentTasks.find((p) => p.id === c.parentTaskId) : undefined;
        if (!c || !parent || !this.appService.memberCanDeleteChild(parent, c, this.memberId)) return;
        if (!confirm('この子タスクをゴミ箱に移しますか？')) return;
        if (this.childEditId === childId) this.cancelChildEdit();
        this.appService.trashChildTask(childId, this.memberId);
    }

    toggleParentToday(task: ParentTask, ev: MouseEvent): void {
        ev.stopPropagation();
        const wasOn = task.isTodayTask;
        this.appService.toggleParentTodayTask(task.id, this.memberId);
        const p = this.appService.parentTasks.find((x) => x.id === task.id);
        if (wasOn && p && !p.isTodayTask) {
            const ids = this.progress
                .openStagnations(this.projectId, this.memberId)
                .filter((s) => s.parentTaskId === task.id)
                .map((s) => s.id);
            if (ids.length) {
                this.progress.resolveStagnation(this.projectId, this.memberId, ids);
            }
        }
    }

    toggleChildToday(c: ChildTask, ev: MouseEvent): void {
        ev.stopPropagation();
        const wasOn = c.isTodayTask;
        this.appService.toggleChildTodayTask(c.id, this.memberId);
        const fresh = this.appService.childTasks.find((x) => x.id === c.id);
        if (wasOn && fresh && !fresh.isTodayTask) {
            const ids = this.progress
                .openStagnations(this.projectId, this.memberId)
                .filter((s) => s.parentTaskId === c.parentTaskId && s.childTaskId === c.id)
                .map((s) => s.id);
            if (ids.length) {
                this.progress.resolveStagnation(this.projectId, this.memberId, ids);
            }
        }
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

    /** 子タスクが無いときのみ親のステータス操作ボタンを表示 */
    showParentStatusButton(parent: ParentTask): boolean {
        return this.appService.getChildTasksByParentId(parent.id).length === 0;
    }

    cycleParentFromCard(task: ParentTask, ev: Event): void {
        ev.stopPropagation();
        if (this.blockCompletionForParent(task)) return;
        this.appService.cycleParentTaskStatus(task.id, this.memberId);
    }

    cycleChildFromRow(child: ChildTask, ev: Event): void {
        ev.stopPropagation();
        if (this.blockCompletionForChild(child)) return;
        this.appService.cycleChildTaskStatus(child.id, this.memberId);
    }

    private blockCompletionForParent(task: ParentTask): boolean {
        if (task.status !== '進行中') return false;
        if (this.progress.hasOpenStagnationForTask(this.projectId, task.id, null)) {
            alert('この親タスクに停滞報告があります。先に解決してから完了にしてください。');
            return true;
        }
        const children = this.appService.getChildTasksByParentId(task.id);
        for (const c of children) {
            if (this.progress.hasOpenStagnationForTask(this.projectId, task.id, c.id)) {
                alert('子タスクに停滞報告があります。先に解決してから完了にしてください。');
                return true;
            }
        }
        return false;
    }

    private blockCompletionForChild(child: ChildTask): boolean {
        if (child.status !== '進行中') return false;
        if (this.progress.hasOpenStagnationForTask(this.projectId, child.parentTaskId, child.id)) {
            alert('停滞報告があります。先に解決してから完了にしてください。');
            return true;
        }
        return false;
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
        this.appService.saveParentTaskEditBundle(
            taskId,
            {
                title: d.title,
                description: d.description,
                deadline: d.deadlineInput ? new Date(d.deadlineInput) : null,
                priority: d.isUrgent ? '高' : '通常',
                mentionUserIds: [...d.mentionUserIds],
                selectionOrder: [...d.selectionOrder]
            },
            this.memberId
        );
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
        const t = ev.target as HTMLElement;
        if (!t.closest('.mention-toolbar')) {
            this.mentionPopoverOpen = false;
        }
        if (!this.rightMenuOpen) return;
        if (t.closest('.side-drawer') || t.closest('.icon-gear-wrap')) return;
        this.rightMenuOpen = false;
    }

    isMemberCheckedInDraft(draft: ParentEditDraft | null, uid: string): boolean {
        return !!draft?.selectionOrder.includes(uid);
    }

    private startCharacterBubbleLoop(): void {
        if (typeof window === 'undefined') return;
        this.scheduleCharacterBubble();
    }

    private refreshMemberTaskChangeBubbleFromStorage(): void {
        const pending = readPendingMemberTaskChangeBubble(this.storage, this.projectId, this.memberId);
        if (!pending) {
            this.memberTaskChangeConfirm = false;
            return;
        }
        this.clearCharacterBubbleTimers();
        this.characterBubbleText = pending.text;
        this.characterBubbleVisible = true;
        this.memberTaskChangeConfirm = true;
    }

    confirmMemberTaskChangeRead(): void {
        confirmMemberTaskChangeBubble(this.storage, this.projectId, this.memberId);
        this.memberTaskChangeConfirm = false;
        this.characterBubbleVisible = false;
        this.scheduleCharacterBubble();
    }

    private scheduleCharacterBubble(): void {
        if (this.memberTaskChangeConfirm) return;
        this.clearCharacterBubbleTimers();
        const waitMs = 30000 + Math.floor(Math.random() * 30001);
        this.characterShowTimerId = window.setTimeout(() => {
            this.characterBubbleText = this.buildCharacterBubbleText();
            this.characterBubbleVisible = true;
            const showMs = 4500 + Math.floor(Math.random() * 2501);
            this.characterHideTimerId = window.setTimeout(() => {
                this.characterBubbleVisible = false;
                this.scheduleCharacterBubble();
            }, showMs);
        }, waitMs);
    }

    private clearCharacterBubbleTimers(): void {
        if (this.characterShowTimerId !== null) {
            window.clearTimeout(this.characterShowTimerId);
            this.characterShowTimerId = null;
        }
        if (this.characterHideTimerId !== null) {
            window.clearTimeout(this.characterHideTimerId);
            this.characterHideTimerId = null;
        }
    }

    private buildCharacterBubbleText(): string {
        const st = this.progress.getMemberState(this.projectId, this.memberId);
        if (!st?.bubbleShort) {
            return '今日も一歩ずつ、進めていきましょう。';
        }
        if (st.bubbleShort === '停滞中！') {
            const stagnations = this.progress.openStagnations(this.projectId, this.memberId);
            const latest = stagnations.length ? stagnations[stagnations.length - 1] : null;
            const detail = (latest?.reason || st.detailForHover || '停滞理由を整理中です。').trim();
            return `停滞内容: ${detail}`;
        }
        if (st.bubbleShort === '考え中') {
            const detail = (st.thinkingDetailLong || st.thinkingChatSnippet || st.detailForHover || '考え中です。').trim();
            return `考え中メモ: ${detail}`;
        }
        if (st.bubbleShort === '問題なし' || st.bubbleShort === 'もう終わる') {
            return '順調です！この調子でいきましょう。';
        }
        return (st.detailForHover || `${st.bubbleShort}で進行中です。`).trim();
    }
}
