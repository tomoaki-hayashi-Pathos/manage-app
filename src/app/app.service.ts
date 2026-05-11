//サービスファイル

import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Firestore, doc, getDoc, onSnapshot, setDoc, Unsubscribe } from '@angular/fire/firestore';

import {

    Project,

    ParentTask,

    ChildTask,

    Member,

    TaskStatus,

    Priority,

    MemberBurdenSummary,

    MENTION_ALL,

    MENTION_ADMIN,

    MemberNavPageKey,

    AdminNavPageKey,

    PendingLoginMember,

    TaskStatusChangeLogEntry

} from './core/interface';

import { Router } from '@angular/router';



@Injectable({

    providedIn: 'root'

})

export class AppService {
    private readonly firestore = inject(Firestore);
    private readonly zone = inject(NgZone);
    private readonly stateDocRef = doc(this.firestore, 'appState', 'primary');
    private hydrated = false;
    private lastPersistedSnapshot = '';
    private unsubscribeRealtime: Unsubscribe | null = null;
    private applyingRemote = false;
    private writeInFlight = false;
    private pendingPersist = false;
    private lastAppliedUpdatedAt = 0;
    private lastLocalWriteAt = 0;



    projectId: string = crypto.randomUUID();

    projects: Project[] = [];

    parentTasks: ParentTask[] = [];

    childTasks: ChildTask[] = [];

    members: Member[] = [];
    pendingLoginMembers: PendingLoginMember[] = [];

    /** 明示的なステータス変更のみ（親子自動同期は含めない） */
    taskStatusChangeLog: TaskStatusChangeLogEntry[] = [];



    /** テンプレートが通知更新を拾うためのシグナル */

    readonly notificationTick = signal(0);
    readonly ready = signal(false);



    /** 「projectId::memberUid」→ ページ種別 → 未確認件数 */

    private memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>> = {};

    /** projectId → 管理画面ドロワー用未確認件数 */

    private adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>> = {};

    /** projectId::memberId → 現在表示中のメンバー画面（通知抑制用） */

    private memberCurrentNavPage: Partial<Record<string, MemberNavPageKey>> = {};

    /** projectId → 現在表示中の管理画面（通知抑制用） */

    private adminCurrentNavPage: Partial<Record<string, AdminNavPageKey>> = {};



    constructor(private router: Router) {
        void this.hydrateFromFirestore();
        this.bindRealtimeState();
        if (typeof window !== 'undefined') {
            window.setInterval(() => {
                void this.persistIfNeeded();
            }, 250);
        }
    }

    private normalizeDateLike(value: unknown): Date | string | null {
        if (value === null || value === undefined || value === '') return null;
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        if (typeof value === 'string') {
            const d = new Date(value);
            return Number.isNaN(d.getTime()) ? null : value;
        }
        if (typeof value === 'object') {
            const maybe = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
            if (typeof maybe.toDate === 'function') {
                const d = maybe.toDate();
                return Number.isNaN(d.getTime()) ? null : d;
            }
            if (typeof maybe.seconds === 'number') {
                const ms = maybe.seconds * 1000 + Math.floor((maybe.nanoseconds ?? 0) / 1000000);
                const d = new Date(ms);
                return Number.isNaN(d.getTime()) ? null : d;
            }
        }
        return null;
    }

    private buildPersistencePayload(): {
        projectId: string;
        projects: Project[];
        parentTasks: ParentTask[];
        childTasks: ChildTask[];
        members: Member[];
        pendingLoginMembers: PendingLoginMember[];
        memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
        adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
        taskStatusChangeLog: TaskStatusChangeLogEntry[];
    } {
        return {
            projectId: this.projectId,
            projects: this.projects,
            parentTasks: this.parentTasks,
            childTasks: this.childTasks,
            members: this.members,
            pendingLoginMembers: this.pendingLoginMembers,
            memberNotificationCounts: this.memberNotificationCounts,
            adminNotificationCounts: this.adminNotificationCounts,
            taskStatusChangeLog: this.taskStatusChangeLog
        };
    }

    private sanitizeForFirestore<T>(value: T): T {
        if (value === undefined) return null as T;
        if (value === null) return value;
        if (value instanceof Date) return value;
        if (Array.isArray(value)) {
            return value
                .map((x) => this.sanitizeForFirestore(x))
                .filter((x) => x !== undefined) as T;
        }
        if (typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                if (v === undefined) continue;
                out[k] = this.sanitizeForFirestore(v);
            }
            return out as T;
        }
        return value;
    }

    private applyStateData(data: Partial<{
        projectId: string;
        projects: Project[];
        parentTasks: ParentTask[];
        childTasks: ChildTask[];
        members: Member[];
        pendingLoginMembers: PendingLoginMember[];
        memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
        adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
        taskStatusChangeLog: TaskStatusChangeLogEntry[];
        updatedAt: number;
    }>): void {
        this.projectId = data.projectId || this.projectId;
        this.projects = Array.isArray(data.projects) ? data.projects : [];
        this.parentTasks = Array.isArray(data.parentTasks)
            ? data.parentTasks.map((t) => ({
                  ...t,
                  deadline: this.normalizeDateLike((t as ParentTask).deadline)
              }))
            : [];
        this.childTasks = Array.isArray(data.childTasks)
            ? data.childTasks.map((c) => ({
                  ...c,
                  deadline: this.normalizeDateLike((c as ChildTask).deadline),
                  scheduledDate: this.normalizeDateLike((c as ChildTask).scheduledDate)
              }))
            : [];
        this.members = Array.isArray(data.members) ? data.members : [];
        this.pendingLoginMembers = Array.isArray(data.pendingLoginMembers) ? data.pendingLoginMembers : [];
        this.memberNotificationCounts = data.memberNotificationCounts ?? {};
        this.adminNotificationCounts = data.adminNotificationCounts ?? {};
        if (data.taskStatusChangeLog !== undefined && Array.isArray(data.taskStatusChangeLog)) {
            this.taskStatusChangeLog = data.taskStatusChangeLog;
        }
        const clearedOpenPageCounts = this.zeroNotificationCountsForCurrentlyOpenPages();
        this.touchNotifications();
        if (clearedOpenPageCounts) {
            this.markStateChanged();
        }
    }

    /**
     * Firestore から通知カウントを取り込んだ直後、今そのページを開いていればその page の件数を 0 にする。
     * （別クライアントが bump した後も、閲覧中タブではバッジを出さない）
     */
    private zeroNotificationCountsForCurrentlyOpenPages(): boolean {
        let changed = false;
        for (const [storeKey, page] of Object.entries(this.memberCurrentNavPage) as [string, MemberNavPageKey][]) {
            const bag = this.memberNotificationCounts[storeKey];
            if (bag?.[page] != null && bag[page]! > 0) {
                delete bag[page];
                changed = true;
            }
        }
        for (const [projectId, page] of Object.entries(this.adminCurrentNavPage) as [string, AdminNavPageKey][]) {
            const bag = this.adminNotificationCounts[projectId];
            if (bag?.[page] != null && bag[page]! > 0) {
                delete bag[page];
                changed = true;
            }
        }
        return changed;
    }

    private bindRealtimeState(): void {
        this.unsubscribeRealtime?.();
        this.unsubscribeRealtime = onSnapshot(this.stateDocRef, (snap) => {
            this.zone.run(() => {
                if (!snap.exists()) return;
                const data = snap.data() as Partial<{
                    projectId: string;
                    projects: Project[];
                    parentTasks: ParentTask[];
                    childTasks: ChildTask[];
                    members: Member[];
                    pendingLoginMembers: PendingLoginMember[];
                    memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
                    adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
                    taskStatusChangeLog: TaskStatusChangeLogEntry[];
                    updatedAt: number;
                }>;
                const remoteUpdatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
                if (remoteUpdatedAt > 0 && remoteUpdatedAt < this.lastAppliedUpdatedAt) return;
                if (this.writeInFlight && remoteUpdatedAt > 0 && remoteUpdatedAt <= this.lastLocalWriteAt) return;
                const nextSnapshot = JSON.stringify({
                    projectId: data.projectId ?? this.projectId,
                    projects: Array.isArray(data.projects) ? data.projects : [],
                    parentTasks: Array.isArray(data.parentTasks) ? data.parentTasks : [],
                    childTasks: Array.isArray(data.childTasks) ? data.childTasks : [],
                    members: Array.isArray(data.members) ? data.members : [],
                    pendingLoginMembers: Array.isArray(data.pendingLoginMembers) ? data.pendingLoginMembers : [],
                    memberNotificationCounts: data.memberNotificationCounts ?? {},
                    adminNotificationCounts: data.adminNotificationCounts ?? {},
                    taskStatusChangeLog: Array.isArray(data.taskStatusChangeLog) ? data.taskStatusChangeLog : [],
                    updatedAt: remoteUpdatedAt
                });
                if (nextSnapshot === this.lastPersistedSnapshot) return;
                this.applyingRemote = true;
                try {
                    this.applyStateData(data);
                    this.hydrated = true;
                    this.ready.set(true);
                    this.ensureBootstrapAdminFromPending();
                    this.lastPersistedSnapshot = JSON.stringify(this.buildPersistencePayload());
                    if (remoteUpdatedAt > 0) this.lastAppliedUpdatedAt = remoteUpdatedAt;
                } finally {
                    this.applyingRemote = false;
                }
            });
        });
    }

    private async hydrateFromFirestore(): Promise<void> {
        try {
            const snap = await getDoc(this.stateDocRef);
            if (snap.exists()) {
                const data = snap.data() as Partial<{
                    projectId: string;
                    projects: Project[];
                    parentTasks: ParentTask[];
                    childTasks: ChildTask[];
                    members: Member[];
                    pendingLoginMembers: PendingLoginMember[];
                    memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
                    adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
                    taskStatusChangeLog: TaskStatusChangeLogEntry[];
                    updatedAt: number;
                }>;
                this.applyStateData(data);
                if (typeof data.updatedAt === 'number') this.lastAppliedUpdatedAt = data.updatedAt;
            }
            this.hydrated = true;
            this.ready.set(true);
            this.ensureBootstrapAdminFromPending();
            this.lastPersistedSnapshot = JSON.stringify(this.buildPersistencePayload());
        } catch {
            this.hydrated = true;
            this.ready.set(true);
            this.ensureBootstrapAdminFromPending();
        }
    }

    async refreshStateFromFirestore(): Promise<void> {
        try {
            const snap = await getDoc(this.stateDocRef);
            if (!snap.exists()) return;
            const data = snap.data() as Partial<{
                projectId: string;
                projects: Project[];
                parentTasks: ParentTask[];
                childTasks: ChildTask[];
                members: Member[];
                pendingLoginMembers: PendingLoginMember[];
                memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
                adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
                taskStatusChangeLog: TaskStatusChangeLogEntry[];
                updatedAt: number;
            }>;
            const remoteUpdatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
            if (remoteUpdatedAt > 0 && remoteUpdatedAt < this.lastAppliedUpdatedAt) return;
            this.applyingRemote = true;
            try {
                this.applyStateData(data);
                if (remoteUpdatedAt > 0) this.lastAppliedUpdatedAt = remoteUpdatedAt;
                this.lastPersistedSnapshot = JSON.stringify(this.buildPersistencePayload());
            } finally {
                this.applyingRemote = false;
            }
        } catch {
            // AI context should still be built from the latest realtime snapshot we have.
        }
    }

    private ensureBootstrapAdminFromPending(): void {
        if (!this.hydrated) return;
        if (this.members.length > 0) return;
        if (this.pendingLoginMembers.length === 0) return;
        const first = [...this.pendingLoginMembers].sort((a, b) => a.requestedAt - b.requestedAt)[0];
        this.members.push({
            uid: first.uid?.trim() || crypto.randomUUID(),
            name: first.name.trim() || first.email,
            email: first.email.trim().toLowerCase(),
            photoURL: first.photoURL || '',
            role: '管理者'
        });
        this.pendingLoginMembers = this.pendingLoginMembers.filter(
            (x) => x.email.trim().toLowerCase() !== first.email.trim().toLowerCase()
        );
        void this.persistIfNeeded();
    }

    private async persistIfNeeded(): Promise<void> {
        if (!this.hydrated) return;
        if (this.applyingRemote) return;
        if (this.writeInFlight) {
            this.pendingPersist = true;
            return;
        }
        const payload = this.buildPersistencePayload();
        const next = JSON.stringify(payload);
        if (next === this.lastPersistedSnapshot) return;
        const writeAt = Date.now();
        this.lastLocalWriteAt = writeAt;
        this.writeInFlight = true;
        try {
            const safePayload = this.sanitizeForFirestore(payload);
            await setDoc(this.stateDocRef, {
                ...safePayload,
                updatedAt: writeAt
            });
            this.lastPersistedSnapshot = next;
            this.lastAppliedUpdatedAt = Math.max(this.lastAppliedUpdatedAt, writeAt);
        } catch (e) {
            console.error('Failed to persist app state to Firestore.', e);
        } finally {
            this.writeInFlight = false;
            if (this.pendingPersist) {
                this.pendingPersist = false;
                void this.persistIfNeeded();
            }
        }
    }

    private markStateChanged(): void {
        void this.persistIfNeeded();
    }



    private touchNotifications(): void {

        this.notificationTick.update((x) => x + 1);

    }



    private notificationStoreKey(projectId: string, memberId: string): string {

        return `${projectId}::${memberId}`;

    }



    getMemberPageNotificationCount(projectId: string, memberId: string, page: MemberNavPageKey): number {

        const bag = this.memberNotificationCounts[this.notificationStoreKey(projectId, memberId)];

        return bag?.[page] ?? 0;

    }



    getMemberGearNotificationTotal(projectId: string, memberId: string): number {

        const bag = this.memberNotificationCounts[this.notificationStoreKey(projectId, memberId)];

        if (!bag) return 0;

        let s = 0;

        (Object.keys(bag) as MemberNavPageKey[]).forEach((k) => {

            s += bag[k] ?? 0;

        });

        return s;

    }



    clearMemberPageNotifications(projectId: string, memberId: string, page: MemberNavPageKey): void {

        const key = this.notificationStoreKey(projectId, memberId);

        const bag = this.memberNotificationCounts[key];

        if (bag?.[page] != null && bag[page]! > 0) {

            delete bag[page];

            this.touchNotifications();
            this.markStateChanged();

        }

    }

    /** メンバー画面の「現在のページ」（通知抑制。null で解除） */
    setMemberCurrentNavPage(projectId: string, memberId: string, page: MemberNavPageKey | null): void {
        const key = this.notificationStoreKey(projectId, memberId);
        if (page === null) {
            delete this.memberCurrentNavPage[key];
        } else {
            this.memberCurrentNavPage[key] = page;
        }
        this.touchNotifications();
    }

    /** 管理画面の「現在のページ」（通知抑制。null で解除） */
    setAdminCurrentNavPage(projectId: string, page: AdminNavPageKey | null): void {
        if (page === null) {
            delete this.adminCurrentNavPage[projectId];
        } else {
            this.adminCurrentNavPage[projectId] = page;
        }
        this.touchNotifications();
    }

    getAdminPageNotificationCount(projectId: string, page: AdminNavPageKey): number {
        return this.adminNotificationCounts[projectId]?.[page] ?? 0;
    }

    getAdminGearNotificationTotal(projectId: string): number {
        const bag = this.adminNotificationCounts[projectId];
        if (!bag) return 0;
        let s = 0;
        (Object.keys(bag) as AdminNavPageKey[]).forEach((k) => {
            s += bag[k] ?? 0;
        });
        return s;
    }

    clearAdminPageNotifications(projectId: string, page: AdminNavPageKey): void {
        const bag = this.adminNotificationCounts[projectId];
        if (bag?.[page] != null && bag[page]! > 0) {
            delete bag[page];
            this.touchNotifications();
            this.markStateChanged();
        }
    }

    private cloneParentNotifyShallow(t: ParentTask): ParentTask {
        return {
            ...t,
            memberIds: [...(t.memberIds ?? [])],
            mentionUserIds: [...(t.mentionUserIds ?? [])]
        };
    }

    private getChildAssigneeIdsForParent(parentId: string): string[] {
        return this.getChildTasksByParentId(parentId)
            .map((c) => c.assigneeId)
            .filter((id): id is string => !!id);
    }

    private deadlineMsForNotify(d: ParentTask['deadline']): number | null {
        if (d == null || AppService.deadlineUnset(d)) return null;
        const x = new Date(d as Date | string).getTime();
        return Number.isNaN(x) ? null : x;
    }

    private showsOnMemberLimitWithAssignees(parent: ParentTask, memberId: string, assigneeIds: string[]): boolean {
        if (parent.isDraft) return false;
        if (this.isPrivateMyHiddenFromOtherMember(parent, memberId)) return false;
        if (parent.leadAssigneeId === memberId) return true;
        if (parent.memberIds.includes(memberId)) return true;
        return assigneeIds.some((id) => id === memberId);
    }

    private memberOnNotSetPage(parent: ParentTask, memberId: string): boolean {
        return (
            parent.leadAssigneeId === memberId &&
            AppService.deadlineUnset(parent.deadline) &&
            !parent.isTodayTask
        );
    }

    private bumpAdminPage(
        projectId: string,
        page: AdminNavPageKey,
        actorUid?: string | null,
        options?: { silent?: boolean }
    ): void {
        const adminId = this.getProjectAdminId(projectId);
        if (actorUid && adminId && actorUid === adminId) return;
        if (this.adminCurrentNavPage[projectId] === page) return;
        if (!this.adminNotificationCounts[projectId]) this.adminNotificationCounts[projectId] = {};
        const cur = this.adminNotificationCounts[projectId][page] ?? 0;
        this.adminNotificationCounts[projectId][page] = cur + 1;
        this.touchNotifications();
        if (!options?.silent) this.markStateChanged();
    }

    /**
     * 親タスクの変更に伴う一覧件数増加通知（差分のみ）。
     * parentBefore が null のときは「新規作成前」とみなし、当該 id に対する before 側はすべて偽。
     */
    private notifyParentListDeltas(
        parentBefore: ParentTask | null,
        assigneesBefore: string[],
        parentAfter: ParentTask,
        assigneesAfter: string[],
        actorMemberUid?: string | null
    ): void {
        const projectId = parentAfter.projectId;
        const adminId = this.getProjectAdminId(projectId);

        const deadlineChanged =
            parentBefore !== null &&
            this.deadlineMsForNotify(parentBefore.deadline) !== this.deadlineMsForNotify(parentAfter.deadline);

        for (const m of this.getMembersByProjectId(projectId)) {
            const limB = parentBefore
                ? this.showsOnMemberLimitWithAssignees(parentBefore, m.uid, assigneesBefore)
                : false;
            const limA = this.showsOnMemberLimitWithAssignees(parentAfter, m.uid, assigneesAfter);
            if ((limA && !limB) || (limA && deadlineChanged)) {
                this.bumpMemberPage(projectId, m.uid, 'limit', actorMemberUid ?? undefined, { silent: true });
            }

            const nsB = parentBefore ? this.memberOnNotSetPage(parentBefore, m.uid) : false;
            const nsA = this.memberOnNotSetPage(parentAfter, m.uid);
            if (!nsB && nsA) {
                this.bumpMemberPage(projectId, m.uid, 'not-set', actorMemberUid ?? undefined, { silent: true });
            }

            const shB = parentBefore ? this.isSharedTaskVisibleToMember(parentBefore, m.uid) : false;
            const shA = this.isSharedTaskVisibleToMember(parentAfter, m.uid);
            if (!shB && shA && parentAfter.createdById !== m.uid) {
                this.bumpMemberPage(projectId, m.uid, 'shared', actorMemberUid ?? undefined, { silent: true });
            }
        }

        if (adminId) {
            const adShB = parentBefore ? this.isSharedTaskVisibleToAdmin(parentBefore) : false;
            const adShA = this.isSharedTaskVisibleToAdmin(parentAfter);
            if (!adShB && adShA && parentAfter.createdById !== adminId) {
                this.bumpAdminPage(projectId, 'shared', actorMemberUid ?? undefined, { silent: true });
            }

            const stB = parentBefore?.status;
            const stA = parentAfter.status;
            if (stA === '完了' && stB !== '完了') {
                this.bumpAdminPage(projectId, 'completed', actorMemberUid ?? undefined, { silent: true });
            }
        }

        this.markStateChanged();
    }



    /** 親タスクの期限に対する一覧カード用トーン（親カード背景） */

    parentDeadlineTone(deadline: ParentTask['deadline']): 'default' | 'warn3' | 'today' | 'blink' | 'overdue' {

        if (!deadline || AppService.deadlineUnset(deadline)) {

            return 'default';

        }

        const end = new Date(deadline as Date | string);

        if (Number.isNaN(end.getTime())) {

            return 'default';

        }

        const now = new Date();

        const today = AppService.startOfLocalDay(now);

        const dueDay = AppService.startOfLocalDay(end);

        const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86400000);

        const msToDeadline = end.getTime() - now.getTime();

        if (msToDeadline > 0 && msToDeadline <= 3600000) {

            return 'blink';

        }

        if (diffDays < 0) {

            return 'overdue';

        }

        if (diffDays === 0) {

            return 'today';

        }

        if (diffDays <= 3) {

            return 'warn3';

        }

        return 'default';

    }



    /** 親カードへの CSS クラス（空文字 = 既定の白系） */

    parentDeadlineCardClass(deadline: ParentTask['deadline']): string {

        switch (this.parentDeadlineTone(deadline)) {

            case 'warn3':

                return 'parent-card--deadline-warn3';

            case 'today':

                return 'parent-card--deadline-today';

            case 'blink':

                return 'parent-card--deadline-today parent-card--deadline-blink';

            case 'overdue':

                return 'parent-card--deadline-today parent-card--deadline-overdue';

            default:

                return '';

        }

    }



    scheduledDateIsToday(d: ChildTask['scheduledDate']): boolean {

        if (d === null || d === undefined) return false;

        if (typeof d === 'string' && !String(d).trim()) return false;

        const x = new Date(d as Date | string);

        if (Number.isNaN(x.getTime())) return false;

        const today = AppService.startOfLocalDay(new Date());

        return AppService.startOfLocalDay(x).getTime() === today.getTime();

    }

    /** 子フォームの `YYYY-MM-DD` が今日か */
    isIsoDateStringToday(iso: string | null | undefined): boolean {
        if (!iso?.trim()) return false;
        return this.scheduledDateIsToday(iso.trim());
    }

    /** 親期限が今日 or 子の実施予定日が今日 →「今日やる」は自動で ON */
    childTodayAutoOn(parent: ParentTask, child: ChildTask): boolean {
        if (this.isParentDueToday(parent.deadline)) return true;
        return this.scheduledDateIsToday(child.scheduledDate);
    }

    /** UI：手動 ON または自動条件 */
    childTodayPillVisualOn(parent: ParentTask, child: ChildTask): boolean {
        return child.isTodayTask || this.childTodayAutoOn(parent, child);
    }

    isParentDueToday(deadline: ParentTask['deadline']): boolean {

        if (!deadline || AppService.deadlineUnset(deadline)) return false;

        const d = new Date(deadline as Date | string);

        if (Number.isNaN(d.getTime())) return false;

        const today = AppService.startOfLocalDay(new Date());

        return AppService.startOfLocalDay(d).getTime() === today.getTime();

    }



    getTodayDisplayOrderForMember(task: ParentTask | ChildTask, memberId: string): number | undefined {

        return task.todayDisplayOrder?.[memberId];

    }



    setTodayDisplayOrderForMember(
        task: ParentTask | ChildTask,
        memberId: string,
        order: number,
        options?: { silent?: boolean }
    ): void {

        if (!task.todayDisplayOrder) task.todayDisplayOrder = {};

        task.todayDisplayOrder[memberId] = order;
        if (!options?.silent) this.markStateChanged();

    }



    applyTodayReorderForMember(

        memberId: string,

        orderedKeys: string[],

        resolver: (key: string) => ParentTask | ChildTask | undefined

    ): void {

        orderedKeys.forEach((k, i) => {

            const row = resolver(k);

            if (!row) return;

            this.setTodayDisplayOrderForMember(row, memberId, i, { silent: true });

        });
        this.markStateChanged();

    }



    childAppearsOnMemberToday(parent: ParentTask, child: ChildTask, memberId: string): boolean {

        if (parent.isTodayTask) return false;

        if (this.isParentDueToday(parent.deadline)) return false;

        if (child.assigneeId !== memberId) return false;

        if (child.isTodayTask) return true;

        return this.scheduledDateIsToday(child.scheduledDate);

    }



    /** 期限日が今日の非下書き親なら「今日やる」を立て、親トグル ON と同様に子の isTodayTask も揃える */

    private syncTodayFlagsForParentDueToday(parent: ParentTask): void {

        if (parent.isDraft) return;

        if (!parent.deadline || AppService.deadlineUnset(parent.deadline)) return;

        if (!this.isParentDueToday(parent.deadline)) return;

        parent.isTodayTask = true;

        for (const c of this.childTasks) {

            if (c.parentTaskId === parent.id) {

                c.isTodayTask = true;

            }

        }

    }



    private showsOnMemberLimit(parent: ParentTask, memberId: string): boolean {

        return this.showsOnMemberLimitWithAssignees(parent, memberId, this.getChildAssigneeIdsForParent(parent.id));

    }



    private isParentVisibleToMemberBase(parent: ParentTask, memberId: string): boolean {

        if (this.isPrivateMyHiddenFromOtherMember(parent, memberId)) return false;

        if (parent.leadAssigneeId === memberId) return true;

        if (parent.memberIds.includes(memberId)) return true;

        return this.getChildTasksByParentId(parent.id).some((c) => c.assigneeId === memberId);

    }



    /** 期限未設定ページと同等の判定 */

    static deadlineUnset(d: ParentTask['deadline']): boolean {

        if (d === null || d === undefined) return true;

        if (typeof d === 'string' && !String(d).trim()) return true;

        const t = new Date(d as Date | string);

        return Number.isNaN(t.getTime());

    }



    collectMemberPagesForParent(parent: ParentTask, memberId: string): MemberNavPageKey[] {

        const pages = new Set<MemberNavPageKey>();

        if (this.showsOnMemberLimit(parent, memberId)) {

            pages.add('limit');

        }

        if (

            parent.leadAssigneeId === memberId &&

            AppService.deadlineUnset(parent.deadline) &&

            !parent.isTodayTask

        ) {

            pages.add('not-set');

        }

        if (!parent.isDraft && this.isParentVisibleToMemberBase(parent, memberId)) {

            if (parent.isTodayTask || this.isParentDueToday(parent.deadline)) {

                pages.add('today');

            } else if (

                this.getChildTasksByParentId(parent.id).some((c) =>

                    this.childAppearsOnMemberToday(parent, c, memberId)

                )

            ) {

                pages.add('today');

            }

        }

        if (

            parent.status === '完了' &&

            (parent.leadAssigneeId === memberId || parent.memberIds.includes(memberId))

        ) {

            pages.add('completed');

        }

        if (this.isSharedTaskVisibleToMember(parent, memberId)) {

            pages.add('shared');

        }

        return [...pages];

    }



    private bumpMemberPage(
        projectId: string,
        memberId: string,
        page: MemberNavPageKey,
        actorMemberUid?: string,
        options?: { silent?: boolean }
    ): void {

        if (actorMemberUid && memberId === actorMemberUid) return;

        const key = this.notificationStoreKey(projectId, memberId);

        if (this.memberCurrentNavPage[key] === page) return;

        if (!this.memberNotificationCounts[key]) this.memberNotificationCounts[key] = {};

        const cur = this.memberNotificationCounts[key][page] ?? 0;

        this.memberNotificationCounts[key][page] = cur + 1;

        this.touchNotifications();
        if (!options?.silent) this.markStateChanged();

    }

    /** 親一覧のドラッグ並び替えでは通知しない（項目を保存したときのみ通知） */
    notifyTaskListReordered(_projectId: string, _actorMemberUid?: string): void {}



    /** 子タスクの実施予定日: 今日 0:00 〜 親期限日（時刻は無視し日付で上限） */

    childScheduledDateRangeIso(parent: ParentTask): { min: string; max: string } | null {

        const today = AppService.startOfLocalDay(new Date());

        const min = this.toIsoDateOnly(today);

        if (!parent.deadline || AppService.deadlineUnset(parent.deadline)) {

            return null;

        }

        const dl = new Date(parent.deadline as Date | string);

        if (Number.isNaN(dl.getTime())) {

            return null;

        }

        const cap = AppService.startOfLocalDay(dl);

        const max = this.toIsoDateOnly(cap);

        return { min, max };

    }



    private toIsoDateOnly(d: Date): string {

        const y = d.getFullYear();

        const mo = String(d.getMonth() + 1).padStart(2, '0');

        const da = String(d.getDate()).padStart(2, '0');

        return `${y}-${mo}-${da}`;

    }



    private normalizeChildScheduledDate(

        value: Date | string | null | undefined,

        parent: ParentTask

    ): Date | string | null | undefined {

        if (value === null || value === undefined) return value;

        if (typeof value === 'string' && !value.trim()) return null;

        const d = new Date(value as Date | string);

        if (Number.isNaN(d.getTime())) {

            alert('実施予定日が無効です');

            return undefined;

        }

        const rng = this.childScheduledDateRangeIso(parent);

        if (!rng) {

            alert('親タスクに有効な期限を設定してください');

            return undefined;

        }

        const iso = this.toIsoDateOnly(AppService.startOfLocalDay(d));

        if (iso < rng.min || iso > rng.max) {

            alert('実施予定日は「今日」から「親タスクの期限日」までの範囲で選んでください');

            return undefined;

        }

        return iso;

    }



    /** 並び替え: 画面に載っている親の並びを、プロジェクト全体の displayOrder に反映 */

    applyParentTaskReorder(projectId: string, visibleParentsInOrder: ParentTask[]): void {

        const visibleIds = visibleParentsInOrder.map((t) => t.id);

        if (visibleIds.length === 0) return;

        const visibleSet = new Set(visibleIds);

        const baseOrder = this.parentTasks

            .filter((t) => t.projectId === projectId && !t.isDraft)

            .sort((a, b) => {

                const ad = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;

                const bd = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;

                if (ad !== bd) return ad - bd;

                const pr = a.priority === '高' ? 0 : 1;

                const qr = b.priority === '高' ? 0 : 1;

                if (pr !== qr) return pr - qr;

                const da = a.displayOrder ?? 0;

                const db = b.displayOrder ?? 0;

                if (da !== db) return da - db;

                return (a.title || '').localeCompare(b.title || '', 'ja');

            })

            .map((t) => t.id);

        const newOrder: string[] = [];

        let inserted = false;

        for (const id of baseOrder) {

            if (!visibleSet.has(id)) {

                newOrder.push(id);

            } else if (!inserted) {

                newOrder.push(...visibleIds);

                inserted = true;

            }

        }

        if (!inserted) {

            newOrder.push(...visibleIds);

        }

        newOrder.forEach((id, i) => {

            const t = this.parentTasks.find((p) => p.id === id);

            if (t && t.projectId === projectId && !t.isDraft) {

                t.displayOrder = i;

            }

        });
        this.markStateChanged();

    }



    saveParentTaskEditBundle(

        taskId: string,

        bundle: {

            title: string;

            description: string;

            deadline: Date | null;

            priority: Priority;

            mentionUserIds: string[];

            selectionOrder: string[];

        },

        actorMemberUid?: string

    ): void {

        const parentRow = this.parentTasks.find((p) => p.id === taskId);

        if (!parentRow) return;

        const parentBefore = this.cloneParentNotifyShallow(parentRow);

        const assigneesBefore = this.getChildAssigneeIdsForParent(taskId);

        this.patchParentTask(

            taskId,

            {

                title: bundle.title,

                description: bundle.description,

                deadline: bundle.deadline,

                priority: bundle.priority,

                mentionUserIds: [...bundle.mentionUserIds]

            },

            { actorMemberUid, skipNotification: true }

        );

        this.setParentMemberOrder(taskId, bundle.selectionOrder);

        const parent = this.parentTasks.find((p) => p.id === taskId);

        if (parent) {

            this.notifyParentListDeltas(

                parentBefore,

                assigneesBefore,

                parent,

                this.getChildAssigneeIdsForParent(taskId),

                actorMemberUid ?? null

            );

        }

    }



    createProject(projectName: string, adminId: string, selectedMemberIds: string[]): void {

        if (!projectName?.trim()) {

            alert('プロジェクト名を入力してください');

            return;

        }

        if (!selectedMemberIds?.length) {

            alert('メンバーを1人以上選択してください');

            return;

        }

        const newProjectId = crypto.randomUUID();

        this.projects.push({

            id: newProjectId,

            name: projectName.trim(),

            adminId: adminId || selectedMemberIds[0],

            memberIds: [...selectedMemberIds]

        });

        this.projectId = newProjectId;

        this.router.navigate(['/admin/manage-tasks', newProjectId]);
        void this.persistIfNeeded();

    }

    updateProject(projectId: string, projectName: string, adminId: string, selectedMemberIds: string[]): void {
        const p = this.projects.find((x) => x.id === projectId);
        if (!p) return;
        p.name = projectName.trim() || p.name;
        p.adminId = adminId;
        p.memberIds = [...selectedMemberIds];
        this.parentTasks = this.parentTasks.map((t) => {
            if (t.projectId !== projectId) return t;
            const lead = t.leadAssigneeId && selectedMemberIds.includes(t.leadAssigneeId) ? t.leadAssigneeId : null;
            const mids = t.memberIds.filter((id) => selectedMemberIds.includes(id) && id !== lead);
            return { ...t, leadAssigneeId: lead, memberIds: mids };
        });
        void this.persistIfNeeded();
    }

    deleteProject(projectId: string): void {
        if (!this.projects.some((p) => p.id === projectId)) return;
        this.projects = this.projects.filter((p) => p.id !== projectId);
        this.parentTasks = this.parentTasks.filter((t) => t.projectId !== projectId);
        this.childTasks = this.childTasks.filter((c) => c.projectId !== projectId);
        const pref = `${projectId}::`;
        for (const key of Object.keys(this.memberNotificationCounts)) {
            if (key.startsWith(pref)) {
                delete this.memberNotificationCounts[key];
            }
        }
        delete this.adminNotificationCounts[projectId];
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter((e) => e.projectId !== projectId);
        if (this.projectId === projectId) {
            this.projectId = this.projects[0]?.id ?? crypto.randomUUID();
        }
        this.touchNotifications();
        void this.persistIfNeeded();
    }



    /** 緊急 ON → 優先度「高」 */

    CreateParentTask(

        projectId: string,

        title: string,

        deadline: Date | string | null,

        isUrgent: boolean,

        leadAssigneeId: string | null,

        memberIds: string[],

        description: string,

        isTodayTask: boolean = false,

        createdById: string | null = null,

        mentionUserIds: string[] = []

    ): void {

        if (!title?.trim()) {

            alert('タイトルを入力してください');

            return;

        }



        const hasLead = !!leadAssigneeId;

        const isDraft = !deadline || !hasLead;

        const mids = [...mentionUserIds];

        const priority: Priority = isUrgent ? '高' : '通常';



        const orderBase = this.parentTasks.filter((t) => t.projectId === projectId && !t.isDraft);

        const nextOrder = orderBase.length === 0 ? 0 : Math.max(...orderBase.map((t) => t.displayOrder ?? 0)) + 1;



        const dueToday =

            !isDraft &&

            !!deadline &&

            !AppService.deadlineUnset(deadline) &&

            this.isParentDueToday(deadline);

        const effectiveTodayTask = isTodayTask || dueToday;



        const newParent: ParentTask = {

            id: crypto.randomUUID(),

            projectId,

            title: title.trim(),

            deadline: deadline || null,

            priority,

            leadAssigneeId: hasLead ? leadAssigneeId : null,

            memberIds: hasLead ? memberIds.filter((id) => id !== leadAssigneeId) : [],

            status: '未着手',

            description: description ?? '',

            isShared: mids.length > 0,

            isDraft,

            isTodayTask: effectiveTodayTask,

            createdById: createdById ?? null,

            mentionUserIds: mids,

            displayOrder: !isDraft ? nextOrder : undefined

        };

        this.parentTasks.push(newParent);



        this.notifyParentListDeltas(

            null,

            [],

            newParent,

            this.getChildAssigneeIdsForParent(newParent.id),

            createdById ?? null

        );

        if (isDraft) {

            alert('未設定タスクを登録しました');

        }
        void this.persistIfNeeded();

    }



    CreateChildTask(

        projectId: string,

        parentTaskId: string,

        title: string,

        assigneeId: string,

        isTodayTask: boolean = false,

        scheduledDate: Date | string | null = null,

        actorMemberUid?: string

    ): void {

        if (!title?.trim()) {

            alert('子タスクのタイトルを入力してください');

            return;

        }

        if (!assigneeId) {

            alert('担当メンバーを選択してください');

            return;

        }

        const allowedAssigneeIds = this.getAllowedChildAssigneeIds(parentTaskId);

        if (!allowedAssigneeIds.includes(assigneeId)) {

            alert('親タスクの担当・メンバーから担当者を選択してください');

            return;

        }



        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return;

        const parentBefore = this.cloneParentNotifyShallow(parent);

        const assigneesBefore = this.getChildAssigneeIdsForParent(parentTaskId);

        let sched: Date | string | null | undefined = null;

        if (scheduledDate !== null && scheduledDate !== undefined) {

            sched = this.normalizeChildScheduledDate(scheduledDate, parent);

            if (sched === undefined) return;

        }



        const row: ChildTask = {

            id: crypto.randomUUID(),

            parentTaskId,

            projectId,

            title: title.trim(),

            assigneeId,

            status: '未着手',

            isUrgent: false,

            isTodayTask: false,

            scheduledDate: sched ?? undefined

        };

        row.isTodayTask = isTodayTask || this.childTodayAutoOn(parent, row);

        this.childTasks.push(row);

        this.syncParentStatusWithChildren(parentTaskId);

        this.notifyParentListDeltas(

            parentBefore,

            assigneesBefore,

            parent,

            this.getChildAssigneeIdsForParent(parentTaskId),

            actorMemberUid ?? null

        );

        void this.persistIfNeeded();

    }



    setChildTaskStatus(childTaskId: string, status: TaskStatus, actorMemberUid?: string): void {

        const child = this.childTasks.find((c) => c.id === childTaskId);

        if (!child) return;

        const parent = this.parentTasks.find((p) => p.id === child.parentTaskId);

        const parentBefore = parent ? this.cloneParentNotifyShallow(parent) : null;

        const assigneesBefore = parent ? this.getChildAssigneeIdsForParent(child.parentTaskId) : [];

        const prevStatus = child.status;

        child.status = status;

        if (status === '完了') {

            child.completedAt = new Date().toISOString();

        } else {

            child.completedAt = undefined;

        }

        if (prevStatus !== status) {
            this.recordChildStatusChange(child, prevStatus, status, actorMemberUid ?? null);
        }

        if (parent) {

            this.syncParentStatusWithChildren(child.parentTaskId);

            this.notifyParentListDeltas(

                parentBefore,

                assigneesBefore,

                parent,

                this.getChildAssigneeIdsForParent(child.parentTaskId),

                actorMemberUid ?? null

            );

        }

        void this.persistIfNeeded();

    }



    setParentTaskStatus(parentTaskId: string, status: TaskStatus, completedByUid?: string | null): void {

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return;

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        if (status === '完了' && children.length > 0 && !children.every((c) => c.status === '完了')) {

            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');

            return;

        }

        const parentBefore = this.cloneParentNotifyShallow(parent);
        const assigneesBefore = this.getChildAssigneeIdsForParent(parentTaskId);

        const prevStatus = parent.status;

        parent.status = status;

        if (status === '完了') {

            parent.completedAt = new Date().toISOString();

            if (completedByUid) {

                parent.completedBy = completedByUid;

            }

        } else {

            parent.completedAt = undefined;

            parent.completedBy = undefined;

        }

        if (prevStatus !== status) {
            this.recordParentStatusChange(parent, prevStatus, status, completedByUid ?? null);
        }

        this.notifyParentListDeltas(
            parentBefore,
            assigneesBefore,
            parent,
            this.getChildAssigneeIdsForParent(parentTaskId),
            completedByUid ?? null
        );

        void this.persistIfNeeded();

    }



    /**

     * 子タスクの状況に応じて親を同期。

     * - 子が全て完了 → 親も完了

     * - いずれかが進行中 → 親は進行中

     * - 全て未着手 → 親は未着手

     * - 上記以外の混在 → 親は進行中

     */

    private syncParentStatusWithChildren(parentTaskId: string): void {

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent || children.length === 0) return;



        const allDone = children.every((c) => c.status === '完了');

        const anyProgress = children.some((c) => c.status === '進行中');

        const allTodo = children.every((c) => c.status === '未着手');



        if (allDone) {

            parent.status = '完了';

            if (!parent.completedAt) {

                parent.completedAt = new Date().toISOString();

            }

        } else if (anyProgress) {

            parent.status = '進行中';

            parent.completedAt = undefined;

            parent.completedBy = undefined;

        } else if (allTodo) {

            parent.status = '未着手';

            parent.completedAt = undefined;

            parent.completedBy = undefined;

        } else {

            parent.status = '進行中';

            parent.completedAt = undefined;

            parent.completedBy = undefined;

        }
        this.markStateChanged();

    }



    /** 巨大ボタン用：親タスクのステータスを 未着手→進行中→完了→… と進める */

    /**cycleParentTaskStatus(parentTaskId: string): void {

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return;

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        const order: TaskStatus[] = ['未着手', '進行中', '完了'];

        const idx = order.indexOf(parent.status);

        const next = order[(idx + 1) % order.length];

        if (next === '完了' && children.length > 0 && !children.every((c) => c.status === '完了')) {

            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');

            return;

        }

        parent.status = next;

    }



     巨大ボタン用：子タスクのステータスを循環 

    cycleChildTaskStatus(childTaskId: string): void {

        const child = this.childTasks.find((c) => c.id === childTaskId);

        if (!child) return;

        const order: TaskStatus[] = ['未着手', '進行中', '完了'];

        const idx = order.indexOf(child.status);

        child.status = order[(idx + 1) % order.length];

        this.syncParentStatusWithChildren(child.parentTaskId);

    } */

    /** 巨大ボタン用：親タスクのステータスを進める */
cycleParentTaskStatus(parentTaskId: string, actorUid?: string | null): void {
    const parent = this.parentTasks.find((p) => p.id === parentTaskId);
    if (!parent) return;

    // すでに「完了」なら、このボタンでは何もしない（ループさせない）
    if (parent.status === '完了') return;

    const parentBefore = this.cloneParentNotifyShallow(parent);
    const assigneesBefore = this.getChildAssigneeIdsForParent(parentTaskId);

    const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);
    const order: TaskStatus[] = ['未着手', '進行中', '完了'];
    const idx = order.indexOf(parent.status);
    const next = order[idx + 1]; // モジュロ演算 (%) を外して、完了で止まるように変更
    const prevStatus = parent.status;

    if (next === '完了') {
        if (children.length > 0 && !children.every((c) => c.status === '完了')) {
            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');
            return;
        }
        // 完了した瞬間を記録
        parent.completedAt = new Date().toISOString();
        if (actorUid) {
            parent.completedBy = actorUid;
        }
    }

    parent.status = next;
    if (prevStatus !== next) {
        this.recordParentStatusChange(parent, prevStatus, next, actorUid ?? null);
    }
    this.notifyParentListDeltas(
        parentBefore,
        assigneesBefore,
        parent,
        this.getChildAssigneeIdsForParent(parentTaskId),
        actorUid ?? null
    );
    void this.persistIfNeeded();
}

/** 巨大ボタン用：子タスクのステータスを循環 */
cycleChildTaskStatus(childTaskId: string, actorUid?: string | null): void {
    const child = this.childTasks.find((c) => c.id === childTaskId);
    if (!child) return;

    // すでに「完了」なら、このボタンでは何もしない
    if (child.status === '完了') return;

    const parent = this.parentTasks.find((p) => p.id === child.parentTaskId);
    if (!parent) return;

    const parentBefore = this.cloneParentNotifyShallow(parent);
    const assigneesBefore = this.getChildAssigneeIdsForParent(child.parentTaskId);

    const order: TaskStatus[] = ['未着手', '進行中', '完了'];
    const idx = order.indexOf(child.status);
    const next = order[idx + 1];
    const prevStatus = child.status;

    if (next === '完了') {
        child.completedAt = new Date().toISOString();
    }

    child.status = next;
    if (prevStatus !== next) {
        this.recordChildStatusChange(child, prevStatus, next, actorUid ?? null);
    }
    this.syncParentStatusWithChildren(child.parentTaskId);
    this.notifyParentListDeltas(
        parentBefore,
        assigneesBefore,
        parent,
        this.getChildAssigneeIdsForParent(child.parentTaskId),
        actorUid ?? null
    );
    void this.persistIfNeeded();
}



    private appendTaskStatusChange(entry: {
        projectId: string;
        kind: 'parent' | 'child';
        taskId: string;
        parentTaskId: string;
        title: string;
        fromStatus: TaskStatus;
        toStatus: TaskStatus;
        actorMemberUid?: string | null;
        at?: number;
    }): void {
        const row: TaskStatusChangeLogEntry = {
            id: crypto.randomUUID(),
            at: entry.at ?? Date.now(),
            projectId: entry.projectId,
            kind: entry.kind,
            taskId: entry.taskId,
            parentTaskId: entry.parentTaskId,
            title: entry.title,
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            actorMemberUid: entry.actorMemberUid ?? null
        };
        const maxKeep = 320;
        this.taskStatusChangeLog = [...this.taskStatusChangeLog, row].slice(-maxKeep);
    }

    private recordParentStatusChange(parent: ParentTask, from: TaskStatus, to: TaskStatus, actorMemberUid?: string | null): void {
        if (from === to) return;
        this.appendTaskStatusChange({
            projectId: parent.projectId,
            kind: 'parent',
            taskId: parent.id,
            parentTaskId: parent.id,
            title: parent.title?.trim() || '（無題）',
            fromStatus: from,
            toStatus: to,
            actorMemberUid: actorMemberUid ?? null
        });
    }

    private recordChildStatusChange(child: ChildTask, from: TaskStatus, to: TaskStatus, actorMemberUid?: string | null): void {
        if (from === to) return;
        this.appendTaskStatusChange({
            projectId: child.projectId,
            kind: 'child',
            taskId: child.id,
            parentTaskId: child.parentTaskId,
            title: child.title?.trim() || '（無題）',
            fromStatus: from,
            toStatus: to,
            actorMemberUid: actorMemberUid ?? null
        });
    }

    private taskStatusLogVisibleToMember(e: TaskStatusChangeLogEntry, memberId: string): boolean {
        if (e.kind === 'child') {
            const parent = this.parentTasks.find((p) => p.id === e.parentTaskId);
            if (!parent) return false;
            const child = this.childTasks.find((c) => c.id === e.taskId);
            if (child && child.assigneeId === memberId) return true;
            return parent.leadAssigneeId === memberId || parent.memberIds.includes(memberId);
        }
        const parent = this.parentTasks.find((p) => p.id === e.taskId);
        if (!parent) return false;
        return parent.leadAssigneeId === memberId || parent.memberIds.includes(memberId);
    }

    private formatTaskStatusLogLine(e: TaskStatusChangeLogEntry): string {
        const d = new Date(e.at);
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const label = e.kind === 'parent' ? '親' : '子';
        return `${stamp} ${label}「${e.title}」 ${e.fromStatus}→${e.toStatus}`;
    }

    /** AI 用: メンバーに関連する直近のステータス変更を時系列で最大 maxLines 行 */
    getRecentTaskStatusChangeLines(projectId: string, memberId: string, maxLines = 8): string {
        const lines = this.taskStatusChangeLog
            .filter((x) => x.projectId === projectId)
            .filter((x) => this.taskStatusLogVisibleToMember(x, memberId))
            .sort((a, b) => b.at - a.at)
            .slice(0, maxLines)
            .reverse()
            .map((x) => this.formatTaskStatusLogLine(x));
        return lines.join('\n');
    }

    /** AI 用: 同一プロジェクト内の他メンバーによる直近の動き */
    getRecentPeerTaskStatusChangeLines(projectId: string, memberId: string, maxLines = 8): string {
        const lines = this.taskStatusChangeLog
            .filter((x) => x.projectId === projectId)
            .filter((x) => x.actorMemberUid !== memberId)
            .sort((a, b) => b.at - a.at)
            .slice(0, maxLines)
            .reverse()
            .map((x) => {
                const actor = this.getMemberById(x.actorMemberUid)?.name ?? '他メンバー';
                return `${this.formatTaskStatusLogLine(x)}（更新: ${actor}）`;
            });
        return lines.join('\n');
    }



    getMembersByProjectId(projectId: string): Member[] {

        const project = this.projects.find((p) => p.id === projectId);

        if (!project || !project.memberIds) {

            return [];

        }

        return this.members.filter((member) => project.memberIds.includes(member.uid));

    }

    getAdminOwnedProjects(adminUid: string | null | undefined): Project[] {
        if (!adminUid) return [];
        return this.projects.filter((p) => p.adminId === adminUid);
    }

    isAdminProjectOwner(projectId: string, adminUid: string | null | undefined): boolean {
        if (!adminUid) return false;
        return this.projects.some((p) => p.id === projectId && p.adminId === adminUid);
    }



    getMembersByUids(uids: (string | null | undefined)[]): Member[] {

        const set = new Set(uids.filter((u): u is string => !!u));

        return this.members.filter((m) => set.has(m.uid));

    }



    getMemberById(uid: string | null | undefined): Member | undefined {

        if (!uid) return undefined;

        return this.members.find((m) => m.uid === uid);

    }



    filterChildTasksByAssigneeId(assigneeId: string): Member | undefined {

        return this.getMemberById(assigneeId);

    }



    getChildTasksByParentId(parentTaskId: string): ChildTask[] {

        return this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

    }



    /** プロジェクトに属する親タスク（絞り込み用・下書き含む） */

    getAllParentTasksForProject(projectId: string): ParentTask[] {

        return this.parentTasks.filter((t) => t.projectId === projectId);

    }



    patchParentTask(

        taskId: string,

        patch: Partial<

            Pick<

                ParentTask,

                | 'title'
                | 'description'
                | 'deadline'
                | 'leadAssigneeId'
                | 'memberIds'
                | 'priority'
                | 'isTodayTask'
                | 'createdById'
                | 'mentionUserIds'

            >

        >,

        options?: { actorMemberUid?: string; skipNotification?: boolean }

    ): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        const parentBefore = this.cloneParentNotifyShallow(t);

        const assigneesBefore = this.getChildAssigneeIdsForParent(taskId);

        const wasDraft = t.isDraft;

        if (patch.title !== undefined) t.title = patch.title.trim();

        if (patch.description !== undefined) t.description = patch.description;

        if (patch.deadline !== undefined) t.deadline = patch.deadline;

        if (patch.leadAssigneeId !== undefined) t.leadAssigneeId = patch.leadAssigneeId;

        if (patch.memberIds !== undefined) t.memberIds = [...patch.memberIds];

        if (patch.priority !== undefined) t.priority = patch.priority;

        if (patch.isTodayTask !== undefined) t.isTodayTask = patch.isTodayTask;

        if (patch.createdById !== undefined) t.createdById = patch.createdById;

        if (patch.mentionUserIds !== undefined) {

            t.mentionUserIds = [...patch.mentionUserIds];

            t.isShared = t.mentionUserIds.length > 0;

        }

        this.recalcParentDraft(t);

        if (!t.isDraft && wasDraft && t.displayOrder === undefined) {

            const maxOther = Math.max(

                0,

                ...this.parentTasks

                    .filter((x) => x.projectId === t.projectId && !x.isDraft && x.id !== t.id)

                    .map((x) => x.displayOrder ?? 0)

            );

            t.displayOrder = maxOther + 1;

        }



        if (patch.deadline !== undefined) {

            this.syncTodayFlagsForParentDueToday(t);

        }



        if (!options?.skipNotification) {

            const assigneesAfter = this.getChildAssigneeIdsForParent(taskId);

            this.notifyParentListDeltas(parentBefore, assigneesBefore, t, assigneesAfter, options?.actorMemberUid ?? null);

        }
        void this.persistIfNeeded();

    }



    /** チェック順で担当・メンバーを更新 */

    setParentMemberOrder(taskId: string, orderedMemberUids: string[]): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        const lead = orderedMemberUids[0] ?? null;

        t.leadAssigneeId = lead;

        t.memberIds = lead ? orderedMemberUids.slice(1).filter((id) => id !== lead) : [];

        this.recalcParentDraft(t);
        this.markStateChanged();

    }



    private recalcParentDraft(t: ParentTask): void {

        t.isDraft = !(t.deadline && t.leadAssigneeId);

    }



    deleteParentTask(taskId: string): void {

        this.parentTasks = this.parentTasks.filter((p) => p.id !== taskId);

        this.childTasks = this.childTasks.filter((c) => c.parentTaskId !== taskId);
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter(
            (e) => e.parentTaskId !== taskId && e.taskId !== taskId
        );
        void this.persistIfNeeded();

    }



    patchChildTask(

        childId: string,

        patch: Partial<Pick<ChildTask, 'title' | 'assigneeId' | 'isTodayTask' | 'scheduledDate'>>,

        options?: { actorMemberUid?: string; skipNotification?: boolean }

    ): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        const parent = this.parentTasks.find((p) => p.id === c.parentTaskId);

        if (patch.assigneeId !== undefined) {

            const allowedAssigneeIds = this.getAllowedChildAssigneeIds(c.parentTaskId);

            if (!allowedAssigneeIds.includes(patch.assigneeId)) {

                alert('親タスクの担当・メンバーから担当者を選択してください');

                return;

            }

        }

        const parentBefore = parent ? this.cloneParentNotifyShallow(parent) : null;

        const assigneesBefore = parent ? this.getChildAssigneeIdsForParent(c.parentTaskId) : [];

        if (patch.title !== undefined) c.title = patch.title.trim();

        if (patch.assigneeId !== undefined) {

            c.assigneeId = patch.assigneeId;

        }

        if (patch.isTodayTask !== undefined) c.isTodayTask = patch.isTodayTask;

        if (patch.scheduledDate !== undefined && parent) {

            if (patch.scheduledDate === null || (typeof patch.scheduledDate === 'string' && !patch.scheduledDate.trim())) {

                c.scheduledDate = undefined;

            } else {

                const n = this.normalizeChildScheduledDate(patch.scheduledDate, parent);

                if (n === undefined) return;

                c.scheduledDate = n ?? undefined;

            }

        }

        if (parent && this.childTodayAutoOn(parent, c)) {
            c.isTodayTask = true;
        }

        if (parent) {

            this.syncParentStatusWithChildren(c.parentTaskId);

            if (!options?.skipNotification) {

                this.notifyParentListDeltas(

                    parentBefore,

                    assigneesBefore,

                    parent,

                    this.getChildAssigneeIdsForParent(c.parentTaskId),

                    options?.actorMemberUid ?? null

                );

            }

        }

        void this.persistIfNeeded();

    }



    deleteChildTask(childId: string): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        const parentId = c.parentTaskId;

        const parent = this.parentTasks.find((p) => p.id === parentId);

        const parentBefore = parent ? this.cloneParentNotifyShallow(parent) : null;

        const assigneesBefore = parent ? this.getChildAssigneeIdsForParent(parentId) : [];

        this.childTasks = this.childTasks.filter((x) => x.id !== childId);
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter((e) => e.taskId !== childId);

        if (parent) {

            this.syncParentStatusWithChildren(parentId);

            this.notifyParentListDeltas(

                parentBefore,

                assigneesBefore,

                parent,

                this.getChildAssigneeIdsForParent(parentId),

                null

            );

        }

        void this.persistIfNeeded();

    }



    toggleParentTodayTask(taskId: string, actorMemberUid?: string): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        if (t.isTodayTask && this.isParentDueToday(t.deadline)) {
            return;
        }

        const parentBefore = this.cloneParentNotifyShallow(t);

        const assigneesBefore = this.getChildAssigneeIdsForParent(taskId);

        const turningOff = t.isTodayTask === true;

        t.isTodayTask = !t.isTodayTask;

        const nextToday = t.isTodayTask;

        for (const child of this.childTasks) {

            if (child.parentTaskId === taskId) {

                child.isTodayTask = nextToday;

            }

        }

        if (!nextToday && turningOff) {
            const children = this.childTasks.filter((c) => c.parentTaskId === taskId);
            for (const child of children) {
                if (child.status === '進行中') {
                    const prevStatus = child.status;
                    child.status = '未着手';
                    this.recordChildStatusChange(child, prevStatus, '未着手', actorMemberUid ?? null);
                }
            }
            if (children.length > 0) {
                this.syncParentStatusWithChildren(taskId);
            } else if (t.status === '進行中') {
                const prevStatus = t.status;
                t.status = '未着手';
                t.completedAt = undefined;
                t.completedBy = undefined;
                this.recordParentStatusChange(t, prevStatus, '未着手', actorMemberUid ?? null);
            }
        }

        this.notifyParentListDeltas(

            parentBefore,

            assigneesBefore,

            t,

            this.getChildAssigneeIdsForParent(taskId),

            actorMemberUid ?? null

        );

        void this.persistIfNeeded();

    }



    toggleChildTodayTask(childId: string, actorMemberUid?: string): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        const parent = this.parentTasks.find((p) => p.id === c.parentTaskId);

        if (parent && this.childTodayAutoOn(parent, c)) return;

        const parentBefore = parent ? this.cloneParentNotifyShallow(parent) : null;

        const assigneesBefore = parent ? this.getChildAssigneeIdsForParent(c.parentTaskId) : [];

        const turningOff = c.isTodayTask === true;

        c.isTodayTask = !c.isTodayTask;

        if (!c.isTodayTask && turningOff) {
            if (c.status === '進行中') {
                const prevStatus = c.status;
                c.status = '未着手';
                this.recordChildStatusChange(c, prevStatus, '未着手', actorMemberUid ?? null);
            }
            this.syncParentStatusWithChildren(c.parentTaskId);
        }

        if (parent) {

            this.notifyParentListDeltas(

                parentBefore,

                assigneesBefore,

                parent,

                this.getChildAssigneeIdsForParent(c.parentTaskId),

                actorMemberUid ?? null

            );

        }

        void this.persistIfNeeded();

    }

    private getAllowedChildAssigneeIds(parentTaskId: string): string[] {

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return [];

        const ids = parent.leadAssigneeId ? [parent.leadAssigneeId, ...parent.memberIds] : [...parent.memberIds];

        return [...new Set(ids)];

    }



    /** 同一プロジェクト内の親タスクを表示用にソート（期限昇順 → 高優先度 → displayOrder） */

    getSortedParentTasksForProject(projectId: string, includeDraft: boolean): ParentTask[] {

        const list = this.parentTasks.filter((t) => t.projectId === projectId && (includeDraft || !t.isDraft));

        return list.sort((a, b) => {

            const ad = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;

            const bd = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;

            if (ad !== bd) return ad - bd;

            const pr = a.priority === '高' ? 0 : 1;

            const qr = b.priority === '高' ? 0 : 1;

            if (pr !== qr) return pr - qr;

            const ao = a.displayOrder ?? 0;

            const bo = b.displayOrder ?? 0;

            if (ao !== bo) return ao - bo;

            return (a.title || '').localeCompare(b.title || '', 'ja');

        });

    }



    createMember(name: string, email: string, photoURL: string, role: '' | '管理者' | 'メンバー' | 'ゲスト'): void {

        if (!name?.trim() || !email?.trim()) {

            alert('名前とメールアドレスを入力してください');

            return;

        }

        this.members.push({

            uid: crypto.randomUUID(),

            name: name.trim(),

            email: email.trim(),

            photoURL: photoURL || '',

            role: role

        });
        void this.persistIfNeeded();

    }

    upsertPendingLoginMember(input: { uid?: string; name: string; email: string; photoURL?: string }): void {
        const email = input.email.trim().toLowerCase();
        if (!email) return;
        if (this.members.some((m) => m.email.trim().toLowerCase() === email)) return;
        const found = this.pendingLoginMembers.find((x) => x.email.trim().toLowerCase() === email);
        if (found) {
            found.name = input.name.trim() || found.name;
            found.photoURL = input.photoURL || found.photoURL || '';
            this.ensureBootstrapAdminFromPending();
            return;
        }
        this.pendingLoginMembers.push({
            uid: input.uid?.trim() || crypto.randomUUID(),
            name: input.name.trim() || email,
            email,
            photoURL: input.photoURL || '',
            requestedAt: Date.now()
        });
        this.ensureBootstrapAdminFromPending();
        void this.persistIfNeeded();
    }

    approvePendingMembers(emails: string[], role: '' | '管理者' | 'メンバー' | 'ゲスト'): void {
        const targets = new Set(emails.map((x) => x.trim().toLowerCase()).filter(Boolean));
        if (targets.size === 0) return;
        for (const p of [...this.pendingLoginMembers]) {
            const em = p.email.trim().toLowerCase();
            if (!targets.has(em)) continue;
            const exists = this.members.find((m) => m.email.trim().toLowerCase() === em);
            if (exists) {
                exists.name = p.name || exists.name;
                exists.photoURL = p.photoURL || exists.photoURL;
                exists.role = role || exists.role;
            } else {
                this.members.push({
                    uid: p.uid || crypto.randomUUID(),
                    name: p.name,
                    email: p.email,
                    photoURL: p.photoURL || '',
                    role
                });
            }
        }
        this.pendingLoginMembers = this.pendingLoginMembers.filter((x) => !targets.has(x.email.trim().toLowerCase()));
        void this.persistIfNeeded();
    }

    removeMemberByUid(uid: string): void {
        this.members = this.members.filter((m) => m.uid !== uid);
        this.projects = this.projects.map((p) => ({
            ...p,
            adminId: p.adminId === uid ? (p.memberIds.find((x) => x !== uid) ?? '') : p.adminId,
            memberIds: p.memberIds.filter((x) => x !== uid)
        }));
        this.parentTasks = this.parentTasks.map((t) => ({
            ...t,
            leadAssigneeId: t.leadAssigneeId === uid ? null : t.leadAssigneeId,
            memberIds: t.memberIds.filter((x) => x !== uid),
            mentionUserIds: (t.mentionUserIds ?? []).filter((x) => x !== uid)
        }));
        this.childTasks = this.childTasks.map((c) => ({
            ...c,
            assigneeId: c.assigneeId === uid ? '' : c.assigneeId
        }));
        void this.persistIfNeeded();
    }

    getMemberByEmail(email: string | null | undefined): Member | undefined {
        const em = email?.trim().toLowerCase();
        if (!em) return undefined;
        return this.members.find((m) => m.email.trim().toLowerCase() === em);
    }



    /** ローカル日の 0:00（期限は日付のみで比較） */
    private static startOfLocalDay(d: Date): Date {

        const x = new Date(d.getTime());

        x.setHours(0, 0, 0, 0);

        return x;

    }



    private static todayLocalStart(): Date {

        return AppService.startOfLocalDay(new Date());

    }



    /** 未完了タスク1件分の期限区分（時刻は無視し日付のみ） */
    private classifyDeadlineForBurden(deadline: Date | string | null | undefined): 'overdue' | 'today' | 'other' {

        const today = AppService.todayLocalStart();

        if (deadline === null || deadline === undefined) {

            return 'other';

        }

        if (typeof deadline === 'string' && !deadline.trim()) {

            return 'other';

        }

        const raw = new Date(deadline as Date | string);

        if (Number.isNaN(raw.getTime())) {

            return 'other';

        }

        const day = AppService.startOfLocalDay(raw);

        const tt = today.getTime();

        const td = day.getTime();

        if (td < tt) {

            return 'overdue';

        }

        if (td === tt) {

            return 'today';

        }

        return 'other';

    }



    /** メンバーが親タスクの担当に含まれるか（リードまたはメンバー一覧） */
    memberAssignedToParent(task: ParentTask, memberId: string): boolean {

        return task.leadAssigneeId === memberId || task.memberIds.includes(memberId);

    }



    /**

     * プロジェクト内メンバーの負担度集計。

     * スコア = 期限切れ×5 + 本日期限×3 + その他未完了×1

     * 親は下書き以外・未完了のみ。子は担当の未完了のみ。

     */
    getMemberBurdenSummaries(projectId: string): MemberBurdenSummary[] {

        const members = this.getMembersByProjectId(projectId);

        const parents = this.parentTasks.filter((t) => t.projectId === projectId && !t.isDraft);

        //const children = this.childTasks.filter((c) => c.projectId === projectId);

        const result: MemberBurdenSummary[] = [];

        for (const m of members) {

            let overdueCount = 0;

            let dueTodayCount = 0;

            let otherIncompleteCount = 0;

            const incompleteTaskTitles: string[] = [];

            for (const p of parents) {

                if (!this.memberAssignedToParent(p, m.uid)) {

                    continue;

                }

                if (p.status === '完了') {

                    continue;

                }

                const bucket = this.classifyDeadlineForBurden(p.deadline);

                if (bucket === 'overdue') {

                    overdueCount++;

                } else if (bucket === 'today') {

                    dueTodayCount++;

                } else {

                    otherIncompleteCount++;

                }

                incompleteTaskTitles.push(p.title?.trim() || '（無題）');

            }
           /** 
            for (const c of children) {

                if (c.assigneeId !== m.uid) {

                    continue;

                }

                if (c.status === '完了') {

                    continue;

                }

                const bucket = this.classifyDeadlineForBurden(c.deadline);

                if (bucket === 'overdue') {

                    overdueCount++;

                } else if (bucket === 'today') {

                    dueTodayCount++;

                } else {

                    otherIncompleteCount++;

                }

                incompleteTaskTitles.push(c.title?.trim() || '（無題）');

            }*/

            const score = overdueCount * 5 + dueTodayCount * 3 + otherIncompleteCount * 1;

            result.push({

                memberId: m.uid,

                score,

                overdueCount,

                dueTodayCount,

                otherIncompleteCount,

                incompleteTaskTitles

            });

        }

        result.sort((a, b) => {

            if (b.score !== a.score) {

                return b.score - a.score;

            }

            return a.memberId.localeCompare(b.memberId);

        });

        return result;

    }



    /** MYタスク（メンバー作成）はメンション有無に関わらず管理の親一覧から除外 */

    shouldExcludePrivateMyFromAdmin(task: ParentTask): boolean {
        if (!task.createdById) return false;
        const creator = this.getMemberById(task.createdById);
        if (!creator) return false;
        return creator.role !== '管理者';

    }



    /** MYは作成者本人のみ通常ページに表示（他メンバーは shared ページのみ） */

    isPrivateMyHiddenFromOtherMember(task: ParentTask, viewerMemberId: string): boolean {

        if (!task.createdById) return false;

        return task.createdById !== viewerMemberId;

    }



    /** 共有ページ（メンバー）: 自分のUID / @all / 自分が共有したタスク */

    isSharedTaskVisibleToMember(task: ParentTask, viewerMemberId: string): boolean {

        if (task.isDraft) return false;

        const m = task.mentionUserIds ?? [];

        if (m.length === 0) return false;

        if (task.createdById === viewerMemberId) return true;

        return m.includes(MENTION_ALL) || m.includes(viewerMemberId);

    }



    /** 共有ページ（管理者）: @admin または @all のときのみ */

    isSharedTaskVisibleToAdmin(task: ParentTask): boolean {

        if (task.isDraft) return false;

        const m = task.mentionUserIds ?? [];

        return m.includes(MENTION_ADMIN) || m.includes(MENTION_ALL);

    }



    /** 自分が作成した共有のみ解除（ゴミ箱） */

    clearParentMentionsIfAuthor(taskId: string, requesterMemberId: string): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t || t.createdById !== requesterMemberId) return;

        const parentBefore = this.cloneParentNotifyShallow(t);

        const assigneesBefore = this.getChildAssigneeIdsForParent(taskId);

        t.mentionUserIds = [];

        t.isShared = false;

        this.notifyParentListDeltas(

            parentBefore,

            assigneesBefore,

            t,

            this.getChildAssigneeIdsForParent(taskId),

            requesterMemberId

        );
        void this.persistIfNeeded();

    }



    /** 完了タスクを未着手へ一括復旧（親＋子の完了情報クリア） */

    revertCompletedParentsToTodo(projectId: string, parentTaskIds: string[], actorMemberUid?: string): void {

        for (const id of parentTaskIds) {

            const p = this.parentTasks.find((x) => x.id === id);

            if (!p || p.projectId !== projectId || p.status !== '完了') continue;

            const parentBefore = this.cloneParentNotifyShallow(p);

            const assigneesBefore = this.getChildAssigneeIdsForParent(id);

            p.status = '未着手';

            p.completedAt = undefined;

            p.completedBy = undefined;

            for (const c of this.childTasks.filter((c) => c.parentTaskId === id)) {

                c.status = '未着手';

                c.completedAt = undefined;

            }

            this.syncParentStatusWithChildren(id);

            this.notifyParentListDeltas(

                parentBefore,

                assigneesBefore,

                p,

                this.getChildAssigneeIdsForParent(id),

                actorMemberUid ?? null

            );

        }
        void this.persistIfNeeded();

    }



    /** プロジェクト内の完了済み親タスクをすべて削除（管理・ログ削除） */

    deleteAllCompletedParentTasksInProject(projectId: string): void {

        const ids = this.parentTasks.filter((t) => t.projectId === projectId && t.status === '完了').map((t) => t.id);

        for (const id of ids) {

            this.deleteParentTask(id);

        }
        void this.persistIfNeeded();

    }



    getProjectAdminId(projectId: string): string | undefined {

        return this.projects.find((p) => p.id === projectId)?.adminId;

    }

}

