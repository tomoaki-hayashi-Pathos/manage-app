import { Component, HostListener, effect, inject, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';
import { MemberAccessService } from '../../services/member-access.service';
import { MemberTaskRouteContext, readMemberTaskRouteMode } from '../member/member-task-route-context';
import { ProjectTopMenuComponent } from '../../shared/project-top-menu/project-top-menu';
import { DrawerLogoutComponent } from '../../shared/drawer-logout/drawer-logout';
import { MemberNavLinksComponent } from '../member/member-nav-links';
import { TaskSearchFilterToolbarComponent } from '../../shared/task-search-filter-toolbar/task-search-filter-toolbar.component';
import { ProgressReportingService } from '../../services/progress-reporting.service';
import {
    defaultToolbarFilterState,
    trashedEntryMatchesToolbar,
    type TaskToolbarFilterMode,
    type TaskToolbarFilterState,
    type ToolbarFilterContext
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';
import { TRASH_RETENTION_MS, trashEntryLabel } from '../../core/task-trash.util';
import type { Member, ParentTask, TrashedTaskEntry, AdminNavPageKey } from '../../core/interface';
import { showAdminDrawerLink, type AdminDrawerNavTarget } from '../admin/admin-drawer-nav.util';

@Component({
    selector: 'app-trash-tasks',
    standalone: true,
    imports: [
        CommonModule,
        RouterLink,
        FormsModule,
        ProjectTopMenuComponent,
        DrawerLogoutComponent,
        MemberNavLinksComponent,
        TaskSearchFilterToolbarComponent
    ],
    templateUrl: './trash-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', '../member/completed-tasks.css', './trash-tasks.css']
})
export class TrashTasksComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);
    private readonly adminAccess = inject(AdminProjectAccessService);
    private readonly memberAccess = inject(MemberAccessService);
    private readonly progress = inject(ProgressReportingService);

    private readonly ctx = new MemberTaskRouteContext(this.route, this.appService, this.auth, this.router);

    toolbarFilter: TaskToolbarFilterState = defaultToolbarFilterState();
    selected: Record<string, boolean> = {};
    rightMenuOpen = false;

    private readonly accessEffect = effect(() => {
        if (this.isAdminView) {
            this.adminAccess.redirectIfForbidden(this.projectId);
            return;
        }
        void this.appService.ready();
        this.ctx.ensureMemberAccess(this.memberAccess);
    });

    get projectId(): string {
        return this.ctx.projectId;
    }

    get memberId(): string | undefined {
        if (this.isAdminView) return undefined;
        const id = this.ctx.memberId;
        return id || undefined;
    }

    get actorUid(): string | null {
        return this.memberId ?? this.appService.getProjectAdminId(this.projectId) ?? this.auth.user()?.uid ?? null;
    }

    get isAdminView(): boolean {
        if (readMemberTaskRouteMode(this.route) === 'personal') return false;
        return !this.route.snapshot.paramMap.get('memberId');
    }

    navLinkMode(): 'member' | 'adminSelf' | 'personal' {
        if (this.ctx.mode === 'personal') return 'personal';
        if (this.ctx.mode === 'adminSelf') return 'adminSelf';
        return 'member';
    }

    ngOnInit(): void {
        if (!this.isAdminView && !this.ctx.ensureMemberAccess(this.memberAccess)) return;
        this.appService.purgeExpiredTrashedTasks();
    }

    ngOnDestroy(): void {}

    get trashedList(): TrashedTaskEntry[] {
        void this.appService.trashRev();
        return this.appService.getTrashedTasksForProject(this.projectId);
    }

    get visibleTrashed(): TrashedTaskEntry[] {
        return this.trashedList.filter((e) => trashedEntryMatchesToolbar(this.toolbarFilterCtx(), e, this.toolbarFilter));
    }

    get users(): Member[] {
        return this.appService.getMembersByProjectId(this.projectId);
    }

    get toolbarCandidateParents(): ParentTask[] {
        return this.trashedList.map((e) => e.parent);
    }

    toolbarFilterMode(): TaskToolbarFilterMode {
        return this.ctx.mode === 'personal' ? 'member' : 'manage';
    }

    private toolbarFilterCtx(): ToolbarFilterContext {
        return {
            app: this.appService,
            projectId: this.projectId,
            hasOpenStagnationForTask: (parentTaskId, childTaskId) =>
                this.progress.hasOpenStagnationForTask(this.projectId, parentTaskId, childTaskId)
        };
    }

    get projectName(): string {
        if (this.ctx.mode === 'personal') {
            return this.appService.getProjectDisplayName(this.projectId);
        }
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get memberDisplayName(): string {
        return this.memberId ? (this.appService.getMemberById(this.memberId)?.name ?? '') : '';
    }

    hideTeamTaskChrome(): boolean {
        return this.ctx.mode === 'personal';
    }

    entryLabel(entry: TrashedTaskEntry): string {
        return trashEntryLabel(entry);
    }

    entryStatusLabel(entry: TrashedTaskEntry): string {
        if (entry.childOnly && entry.children[0]) {
            return entry.children[0].status;
        }
        return entry.parent.status;
    }

    statusClass(status: string): string {
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

    formatDeadline(deadline: ParentTask['deadline']): string {
        if (!deadline) return '期限未設定';
        const d = new Date(deadline);
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時まで`;
    }

    formatDeletedAt(entry: TrashedTaskEntry): string {
        const d = new Date(entry.deletedAt);
        const remain = entry.deletedAt + TRASH_RETENTION_MS - Date.now();
        const days = Math.max(0, Math.ceil(remain / 86400000));
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}削除（あと${days}日）`;
    }

    membersOrderedForAvatar(entry: TrashedTaskEntry): Member[] {
        const p = entry.parent;
        const ids = p.leadAssigneeId ? [p.leadAssigneeId, ...p.memberIds] : [...p.memberIds];
        return this.appService.getMembersByUids(ids);
    }

    initials(name: string): string {
        return name.trim().slice(0, 2);
    }

    canActOn(entry: TrashedTaskEntry): boolean {
        return this.appService.memberCanActOnTrashed(entry, this.actorUid);
    }

    toggleSelect(entryId: string, checked: boolean): void {
        const entry = this.trashedList.find((e) => e.id === entryId);
        if (!entry || !this.canActOn(entry)) return;
        this.selected[entryId] = checked;
    }

    isSelected(entryId: string): boolean {
        return !!this.selected[entryId];
    }

    get selectedRestorableIds(): string[] {
        return Object.keys(this.selected).filter((id) => {
            if (!this.selected[id]) return false;
            const e = this.trashedList.find((x) => x.id === id);
            return e && this.canActOn(e);
        });
    }

    restoreSelected(): void {
        const ids = this.selectedRestorableIds;
        if (!ids.length) {
            alert('復元するタスクを選択してください。');
            return;
        }
        if (!confirm(`選択した ${ids.length} 件を復元しますか？`)) return;
        const n = this.appService.restoreTrashedEntries(ids, this.actorUid);
        for (const id of ids) delete this.selected[id];
        if (n < ids.length) {
            alert(`${n} 件を復元しました。一部は権限がないか、親タスクが既に存在するためスキップしました。`);
        }
    }

    purgeAll(): void {
        const n = this.trashedList.length;
        if (n === 0) return;
        if (!confirm(`ゴミ箱の ${n} 件を完全に削除しますか？復元できなくなります。`)) return;
        this.appService.purgeAllTrashedInProject(this.projectId);
        this.selected = {};
    }

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        if (this.isAdminView) {
            return this.appService.getAdminGearNotificationTotal(this.projectId);
        }
        if (!this.memberId) return 0;
        return this.appService.getMemberGearNotificationTotal(this.projectId, this.memberId);
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
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
        if (!this.rightMenuOpen) return;
        const t = ev.target as HTMLElement;
        if (t.closest('.side-drawer') || t.closest('.icon-gear-wrap')) return;
        this.rightMenuOpen = false;
    }
}
