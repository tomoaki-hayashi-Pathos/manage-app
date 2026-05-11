// 親タスク管理ページ

import { Component, HostListener, effect, inject, OnDestroy, OnInit } from '@angular/core';

import { AppService } from '../../app.service';

import { ActivatedRoute } from '@angular/router';

import { FormsModule } from '@angular/forms';

import { CommonModule } from '@angular/common';

import { RouterLink } from '@angular/router';

import { ParentTask, Member, TaskStatus, ChildTask, MENTION_ALL, MENTION_ADMIN, AdminNavPageKey } from '../../core/interface';

import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ProgressReportingService } from '../../services/progress-reporting.service';
import { AiChatService } from '../../services/ai-chat.service';
import { StorageService, storageKeyConsultationBundle } from '../../services/storage.service';
import type { ConsultationProjectBundle } from '../../core/progress-chat.types';
import { MemberProgressBubblesComponent } from '../../shared/member-progress-bubbles/member-progress-bubbles.component';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';

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
    imports: [FormsModule, CommonModule, RouterLink, DragDropModule, MemberProgressBubblesComponent],
    templateUrl: './Manage-tasks.html',
    styleUrls: ['./Manage-tasks.css', '../../progress-ai.css']
})
export class ManageTasksComponent implements OnInit, OnDestroy {

    public appService = inject(AppService);
    public route = inject(ActivatedRoute);
    readonly progress = inject(ProgressReportingService);
    readonly aiChat = inject(AiChatService);
    private readonly storage = inject(StorageService);
    private readonly adminAccess = inject(AdminProjectAccessService);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    private readonly accessEffect = effect(() => {
        this.adminAccess.redirectIfForbidden(this.projectId);
    });

    projectName = this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    readonly characterVideoSrc = 'assets/character-typing.mp4';
    characterBubbleVisible = false;
    characterBubbleText = '';
    /** 要相談サマリ表示中は確認ボタンを出す */
    consultationConfirm = false;
    private consultUnsub: (() => void) | null = null;
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

    /** 'all' = すべて表示、それ以外 = 親タスク id */
    parentTaskFilterId: string | 'all' = 'all';

    viewMode: number = 0;
    incompleteSectionOpen = false;

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
        this.consultUnsub = this.storage.watchKey(storageKeyConsultationBundle(this.projectId), () => {
            void this.refreshConsultationBubbleFromStorage();
        });
        void this.refreshConsultationBubbleFromStorage();
        this.startCharacterBubbleLoop();
    }

    ngOnDestroy(): void {
        this.appService.setAdminCurrentNavPage(this.projectId, null);
        this.progress.setAdminPageActive(this.projectId, false);
        this.consultUnsub?.();
        this.consultUnsub = null;
        this.clearCharacterBubbleTimers();
        if (this.aiChat.chatOpen() && this.aiChat.projectIdOpen() === this.projectId) {
            this.aiChat.closeChat();
        }
    }

    /** 管理画面左下 OL：メンバー文脈で AI 相談（進捗の deferred は起こさない） */
    chatDraft = '';
    chatPublicOn = true;

    openAdminOlChat(): void {
        const mid =
            this.memberId?.trim() ||
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
        const deferred = new Set(
            this.appService.getMembersByProjectId(this.projectId).map((m) => m.uid).filter((uid) => this.aiChat.isChatActiveFor(this.projectId, uid))
        );
        this.progress.requestProgressReport(this.projectId, deferred);
        alert('メンバー全員に進捗の報告（もう終わる / 問題なし / 要相談）を促しました。');
    }

    progressBubblesForChild(task: ParentTask, child: ChildTask) {
        return this.progress.bubblesForChildRow(this.projectId, task, child.id, null, child.assigneeId ?? null);
    }

    progressBubblesParentOnly(task: ParentTask) {
        return this.progress.bubblesForParentOnly(this.projectId, task, null);
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
        return this.appService.getMembersByProjectId(this.projectId).filter((m) => m.role !== '管理者');
    }

    /** 絞り込み用（下書き含む） */
    get parentTasksForFilter(): ParentTask[] {
        return [...this.appService.getAllParentTasksForProject(this.projectId)]
            .filter((t) => !t.isDraft)
            .filter((t) => !this.appService.shouldExcludePrivateMyFromAdmin(t))
            .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
    }

    get visibleParentTasks(): ParentTask[] {
        let tasks = this.appService
            .getSortedParentTasksForProject(this.projectId, false)
            .filter((t) => !this.appService.shouldExcludePrivateMyFromAdmin(t));
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

    createParentTask(): void {
        const deadline = this.deadlineInput ? new Date(this.deadlineInput) : null;
        const lead = this.selectionOrder[0] ?? null;
        const members = this.selectionOrder.slice(1);
        this.appService.CreateParentTask(this.projectId, this.title, deadline, this.isUrgent, lead, members, this.description, false, null, this.mentionUserIds);
        this.title = '';
        this.deadlineInput = '';
        this.isUrgent = false;
        this.description = '';
        this.selectionOrder = [];
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

        const list = [...this.visibleParentTasks];

        if (ev.previousIndex === ev.currentIndex) return;

        moveItemInArray(list, ev.previousIndex, ev.currentIndex);

        this.appService.applyParentTaskReorder(this.projectId, list);

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
        }, undefined);

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
        if (this.parentTaskFilterId === taskId) this.parentTaskFilterId = 'all';
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

        });

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

    //テスト時のみ使用（leadMemberにも記載あり）

    memberId: string = this.appService.members.find((m)=>m.email === 'tomoaki8843@gmail.com')!.uid;
    
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

    private async refreshConsultationBubbleFromStorage(): Promise<void> {
        const bundle = this.storage.getJson<ConsultationProjectBundle | null>(storageKeyConsultationBundle(this.projectId));
        if (!bundle || !Array.isArray(bundle.entries)) {
            this.consultationConfirm = false;
            return;
        }
        const dismissed = bundle.adminDismissedAt ?? 0;
        const pending = bundle.entries.filter((e) => e.at > dismissed);
        if (pending.length === 0) {
            this.consultationConfirm = false;
            return;
        }
        const text = await this.aiChat.summarizeConsultationEntries(pending, this.projectId);
        this.clearCharacterBubbleTimers();
        this.characterBubbleText = text;
        this.characterBubbleVisible = true;
        this.consultationConfirm = true;
    }

    confirmConsultationRead(): void {
        const key = storageKeyConsultationBundle(this.projectId);
        const bundle = this.storage.getJson<ConsultationProjectBundle | null>(key);
        if (!bundle || !Array.isArray(bundle.entries)) {
            this.consultationConfirm = false;
            this.characterBubbleVisible = false;
            this.scheduleCharacterBubble();
            return;
        }
        bundle.adminDismissedAt = Date.now();
        this.storage.setJson(key, bundle);
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
