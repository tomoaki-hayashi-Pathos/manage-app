// 親タスク管理ページ

import { Component, DestroyRef, ElementRef, HostListener, ViewChild, inject, OnDestroy, OnInit } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

import { AppService } from '../../app.service';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { FormsModule } from '@angular/forms';

import { CommonModule } from '@angular/common';

import { ParentTask, Member, TaskStatus, ChildTask, MENTION_ALL, MENTION_ADMIN, AdminNavPageKey } from '../../core/interface';

import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ProgressReportingService, type ProgressBubbleVm } from '../../services/progress-reporting.service';
import { AiChatService } from '../../services/ai-chat.service';
import {
    StorageService,
    storageKeyAdminTaskChangeBundle,
    storageKeyConsultationBundle,
    storageKeyManageParentListCompact
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
    canReorderList,
    defaultToolbarFilterState,
    parentMatchesToolbarFilters,
    removeParentIdFromFilter,
    type TaskToolbarFilterState,
    type ToolbarFilterContext,
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';
import { showAdminDrawerLink, type AdminDrawerNavTarget } from './admin-drawer-nav.util';
import { ProjectTopMenuComponent } from '../../shared/project-top-menu/project-top-menu';
import { DrawerLogoutComponent } from '../../shared/drawer-logout/drawer-logout';
import { AuditLogModalComponent } from '../../shared/audit-log-modal/audit-log-modal.component';
import { CharacterVideoDockComponent } from '../../shared/character-video-dock/character-video-dock.component';
import { buildTasksExportCsv, csvFilenameBase, downloadCsv } from '../../core/csv-export.util';

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
        TaskSearchFilterToolbarComponent,
        ProjectTopMenuComponent,
        DrawerLogoutComponent,
        AuditLogModalComponent,
        CharacterVideoDockComponent
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
    private readonly destroyRef = inject(DestroyRef);

    private readonly routeProjectId = toSignal(
        this.route.paramMap.pipe(map((p) => p.get('projectId') ?? '')),
        { initialValue: this.route.snapshot.paramMap.get('projectId') ?? '' }
    );
    private readonly routeProjectId$ = toObservable(this.routeProjectId);
    private readonly appReady$ = toObservable(this.appService.ready);
    private readonly authLoading$ = toObservable(this.auth.loading);
    private readonly notificationTick$ = toObservable(this.appService.notificationTick);
    private boundProjectId: string | null = null;
    private consultUnsub: (() => void) | null = null;
    private taskChangeUnsub: (() => void) | null = null;

    get projectId(): string {
        return this.routeProjectId();
    }

    get projectName(): string {
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get characterDockBubbleOpen(): boolean {
        return this.characterBubbleVisible || this.characterHoverHint;
    }

    get characterDockBubbleLine(): string {
        if (this.characterBubbleVisible) return this.characterBubbleText;
        if (this.characterHoverHint) return ManageTasksComponent.CHARACTER_HOVER_HINT;
        return '';
    }

    onCharacterDockPointerEnter(): void {
        if (this.characterBubbleVisible) return;
        this.characterHoverHint = true;
    }

    onCharacterDockPointerLeave(): void {
        this.characterHoverHint = false;
    }
    readonly characterVideoSrc = '/assets/character-typing.mp4';
    private static readonly CHARACTER_HOVER_HINT = '話し聞くよ？';
    characterBubbleVisible = false;
    characterBubbleText = '';
    characterHoverHint = false;
    /** 要相談・メンバー変更通知表示中は確認ボタンを出す */
    consultationConfirm = false;
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

    /** 設定未完成一覧：一括操作用 */
    incompleteBulkPanel: 'assignee' | 'deadline' | 'both' | null = null;
    incompleteBulkDraft = { selectionOrder: [] as string[], deadlineInput: '', isUrgent: false };
    private readonly incompleteSelectedIds = new Set<string>();
    /** 左フォーム「担当｜メンバー」2人以上のとき折りたたみ用 */
    createMemberAssignSectionOpen = true;

    childInputs: Record<string, { title: string; assigneeId: string; scheduledDateStr: string }> = {};

    /** 親の子一覧が 3 件以上のときの折りたたみ（today / limit と同仕様） */
    expandedSubChildren: Record<string, boolean> = {};

    /** 一覧を縮小表示（localStorage と同期） */
    globalListCompact = false;

    /** 縮小モードで個別に展開した親 */
    private parentExpandedOverrides: Record<string, boolean> = {};

    /** 一括縮小後に追加された親は次の一括縮小まで展開 */
    private exemptFromCompactParentIds = new Set<string>();

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        return this.appService.getAdminGearNotificationTotal(this.projectId);
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
    }

    ngOnInit(): void {
        combineLatest([this.routeProjectId$, this.appReady$, this.authLoading$])
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(([pid, ready, loading]) => {
                if (!ready || loading) {
                    this.unbindProjectScope();
                    return;
                }
                this.syncProjectScope(pid);
            });

        this.notificationTick$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                const pid = this.routeProjectId();
                if (!pid || this.boundProjectId === pid) return;
                if (!this.appService.ready() || this.auth.loading()) return;
                if (!this.appService.projects.some((p) => p.id === pid)) return;
                this.syncProjectScope(pid);
            });

        this.startCharacterBubbleLoop();
        if (this.users.length >= 2) {
            this.createMemberAssignSectionOpen = false;
        }
    }

    toggleCreateMemberAssignSection(): void {
        this.createMemberAssignSectionOpen = !this.createMemberAssignSectionOpen;
    }

    ngOnDestroy(): void {
        this.unbindProjectScope();
        this.clearCharacterBubbleTimers();
    }

    private syncProjectScope(pid: string): void {
        if (!pid) {
            this.unbindProjectScope();
            return;
        }
        if (!this.appService.projects.some((p) => p.id === pid)) {
            this.unbindProjectScope();
            return;
        }
        if (this.boundProjectId === pid) return;
        this.unbindProjectScope();
        if (this.adminAccess.redirectIfForbidden(pid)) return;
        this.bindProjectScope(pid);
    }

    private bindProjectScope(pid: string): void {
        this.boundProjectId = pid;
        this.loadListCompactPreference(pid);
        this.appService.setAdminCurrentNavPage(pid, null);
        this.progress.setAdminPageActive(pid, true);
        this.progress.ensureProgressRoundForProject(pid);
        const refreshBubble = () => void this.refreshAdminBubbleFromStorage();
        this.consultUnsub = this.storage.watchKey(storageKeyConsultationBundle(pid), refreshBubble);
        this.taskChangeUnsub = this.storage.watchKey(storageKeyAdminTaskChangeBundle(pid), refreshBubble);
        void this.refreshAdminBubbleFromStorage();
    }

    private unbindProjectScope(): void {
        const pid = this.boundProjectId;
        if (!pid) return;
        this.appService.setAdminCurrentNavPage(pid, null);
        this.progress.setAdminPageActive(pid, false);
        this.consultUnsub?.();
        this.consultUnsub = null;
        this.taskChangeUnsub?.();
        this.taskChangeUnsub = null;
        if (this.aiChat.chatOpen() && this.aiChat.projectIdOpen() === pid) {
            this.aiChat.closeChat();
        }
        this.boundProjectId = null;
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
            .getAssignableMembersByProjectId(this.projectId)
            .filter((m) => this.appService.shouldReceiveProgressCheck(this.projectId, m.uid));
        const deferred = new Set(
            targets.map((m) => m.uid).filter((uid) => this.aiChat.isChatActiveFor(this.projectId, uid))
        );
        this.progress.requestProgressReport(this.projectId, deferred);
        if (!targets.length) {
            alert('進捗確認の対象となるメンバーがいません（責任者は進行中の関与タスクがある場合のみ対象です）。');
            return;
        }
        alert(`${targets.length}名に進捗の報告（もう終わる / 問題なし / ちょっと相談）を促しました。`);
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

    auditModalOpen = false;

    /** メインカードの親タスク編集 */
    parentEditTaskId: string | null = null;
    parentEditDraft: ParentEditDraft | null = null;

    /** 子タスク編集 */
    childEditId: string | null = null;
    childEditDraft: ChildEditDraft | null = null;

    get users(): Member[] {
        const list = [...this.appService.getAssignableMembersByProjectId(this.projectId)];
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

    /** 監査ログ・作成者記録用（ログイン責任者 → プロジェクト責任者 → Auth UID） */
    private auditActorUid(): string | null {
        const uid =
            this.adminSelfMemberUid ||
            this.appService.getProjectAdminId(this.projectId) ||
            this.auth.user()?.uid ||
            null;
        return uid?.trim() ? uid : null;
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
            .getActiveSortedParentTasksForProject(this.projectId)
            .filter((t) => !this.appService.shouldExcludePrivateMyFromAdmin(t));
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

    parentListDragEnabled(): boolean {
        return canReorderList(this.toolbarFilter);
    }

    listDensityToggleLabel(): string {
        return this.globalListCompact ? '展開' : '縮小';
    }

    toggleListDensityMode(): void {
        if (this.globalListCompact) {
            this.globalListCompact = false;
        } else {
            this.globalListCompact = true;
            this.exemptFromCompactParentIds.clear();
        }
        this.persistListCompactPreference();
    }

    isParentCardExpanded(parentId: string): boolean {
        if (!this.globalListCompact) return true;
        if (this.parentExpandedOverrides[parentId]) return true;
        if (this.exemptFromCompactParentIds.has(parentId)) return true;
        return false;
    }

    expandParentCard(parentId: string, ev?: Event): void {
        ev?.stopPropagation();
        this.parentExpandedOverrides[parentId] = true;
    }

    collapseParentCard(parentId: string, ev?: Event): void {
        ev?.stopPropagation();
        if (this.isParentTaskEditing(parentId)) return;
        delete this.parentExpandedOverrides[parentId];
        this.exemptFromCompactParentIds.delete(parentId);
    }

    canCollapseParentCard(parentId: string): boolean {
        return this.globalListCompact && this.isParentCardExpanded(parentId) && !this.isParentTaskEditing(parentId);
    }

    isParentTaskEditing(parentId: string): boolean {
        if (this.parentEditTaskId === parentId) return true;
        if (!this.childEditId) return false;
        const child = this.appService.childTasks.find((c) => c.id === this.childEditId);
        return child?.parentTaskId === parentId;
    }

    parentCompactBlinkClass(task: ParentTask): string {
        if (!task.deadline || AppService.deadlineUnset(task.deadline)) return '';
        const end = new Date(task.deadline as Date | string);
        if (Number.isNaN(end.getTime())) return '';
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDay = new Date(end);
        dueDay.setHours(0, 0, 0, 0);
        const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
        if (diffDays === 0 || diffDays === 1) return 'parent-card--compact-blink';
        return '';
    }

    formatDeadlineCompact(deadline: Date | string | null): string {
        if (!deadline) return '期限未設定';
        const d = new Date(deadline);
        if (Number.isNaN(d.getTime())) return '期限未設定';
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 縮小行：担当アイコン左の代表吹き出し（1件） */
    compactSpeechBubblesForParent(task: ParentTask): ProgressBubbleVm[] {
        void this.progress.progressRevision();
        const children = this.appService.getWorkViewChildTasksByParentId(task.id);
        if (children.length > 0) {
            const stagnantChild = children.find((c) =>
                this.progress.hasOpenStagnationForTask(this.projectId, task.id, c.id)
            );
            const child = stagnantChild ?? this.pickCompactRepresentativeChild(task, children);
            return this.pickOneCompactBubble(this.progressBubblesForChild(task, child));
        }
        const parentBubbles = this.progressBubblesParentOnly(task);
        if (!parentBubbles.length) return [];
        const leadId = task.leadAssigneeId;
        const leadBubble = leadId ? parentBubbles.find((b) => b.memberId === leadId) : undefined;
        return [leadBubble ?? parentBubbles[0]];
    }

    private pickCompactRepresentativeChild(task: ParentTask, children: ChildTask[]): ChildTask {
        for (const c of children) {
            const bubbles = this.progressBubblesForChild(task, c);
            if (bubbles.some((b) => this.isCompactProblemBubble(b))) return c;
        }
        return children[0];
    }

    private pickOneCompactBubble(bubbles: ProgressBubbleVm[]): ProgressBubbleVm[] {
        if (!bubbles.length) return [];
        const stagnant = bubbles.find((b) => b.isStagnating || (b.short || '').trim() === '停滞中！');
        if (stagnant) return [stagnant];
        const problem = bubbles.find((b) => this.isCompactProblemBubble(b));
        return [problem ?? bubbles[0]];
    }

    private isCompactProblemBubble(b: ProgressBubbleVm): boolean {
        if (b.isStagnating) return true;
        const s = (b.short || '').trim();
        if (!s || s === '—' || s === '問題なし' || s === 'もう終わる') return false;
        if (s === '停滞中！' || s === '考え中' || s === '要回答' || s === '質問中') return true;
        return s.includes('相談');
    }

    private loadListCompactPreference(projectId: string): void {
        const uid = this.adminSelfMemberUid || this.appService.getProjectAdminId(projectId) || '';
        if (!uid) {
            this.globalListCompact = false;
            return;
        }
        const raw = this.storage.getJson<boolean | null>(storageKeyManageParentListCompact(projectId, uid));
        this.globalListCompact = raw === true;
        this.parentExpandedOverrides = {};
        this.exemptFromCompactParentIds.clear();
    }

    private persistListCompactPreference(): void {
        const pid = this.projectId;
        const uid = this.adminSelfMemberUid || this.appService.getProjectAdminId(pid) || '';
        if (!pid || !uid) return;
        this.storage.setJson(storageKeyManageParentListCompact(pid, uid), this.globalListCompact);
    }

    onParentSortPick(kind: 'deadline' | 'status'): void {
        if (kind === 'deadline') {
            this.appService.resetParentListSortToDeadline(this.projectId);
        } else {
            this.appService.resetParentListSortToStatus(this.projectId);
        }
    }

    get visibleParentTasks(): ParentTask[] {
        return this.baseVisibleParentTasks.filter((t) =>
            parentMatchesToolbarFilters(this.toolbarFilterCtx(), t, this.toolbarFilter, 'manage')
        );
    }

    get viewModeLabel(): string {
        const labels = ['担当・期限未設定タスク', '期限未設定タスク', '担当未設定タスク'];
        return labels[this.viewMode];
    }

    get filteredIncompleteTasks(): ParentTask[] {
        const pool = this.appService.parentTasks.filter((t) => t.projectId === this.projectId && t.isDraft);
        return pool.filter((t) => {
            const noDeadline = AppService.deadlineUnset(t.deadline);
            const noLead = !t.leadAssigneeId;
            if (this.viewMode === 1) return noDeadline && !noLead;
            if (this.viewMode === 2) return !noDeadline && noLead;
            return noDeadline && noLead;
        });
    }

    get incompleteShowAssigneeBtn(): boolean {
        return this.viewMode === 2;
    }

    get incompleteShowDeadlineBtn(): boolean {
        return this.viewMode === 1;
    }

    get incompleteShowBothBtn(): boolean {
        return this.viewMode === 0;
    }

    incompleteRowShowsAssignees(task: ParentTask): boolean {
        return !!task.leadAssigneeId && AppService.deadlineUnset(task.deadline);
    }

    incompleteRowShowsDeadline(task: ParentTask): boolean {
        return !task.leadAssigneeId && !!task.deadline && !AppService.deadlineUnset(task.deadline);
    }

    toggleViewMode(): void {
        this.viewMode = (this.viewMode + 1) % 3;
        this.closeIncompleteBulkPanel();
        this.incompleteSelectedIds.clear();
    }

    isIncompleteSelected(taskId: string): boolean {
        return this.incompleteSelectedIds.has(taskId);
    }

    toggleIncompleteSelection(taskId: string, checked: boolean): void {
        if (checked) this.incompleteSelectedIds.add(taskId);
        else this.incompleteSelectedIds.delete(taskId);
    }

    openIncompleteBulkPanel(kind: 'assignee' | 'deadline' | 'both'): void {
        this.incompleteBulkPanel = kind;
        this.incompleteBulkDraft = { selectionOrder: [], deadlineInput: '', isUrgent: false };
    }

    closeIncompleteBulkPanel(): void {
        this.incompleteBulkPanel = null;
        this.incompleteBulkDraft = { selectionOrder: [], deadlineInput: '', isUrgent: false };
    }

    isIncompleteBulkMemberChecked(uid: string): boolean {
        return this.incompleteBulkDraft.selectionOrder.includes(uid);
    }

    onIncompleteBulkMemberChange(uid: string, checked: boolean): void {
        if (checked) {
            if (!this.incompleteBulkDraft.selectionOrder.includes(uid)) {
                this.incompleteBulkDraft.selectionOrder.push(uid);
            }
        } else {
            this.incompleteBulkDraft.selectionOrder = this.incompleteBulkDraft.selectionOrder.filter((id) => id !== uid);
        }
    }

    toggleIncompleteBulkUrgent(): void {
        this.incompleteBulkDraft.isUrgent = !this.incompleteBulkDraft.isUrgent;
    }

    applyIncompleteBulk(): void {
        const taskIds = [...this.incompleteSelectedIds];
        if (taskIds.length === 0) {
            alert('タスクを1件以上選択してください');
            return;
        }
        const panel = this.incompleteBulkPanel;
        if (!panel) return;

        const needsAssignee = panel === 'assignee' || panel === 'both';
        const needsDeadline = panel === 'deadline' || panel === 'both';
        if (needsAssignee && this.incompleteBulkDraft.selectionOrder.length === 0) {
            alert('担当者を1人以上選択してください');
            return;
        }
        if (needsDeadline && !this.incompleteBulkDraft.deadlineInput.trim()) {
            alert('期限を入力してください');
            return;
        }

        const bulkDeadline = needsDeadline ? new Date(this.incompleteBulkDraft.deadlineInput) : null;
        const bulkSelection = needsAssignee ? [...this.incompleteBulkDraft.selectionOrder] : null;
        const actor = this.appService.getProjectAdminId(this.projectId);

        for (const taskId of taskIds) {
            const task = this.appService.parentTasks.find((p) => p.id === taskId);
            if (!task) continue;
            const base = this.buildParentDraft(task);
            const priority = this.incompleteBulkDraft.isUrgent ? '高' : task.priority;
            this.appService.saveParentTaskEditBundle(
                taskId,
                {
                    title: base.title,
                    description: base.description,
                    deadline: needsDeadline
                        ? bulkDeadline
                        : task.deadline && !AppService.deadlineUnset(task.deadline)
                          ? new Date(task.deadline as Date | string)
                          : null,
                    priority,
                    mentionUserIds: [...base.mentionUserIds],
                    selectionOrder: needsAssignee ? bulkSelection! : [...base.selectionOrder]
                },
                actor
            );
        }

        this.incompleteSelectedIds.clear();
        this.closeIncompleteBulkPanel();
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
        this.appService.revertChildTaskFromComplete(c.id, this.auditActorUid());
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
        const parentIdsBefore = new Set(
            this.appService.parentTasks.filter((p) => p.projectId === this.projectId).map((p) => p.id)
        );
        this.appService.CreateParentTask(
            this.projectId,
            this.title,
            deadline,
            this.isUrgent,
            lead,
            members,
            this.description,
            false,
            null,
            this.mentionUserIds,
            this.auditActorUid()
        );
        if (!titleTrim) return;
        if (this.globalListCompact) {
            for (const p of this.appService.parentTasks) {
                if (p.projectId === this.projectId && !parentIdsBefore.has(p.id)) {
                    this.exemptFromCompactParentIds.add(p.id);
                }
            }
        }
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

    toggleDraftMention(ctx: 'main', id: string, checked: boolean): void {
        const draft = this.parentEditDraft;
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

        this.appService.CreateChildTask(this.projectId, parentTask.id, draft.title, draft.assigneeId, false, sd, this.auditActorUid() ?? undefined);

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
        return [...new Set(ids)].filter((uid) => !this.appService.isProjectGuest(parentTask.projectId, uid));
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

    onDraftMemberChange(ctx: 'main', uid: string, checked: boolean): void {
        const draft = this.parentEditDraft;
        if (!draft) return;
        if (checked) {
            if (!draft.selectionOrder.includes(uid)) draft.selectionOrder.push(uid);
        } else {
            draft.selectionOrder = draft.selectionOrder.filter((id) => id !== uid);
        }
    }

    toggleDraftUrgent(ctx: 'main'): void {
        const d = this.parentEditDraft;
        if (!d) return;
        d.isUrgent = !d.isUrgent;
    }

    deleteParentTask(taskId: string): void {
        const t = this.appService.parentTasks.find((p) => p.id === taskId);
        const actor = this.auth.user()?.uid ?? this.appService.getProjectAdminId(this.projectId) ?? null;
        if (!t || !this.appService.memberCanDeleteParent(t, actor)) return;
        if (!confirm('この親タスクと紐づく子タスクをすべてゴミ箱に移しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        this.incompleteSelectedIds.delete(taskId);
        this.appService.trashParentTask(taskId, actor);
        this.toolbarFilter = removeParentIdFromFilter(this.toolbarFilter, taskId);
        delete this.parentExpandedOverrides[taskId];
        this.exemptFromCompactParentIds.delete(taskId);
    }

    enterChildEdit(c: ChildTask, ev?: Event): void {
        ev?.stopPropagation();
        if (c.status === '完了') return;
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
        const c = this.appService.childTasks.find((x) => x.id === childId);
        const parent = c ? this.appService.parentTasks.find((p) => p.id === c.parentTaskId) : undefined;
        const actor = this.auth.user()?.uid ?? this.appService.getProjectAdminId(this.projectId) ?? null;
        if (!c || !parent || !this.appService.memberCanDeleteChild(parent, c, actor)) return;
        if (!confirm('この子タスクをゴミ箱に移しますか？')) return;
        if (this.childEditId === childId) this.cancelChildEdit();
        this.appService.trashChildTask(childId, actor);
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

    openAuditModal(): void {
        this.closeRightMenu();
        this.auditModalOpen = true;
    }

    closeAuditModal(): void {
        this.auditModalOpen = false;
    }

    exportTasksCsv(): void {
        this.closeRightMenu();
        const csv = buildTasksExportCsv(this.appService, this.projectId);
        const parents = this.appService.parentTasks.filter((t) => t.projectId === this.projectId);
        if (!parents.length) {
            alert('エクスポートするタスクがありません。');
            return;
        }
        downloadCsv(`${csvFilenameBase(this.projectName)}_tasks.csv`, csv);
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

    private buildConsultPendingFallback(entries: ConsultationProjectBundle['entries']): string {
        return entries
            .map((e) => {
                const tasks = e.noChangeOnly
                    ? '現状変化なし'
                    : e.parentTaskIds
                          .map(
                              (id) =>
                                  this.appService.parentTasks.find((p) => p.id === id && p.projectId === this.projectId)
                                      ?.title || id
                          )
                          .join('、');
                return `・${e.memberName}／対象: ${tasks}／相談: ${e.content.replace(/\s+/g, ' ').trim()}`;
            })
            .join('\n');
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

        if (consultPending.length > 0) {
            const summary = consultSummary?.trim();
            parts.push(summary || this.buildConsultPendingFallback(consultPending));
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
        const members = this.appService.getAssignableMembersByProjectId(this.projectId);
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
