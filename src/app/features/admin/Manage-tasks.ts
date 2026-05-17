// 親タスク管理ページ

import { Component, ElementRef, HostListener, ViewChild, effect, inject, OnDestroy, OnInit } from '@angular/core';

import { AppService } from '../../app.service';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { FormsModule } from '@angular/forms';

import { CommonModule } from '@angular/common';

import { ParentTask, Member, TaskStatus, ChildTask, MENTION_ALL, MENTION_ADMIN, AdminNavPageKey } from '../../core/interface';

import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ProgressReportingService } from '../../services/progress-reporting.service';
import { AiChatService } from '../../services/ai-chat.service';
import {
    StorageService,
    storageKeyAdminTaskChangeBundle,
    storageKeyConsultationBundle
} from '../../services/storage.service';
import type { ConsultationProjectBundle } from '../../core/progress-chat.types';
import {
    dismissAdminTaskChangeBundle,
    getPendingAdminTaskChangeText
} from '../../core/member-task-change-notify.util';
import { MemberProgressBubblesComponent } from '../../shared/member-progress-bubbles/member-progress-bubbles.component';
import { ProgressMemberShellComponent } from '../../shared/progress-member-shell/progress-member-shell.component';
import { ParentTeamProgressStripComponent } from '../../shared/parent-team-progress-strip/parent-team-progress-strip.component';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';
import { AuthSessionService } from '../../services/auth-session.service';
import { TaskSearchFilterToolbarComponent } from '../../shared/task-search-filter-toolbar/task-search-filter-toolbar.component';
import {
    defaultToolbarFilterState,
    isToolbarFilterDefault,
    parentMatchesToolbarFilters,
    type TaskToolbarFilterState,
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';
import { showAdminDrawerLink, type AdminDrawerNavTarget } from './admin-drawer-nav.util';

type ParentEditDraft = {
    title: string;
    description: string;
    deadlineInput: string;
    selectionOrder: string[];
    isUrgent: boolean;
    mentionUserIds: string[];
};

type ChildEditDraft = {
    title: string;
    assigneeId: string;
    scheduledDateStr: string;
};

@Component({
    selector: 'app-manage-tasks',
    standalone: true,
    imports: [
        FormsModule,
        CommonModule,
        RouterLink,
        DragDropModule,
        MemberProgressBubblesComponent,
        ProgressMemberShellComponent,
        ParentTeamProgressStripComponent,
        TaskSearchFilterToolbarComponent
    ],
    templateUrl: './Manage-tasks.html',
    styleUrls: ['./Manage-tasks.css', '../../progress-ai.css']
})
export class ManageTasksComponent implements OnInit, OnDestroy {
    /** タイトル入力完了時（blur / Enter） */
    private static readonly SIDEBAR_SCROLL_STEP_PX = 72;
    /** 設定未完成タスク追加後（一覧1件分が見える程度） */
    private static readonly SIDEBAR_SCROLL_AFTER_DRAFT_PX = 112;

    @ViewChild('sidebarScroll') sidebarScrollRef?: ElementRef<HTMLElement>;

    /** Enter 後の blur で二重スクロールしない */
    private skipTitleBlurScroll = false;

    public appService = inject(AppService);
    public route = inject(ActivatedRoute);
    readonly progress = inject(ProgressReportingService);
    readonly aiChat = inject(AiChatService);
    private readonly storage = inject(StorageService);
    private readonly adminAccess = inject(AdminProjectAccessService);
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    private readonly accessEffect = effect(() => {
        this.adminAccess.redirectIfForbidden(this.projectId);
    });

    get projectName(): string {
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }
    readonly characterVideoSrc = 'assets/character-typing.mp4';
    characterBubbleVisible = false;
    characterBubbleText = '';
    /** 要相談・メンバー変更通知表示中は確認ボタンを出す */
    consultationConfirm = false;
    private consultUnsub: (() => void) | null = null;
    private taskChangeUnsub: (() => void) | null = null;
    private adminBubbleRefreshSeq = 0;
    private characterShowTimerId: number | null = null;
    private characterHideTimerId: number | null = null;

    title = '';
    deadlineInput = '';
    isUrgent = false;
    description = '';
    selectionOrder: string[] = [];

    /** メンション作成フォーム */
    mentionPopoverOpen = false;
    mentionUserIds: string[] = [];
    readonly TOK_ALL = MENTION_ALL;
    readonly TOK_ADMIN = MENTION_ADMIN;

    toolbarFilter: TaskToolbarFilterState = defaultToolbarFilterState();

    viewMode: number = 0;
    /** 左フォーム「担当｜メンバー」2人以上のとき折りたたみ用 */
    createMemberAssignSectionOpen = true;

    childInputs: Record<string, { title: string; assigneeId: string; scheduledDateStr: string }> = {};

    /** 親の子一覧が 3 件以上のときの折りたたみ（today / limit と同仕様） */
    expandedSubChildren: Record<string, boolean> = {};

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        return this.appService.getAdminGearNotificationTotal(this.projectId);
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
    }

    ngOnInit(): void {
        this.appService.setAdminCurrentNavPage(this.projectId, null);
        this.progress.setAdminPageActive(this.projectId, true);
        this.progress.ensureProgressRoundForProject(this.projectId);
        const refreshBubble = () => void this.refreshAdminBubbleFromStorage();
        this.consultUnsub = this.storage.watchKey(storageKeyConsultationBundle(this.projectId), refreshBubble);
        this.taskChangeUnsub = this.storage.watchKey(storageKeyAdminTaskChangeBundle(this.projectId), refreshBubble);
        void this.refreshAdminBubbleFromStorage();
        this.startCharacterBubbleLoop();
        if (this.users.length >= 2) {
            this.createMemberAssignSectionOpen = false;
        }
    }

    toggleCreateMemberAssignSection(): void {
        this.createMemberAssignSectionOpen = !this.createMemberAssignSectionOpen;
    }

    ngOnDestroy(): void {
        this.appService.setAdminCurrentNavPage(this.projectId, null);
        this.progress.setAdminPageActive(this.projectId, false);
        this.consultUnsub?.();
        this.consultUnsub = null;
        this.taskChangeUnsub?.();
        this.taskChangeUnsub = null;
        this.clearCharacterBubbleTimers();
        if (this.aiChat.chatOpen() && this.aiChat.projectIdOpen() === this.projectId) {
            this.aiChat.closeChat();
        }
    }

    /** 管理画面左下 OL：メンバー文脈で AI 相談（進捗の deferred は起こさない） */
    chatDraft = '';
    chatPublicOn = true;

    openAdminOlChat(): void {
        const meUid = this.appService.getMemberByEmail(this.auth.currentEmail())?.uid?.trim();
        const mid =
            meUid ||
            this.appService.getMembersByProjectId(this.projectId)[0]?.uid;
        if (!mid) {
            window.alert('プロジェクトにメンバーがいません');
            return;
        }
        this.aiChat.openChat(this.projectId, mid);
    }

    closeAdminOlChat(): void {
        this.aiChat.closeChat();
    }

    adminChatStagnationLabel(): string {
        if (!this.aiChat.chatOpen() || this.aiChat.projectIdOpen() !== this.projectId) return '';
        const mid = this.aiChat.memberIdOpen();
        if (!mid) return '';
        return this.progress.stagnationElapsedLabel(this.projectId, mid);
    }

    async sendAdminOlChat(): Promise<void> {
        const t = this.chatDraft.trim();
        if (!t) return;
        this.chatDraft = '';
        await this.aiChat.sendUserMessage(t, this.adminChatStagnationLabel() || null, this.chatPublicOn, 'admin');
    }

    requestProgressCheck(): void {
        const targets = this.appService
            .getMembersByProjectId(this.projectId)
            .filter((m) => this.appService.shouldReceiveProgressCheck(this.projectId, m.uid));
        const deferred = new Set(
            targets.map((m) => m.uid).filter((uid) => this.aiChat.isChatActiveFor(this.projectId, uid))
        );
        this.progress.requestProgressReport(this.projectId, deferred);
        if (!targets.length) {
            alert('進捗確認の対象となるメンバーがいません（責任者は進行中の関与タスクがある場合のみ対象です）。');
            return;
        }
        alert(`${targets.length}名に進捗の報告（もう終わる / 問題なし / 要相談）を促しました。`);
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

    get headerSelfBubbles() {
        return this.progress.bubblesForMemberHeaderDisplay(this.projectId, this.adminSelfMemberUid);
    }

    /** 右上オーバーメニュー */
    rightMenuOpen = false;

    /** メインカードの親タスク編集 */
    parentEditTaskId: string | null = null;
    parentEditDraft: ParentEditDraft | null = null;

    /** 子タスク編集 */
    childEditId: string | null = null;
    childEditDraft: ChildEditDraft | null = null;

    /** サイドバー「未完成」一覧のインライン編集 */
    sidebarIncompleteEditId: string | null = null;
    sidebarIncompleteDraft: ParentEditDraft | null = null;

    get users(): Member[] {
        const list = [...this.appService.getMembersByProjectId(this.projectId)];
        const p = this.appService.projects.find((x) => x.id === this.projectId);
        if (p?.adminId) {
            const adminMem = this.appService.getMemberById(p.adminId);
            if (adminMem && !list.some((m) => m.uid === adminMem.uid)) {
                list.push(adminMem);
            }
        }
        return list;
    }

    /** 管理者用メンバー画面ルート用 */
    get adminSelfMemberUid(): string {
        return this.appService.getMemberByEmail(this.auth.currentEmail())?.uid ?? '';
    }

    /** 責任者が進行中タスクに関与しているときだけ進捗・停滞シェルを表示 */
    get adminShowsProgressMemberShell(): boolean {
        void this.appService.notificationTick();
        const uid = this.adminSelfMemberUid;
        return !!uid && this.appService.memberHasInProgressTaskInvolvement(this.projectId, uid);
    }

    /** 進捗シェル（要相談・もう終わる選択）用 */
    get progressShellParents(): ParentTask[] {
        const uid = this.adminSelfMemberUid;
        if (!uid) return [];
        return this.baseVisibleParentTasks.filter(
            (t) => t.leadAssigneeId === uid || t.memberIds.includes(uid)
        );
    }

    get baseVisibleParentTasks(): ParentTask[] {
        return this.appService
            .getSortedParentTasksForProject(this.projectId, false)
            .filter((t) => !this.appService.shouldExcludePrivateMyFromAdmin(t));
    }

    get toolbarCandidateParents(): ParentTask[] {
        return this.baseVisibleParentTasks;
    }

    hideToolbarAssigneeFilter(): boolean {
        return false;
    }

    parentListDragEnabled(): boolean {
        return isToolbarFilterDefault(this.toolbarFilter);
    }

    onParentSortPick(kind: 'deadline' | 'status'): void {
        if (kind === 'deadline') {
            this.appService.resetParentListSortToDeadline(this.projectId);
        } else {
            this.appService.resetParentListSortToStatus(this.projectId);
        }
    }

    get visibleParentTasks(): ParentTask[] {
        return this.baseVisibleParentTasks.filter((t) => parentMatchesToolbarFilters(this.appService, t, this.toolbarFilter));
    }

    get viewModeLabel(): string {
        const labels = ['全未入力タスク一覧', '期限未入力タスク', '担当者未入力タスク'];
        return labels[this.viewMode];
    }

    get filteredIncompleteTasks(): ParentTask[] {
        const pool = this.appService.parentTasks.filter((t) => t.projectId === this.projectId && t.isDraft);
        if (this.viewMode === 1) {
            return pool.filter((t) => !t.deadline);
        }
        if (this.viewMode === 2) {
            return pool.filter((t) => !t.leadAssigneeId);
        }
        return pool;
    }

    toggleViewMode(): void {
        this.viewMode = (this.viewMode + 1) % 3;
    }

    isMemberChecked(uid: string): boolean {
        return this.selectionOrder.includes(uid);
    }

    onMemberCheckboxChange(uid: string, checked: boolean): void {
        if (checked) {
            if (!this.selectionOrder.includes(uid)) this.selectionOrder.push(uid);
        } else {
            this.selectionOrder = this.selectionOrder.filter((id) => id !== uid);
        }
    }

    toggleUrgent(): void {
        this.isUrgent = !this.isUrgent;
    }

    toggleSubtasksExpand(parentId: string, ev: Event): void {
        ev.stopPropagation();
        this.expandedSubChildren[parentId] = !this.expandedSubChildren[parentId];
    }

    isSubtasksExpanded(parentId: string): boolean {
        return !!this.expandedSubChildren[parentId];
    }

    visibleChildRowsForParent(parent: ParentTask): ChildTask[] {
        const all = this.appService.getChildTasksByParentId(parent.id);
        if (all.length < 3) return all;
        if (this.isSubtasksExpanded(parent.id)) return all;
        return all.slice(0, 2);
    }

    moreSubtasksHiddenCount(parent: ParentTask): number {
        const n = this.appService.getChildTasksByParentId(parent.id).length;
        return n >= 3 ? n - 2 : 0;
    }

    getChildInput(parentId: string): { title: string; assigneeId: string; scheduledDateStr: string } {
        if (!this.childInputs[parentId]) {
            this.childInputs[parentId] = { title: '', assigneeId: '', scheduledDateStr: '' };
        }
        return this.childInputs[parentId];
    }

    onCreateTitleBlur(): void {
        if (this.skipTitleBlurScroll) {
            this.skipTitleBlurScroll = false;
            return;
        }
        this.scrollSidebarAfterTitleComplete();
    }

    onCreateTitleEnter(ev: Event): void {
        const e = ev as KeyboardEvent;
        if (e.key !== 'Enter') return;
        e.preventDefault();
        this.skipTitleBlurScroll = true;
        (e.target as HTMLInputElement | null)?.blur();
        this.scrollSidebarAfterTitleComplete();
    }

    private scrollSidebarAfterTitleComplete(): void {
        if (!this.title.trim()) return;
        this.scrollSidebarByWheelStep();
    }

    private scrollSidebarByWheelStep(px: number = ManageTasksComponent.SIDEBAR_SCROLL_STEP_PX): void {
        const el = this.sidebarScrollRef?.nativeElement;
        if (!el) return;
        el.scrollBy({ top: px, behavior: 'smooth' });
    }

    createParentTask(): void {
        const titleTrim = this.title.trim();
        const deadline = this.deadlineInput ? new Date(this.deadlineInput) : null;
        const lead = this.selectionOrder[0] ?? null;
        const members = this.selectionOrder.slice(1);
        const addedAsDraft = !!titleTrim && (!deadline || !lead);
        this.appService.CreateParentTask(this.projectId, this.title, deadline, this.isUrgent, lead, members, this.description, false, null, this.mentionUserIds);
        if (!titleTrim) return;
        this.title = '';
        this.deadlineInput = '';
        this.isUrgent = false;
        this.description = '';
        this.selectionOrder = [];
        this.mentionUserIds = [];
        this.mentionPopoverOpen = false;
        if (addedAsDraft) {
            setTimeout(() => this.scrollSidebarByWheelStep(ManageTasksComponent.SIDEBAR_SCROLL_AFTER_DRAFT_PX), 0);
        }
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

    addChildTask(parentTask: ParentTask): void {
        const draft = this.getChildInput(parentTask.id);
        if (!this.getAssignableMemberIds(parentTask).includes(draft.assigneeId)) {
            alert('親タスクの担当・メンバーから担当者を選択してください');
            return;
        }
        const sd = draft.scheduledDateStr?.trim() ? draft.scheduledDateStr : null;

        this.appService.CreateChildTask(this.projectId, parentTask.id, draft.title, draft.assigneeId, false, sd, undefined);

        draft.title = '';

        draft.assigneeId = '';

        draft.scheduledDateStr = '';
    }

    leadMember(task: ParentTask): Member | undefined {
        return this.appService.getMemberById(task.leadAssigneeId);
    }

    memberList(task: ParentTask): Member[] {
        return this.appService.getMembersByUids(task.memberIds);
    }

    /** 担当→メンバー順の写真表示用 */
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

    remainingLabel(deadline: Date | string | null): string {
        if (!deadline) return '';
        const end = new Date(deadline);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dayStart = new Date(end);
        dayStart.setHours(0, 0, 0, 0);
        const diff = Math.round((dayStart.getTime() - today.getTime()) / 86400000);
        if (diff > 0) return `（残り${diff}日）`;
        if (diff === 0) return '（本日まで）';
        return `（期限超過${Math.abs(diff)}日）`;
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
        this.appService.notifyTaskListReordered(this.projectId);
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
        this.appService.saveParentTaskEditBundle(taskId, {
            title: d.title,
            description: d.description,
            deadline: d.deadlineInput ? new Date(d.deadlineInput) : null,
            priority: d.isUrgent ? '高' : '通常',
            mentionUserIds: [...d.mentionUserIds],
            selectionOrder: [...d.selectionOrder]
        }, this.appService.getProjectAdminId(this.projectId));

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
        if (!confirm('この親タスクと紐づく子タスクをすべて削除しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        if (this.sidebarIncompleteEditId === taskId) this.cancelSidebarIncompleteEdit();
        this.appService.deleteParentTask(taskId);
        if (this.toolbarFilter.pickParentId === taskId) {
            this.toolbarFilter = { ...this.toolbarFilter, pickParentId: null };
        }
    }

    enterChildEdit(c: ChildTask, ev?: Event): void {
        ev?.stopPropagation();
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
        if (!d.assigneeId) {
            alert('担当メンバーを選択してください');
            return;
        }
        const child = this.appService.childTasks.find((c) => c.id === childId);
        if (!child || !this.getAssignableMembersByParentId(child.parentTaskId).some((m) => m.uid === d.assigneeId)) {
            alert('親タスクの担当・メンバーから担当者を選択してください');
            return;
        }
        this.appService.patchChildTask(childId, {
            title: d.title,
            assigneeId: d.assigneeId,
            scheduledDate: d.scheduledDateStr?.trim() ? d.scheduledDateStr : null
        });

        this.cancelChildEdit();

    }

    deleteChildTask(childId: string): void {
        if (!confirm('この子タスクを削除しますか？')) return;
        if (this.childEditId === childId) this.cancelChildEdit();
        this.appService.deleteChildTask(childId);
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
        this.appService.saveParentTaskEditBundle(taskId, {

            title: d.title,

            description: d.description,

            deadline: d.deadlineInput ? new Date(d.deadlineInput) : null,

            priority: d.isUrgent ? '高' : '通常',

            mentionUserIds: [...d.mentionUserIds],

            selectionOrder: [...d.selectionOrder]

        }, this.appService.getProjectAdminId(this.projectId));

        this.cancelSidebarIncompleteEdit();

    }

    showAdminDrawerNav(target: AdminDrawerNavTarget): boolean {
        return showAdminDrawerLink(this.router, this.projectId, target);
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

    private scheduleCharacterBubble(): void {
        if (typeof window === 'undefined') return;
        if (this.consultationConfirm) return;
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

    private getConsultPendingEntries(): ConsultationProjectBundle['entries'] {
        const consultBundle = this.storage.getJson<ConsultationProjectBundle | null>(
            storageKeyConsultationBundle(this.projectId)
        );
        if (!consultBundle || !Array.isArray(consultBundle.entries)) return [];
        const dismissed = consultBundle.adminDismissedAt ?? 0;
        return consultBundle.entries.filter((e) => e.at > dismissed);
    }

    private hideAdminPendingBubble(): void {
        this.consultationConfirm = false;
        this.characterBubbleVisible = false;
        this.characterBubbleText = '';
    }

    private async refreshAdminBubbleFromStorage(): Promise<void> {
        const seq = ++this.adminBubbleRefreshSeq;

        const consultPending = this.getConsultPendingEntries();
        let consultSummary: string | null = null;
        if (consultPending.length) {
            consultSummary = await this.aiChat.summarizeConsultationEntries(consultPending, this.projectId);
        }

        if (seq !== this.adminBubbleRefreshSeq) return;

        const parts: string[] = [];
        const taskChangeText = getPendingAdminTaskChangeText(this.storage, this.projectId);
        if (taskChangeText) parts.push(taskChangeText);

        if (this.getConsultPendingEntries().length > 0 && consultSummary) {
            parts.push(consultSummary);
        }

        if (!parts.length) {
            this.hideAdminPendingBubble();
            this.scheduleCharacterBubble();
            return;
        }

        this.clearCharacterBubbleTimers();
        this.characterBubbleText = parts.join('\n\n');
        this.characterBubbleVisible = true;
        this.consultationConfirm = true;
    }

    confirmConsultationRead(): void {
        this.adminBubbleRefreshSeq++;
        const consultKey = storageKeyConsultationBundle(this.projectId);
        const consultBundle = this.storage.getJson<ConsultationProjectBundle | null>(consultKey);
        if (consultBundle && Array.isArray(consultBundle.entries)) {
            consultBundle.adminDismissedAt = Date.now();
            this.storage.setJson(consultKey, consultBundle);
        }
        dismissAdminTaskChangeBundle(this.storage, this.projectId);
        this.consultationConfirm = false;
        this.characterBubbleVisible = false;
        this.scheduleCharacterBubble();
    }

    private buildCharacterBubbleText(): string {
        const members = this.appService.getMembersByProjectId(this.projectId);
        const focusMemberId =
            (this.aiChat.projectIdOpen() === this.projectId ? this.aiChat.memberIdOpen() : null) ??
            members[0]?.uid ??
            null;
        if (!focusMemberId) {
            return '今日も良い流れで進めましょう。';
        }
        const st = this.progress.getMemberState(this.projectId, focusMemberId);
        if (!st?.bubbleShort) {
            return '進捗は順調そうです。この調子でいきましょう。';
        }
        if (st.bubbleShort === '停滞中！') {
            const stagnations = this.progress.openStagnations(this.projectId, focusMemberId);
            const latest = stagnations.length ? stagnations[stagnations.length - 1] : null;
            const detail = (latest?.reason || st.detailForHover || '停滞理由を確認中です。').trim();
            return `停滞内容: ${detail}`;
        }
        if (st.bubbleShort === '考え中') {
            const detail = (st.thinkingDetailLong || st.thinkingChatSnippet || st.detailForHover || '考え中です。').trim();
            return `考え中メモ: ${detail}`;
        }
        if (st.bubbleShort === '問題なし' || st.bubbleShort === 'もう終わる') {
            return '順調です！そのまま進めていきましょう。';
        }
        return (st.detailForHover || `${st.bubbleShort}で進行中です。`).trim();
    }
    
}
