import { effect, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../app.service';
import type { MemberTaskRouteMode } from '../features/member/member-task-route-context';
import { AuthSessionService } from './auth-session.service';

@Injectable({ providedIn: 'root' })
export class MemberAccessService {
    private readonly app = inject(AppService);
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);

    private logoutInFlight = false;

    constructor() {
        effect(() => {
            if (!this.app.ready() || this.auth.loading()) return;
            void this.app.notificationTick();
            if (!this.auth.user()) return;
            void this.ensureMemberAppSessionActive();
        });
    }

    /**
     * メンバー系タスク画面の入場・同期後チェック。
     * personal: 仮想 __personal_* は対象外。実体の個人プロジェクト削除時は hub。
     */
    ensureMemberTaskRoute(mode: MemberTaskRouteMode, projectId: string, memberId: string): boolean {
        if (!this.app.ready() || this.auth.loading()) return true;
        if (!this.ensureMemberAppSessionActive()) return false;
        if (mode === 'personal') {
            return this.ensurePersonalProjectAccess(projectId, memberId);
        }
        if (!this.ensureTeamProjectAccess(projectId, memberId)) return false;
        if (mode === 'team' && this.app.isProjectGuest(projectId, memberId)) {
            return this.ensureGuestTeamMemberRoute(projectId, memberId);
        }
        return true;
    }

    /** ゲストは limit-tasks / completed-tasks の閲覧のみ */
    private ensureGuestTeamMemberRoute(projectId: string, memberId: string): boolean {
        const path = this.router.url.split('?')[0];
        if (path.includes('/member/limit-tasks/') || path.includes('/member/completed-tasks/')) {
            return true;
        }
        void this.router.navigate(['/member/limit-tasks', projectId, memberId]);
        return false;
    }

    /** members から外れたら強制ログアウト（承認待ちは除外） */
    ensureMemberAppSessionActive(): boolean {
        if (!this.app.ready() || this.auth.loading() || !this.auth.user()) return true;

        const email = this.auth.currentEmail();
        if (!email) return true;

        const norm = email.trim().toLowerCase();
        if (this.app.pendingLoginMembers.some((p) => p.email.trim().toLowerCase() === norm)) {
            return true;
        }

        if (this.app.getMemberByEmail(email)) return true;

        void this.logoutRemovedMember();
        return false;
    }

    private ensurePersonalProjectAccess(projectId: string, memberId: string): boolean {
        if (!memberId) {
            void this.router.navigate(['/top']);
            return false;
        }

        if (AppService.isPersonalWorkspaceProjectId(projectId)) {
            return true;
        }

        const project = this.app.projects.find((p) => p.id === projectId);
        if (!project?.isPersonal) {
            return this.redirectHub('プロジェクトが削除されたか、参加していません。');
        }

        if (project.adminId !== memberId && !project.memberIds.includes(memberId)) {
            return this.redirectHub('プロジェクトが削除されたか、参加していません。');
        }

        return true;
    }

    private ensureTeamProjectAccess(projectId: string, memberId: string): boolean {
        const me = this.app.getMemberByEmail(this.auth.currentEmail());
        if (!me?.uid) {
            return this.ensureMemberAppSessionActive();
        }

        if (memberId !== me.uid) {
            window.alert('このページを開く権限がありません。');
            void this.router.navigate(['/landing']);
            return false;
        }

        const project = this.app.projects.find((p) => p.id === projectId);
        if (!project) {
            return this.redirectHub('プロジェクトが削除されたか、参加していません。');
        }

        if (!project.memberIds.includes(memberId) && project.adminId !== memberId) {
            return this.redirectHub('プロジェクトが削除されたか、参加していません。');
        }

        return true;
    }

    private redirectHub(message: string): boolean {
        window.alert(message);
        void this.router.navigate(['/landing']);
        return false;
    }

    private async logoutRemovedMember(): Promise<void> {
        if (this.logoutInFlight) return;
        this.logoutInFlight = true;
        window.alert('メンバー登録が解除されたため、ログアウトします。');
        try {
            await this.auth.logout();
        } finally {
            void this.router.navigate(['/top']);
            this.logoutInFlight = false;
        }
    }
}
