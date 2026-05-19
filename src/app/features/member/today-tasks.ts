import { Component, effect, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ParentTask, Member, TaskStatus, ChildTask, MENTION_ALL, MENTION_ADMIN } from '../../core/interface';
import { MemberNavLinksComponent } from './member-nav-links';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
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
import { TaskSearchFilterToolbarComponent } from '../../shared/task-search-filter-toolbar/task-search-filter-toolbar.component';
import { ProjectTopMenuComponent } from '../../shared/project-top-menu/project-top-menu';
import { DrawerLogoutComponent } from '../../shared/drawer-logout/drawer-logout';
import { CharacterVideoDockComponent } from '../../shared/character-video-dock/character-video-dock.component';
import { showProjectTopMemberEdit } from '../../shared/project-top-menu/project-top-menu.util';
import {
    canReorderList,
    defaultToolbarFilterState,
    removeParentIdFromFilter,
    todayItemMatchesToolbar,
    type TaskToolbarFilterState,
    type ToolbarFilterContext,
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';

export type TodayItem =
    | { kind: 'parent'; task: ParentTask }
    | { kind: 'child'; task: ChildTask; parent: ParentTask };

function itemKey(item: TodayItem): string {
    return item.kind === 'parent' ? 'p-' + item.task.id : 'c-' + item.task.id;
}

function todayParentOf(item: TodayItem): ParentTask {
    return item.kind === 'parent' ? item.task : item.parent;
}

function todayStatusOf(item: TodayItem): TaskStatus {
    return item.kind === 'parent' ? item.task.status : item.task.status;
}

function todayStatusRank(s: TaskStatus): number {
    switch (s) {
        case '未着手':
            return 0;
        case '進行中':
            return 1;
        case '完了':
            return 2;
        default:
            return 3;
    }
}

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
    selector: 'app-today-tasks',
    standalone: true,
    imports: [
        FormsModule,
        CommonModule,
        MemberNavLinksComponent,
        DragDropModule,
        ProgressMemberShellComponent,
        MemberProgressBubblesComponent,
        ParentTeamProgressStripComponent,
        TaskSearchFilterToolbarComponent,
        ProjectTopMenuComponent,
        DrawerLogoutComponent,
        CharacterVideoDockComponent
    ],
    templateUrl: './today-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './today-tasks.css', '../../progress-ai.css']
})
export class TodayTasksComponent implements OnInit, OnDestroy {
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

    /** 右メニュー用 */
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

    ngOnInit(): void {
        if (!this.ctx.ensureMemberAccess(this.memberAccess)) return;
        this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, 'today');
        this.appService.clearMemberPageNotifications(this.projectId, this.memberId, 'today');
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

    /** 進捗シェル（停滞報告・AI）用の親タスク一覧 */
    get progressShellParents(): ParentTask[] {
        return this.appService
            .getActiveSortedParentTasksForProject(this.projectId)
            .filter((t) => this.isTaskVisibleToMember(t));
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

    get projectName(): string {
        if (this.ctx.mode === 'personal') {
            return this.appService.getProjectDisplayName(this.projectId);
        }
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get characterDockBubbleOpen(): boolean {
        return this.characterBubbleVisible || this.characterHoverHint;
    }

    get characterDockBubbleLine(): string {
        if (this.characterBubbleVisible) return this.characterBubbleText;
        if (this.characterHoverHint) return TodayTasksComponent.CHARACTER_HOVER_HINT;
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
    isUrgent = false;
    description = '';

    mentionPopoverOpen = false;
    mentionUserIds: string[] = [];
    readonly TOK_ALL = MENTION_ALL;
    readonly TOK_ADMIN = MENTION_ADMIN;

    toolbarFilter: TaskToolbarFilterState = defaultToolbarFilterState();

    /** 親の子一覧が 3 件以上のときの展開（today 専用） */
    expandedSubChildren: Record<string, boolean> = {};

    rightMenuOpen = false;
    parentEditTaskId: string | null = null;
    parentEditDraft: ParentEditDraft | null = null;
    childEditId: string | null = null;
    childEditDraft: ChildEditDraft | null = null;

    childInputs: Record<string, { title: string; assigneeId: string; scheduledDateStr: string; isTodayForNew: boolean }> = {};

    get users(): Member[] {
        return this.appService.getMembersByProjectId(this.projectId);
    }

    get mentionableUsers(): Member[] {
        return this.users.filter((u) => u.uid !== this.memberId);
    }

    get headerSelfBubbles() {
        return this.progress.bubblesForMemberHeaderDisplay(this.projectId, this.memberId);
    }

    isTaskVisibleToMember(t: ParentTask): boolean {
        if (this.appService.isPrivateMyHiddenFromOtherMember(t, this.memberId)) return false;
        if (t.leadAssigneeId === this.memberId) return true;
        if (t.memberIds.includes(this.memberId)) return true;
        return this.appService.getChildTasksByParentId(t.id).some((c) => c.assigneeId === this.memberId);
    }

    isMyParent(task: ParentTask): boolean {
        return task.createdById === this.memberId;
    }

    /** 「今日やるべきタスク」の基準リスト（ツールバー絞り込み前） */
    get baseTodayItems(): TodayItem[] {
        const items: TodayItem[] = [];
        const parents = this.appService
            .getActiveSortedParentTasksForProject(this.projectId)
            .filter((t) => (t.isTodayTask || this.appService.isParentDueToday(t.deadline)) && this.isTaskVisibleToMember(t));
        for (const p of parents) {
            items.push({ kind: 'parent', task: p });
        }
        for (const c of this.appService.childTasks) {
            if (c.projectId !== this.projectId) continue;
            if (!this.appService.isActiveChildTask(c)) continue;
            const parent = this.appService.parentTasks.find((pt) => pt.id === c.parentTaskId);
            if (!parent || !this.appService.isActiveParentTask(parent) || !this.isTaskVisibleToMember(parent)) continue;
            if (parent.isTodayTask || this.appService.isParentDueToday(parent.deadline)) continue;
            if (!this.appService.childAppearsOnMemberToday(parent, c, this.memberId)) continue;
            items.push({ kind: 'child', task: c, parent });
        }
        return items.sort((a, b) => {
            const ao = this.todayOrder(itemKey(a));
            const bo = this.todayOrder(itemKey(b));
            if (ao !== undefined || bo !== undefined) {
                if (ao === undefined) return 1;
                if (bo === undefined) return -1;
                if (ao !== bo) return ao - bo;
            }
            const pa = a.kind === 'parent' ? a.task : a.parent;
            const pb = b.kind === 'parent' ? b.task : b.parent;
            const pr = pa.priority === '高' ? 0 : 1;
            const qr = pb.priority === '高' ? 0 : 1;
            if (pr !== qr) return pr - qr;
            const ad = pa.deadline ? new Date(pa.deadline).getTime() : Number.MAX_SAFE_INTEGER;
            const bd = pb.deadline ? new Date(pb.deadline).getTime() : Number.MAX_SAFE_INTEGER;
            return ad - bd;
        });
    }

    get toolbarCandidateParents(): ParentTask[] {
        const ids = new Set<string>();
        for (const p of this.appService.getActiveSortedParentTasksForProject(this.projectId)) {
            if ((p.isTodayTask || this.appService.isParentDueToday(p.deadline)) && this.isTaskVisibleToMember(p)) ids.add(p.id);
        }
        for (const c of this.appService.childTasks) {
            if (c.projectId !== this.projectId) continue;
            if (!this.appService.isActiveChildTask(c)) continue;
            const parent = this.appService.parentTasks.find((pt) => pt.id === c.parentTaskId);
            if (!parent || !this.appService.isActiveParentTask(parent) || !this.isTaskVisibleToMember(parent) || parent.isTodayTask || this.appService.isParentDueToday(parent.deadline)) continue;
            if (this.appService.childAppearsOnMemberToday(parent, c, this.memberId)) {
                ids.add(parent.id);
            }
        }
        return [...this.appService.getAllParentTasksForProject(this.projectId)]
            .filter((t) => ids.has(t.id))
            .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
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

    todayListDragEnabled(): boolean {
        return canReorderList(this.toolbarFilter);
    }

    get todayItems(): TodayItem[] {
        return this.baseTodayItems.filter((it) => todayItemMatchesToolbar(this.toolbarFilterCtx(), it, this.toolbarFilter));
    }

    trackKey(item: TodayItem): string {
        return itemKey(item);
    }

    todayOrder(key: string): number | undefined {
        if (key.startsWith('p-')) {
            const id = key.slice(2);
            const p = this.appService.parentTasks.find((x) => x.id === id);
            return p ? this.appService.getTodayDisplayOrderForMember(p, this.memberId) : undefined;
        }
        const id = key.slice(2);
        const c = this.appService.childTasks.find((x) => x.id === id);
        return c ? this.appService.getTodayDisplayOrderForMember(c, this.memberId) : undefined;
    }

    onTodayDrop(ev: CdkDragDrop<void>): void {
        if (!this.todayListDragEnabled()) return;
        const rows = [...this.todayItems];
        if (ev.previousIndex === ev.currentIndex) return;
        moveItemInArray(rows, ev.previousIndex, ev.currentIndex);
        this.applyTodayOrderKeys(rows.map((x) => itemKey(x)));
    }

    onTodaySortPick(kind: 'deadline' | 'status'): void {
        const rows = [...this.baseTodayItems];
        rows.sort((a, b) => this.compareTodayForSort(a, b, kind));
        this.applyTodayOrderKeys(rows.map((x) => itemKey(x)));
    }

    private applyTodayOrderKeys(keys: string[]): void {
        this.appService.applyTodayReorderForMember(this.memberId, keys, (k) => {
            if (k.startsWith('p-')) {
                return this.appService.parentTasks.find((x) => x.id === k.slice(2));
            }
            return this.appService.childTasks.find((x) => x.id === k.slice(2));
        });
    }

    private compareTodayForSort(a: TodayItem, b: TodayItem, kind: 'deadline' | 'status'): number {
        if (kind === 'deadline') {
            const ad = this.todayDeadlineSortMs(a);
            const bd = this.todayDeadlineSortMs(b);
            if (ad !== bd) return ad - bd;
        } else {
            const sa = todayStatusRank(todayStatusOf(a));
            const sb = todayStatusRank(todayStatusOf(b));
            if (sa !== sb) return sa - sb;
            const ad = this.todayDeadlineSortMs(a);
            const bd = this.todayDeadlineSortMs(b);
            if (ad !== bd) return ad - bd;
        }
        const pa = todayParentOf(a);
        const pb = todayParentOf(b);
        const pr = pa.priority === '高' ? 0 : 1;
        const qr = pb.priority === '高' ? 0 : 1;
        if (pr !== qr) return pr - qr;
        const ta = a.kind === 'parent' ? a.task.title : a.task.title;
        const tb = b.kind === 'parent' ? b.task.title : b.task.title;
        return (ta || '').localeCompare(tb || '', 'ja');
    }

    private todayDeadlineSortMs(item: TodayItem): number {
        if (item.kind === 'child') {
            const c = item.task;
            if (c.scheduledDate) {
                const t = new Date(c.scheduledDate as Date | string).getTime();
                if (!Number.isNaN(t)) return t;
            }
        }
        const p = todayParentOf(item);
        if (!p.deadline || AppService.deadlineUnset(p.deadline)) return Number.MAX_SAFE_INTEGER;
        const t = new Date(p.deadline as Date | string).getTime();
        return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
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
            this.description,
            true,
            this.memberId,
            this.mentionUserIds
        );
        this.title = '';
        this.isUrgent = false;
        this.description = '';
        this.mentionUserIds = [];
        this.mentionPopoverOpen = false;
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
        this.appService.revertChildTaskFromComplete(c.id, this.memberId);
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
            if (this.blockCompletionForParent(item.task)) return;
            this.appService.cycleParentTaskStatus(item.task.id, this.memberId);
        } else {
            if (this.blockCompletionForChild(item.task)) return;
            this.appService.cycleChildTaskStatus(item.task.id, this.memberId);
        }
    }

    //子タスクのステータスを切り換える
    cycleChildAction(child: ChildTask, ev: Event): void {
        ev.stopPropagation();
        if (this.blockCompletionForChild(child)) return;
        this.appService.cycleChildTaskStatus(child.id, this.memberId);
    }

    /** 完了に進む直前なら停滞解決を促してブロック（親） */
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

    /** 完了に進む直前なら停滞解決を促してブロック（子） */
    private blockCompletionForChild(child: ChildTask): boolean {
        if (child.status !== '進行中') return false;
        if (this.progress.hasOpenStagnationForTask(this.projectId, child.parentTaskId, child.id)) {
            alert('停滞報告があります。先に解決してから完了にしてください。');
            return true;
        }
        return false;
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

    memberList(task: ParentTask): Member[] {
        return this.appService.getMembersByUids(task.memberIds);
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

    getChildInput(parentId: string): { title: string; assigneeId: string; scheduledDateStr: string; isTodayForNew: boolean } {
        if (!this.childInputs[parentId]) {
            this.childInputs[parentId] = {
                title: '',
                assigneeId: this.hideTeamTaskChrome() ? this.memberId : '',
                scheduledDateStr: '',
                isTodayForNew: false
            };
        }
        return this.childInputs[parentId];
    }

    toggleChildInputToday(parentId: string): void {
        const d = this.getChildInput(parentId);
        d.isTodayForNew = !d.isTodayForNew;
    }

    newChildTodayPillOn(parentId: string): boolean {
        const d = this.getChildInput(parentId);
        return d.isTodayForNew || this.appService.isIsoDateStringToday(d.scheduledDateStr);
    }

    parentDlClass(task: ParentTask): string {
        return this.appService.parentDeadlineCardClass(task.deadline);
    }

    childStatusChipClass(status: TaskStatus): string {
        return `subtask-status-readonly ${this.statusClass(status)}`;
    }

    leadMember(task: ParentTask): Member | undefined {
        return this.appService.getMemberById(task.leadAssigneeId);
    }

    isMyTask(task: ParentTask): boolean {
        return this.isMyParent(task);
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

    tooltipForParent(task: ParentTask): string {
        const d = (task.description || '').trim();
        return d ? d : '（備考なし）';
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

    todayCardDlClass(item: TodayItem): string {
        const dl = item.kind === 'parent' ? item.task.deadline : item.parent.deadline;
        return this.appService.parentDeadlineCardClass(dl);
    }

    addChildTask(parentTask: ParentTask): void {
        const draft = this.getChildInput(parentTask.id);
        const assigneeId = this.hideTeamTaskChrome() ? this.memberId : draft.assigneeId;
        if (!this.hideTeamTaskChrome() && !this.getAssignableMemberIds(parentTask).includes(assigneeId)) {
            alert('親タスクの担当・メンバーから担当者を選択してください');
            return;
        }
        const sd = draft.scheduledDateStr?.trim() ? draft.scheduledDateStr : null;
        const effToday =
            draft.isTodayForNew ||
            this.appService.isIsoDateStringToday(draft.scheduledDateStr) ||
            this.appService.isParentDueToday(parentTask.deadline);
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
        draft.scheduledDateStr = '';
        draft.isTodayForNew = false;
    }

    deleteParentTask(taskId: string): void {
        const t = this.appService.parentTasks.find((p) => p.id === taskId);
        if (!t || !this.appService.memberCanDeleteParent(t, this.memberId)) return;
        if (!confirm('この親タスクと紐づく子タスクをすべてゴミ箱に移しますか？')) return;
        if (this.parentEditTaskId === taskId) this.cancelParentEdit();
        this.appService.trashParentTask(taskId, this.memberId);
        this.toolbarFilter = removeParentIdFromFilter(this.toolbarFilter, taskId);
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
            isUrgent: task.priority === '高',
            mentionUserIds: [...(task.mentionUserIds ?? [])]
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

    toggleDraftMention(id: string, checked: boolean): void {
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
        const t = ev.target as HTMLElement;
        if (!t.closest('.mention-toolbar')) {
            this.mentionPopoverOpen = false;
        }
        if (!this.rightMenuOpen) return;
        if (t.closest('.side-drawer') || t.closest('.icon-gear-wrap')) return;
        this.rightMenuOpen = false;
    }

    showSiren(item: TodayItem): boolean {
        if (item.kind === 'parent') return item.task.priority === '高';
        return item.parent.priority === '高';
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
            return '今日のタスク、いいペースです。';
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
            return '順調です！このまま進めていきましょう。';
        }
        return (st.detailForHover || `${st.bubbleShort}で進行中です。`).trim();
    }
}
