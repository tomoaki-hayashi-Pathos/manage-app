import { Component, HostListener, effect, inject, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AppService } from '../../app.service';
import { ParentTask, Member, MENTION_ALL, MENTION_ADMIN, AdminNavPageKey } from '../../core/interface';
import { MemberNavLinksComponent } from './member-nav-links';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';

@Component({
    selector: 'app-shared-tasks',
    standalone: true,
    imports: [CommonModule, RouterLink, FormsModule, MemberNavLinksComponent],
    templateUrl: './shared-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './shared-tasks.css']
})
export class SharedTasksComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    private readonly adminAccess = inject(AdminProjectAccessService);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    readonly memberId = this.route.snapshot.params['memberId'] as string | undefined;
    private readonly accessEffect = effect(() => {
        if (this.isAdminView) this.adminAccess.redirectIfForbidden(this.projectId);
    });

    parentTaskFilterId: string | 'all' = 'all';
    rightMenuOpen = false;

    readonly TOK_ALL = MENTION_ALL;
    readonly TOK_ADMIN = MENTION_ADMIN;

    ngOnInit(): void {
        if (this.isAdminView) {
            this.appService.setAdminCurrentNavPage(this.projectId, 'shared');
            this.appService.clearAdminPageNotifications(this.projectId, 'shared');
        } else if (this.memberId) {
            this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, 'shared');
            this.appService.clearMemberPageNotifications(this.projectId, this.memberId, 'shared');
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
        return this.memberId === undefined;
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
    }

    get projectName(): string {
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get memberDisplayName(): string {
        return this.memberId ? (this.appService.getMemberById(this.memberId)?.name ?? '') : '';
    }

    get sharedParents(): ParentTask[] {
        const base = this.appService.getSortedParentTasksForProject(this.projectId, false);
        if (this.isAdminView) {
            return base.filter((t) => this.appService.isSharedTaskVisibleToAdmin(t));
        }
        return base.filter((t) => this.appService.isSharedTaskVisibleToMember(t, this.memberId!));
    }

    get parentTasksForFilter(): ParentTask[] {
        return [...this.sharedParents].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
    }

    get visibleSharedParents(): ParentTask[] {
        let list = this.sharedParents;
        if (this.parentTaskFilterId !== 'all') {
            list = list.filter((t) => t.id === this.parentTaskFilterId);
        }
        return list;
    }

    canUnshare(task: ParentTask): boolean {
        if (this.isAdminView) return false;
        return task.createdById === this.memberId;
    }

    unshare(task: ParentTask, ev: Event): void {
        ev.stopPropagation();
        if (!this.canUnshare(task) || !this.memberId) return;
        if (!confirm('共有（メンション）を解除しますか？')) return;
        this.appService.clearParentMentionsIfAuthor(task.id, this.memberId);
    }

    senderOf(task: ParentTask): Member | undefined {
        return task.createdById ? this.appService.getMemberById(task.createdById) : undefined;
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

    initials(name: string): string {
        return name.trim().slice(0, 2);
    }

    statusClass(s: string): string {
        switch (s) {
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
