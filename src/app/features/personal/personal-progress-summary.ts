import { CommonModule } from '@angular/common';
import { Component, computed, effect, HostListener, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import type { ParentTask, TaskStatus } from '../../core/interface';
import { MemberNavLinksComponent } from '../member/member-nav-links';
import { MemberAccessService } from '../../services/member-access.service';

@Component({
    selector: 'app-personal-progress-summary',
    standalone: true,
    imports: [CommonModule, MemberNavLinksComponent],
    templateUrl: './personal-progress-summary.html',
    styleUrls: ['../admin/Manage-tasks.css', './personal-progress-summary.css']
})
export class PersonalProgressSummaryComponent implements OnInit {
    private readonly app = inject(AppService);
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);
    private readonly memberAccess = inject(MemberAccessService);

    rightMenuOpen = false;

    private readonly memberRouteGuardEffect = effect(() => {
        void this.app.ready();
        void this.app.notificationTick();
        const id = this.uid();
        const pid = this.personalProjectId();
        if (!id || !pid) return;
        this.memberAccess.ensureMemberTaskRoute('personal', pid, id);
    });

    private readonly uid = computed(() => this.app.getMemberByEmail(this.auth.currentEmail())?.uid ?? '');

    readonly memberDisplayName = computed(() => {
        const id = this.uid();
        return id ? (this.app.getMemberById(id)?.name ?? '') : '';
    });

    private readonly personalProjectId = computed(() => {
        void this.app.notificationTick();
        const id = this.uid();
        return id ? this.app.resolvePersonalTaskProjectIdForMember(id) : '';
    });

    readonly parents = computed(() => {
        void this.app.notificationTick();
        const pid = this.personalProjectId();
        if (!pid) return [];
        return this.app.parentTasks.filter((t) => t.projectId === pid && !t.isDraft);
    });

    readonly children = computed(() => {
        void this.app.notificationTick();
        const pid = this.personalProjectId();
        if (!pid) return [];
        return this.app.childTasks.filter((c) => c.projectId === pid);
    });

    ngOnInit(): void {
        const id = this.uid();
        if (!id) {
            void this.router.navigate(['/top']);
            return;
        }
        const pid = this.app.resolvePersonalTaskProjectIdForMember(id);
        if (!this.memberAccess.ensureMemberTaskRoute('personal', pid, id)) return;
    }

    readonly completionRate = computed(() => {
        const ps = this.parents();
        if (ps.length === 0) return 0;
        const done = ps.filter((p) => p.status === '完了').length;
        return Math.round((done / ps.length) * 1000) / 10;
    });

    readonly statusBreakdown = computed(() => this.countStatuses([...this.parents(), ...this.mapChildrenAsPseudo()]));

    readonly deadlineIncomplete = computed(() => {
        const now = Date.now();
        const day = 86400000;
        let overdue = 0;
        let week = 0;
        let none = 0;
        for (const p of this.parents()) {
            if (p.status === '完了') continue;
            if (!p.deadline || AppService.deadlineUnset(p.deadline)) {
                none++;
                continue;
            }
            const t = new Date(p.deadline).getTime();
            if (t < now) overdue++;
            else if (t <= now + 7 * day) week++;
        }
        return { overdue, week, none };
    });

    readonly completedLast7Days = computed(() => {
        const since = Date.now() - 7 * 86400000;
        const out: ParentTask[] = [];
        for (const p of this.parents()) {
            if (p.status !== '完了') continue;
            const at = p.completedAt ? new Date(p.completedAt).getTime() : 0;
            if (at >= since) out.push(p);
        }
        return out.sort((a, b) => (b.completedAt ? new Date(b.completedAt).getTime() : 0) - (a.completedAt ? new Date(a.completedAt).getTime() : 0));
    });

    get navProjectId(): string {
        return this.personalProjectId();
    }

    get navMemberId(): string {
        return this.uid();
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

    private mapChildrenAsPseudo(): { status: TaskStatus }[] {
        return this.children().map((c) => ({ status: c.status }));
    }

    private countStatuses(items: { status: TaskStatus }[]): Record<TaskStatus, number> {
        const o: Record<TaskStatus, number> = { 未着手: 0, 進行中: 0, 完了: 0 };
        for (const x of items) o[x.status] = (o[x.status] ?? 0) + 1;
        return o;
    }
}
