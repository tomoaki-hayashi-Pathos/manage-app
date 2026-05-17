import { Component, HostListener, effect, inject, OnDestroy, OnInit } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { MemberBurdenSummary, AdminNavPageKey } from '../../core/interface';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';
import { showAdminDrawerLink, type AdminDrawerNavTarget } from './admin-drawer-nav.util';

@Component({
    selector: 'app-ops-status',
    standalone: true,
    imports: [CommonModule, RouterLink],
    templateUrl: './ops-status.html',
    styleUrls: ['./Manage-tasks.css', './ops-status.css']
})
export class OpsStatusComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly adminAccess = inject(AdminProjectAccessService);
    readonly projectId = this.route.snapshot.params['projectId'] as string;
    private readonly accessEffect = effect(() => {
        this.adminAccess.redirectIfForbidden(this.projectId);
    });

    rightMenuOpen = false;

    ngOnInit(): void {
        this.appService.setAdminCurrentNavPage(this.projectId, null);
    }

    ngOnDestroy(): void {
        this.appService.setAdminCurrentNavPage(this.projectId, null);
    }

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        return this.appService.getAdminGearNotificationTotal(this.projectId);
    }

    adminNavBadge(page: AdminNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getAdminPageNotificationCount(this.projectId, page);
    }

    get projectName(): string {
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    /** 負担度の高い順（サービス側でソート済み） */
    get summaries(): MemberBurdenSummary[] {
        return this.appService.getMemberBurdenSummaries(this.projectId);
    }

    breakdownText(s: MemberBurdenSummary): string {
        if (s.overdueCount === 0 && s.dueTodayCount === 0) {
            return '(期限切れ、今日締め切りなし)';
        }
        return `(期限切れ${s.overdueCount}、本日期限${s.dueTodayCount})`;
    }

    previewTitles(s: MemberBurdenSummary): string[] {
        return s.incompleteTaskTitles.slice(0, 5);
    }

    previewRestCount(s: MemberBurdenSummary): number {
        const n = s.incompleteTaskTitles.length;
        return n > 5 ? n - 5 : 0;
    }

    toggleRightMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.rightMenuOpen = !this.rightMenuOpen;
    }

    showAdminDrawerNav(target: AdminDrawerNavTarget): boolean {
        return showAdminDrawerLink(this.router, this.projectId, target);
    }

    closeRightMenu(): void {
        this.rightMenuOpen = false;
    }

    scrollToTop(): void {
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
