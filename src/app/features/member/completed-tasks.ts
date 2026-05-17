import { Component, HostListener, effect, inject, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AppService } from '../../app.service';
import { ParentTask, Member, AdminNavPageKey } from '../../core/interface';
import { MemberNavLinksComponent } from './member-nav-links';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';
import { AuthSessionService } from '../../services/auth-session.service';
import { MemberTaskRouteContext, readMemberTaskRouteMode } from './member-task-route-context';
import { MemberAccessService } from '../../services/member-access.service';
import { TaskSearchFilterToolbarComponent } from '../../shared/task-search-filter-toolbar/task-search-filter-toolbar.component';
import {
    defaultToolbarFilterState,
    parentMatchesToolbarFilters,
    type TaskToolbarFilterState,
} from '../../shared/task-search-filter-toolbar/task-search-filter.util';
import { showAdminDrawerLink, type AdminDrawerNavTarget } from '../admin/admin-drawer-nav.util';

@Component({
    selector: 'app-completed-tasks',
    standalone: true,
    imports: [CommonModule, RouterLink, FormsModule, MemberNavLinksComponent, TaskSearchFilterToolbarComponent],
    templateUrl: './completed-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './completed-tasks.css']
})
export class CompletedTasksComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    private readonly adminAccess = inject(AdminProjectAccessService);
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);
    private readonly memberAccess = inject(MemberAccessService);

    private readonly ctx = new MemberTaskRouteContext(this.route, this.appService, this.auth, this.router);

    get projectId(): string {
        return this.ctx.projectId;
    }

    get memberId(): string | undefined {
        if (this.isAdminView) return undefined;
        const id = this.ctx.memberId;
        return id || undefined;
    }

    navLinkMode(): 'member' | 'adminSelf' | 'personal' {
        if (this.ctx.mode === 'personal') return 'personal';
        if (this.ctx.mode === 'adminSelf') return 'adminSelf';
        return 'member';
    }

    private readonly accessEffect = effect(() => {
        if (this.isAdminView) {
            this.adminAccess.redirectIfForbidden(this.projectId);
            return;
        }
        void this.appService.ready();
        void this.appService.notificationTick();
        this.ctx.ensureMemberAccess(this.memberAccess);
    });

    toolbarFilter: TaskToolbarFilterState = defaultToolbarFilterState();
    rightMenuOpen = false;

    /** 一括未完了用チェック */
    selected: Record<string, boolean> = {};

    ngOnInit(): void {
        if (!this.isAdminView && !this.ctx.ensureMemberAccess(this.memberAccess)) return;
        if (this.isAdminView) {
            this.appService.setAdminCurrentNavPage(this.projectId, 'completed');
            this.appService.clearAdminPageNotifications(this.projectId, 'completed');
        } else if (this.memberId) {
            this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, 'completed');
            this.appService.clearMemberPageNotifications(this.projectId, this.memberId, 'completed');
        }
    }

    ngOnDestroy(): void {
        if (this.isAdminView) {
            this.appService.setAdminCurrentNavPage(this.projectId, null);
        } else if (this.memberId) {
            this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, null);
        }
    }

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        if (this.isAdminView) {
            return this.appService.getAdminGearNotificationTotal(this.projectId);
        }
        if (!this.memberId) return 0;
        return this.appService.getMemberGearNotificationTotal(this.projectId, this.memberId);
    }

    get isAdminView(): boolean {
        if (readMemberTaskRouteMode(this.route) === 'personal') return false;
        return !this.route.snapshot.paramMap.get('memberId');
    }

    /** チーム管理の完了ページと同様の「全完了削除」（個人ワークスペースでも利用可） */
    showBulkDeleteCompletedButton(): boolean {
        return this.isAdminView || this.ctx.mode === 'personal';
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
    }

    showAdminDrawerNav(target: AdminDrawerNavTarget): boolean {
        return showAdminDrawerLink(this.router, this.projectId, target);
    }

    get projectName(): string {
        if (this.ctx.mode === 'personal') return '個人タスク';
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get memberDisplayName(): string {
        return this.memberId ? (this.appService.getMemberById(this.memberId)?.name ?? '') : '';
    }

    get completedList(): ParentTask[] {
        let list = this.appService.parentTasks.filter((t) => t.projectId === this.projectId && t.status === '完了');
        if (this.isAdminView) {
            list = list.filter(
                (t) =>
                    !this.appService.shouldExcludePrivateMyFromAdmin(t) ||
                    this.appService.isSharedTaskVisibleToAdmin(t)
            );
        } else if (this.memberId) {
            list = list.filter(
                (t) => t.leadAssigneeId === this.memberId || (t.memberIds && t.memberIds.includes(this.memberId!))
            );
        }
        return list.sort((a, b) => {
            const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
            const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
            return tb - ta;
        });
    }

    get users(): Member[] {
        return this.appService.getMembersByProjectId(this.projectId);
    }

    get toolbarCandidateParents(): ParentTask[] {
        return [...this.completedList];
    }

    hideToolbarAssigneeFilter(): boolean {
        return this.ctx.mode === 'personal';
    }

    /** 個人ワークスペースのみ: 担当・メンバー表示を非表示 */
    hideTeamTaskChrome(): boolean {
        return this.ctx.mode === 'personal';
    }

    get visibleCompleted(): ParentTask[] {
        return this.completedList.filter((t) => parentMatchesToolbarFilters(this.appService, t, this.toolbarFilter));
    }

    toggleSelect(taskId: string, checked: boolean): void {
        this.selected[taskId] = checked;
    }

    isSelected(taskId: string): boolean {
        return !!this.selected[taskId];
    }

    get selectedIds(): string[] {
        return Object.keys(this.selected).filter((id) => this.selected[id]);
    }

    revertBulk(): void {
        const ids = this.selectedIds.filter((id) => {
            const t = this.appService.parentTasks.find((p) => p.id === id);
            return t && t.projectId === this.projectId && t.status === '完了';
        });
        if (ids.length === 0) {
            alert('タスクを選択してください。');
            return;
        }
        if (!confirm(`選択した ${ids.length} 件を未着手に戻しますか？`)) return;
        this.appService.revertCompletedParentsToTodo(this.projectId, ids, this.memberId ?? undefined);
        for (const id of ids) delete this.selected[id];
    }

    deleteAllCompletedLogs(): void {
        if (!this.showBulkDeleteCompletedButton()) return;
        const n = this.appService.parentTasks.filter((t) => t.projectId === this.projectId && t.status === '完了').length;
        if (n === 0) return;
        if (!confirm(`完了済みタスク ${n} 件をすべて削除しますか？（元に戻せません）`)) return;
        this.appService.deleteAllCompletedParentTasksInProject(this.projectId);
        this.selected = {};
    }

    formatDeadline(deadline: Date | string | null): string {
        if (!deadline) return '期限未設定';
        const d = new Date(deadline);
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時まで`;
    }

    formatCompletedAt(task: ParentTask): string {
        if (!task.completedAt) return '—';
        const d = new Date(task.completedAt);
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分完了`;
    }

    membersOrderedForAvatar(task: ParentTask): Member[] {
        const ids = task.leadAssigneeId ? [task.leadAssigneeId, ...task.memberIds] : [...task.memberIds];
        return this.appService.getMembersByUids(ids);
    }

    initials(name: string): string {
        return name.trim().slice(0, 2);
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
