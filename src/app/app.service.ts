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

    PendingProjectJoin,

    TaskStatusChangeLogEntry,

    AuditLogEntry

} from './core/interface';
import { auditSummaryStatusChange, pruneAuditLogEntries } from './core/audit-log.util';

import { Router } from '@angular/router';
import {
    StorageService,
    storageKeyLastOpenedProjectByMember,
    storageKeyUnseenApprovedTeamByMember
} from './services/storage.service';
import { AdminToastService } from './services/admin-toast.service';
import { recordMemberTaskChangeNotifications } from './core/member-task-change-notify.util';
import { canMutateTasksInProject, isProjectGuestById } from './core/project-permissions.util';
import {
    TRASH_RETENTION_MS,
    canActOnTrashedEntry,
    canDeleteChildTask,
    canDeleteParentTask,
    cloneChildForTrash,
    cloneParentForTrash
} from './core/task-trash.util';
import type { TrashedTaskEntry } from './core/interface';



@Injectable({

    providedIn: 'root'

})

export class AppService {
    private readonly firestore = inject(Firestore);
    private readonly zone = inject(NgZone);
    private readonly storage = inject(StorageService);
    private readonly adminToast = inject(AdminToastService);
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

    /** 個人タスク用の仮想 projectId（Firestore の projects には存在しない） */
    static personalWorkspaceProjectId(uid: string): string {
        return `__personal_${uid}`;
    }

    static isPersonalWorkspaceProjectId(projectId: string | null | undefined): boolean {
        return !!projectId && projectId.startsWith('__personal_');
    }

    /** `/personal/*` 用: `projectId` が本人の実体の個人プロジェクトならその id、否则仮想 `__personal_${uid}` */
    resolvePersonalTaskProjectIdForMember(memberUid: string): string {
        const proj = this.projects.find((x) => x.id === this.projectId);
        if (proj?.isPersonal && proj.adminId === memberUid && proj.memberIds.includes(memberUid)) {
            return this.projectId;
        }
        return AppService.personalWorkspaceProjectId(memberUid);
    }

    projects: Project[] = [];

    parentTasks: ParentTask[] = [];

    childTasks: ChildTask[] = [];

    members: Member[] = [];
    pendingLoginMembers: PendingLoginMember[] = [];
    pendingProjectJoins: PendingProjectJoin[] = [];

    /** アプリ全体のオーナー（最初のログイン者）。承認済み members の uid */
    appOwnerUid: string | null = null;

    /** 明示的なステータス変更のみ（親子自動同期は含めない） */
    taskStatusChangeLog: TaskStatusChangeLogEntry[] = [];

    auditLog: AuditLogEntry[] = [];

    trashedTasks: TrashedTaskEntry[] = [];

    /** テンプレートが通知更新を拾うためのシグナル */

    readonly notificationTick = signal(0);
    readonly trashRev = signal(0);
    /** プロジェクト一覧の変更を UI computed に伝える */
    readonly projectsRev = signal(0);
    readonly ready = signal(false);

    /** Firestore 反映前のローカル作成（リモート上書きで消えないようにする） */
    private pendingLocalProjectIds = new Set<string>();



    /** 「projectId::memberUid」→ ページ種別 → 未確認件数 */

    private memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>> = {};

    /** projectId → 管理画面ドロワー用未確認件数 */

    private adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>> = {};

    /** projectId::memberId → 現在表示中のメンバー画面（通知抑制用） */

    private memberCurrentNavPage: Partial<Record<string, MemberNavPageKey>> = {};

    /** projectId → 現在表示中の管理画面（通知抑制用） */

    private adminCurrentNavPage: Partial<Record<string, AdminNavPageKey>> = {};

    /** projectId → 親タスク一覧のソートモード（期限 / ステータス / 手動混在） */

    private parentListSortMode: Partial<Record<string, 'deadline' | 'status' | 'manual'>> = {};



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
        pendingProjectJoins: PendingProjectJoin[];
        memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
        adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
        taskStatusChangeLog: TaskStatusChangeLogEntry[];
        auditLog: AuditLogEntry[];
        trashedTasks: TrashedTaskEntry[];
        appOwnerUid: string | null;
    } {
        this.pruneAuditLog();
        return {
            projectId: this.projectId,
            projects: this.projects,
            parentTasks: this.parentTasks,
            childTasks: this.childTasks,
            members: this.members,
            pendingLoginMembers: this.pendingLoginMembers,
            pendingProjectJoins: this.pendingProjectJoins,
            memberNotificationCounts: this.memberNotificationCounts,
            adminNotificationCounts: this.adminNotificationCounts,
            taskStatusChangeLog: this.taskStatusChangeLog,
            auditLog: this.auditLog,
            trashedTasks: this.trashedTasks,
            appOwnerUid: this.appOwnerUid
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
        pendingProjectJoins: PendingProjectJoin[];
        memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
        adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
        taskStatusChangeLog: TaskStatusChangeLogEntry[];
        auditLog: AuditLogEntry[];
        trashedTasks: TrashedTaskEntry[];
        appOwnerUid: string | null;
        updatedAt: number;
    }>): void {
        const prevPendingProjectJoins = [...this.pendingProjectJoins];
        this.projectId = data.projectId || this.projectId;
        const remoteProjects = Array.isArray(data.projects)
            ? data.projects.map((raw) => {
                  const p = raw as Project;
                  return { ...p, isPersonal: !!p.isPersonal };
              })
            : [];
        if (remoteProjects.length > 0) {
            const remoteIdSet = new Set(remoteProjects.map((p) => p.id));
            for (const id of [...this.pendingLocalProjectIds]) {
                if (remoteIdSet.has(id)) this.pendingLocalProjectIds.delete(id);
            }
        }
        this.projects = this.mergePendingLocalProjects(remoteProjects);
        this.bumpProjectsRev();
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
        this.pendingProjectJoins = Array.isArray(data.pendingProjectJoins) ? data.pendingProjectJoins : [];
        this.reconcileUnseenApprovedTeamJoins(prevPendingProjectJoins, this.pendingProjectJoins);
        this.appOwnerUid = typeof data.appOwnerUid === 'string' && data.appOwnerUid ? data.appOwnerUid : null;
        this.memberNotificationCounts = data.memberNotificationCounts ?? {};
        this.adminNotificationCounts = data.adminNotificationCounts ?? {};
        this.parentListSortMode = {};
        if (data.taskStatusChangeLog !== undefined && Array.isArray(data.taskStatusChangeLog)) {
            this.taskStatusChangeLog = data.taskStatusChangeLog;
        }
        if (data.auditLog !== undefined && Array.isArray(data.auditLog)) {
            this.auditLog = data.auditLog;
        }
        this.trashedTasks = Array.isArray(data.trashedTasks)
            ? data.trashedTasks.map((e) => ({
                  ...e,
                  parent: {
                      ...e.parent,
                      deadline: this.normalizeDateLike(e.parent.deadline)
                  },
                  children: (e.children ?? []).map((c) => ({
                      ...c,
                      deadline: this.normalizeDateLike(c.deadline),
                      scheduledDate: this.normalizeDateLike(c.scheduledDate)
                  }))
              }))
            : [];
        this.purgeExpiredTrashedTasks();
        const clearedOpenPageCounts = this.zeroNotificationCountsForCurrentlyOpenPages();
        this.touchNotifications();
        if (clearedOpenPageCounts) {
            this.markStateChanged();
        }
        this.ensureAppOwnerUidAfterLoad();
    }

    /** Firestore に appOwnerUid が無い既存データ向け。members と整合させる */
    private ensureAppOwnerUidAfterLoad(): void {
        if (this.members.length === 0) {
            this.appOwnerUid = null;
            return;
        }
        if (this.appOwnerUid && !this.members.some((m) => m.uid === this.appOwnerUid)) {
            this.appOwnerUid = null;
        }
        if (!this.appOwnerUid && this.members.length > 0) {
            const legacy = this.members.find((m) => m.role === '管理者');
            this.appOwnerUid = legacy?.uid ?? this.members[0].uid;
            void this.persistIfNeeded();
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
                    pendingProjectJoins: PendingProjectJoin[];
                    memberNotificationCounts: Record<string, Partial<Record<MemberNavPageKey, number>>>;
                    adminNotificationCounts: Record<string, Partial<Record<AdminNavPageKey, number>>>;
                    taskStatusChangeLog: TaskStatusChangeLogEntry[];
                    auditLog?: AuditLogEntry[];
                    trashedTasks?: TrashedTaskEntry[];
                    appOwnerUid: string | null;
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
                    pendingProjectJoins: Array.isArray(data.pendingProjectJoins) ? data.pendingProjectJoins : [],
                    memberNotificationCounts: data.memberNotificationCounts ?? {},
                    adminNotificationCounts: data.adminNotificationCounts ?? {},
                    taskStatusChangeLog: Array.isArray(data.taskStatusChangeLog) ? data.taskStatusChangeLog : [],
                    auditLog: Array.isArray(data.auditLog) ? data.auditLog : [],
                    trashedTasks: Array.isArray(data.trashedTasks) ? data.trashedTasks : [],
                    appOwnerUid: (data as { appOwnerUid?: string | null }).appOwnerUid ?? null,
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
                    trashedTasks?: TrashedTaskEntry[];
                    appOwnerUid: string | null;
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
                trashedTasks?: TrashedTaskEntry[];
                appOwnerUid: string | null;
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
        const uid = first.uid?.trim() || crypto.randomUUID();
        this.members.push({
            uid,
            name: first.name.trim() || first.email,
            email: first.email.trim().toLowerCase(),
            photoURL: first.photoURL || '',
            role: 'メンバー'
        });
        this.appOwnerUid = uid;
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
            this.clearPersistedPendingProjects(payload.projects.map((p) => p.id));
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

    private bumpProjectsRev(): void {
        this.projectsRev.update((x) => x + 1);
    }

    private noteLocalProjectCreated(projectId: string): void {
        this.pendingLocalProjectIds.add(projectId);
        this.bumpProjectsRev();
    }

    /** リモート適用時、未反映のローカル作成プロジェクトを一覧に残す */
    private mergePendingLocalProjects(remoteProjects: Project[]): Project[] {
        if (this.pendingLocalProjectIds.size === 0) return remoteProjects;
        const remoteIds = new Set(remoteProjects.map((p) => p.id));
        const extras: Project[] = [];
        for (const id of this.pendingLocalProjectIds) {
            if (remoteIds.has(id)) continue;
            const local = this.projects.find((p) => p.id === id);
            if (local) extras.push(local);
        }
        return extras.length === 0 ? remoteProjects : [...remoteProjects, ...extras];
    }

    private clearPersistedPendingProjects(projectIds: string[]): void {
        let changed = false;
        for (const id of projectIds) {
            if (this.pendingLocalProjectIds.delete(id)) changed = true;
        }
        if (changed) this.bumpProjectsRev();
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

        for (const m of this.getAssignableMembersByProjectId(projectId)) {
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
            if (
                stA === '完了' &&
                stB !== '完了' &&
                (!this.shouldExcludePrivateMyFromAdmin(parentAfter) || this.isSharedTaskVisibleToAdmin(parentAfter))
            ) {
                this.bumpAdminPage(projectId, 'completed', actorMemberUid ?? undefined, { silent: true });
            }
        }

        this.markStateChanged();
    }

    private notifyMemberTaskFieldChanges(
        parentBefore: ParentTask,
        assigneesBefore: string[],
        parentAfter: ParentTask,
        assigneesAfter: string[],
        actorMemberUid?: string | null
    ): void {
        recordMemberTaskChangeNotifications(
            this.storage,
            parentAfter.projectId,
            parentBefore,
            assigneesBefore,
            parentAfter,
            assigneesAfter,
            actorMemberUid ?? null,
            (pid) => this.getAssignableMembersByProjectId(pid),
            (uid) => this.getMemberById(uid),
            (pid) => this.getProjectAdminId(pid)
        );
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
        this.parentListSortMode[projectId] = 'manual';
        const visibleIds = visibleParentsInOrder.map((t) => t.id);
        const visibleSet = new Set(visibleIds);
        const others = this.parentTasks
            .filter((t) => t.projectId === projectId && !t.isDraft && !visibleSet.has(t.id))
            .sort((a, b) => this.compareParentsByDeadlinePriorityTitle(a, b));
        const merged = [...visibleIds, ...others.map((t) => t.id)];
        merged.forEach((id, index) => {
            const t = this.parentTasks.find((p) => p.id === id);
            if (t && t.projectId === projectId && !t.isDraft) {
                t.displayOrder = index;
            }
        });
        this.markStateChanged();
        alert('並び順を保存しました');
    }

    /** 全親の displayOrder を消し、期限順表示に戻す */

    resetParentListSortToDeadline(projectId: string): void {
        for (const t of this.parentTasks) {
            if (t.projectId === projectId && !t.isDraft) {
                t.displayOrder = undefined;
            }
        }
        this.parentListSortMode[projectId] = 'deadline';
        this.markStateChanged();
        alert('期限順にリセットしました');
    }

    /** displayOrder を消し、ステータス順（未着手→進行中→完了）で並べる */

    resetParentListSortToStatus(projectId: string): void {
        for (const t of this.parentTasks) {
            if (t.projectId === projectId && !t.isDraft) {
                t.displayOrder = undefined;
            }
        }
        this.parentListSortMode[projectId] = 'status';
        this.markStateChanged();
        alert('ステータス順に並べ替えました');
    }

    private parentListSortResolved(projectId: string): 'deadline' | 'status' | 'manual' {
        const ex = this.parentListSortMode[projectId];
        if (ex) return ex;
        const inProj = this.parentTasks.filter((t) => t.projectId === projectId && !t.isDraft);
        if (inProj.some((t) => t.displayOrder !== undefined && t.displayOrder !== null)) {
            return 'manual';
        }
        return 'deadline';
    }

    private statusRankForSort(s: TaskStatus): number {
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

    private compareParentsByDeadlinePriorityTitle(a: ParentTask, b: ParentTask): number {
        const ad = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
        if (ad !== bd) return ad - bd;
        const pr = a.priority === '高' ? 0 : 1;
        const qr = b.priority === '高' ? 0 : 1;
        if (pr !== qr) return pr - qr;
        return (a.title || '').localeCompare(b.title || '', 'ja');
    }

    private compareParentsByStatusThenDeadline(a: ParentTask, b: ParentTask): number {
        const ra = this.statusRankForSort(a.status);
        const rb = this.statusRankForSort(b.status);
        if (ra !== rb) return ra - rb;
        return this.compareParentsByDeadlinePriorityTitle(a, b);
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

        if (!this.assertCanMutateProjectTasks(parentRow.projectId, actorMemberUid)) return;

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

            this.notifyMemberTaskFieldChanges(
                parentBefore,
                assigneesBefore,
                parent,
                this.getChildAssigneeIdsForParent(taskId),
                actorMemberUid ?? null
            );

            const pt = parent.title?.trim() || '（無題）';
            this.appendAudit({
                projectId: parent.projectId,
                actorUid: actorMemberUid ?? null,
                action: 'parent.update',
                title: pt,
                summary: `親タスクを更新: ${pt}`
            });

        }

    }



    createProject(
        projectName: string,
        adminId: string,
        selectedMemberIds: string[],
        isPersonal = false,
        description?: string,
        options?: { navigate?: boolean }
    ): string | null {

        if (!projectName?.trim()) {

            alert('プロジェクト名を入力してください');

            return null;

        }

        if (!selectedMemberIds?.length) {

            alert('メンバーを1人以上選択してください');

            return null;

        }

        const newProjectId = crypto.randomUUID();

        this.projects.push({

            id: newProjectId,

            name: projectName.trim(),

            adminId: adminId || selectedMemberIds[0],

            memberIds: [...selectedMemberIds],

            isPersonal: !!isPersonal,

            description: description?.trim() || undefined

        });

        this.noteLocalProjectCreated(newProjectId);
        this.projectId = newProjectId;

        const leadUid = adminId || selectedMemberIds[0];
        if (options?.navigate !== false) {
            void this.navigateToProject(newProjectId, leadUid);
        }
        if (leadUid) this.setLastOpenedProject(leadUid, newProjectId);
        this.touchNotifications();
        void this.persistIfNeeded();
        return newProjectId;

    }

    /** 参加コード表示用（projectId の末尾6文字） */
    static projectInviteCode(projectId: string): string {
        return projectId.slice(-6).toUpperCase();
    }

    static guestInviteCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    private static generateGuestInviteCodeValue(): string {
        const chars = AppService.guestInviteCodeChars;
        let out = '';
        for (let i = 0; i < 6; i++) {
            out += chars[Math.floor(Math.random() * chars.length)];
        }
        return out;
    }

    private normalizeInviteCodeInput(code: string): string {
        return code.trim().toLowerCase().replace(/\s/g, '');
    }

    private isInviteCodeInUse(norm: string, exceptProjectId?: string): boolean {
        if (norm.length !== 6) return true;
        for (const p of this.projects) {
            if (p.isPersonal) continue;
            if (exceptProjectId && p.id === exceptProjectId) continue;
            if (p.id.slice(-6).toLowerCase() === norm) return true;
            if (p.guestInviteCode?.toLowerCase() === norm) return true;
        }
        return false;
    }

    findTeamProjectByInviteCode(code: string): Project | undefined {
        const norm = this.normalizeInviteCodeInput(code);
        if (norm.length !== 6) return undefined;
        return this.projects.find((p) => !p.isPersonal && p.id.slice(-6).toLowerCase() === norm);
    }

    findTeamProjectByGuestInviteCode(code: string): Project | undefined {
        const norm = this.normalizeInviteCodeInput(code);
        if (norm.length !== 6) return undefined;
        return this.projects.find((p) => !p.isPersonal && p.guestInviteCode?.toLowerCase() === norm);
    }

    /** ゲスト用参加コードを発行（未発行なら新規、既存ならそのまま返す） */
    ensureGuestInviteCode(projectId: string): string | null {
        const project = this.projects.find((p) => p.id === projectId);
        if (!project || project.isPersonal) return null;
        if (project.guestInviteCode?.trim()) {
            return project.guestInviteCode.trim().toUpperCase();
        }
        let code = '';
        for (let attempt = 0; attempt < 40; attempt++) {
            const candidate = AppService.generateGuestInviteCodeValue();
            const norm = candidate.toLowerCase();
            if (!this.isInviteCodeInUse(norm, projectId)) {
                code = candidate;
                break;
            }
        }
        if (!code) return null;
        project.guestInviteCode = code;
        this.bumpProjectsRev();
        void this.persistIfNeeded();
        return code.toUpperCase();
    }

    guestInviteCodeForProject(projectId: string): string {
        const p = this.projects.find((x) => x.id === projectId);
        return p?.guestInviteCode?.trim().toUpperCase() ?? '';
    }

    isProjectGuest(projectId: string, uid: string | null | undefined): boolean {
        return isProjectGuestById(this.projects, projectId, uid);
    }

    private assertCanMutateProjectTasks(projectId: string, actorUid?: string | null): boolean {
        const project = this.projects.find((p) => p.id === projectId);
        if (!canMutateTasksInProject(project, actorUid ?? null)) {
            if (isProjectGuestById(this.projects, projectId, actorUid)) {
                alert('閲覧のみのため変更できません。');
            }
            return false;
        }
        return true;
    }

    getAccessibleProjectsForMember(memberUid: string): Project[] {
        if (!memberUid) return [];
        return this.projects.filter((p) => p.adminId === memberUid || p.memberIds.includes(memberUid));
    }

    getTeamProjectsForMember(memberUid: string): Project[] {
        return this.getAccessibleProjectsForMember(memberUid).filter((p) => !p.isPersonal);
    }

    getPersonalProjectsForMember(memberUid: string): Project[] {
        return this.getAccessibleProjectsForMember(memberUid).filter((p) => !!p.isPersonal);
    }

    getPendingProjectJoinsForProject(projectId: string): PendingProjectJoin[] {
        return this.pendingProjectJoins.filter((x) => x.projectId === projectId);
    }

    getMyPendingProjectJoins(memberUid: string): PendingProjectJoin[] {
        return this.pendingProjectJoins.filter((x) => x.uid === memberUid);
    }

    hasPendingProjectJoin(memberUid: string, projectId?: string): boolean {
        const list = this.getMyPendingProjectJoins(memberUid);
        if (!projectId) return list.length > 0;
        return list.some((x) => x.projectId === projectId);
    }

    setLastOpenedProject(memberUid: string, projectId: string): void {
        if (!memberUid || !projectId) return;
        const map = this.storage.getJson<Record<string, string>>(storageKeyLastOpenedProjectByMember()) ?? {};
        map[memberUid] = projectId;
        this.storage.setJson(storageKeyLastOpenedProjectByMember(), map);
    }

    getLastOpenedProject(memberUid: string): string | null {
        const map = this.storage.getJson<Record<string, string>>(storageKeyLastOpenedProjectByMember());
        return map?.[memberUid] ?? null;
    }

    private readUnseenApprovedTeamMap(): Record<string, string[]> {
        return this.storage.getJson<Record<string, string[]>>(storageKeyUnseenApprovedTeamByMember()) ?? {};
    }

    private writeUnseenApprovedTeamMap(map: Record<string, string[]>): void {
        this.storage.setJson(storageKeyUnseenApprovedTeamByMember(), map);
    }

    getUnseenApprovedTeamProjectIds(memberUid: string): string[] {
        if (!memberUid?.trim()) return [];
        return this.readUnseenApprovedTeamMap()[memberUid] ?? [];
    }

    addUnseenApprovedTeamProject(memberUid: string, projectId: string): void {
        const uid = memberUid.trim();
        const pid = projectId.trim();
        if (!uid || !pid) return;
        const map = this.readUnseenApprovedTeamMap();
        const cur = new Set(map[uid] ?? []);
        if (cur.has(pid)) return;
        cur.add(pid);
        map[uid] = [...cur];
        this.writeUnseenApprovedTeamMap(map);
        this.touchNotifications();
    }

    clearUnseenApprovedTeamProjects(memberUid: string): void {
        const uid = memberUid.trim();
        if (!uid) return;
        const map = this.readUnseenApprovedTeamMap();
        if (!map[uid]?.length) return;
        delete map[uid];
        this.writeUnseenApprovedTeamMap(map);
        this.touchNotifications();
    }

    private reconcileUnseenApprovedTeamJoins(before: PendingProjectJoin[], after: PendingProjectJoin[]): void {
        const afterKeys = new Set(after.map((p) => `${p.projectId}::${p.uid}`));
        for (const p of before) {
            if (afterKeys.has(`${p.projectId}::${p.uid}`)) continue;
            const proj = this.projects.find((x) => x.id === p.projectId);
            if (!proj || proj.isPersonal) continue;
            if (!proj.memberIds.includes(p.uid)) continue;
            this.addUnseenApprovedTeamProject(p.uid, p.projectId);
        }
    }

    navigateToProject(projectId: string, memberUid: string): void {
        const p = this.projects.find((x) => x.id === projectId);
        if (!p || !memberUid) return;
        this.projectId = projectId;
        this.setLastOpenedProject(memberUid, projectId);
        if (p.isPersonal) {
            void this.router.navigate(['/personal/today-tasks']);
            return;
        }
        if (p.adminId === memberUid) {
            void this.router.navigate(['/admin/manage-tasks', projectId]);
            return;
        }
        void this.router.navigate(['/member/limit-tasks', projectId, memberUid]);
    }

    resolvePostLoginRoute(memberUid: string): string[] {
        const accessible = this.getAccessibleProjectsForMember(memberUid);
        if (accessible.length === 0) return ['/landing'];
        const last = this.getLastOpenedProject(memberUid);
        if (last && accessible.some((p) => p.id === last)) {
            const p = accessible.find((x) => x.id === last)!;
            if (p.isPersonal) return ['/personal/today-tasks'];
            if (p.adminId === memberUid) return ['/admin/manage-tasks', last];
            return ['/member/limit-tasks', last, memberUid];
        }
        const first = accessible[0];
        if (first.isPersonal) return ['/personal/today-tasks'];
        if (first.adminId === memberUid) return ['/admin/manage-tasks', first.id];
        return ['/member/limit-tasks', first.id, memberUid];
    }

    requestJoinProjectByInviteCode(
        code: string,
        member: { uid: string; email: string; name: string }
    ): 'ok' | 'not_found' | 'personal' | 'already_member' | 'already_pending' {
        const guestProject = this.findTeamProjectByGuestInviteCode(code);
        const memberProject = this.findTeamProjectByInviteCode(code);
        const project = guestProject ?? memberProject;
        if (!project) return 'not_found';
        if (project.isPersonal) return 'personal';
        const joinRole: PendingProjectJoin['joinRole'] = guestProject ? 'guest' : 'member';
        const uid = member.uid.trim();
        if (!uid) return 'not_found';
        if (project.adminId === uid || project.memberIds.includes(uid)) return 'already_member';
        if (this.pendingProjectJoins.some((x) => x.projectId === project.id && x.uid === uid)) {
            return 'already_pending';
        }

        const applicantName = member.name.trim() || member.email;
        this.pendingProjectJoins.push({
            projectId: project.id,
            uid,
            email: member.email.trim().toLowerCase(),
            name: applicantName,
            requestedAt: Date.now(),
            joinRole
        });
        this.touchNotifications();
        this.adminToast.show(`${applicantName}さんが「${project.name}」への参加を申請しました。`);
        void this.persistIfNeeded();
        return 'ok';
    }

    approvePendingProjectJoins(projectId: string, uids: string[]): void {
        const targets = new Set(uids.map((x) => x.trim()).filter(Boolean));
        if (targets.size === 0) return;
        const project = this.projects.find((p) => p.id === projectId);
        if (!project || project.isPersonal) return;
        if (!project.memberRoles) project.memberRoles = {};
        for (const uid of targets) {
            if (!project.memberIds.includes(uid)) project.memberIds.push(uid);
            const pending = this.pendingProjectJoins.find((x) => x.projectId === projectId && x.uid === uid);
            const role = pending?.joinRole === 'guest' ? 'guest' : 'member';
            if (role === 'guest') {
                project.memberRoles[uid] = 'guest';
            } else {
                delete project.memberRoles[uid];
            }
            const name = pending?.name ?? this.getMemberById(uid)?.name ?? uid;
            const roleLabel = role === 'guest' ? 'ゲスト' : 'メンバー';
            this.appendAudit({
                projectId,
                actorUid: project.adminId,
                action: 'member.join_approve',
                title: name,
                summary: `参加を承認（${roleLabel}）: ${name}`
            });
        }
        this.pendingProjectJoins = this.pendingProjectJoins.filter(
            (x) => !(x.projectId === projectId && targets.has(x.uid))
        );
        this.bumpProjectsRev();
        this.touchNotifications();
        void this.persistIfNeeded();
    }

    rejectPendingProjectJoins(projectId: string, uids: string[]): void {
        const targets = new Set(uids.map((x) => x.trim()).filter(Boolean));
        if (targets.size === 0) return;
        this.pendingProjectJoins = this.pendingProjectJoins.filter(
            (x) => !(x.projectId === projectId && targets.has(x.uid))
        );
        this.touchNotifications();
        void this.persistIfNeeded();
    }

    /** ヘッダー表示用のプロジェクト名 */
    getProjectDisplayName(projectId: string): string {
        const p = this.projects.find((x) => x.id === projectId);
        if (p?.name) return p.name;
        if (AppService.isPersonalWorkspaceProjectId(projectId)) return '個人タスク';
        return 'プロジェクト';
    }

    createProjectFromMenu(
        projectName: string,
        description: string,
        isPersonal: boolean,
        creatorUid: string
    ): string | null {
        return this.createProject(
            projectName,
            creatorUid,
            [creatorUid],
            isPersonal,
            description,
            { navigate: true }
        );
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
        this.bumpProjectsRev();
        void this.persistIfNeeded();
    }

    deleteProject(projectId: string): void {
        if (!this.projects.some((p) => p.id === projectId)) return;
        this.pendingLocalProjectIds.delete(projectId);
        this.projects = this.projects.filter((p) => p.id !== projectId);
        this.bumpProjectsRev();
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
        this.auditLog = this.auditLog.filter((e) => e.projectId !== projectId);
        this.trashedTasks = this.trashedTasks.filter((e) => e.projectId !== projectId);
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

        mentionUserIds: string[] = [],

        actorMemberUid?: string | null

    ): void {

        if (!title?.trim()) {

            alert('タイトルを入力してください');

            return;

        }

        const mutateActor = createdById ?? actorMemberUid ?? null;
        const auditActor = actorMemberUid ?? createdById ?? null;

        if (!this.assertCanMutateProjectTasks(projectId, mutateActor)) return;



        const hasLead = !!leadAssigneeId;

        const isDraft = !deadline || !hasLead;

        const mids = [...mentionUserIds];

        const priority: Priority = isUrgent ? '高' : '通常';

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

            mentionUserIds: mids

        };

        this.parentTasks.push(newParent);



        this.notifyParentListDeltas(

            null,

            [],

            newParent,

            this.getChildAssigneeIdsForParent(newParent.id),

            auditActor

        );

        if (isDraft) {

            alert('未設定タスクを登録しました');

        }
        const pt = newParent.title?.trim() || '（無題）';
        this.appendAudit({
            projectId,
            actorUid: auditActor,
            action: 'parent.create',
            title: pt,
            summary: `親タスクを作成: ${pt}`
        });
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

        if (!this.assertCanMutateProjectTasks(projectId, actorMemberUid)) return;

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

        const ct = row.title?.trim() || '（無題）';
        this.appendAudit({
            projectId,
            actorUid: actorMemberUid ?? null,
            action: 'child.create',
            title: ct,
            summary: `子タスクを作成: ${ct}`
        });

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
    if (!this.assertCanMutateProjectTasks(parent.projectId, actorUid)) return;

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
    if (!this.assertCanMutateProjectTasks(child.projectId, actorUid)) return;

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



    private pruneAuditLog(): void {
        this.auditLog = pruneAuditLogEntries(this.auditLog);
    }

    appendAudit(entry: {
        projectId: string;
        actorUid?: string | null;
        action: string;
        title: string;
        summary: string;
        at?: number;
    }): void {
        const actorUid = entry.actorUid ?? null;
        const row: AuditLogEntry = {
            id: crypto.randomUUID(),
            at: entry.at ?? Date.now(),
            projectId: entry.projectId,
            actorUid,
            actorName: actorUid ? (this.getMemberById(actorUid)?.name ?? '（不明）') : '（不明）',
            action: entry.action,
            title: entry.title,
            summary: entry.summary
        };
        this.auditLog = [...this.auditLog, row];
    }

    getAuditLogForProject(projectId: string): AuditLogEntry[] {
        this.pruneAuditLog();
        return this.auditLog
            .filter((e) => e.projectId === projectId)
            .sort((a, b) => b.at - a.at);
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
        const title = parent.title?.trim() || '（無題）';
        this.appendTaskStatusChange({
            projectId: parent.projectId,
            kind: 'parent',
            taskId: parent.id,
            parentTaskId: parent.id,
            title,
            fromStatus: from,
            toStatus: to,
            actorMemberUid: actorMemberUid ?? null
        });
        this.appendAudit({
            projectId: parent.projectId,
            actorUid: actorMemberUid ?? null,
            action: 'status_change',
            title,
            summary: auditSummaryStatusChange('parent', title, from, to)
        });
    }

    private recordChildStatusChange(child: ChildTask, from: TaskStatus, to: TaskStatus, actorMemberUid?: string | null): void {
        if (from === to) return;
        const title = child.title?.trim() || '（無題）';
        this.appendTaskStatusChange({
            projectId: child.projectId,
            kind: 'child',
            taskId: child.id,
            parentTaskId: child.parentTaskId,
            title,
            fromStatus: from,
            toStatus: to,
            actorMemberUid: actorMemberUid ?? null
        });
        this.appendAudit({
            projectId: child.projectId,
            actorUid: actorMemberUid ?? null,
            action: 'status_change',
            title,
            summary: auditSummaryStatusChange('child', title, from, to)
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

        if (AppService.isPersonalWorkspaceProjectId(projectId)) {
            const uid = projectId.slice('__personal_'.length);
            const m = this.getMemberById(uid);
            return m ? [m] : [];
        }

        const project = this.projects.find((p) => p.id === projectId);

        if (!project || !project.memberIds) {

            return [];

        }

        return this.members.filter((member) => project.memberIds.includes(member.uid));

    }

    /** 担当・共有・稼働集計・進捗確認など「作業メンバー」向け（ゲスト除外） */
    getAssignableMembersByProjectId(projectId: string): Member[] {
        return this.getMembersByProjectId(projectId).filter((m) => !this.isProjectGuest(projectId, m.uid));
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

    /** 作業一覧用: 下書き・完了以外の親タスク */
    isActiveParentTask(task: ParentTask): boolean {
        return !task.isDraft && task.status !== '完了';
    }

    /** 担当のみ設定済みの下書き（期限未設定ページ・管理中央一覧） */
    isAssigneeOnlyDraftParent(task: ParentTask): boolean {
        return task.isDraft && !!task.leadAssigneeId && AppService.deadlineUnset(task.deadline);
    }

    isActiveChildTask(child: ChildTask): boolean {
        return child.status !== '完了';
    }

    getActiveChildTasksByParentId(parentTaskId: string): ChildTask[] {
        return this.getChildTasksByParentId(parentTaskId).filter((c) => this.isActiveChildTask(c));
    }

    /** 作業一覧: 作成順を維持し、完了子のみ末尾へ（stable partition） */
    getWorkViewChildTasksByParentId(parentTaskId: string): ChildTask[] {
        const children = this.getChildTasksByParentId(parentTaskId);
        const active: ChildTask[] = [];
        const done: ChildTask[] = [];
        for (const c of children) {
            if (c.status === '完了') done.push(c);
            else active.push(c);
        }
        return [...active, ...done];
    }

    /** 誤完了など: 完了子を進行中へ戻す（親の sync は setChildTaskStatus 経由） */
    revertChildTaskFromComplete(childTaskId: string, actorMemberUid?: string | null): void {
        const child = this.childTasks.find((c) => c.id === childTaskId);
        if (!child || child.status !== '完了') return;
        this.setChildTaskStatus(childTaskId, '進行中', actorMemberUid ?? undefined);
    }

    /** 作業一覧用: 下書き・完了を除いた親タスク（ソート済み） */
    getActiveSortedParentTasksForProject(projectId: string): ParentTask[] {
        return this.getSortedParentTasksForProject(projectId, false).filter((t) => this.isActiveParentTask(t));
    }

    /** 子あり親で親ストリップの吹き出しを隠す（全子未着手のときは親に表示） */
    shouldHideParentProgressSpeech(parentTaskId: string): boolean {
        const children = this.getChildTasksByParentId(parentTaskId);
        if (children.length === 0) return false;
        return children.some((c) => c.status !== '未着手');
    }

    /** 進行中の親・子にメンバーが関与しているか */
    memberHasInProgressTaskInvolvement(projectId: string, memberUid: string): boolean {
        if (!memberUid?.trim() || AppService.isPersonalWorkspaceProjectId(projectId)) return false;
        for (const p of this.parentTasks) {
            if (p.projectId !== projectId || p.isDraft) continue;
            const onTeam = p.leadAssigneeId === memberUid || p.memberIds.includes(memberUid);
            if (onTeam && p.status === '進行中') return true;
        }
        for (const c of this.childTasks) {
            if (c.projectId !== projectId) continue;
            if (c.assigneeId === memberUid && c.status === '進行中') return true;
        }
        return false;
    }

    /** 進捗確認ラウンドの対象（責任者は進行中関与があるときのみ） */
    shouldReceiveProgressCheck(projectId: string, memberUid: string): boolean {
        const project = this.projects.find((p) => p.id === projectId);
        if (!project || AppService.isPersonalWorkspaceProjectId(projectId)) return false;
        if (this.isProjectGuest(projectId, memberUid)) return false;
        if (project.adminId !== memberUid) return true;
        return this.memberHasInProgressTaskInvolvement(projectId, memberUid);
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


        if (patch.deadline !== undefined) {

            this.syncTodayFlagsForParentDueToday(t);

        }



        if (!options?.skipNotification) {

            const assigneesAfter = this.getChildAssigneeIdsForParent(taskId);

            this.notifyParentListDeltas(parentBefore, assigneesBefore, t, assigneesAfter, options?.actorMemberUid ?? null);

            this.notifyMemberTaskFieldChanges(
                parentBefore,
                assigneesBefore,
                t,
                assigneesAfter,
                options?.actorMemberUid ?? null
            );

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



    private touchTrash(): void {
        this.trashRev.update((x) => x + 1);
    }

    purgeExpiredTrashedTasks(): number {
        const cutoff = Date.now() - TRASH_RETENTION_MS;
        const before = this.trashedTasks.length;
        this.trashedTasks = this.trashedTasks.filter((e) => e.deletedAt >= cutoff);
        const removed = before - this.trashedTasks.length;
        if (removed > 0) {
            this.touchTrash();
            void this.persistIfNeeded();
        }
        return removed;
    }

    getTrashedTasksForProject(projectId: string): TrashedTaskEntry[] {
        void this.trashRev();
        this.purgeExpiredTrashedTasks();
        return this.trashedTasks
            .filter((e) => e.projectId === projectId)
            .sort((a, b) => b.deletedAt - a.deletedAt);
    }

    memberCanDeleteParent(parent: ParentTask, actorUid: string | null | undefined): boolean {
        return canDeleteParentTask(parent, actorUid, this.getProjectAdminId(parent.projectId));
    }

    memberCanDeleteChild(parent: ParentTask, child: ChildTask, actorUid: string | null | undefined): boolean {
        return canDeleteChildTask(parent, child, actorUid, this.getProjectAdminId(parent.projectId));
    }

    memberCanActOnTrashed(entry: TrashedTaskEntry, actorUid: string | null | undefined): boolean {
        return canActOnTrashedEntry(entry, actorUid, this.getProjectAdminId(entry.projectId));
    }

    trashParentTask(taskId: string, actorUid: string | null | undefined): boolean {
        const parent = this.parentTasks.find((p) => p.id === taskId);
        if (!parent) return false;
        if (!this.assertCanMutateProjectTasks(parent.projectId, actorUid)) return false;
        if (!this.memberCanDeleteParent(parent, actorUid)) return false;

        const children = this.childTasks.filter((c) => c.parentTaskId === taskId).map(cloneChildForTrash);
        const entry: TrashedTaskEntry = {
            id: crypto.randomUUID(),
            projectId: parent.projectId,
            parent: cloneParentForTrash(parent),
            children,
            deletedAt: Date.now(),
            deletedByUid: actorUid ?? null,
            childOnly: false
        };
        this.trashedTasks.push(entry);
        this.hardDeleteParentTask(taskId);
        const pt = parent.title?.trim() || '（無題）';
        this.appendAudit({
            projectId: parent.projectId,
            actorUid: actorUid ?? null,
            action: 'parent.trash',
            title: pt,
            summary: `親タスクをゴミ箱へ: ${pt}`
        });
        this.touchTrash();
        void this.persistIfNeeded();
        return true;
    }

    trashChildTask(childId: string, actorUid: string | null | undefined): boolean {
        const child = this.childTasks.find((c) => c.id === childId);
        if (!child) return false;
        const parent = this.parentTasks.find((p) => p.id === child.parentTaskId);
        if (!parent) return false;
        if (!this.assertCanMutateProjectTasks(parent.projectId, actorUid)) return false;
        if (!this.memberCanDeleteChild(parent, child, actorUid)) return false;

        const parentBefore = this.cloneParentNotifyShallow(parent);
        const assigneesBefore = this.getChildAssigneeIdsForParent(parent.id);

        const entry: TrashedTaskEntry = {
            id: crypto.randomUUID(),
            projectId: parent.projectId,
            parent: cloneParentForTrash(parent),
            children: [cloneChildForTrash(child)],
            deletedAt: Date.now(),
            deletedByUid: actorUid ?? null,
            childOnly: true
        };
        this.trashedTasks.push(entry);

        this.childTasks = this.childTasks.filter((x) => x.id !== childId);
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter((e) => e.taskId !== childId);
        this.syncParentStatusWithChildren(parent.id);
        this.notifyParentListDeltas(
            parentBefore,
            assigneesBefore,
            parent,
            this.getChildAssigneeIdsForParent(parent.id),
            actorUid ?? null
        );
        const ct = child.title?.trim() || '（無題）';
        this.appendAudit({
            projectId: child.projectId,
            actorUid: actorUid ?? null,
            action: 'child.trash',
            title: ct,
            summary: `子タスクをゴミ箱へ: ${ct}`
        });
        this.touchTrash();
        void this.persistIfNeeded();
        return true;
    }

    restoreTrashedEntries(entryIds: string[], actorUid: string | null | undefined): number {
        let restored = 0;
        const idSet = new Set(entryIds);
        const remaining: TrashedTaskEntry[] = [];

        for (const entry of this.trashedTasks) {
            if (!idSet.has(entry.id)) {
                remaining.push(entry);
                continue;
            }
            if (!this.memberCanActOnTrashed(entry, actorUid)) {
                remaining.push(entry);
                continue;
            }
            if (entry.childOnly) {
                const liveParent = this.parentTasks.find((p) => p.id === entry.parent.id);
                if (!liveParent) {
                    remaining.push(entry);
                    continue;
                }
                for (const c of entry.children) {
                    if (!this.childTasks.some((x) => x.id === c.id)) {
                        this.childTasks.push(cloneChildForTrash(c));
                    }
                }
                this.syncParentStatusWithChildren(liveParent.id);
                for (const c of entry.children) {
                    const ct = c.title?.trim() || '（無題）';
                    this.appendAudit({
                        projectId: entry.projectId,
                        actorUid: actorUid ?? null,
                        action: 'child.restore',
                        title: ct,
                        summary: `子タスクを復元: ${ct}`
                    });
                }
                restored++;
                continue;
            }

            if (this.parentTasks.some((p) => p.id === entry.parent.id)) {
                remaining.push(entry);
                continue;
            }
            this.parentTasks.push(cloneParentForTrash(entry.parent));
            for (const c of entry.children) {
                if (!this.childTasks.some((x) => x.id === c.id)) {
                    this.childTasks.push(cloneChildForTrash(c));
                }
            }
            const pt = entry.parent.title?.trim() || '（無題）';
            this.appendAudit({
                projectId: entry.projectId,
                actorUid: actorUid ?? null,
                action: 'parent.restore',
                title: pt,
                summary: `親タスクを復元: ${pt}`
            });
            restored++;
        }

        if (restored > 0) {
            this.trashedTasks = remaining;
            this.touchTrash();
            this.markStateChanged();
            void this.persistIfNeeded();
        }
        return restored;
    }

    purgeAllTrashedInProject(projectId: string): number {
        const before = this.trashedTasks.length;
        this.trashedTasks = this.trashedTasks.filter((e) => e.projectId !== projectId);
        const removed = before - this.trashedTasks.length;
        if (removed > 0) {
            this.touchTrash();
            void this.persistIfNeeded();
        }
        return removed;
    }

    trashAllCompletedParentsInProject(projectId: string, actorUid: string | null | undefined): number {
        const ids = this.parentTasks
            .filter((t) => t.projectId === projectId && t.status === '完了' && this.memberCanDeleteParent(t, actorUid))
            .map((t) => t.id);
        let n = 0;
        for (const id of ids) {
            if (this.trashParentTask(id, actorUid)) n++;
        }
        return n;
    }

    /** @deprecated 完全削除（ゴミ箱パージ用）。UI からは trashParentTask を使用 */
    deleteParentTask(taskId: string): void {
        this.hardDeleteParentTask(taskId);
    }

    private hardDeleteParentTask(taskId: string): void {
        this.parentTasks = this.parentTasks.filter((p) => p.id !== taskId);
        this.childTasks = this.childTasks.filter((c) => c.parentTaskId !== taskId);
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter(
            (e) => e.parentTaskId !== taskId && e.taskId !== taskId
        );
    }



    patchChildTask(

        childId: string,

        patch: Partial<Pick<ChildTask, 'title' | 'assigneeId' | 'isTodayTask' | 'scheduledDate'>>,

        options?: { actorMemberUid?: string; skipNotification?: boolean }

    ): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        if (!this.assertCanMutateProjectTasks(c.projectId, options?.actorMemberUid)) return;

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



    deleteChildTask(childId: string, actorUid?: string | null): void {
        if (actorUid !== undefined && actorUid !== null) {
            this.trashChildTask(childId, actorUid);
            return;
        }
        const c = this.childTasks.find((x) => x.id === childId);
        if (!c) return;
        const parentId = c.parentTaskId;
        const parent = this.parentTasks.find((p) => p.id === parentId);
        this.childTasks = this.childTasks.filter((x) => x.id !== childId);
        this.taskStatusChangeLog = this.taskStatusChangeLog.filter((e) => e.taskId !== childId);
        if (parent) {
            this.syncParentStatusWithChildren(parentId);
        }
        void this.persistIfNeeded();
    }



    toggleParentTodayTask(taskId: string, actorMemberUid?: string): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        if (!this.assertCanMutateProjectTasks(t.projectId, actorMemberUid)) return;

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

        if (!this.assertCanMutateProjectTasks(c.projectId, actorMemberUid)) return;

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

        return [...new Set(ids)].filter((uid) => !this.isProjectGuest(parent.projectId, uid));

    }



    /** 同一プロジェクト内の親タスクを表示用にソート */

    getSortedParentTasksForProject(projectId: string, includeDraft: boolean): ParentTask[] {

        const list = this.parentTasks.filter((t) => t.projectId === projectId && (includeDraft || !t.isDraft));

        const mode = this.parentListSortResolved(projectId);

        if (mode === 'deadline') {

            return [...list].sort((a, b) => this.compareParentsByDeadlinePriorityTitle(a, b));

        }

        if (mode === 'status') {

            return [...list].sort((a, b) => this.compareParentsByStatusThenDeadline(a, b));

        }

        const hasManualOrder = (t: ParentTask) => t.displayOrder !== undefined && t.displayOrder !== null;

        const without = list.filter((t) => !hasManualOrder(t)).sort((a, b) => this.compareParentsByDeadlinePriorityTitle(a, b));

        const withOrder = list.filter((t) => hasManualOrder(t)).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

        return [...without, ...withOrder];

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

    /** Google ログイン時に members へ自動登録（A1） */
    syncMemberFromAuth(input: { uid?: string; name: string; email: string; photoURL?: string }): void {
        const email = input.email.trim().toLowerCase();
        if (!email) return;
        const uid = input.uid?.trim() || '';
        let member = this.members.find((m) => m.email.trim().toLowerCase() === email);
        if (member) {
            member.name = input.name.trim() || member.name;
            member.photoURL = input.photoURL || member.photoURL || '';
            if (uid && !member.uid) member.uid = uid;
        } else if (this.members.length === 0) {
            const newUid = uid || crypto.randomUUID();
            member = {
                uid: newUid,
                name: input.name.trim() || email,
                email,
                photoURL: input.photoURL || '',
                role: 'メンバー'
            };
            this.members.push(member);
            this.appOwnerUid = newUid;
        } else {
            const newUid = uid || crypto.randomUUID();
            member = {
                uid: newUid,
                name: input.name.trim() || email,
                email,
                photoURL: input.photoURL || '',
                role: 'メンバー'
            };
            this.members.push(member);
        }
        this.pendingLoginMembers = this.pendingLoginMembers.filter(
            (x) => x.email.trim().toLowerCase() !== email
        );
        this.ensureBootstrapAdminFromPending();
        void this.persistIfNeeded();
    }

    upsertPendingLoginMember(input: { uid?: string; name: string; email: string; photoURL?: string }): void {
        this.syncMemberFromAuth(input);
    }

    approvePendingMembers(emails: string[], _role: '' | '管理者' | 'メンバー' | 'ゲスト'): void {
        const targets = new Set(emails.map((x) => x.trim().toLowerCase()).filter(Boolean));
        if (targets.size === 0) return;
        const approvedRole: Member['role'] = 'メンバー';
        for (const p of [...this.pendingLoginMembers]) {
            const em = p.email.trim().toLowerCase();
            if (!targets.has(em)) continue;
            const exists = this.members.find((m) => m.email.trim().toLowerCase() === em);
            if (exists) {
                exists.name = p.name || exists.name;
                exists.photoURL = p.photoURL || exists.photoURL;
                exists.role = approvedRole;
            } else {
                this.members.push({
                    uid: p.uid || crypto.randomUUID(),
                    name: p.name,
                    email: p.email,
                    photoURL: p.photoURL || '',
                    role: approvedRole
                });
            }
        }
        this.pendingLoginMembers = this.pendingLoginMembers.filter((x) => !targets.has(x.email.trim().toLowerCase()));
        void this.persistIfNeeded();
    }

    removeMemberByUid(uid: string): void {
        if (this.appOwnerUid === uid) {
            alert('オーナーは削除できません。先にオーナーを他のメンバーに譲渡してください。');
            return;
        }
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
        this.touchNotifications();
        void this.persistIfNeeded();
    }

    /** プロジェクトの責任者（adminId）を引き継ぐ。新責任者は memberIds に含まれている必要がある */

    transferProjectAdmin(projectId: string, newAdminUid: string): void {
        const p = this.projects.find((x) => x.id === projectId);
        if (!p || newAdminUid === p.adminId) return;
        if (!p.memberIds.includes(newAdminUid)) return;
        p.adminId = newAdminUid;
        this.markStateChanged();
    }

    /** プロジェクトの memberIds から外す（責任者は不可） */

    removeMemberFromProject(projectId: string, memberUid: string): void {
        const p = this.projects.find((x) => x.id === projectId);
        if (!p) return;
        if (p.adminId === memberUid) {
            alert('責任者は先に他のメンバーに引き継いでから削除してください。');
            return;
        }
        const name = this.getMemberById(memberUid)?.name ?? memberUid;
        p.memberIds = p.memberIds.filter((id) => id !== memberUid);
        if (p.memberRoles?.[memberUid]) {
            const next = { ...p.memberRoles };
            delete next[memberUid];
            p.memberRoles = Object.keys(next).length ? next : undefined;
        }
        this.appendAudit({
            projectId,
            actorUid: p.adminId,
            action: 'member.remove',
            title: name,
            summary: `メンバーをプロジェクトから外しました: ${name}`
        });
        this.bumpProjectsRev();
        this.markStateChanged();
    }

    /** メンバーのアプリ全体ロール。プロジェクト責任者のまま「メンバー」にはできない。成功時 true */

    setMemberAppRole(uid: string, role: '管理者' | 'メンバー'): boolean {
        const m = this.members.find((x) => x.uid === uid);
        if (!m) return false;
        if (m.role === role) return true;
        if (role === 'メンバー' && m.role === '管理者') {
            const adminCount = this.members.filter((x) => x.role === '管理者').length;
            if (adminCount <= 1) {
                alert('アプリ上の最後の管理者は外せません。');
                return false;
            }
            for (const p of this.projects) {
                if (p.adminId === uid) {
                    alert('プロジェクトの責任者になっている間はアプリ権限を「メンバー」にできません。先に責任者を引き継いでください。');
                    return false;
                }
            }
        }
        m.role = role;
        this.markStateChanged();
        return true;
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

        const members = this.getAssignableMembersByProjectId(projectId);

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
        const project = this.projects.find((p) => p.id === task.projectId);
        if (project?.adminId === task.createdById) return false;
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
        if (!this.assertCanMutateProjectTasks(projectId, actorMemberUid)) return;

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

    deleteAllCompletedParentTasksInProject(projectId: string, actorUid?: string | null): void {
        if (!this.assertCanMutateProjectTasks(projectId, actorUid)) return;
        this.trashAllCompletedParentsInProject(projectId, actorUid ?? null);
    }



    getProjectAdminId(projectId: string): string | undefined {

        return this.projects.find((p) => p.id === projectId)?.adminId;

    }

    isAppOwner(uid: string | null | undefined): boolean {
        return !!uid && !!this.appOwnerUid && uid === this.appOwnerUid;
    }

    transferAppOwnership(newOwnerUid: string): void {
        const m = this.members.find((x) => x.uid === newOwnerUid);
        if (!m) return;
        this.appOwnerUid = newOwnerUid;
        this.markStateChanged();
    }

    /** タスク・プロジェクト・承認待ちを消去し、オーナー本人のみ残す */
    resetAppWorkspaceForOwner(): void {
        const owner = this.members.find((x) => x.uid === this.appOwnerUid);
        if (!owner) {
            alert('オーナー情報が見つかりません。');
            return;
        }
        this.members = [{ ...owner, role: 'メンバー' }];
        this.appOwnerUid = owner.uid;
        this.pendingLoginMembers = [];
        this.pendingLocalProjectIds.clear();
        this.projects = [];
        this.bumpProjectsRev();
        this.parentTasks = [];
        this.childTasks = [];
        this.memberNotificationCounts = {};
        this.adminNotificationCounts = {};
        this.taskStatusChangeLog = [];
        this.projectId = crypto.randomUUID();
        this.touchNotifications();
        this.markStateChanged();
    }

}

