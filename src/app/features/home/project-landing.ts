import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
    selector: 'app-project-landing',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './project-landing.html',
    styleUrl: './project-landing.css'
})
export class ProjectLandingComponent implements OnInit, OnDestroy {
    readonly app = inject(AppService);
    readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);

    createOpen = signal(false);
    createdSuccessOpen = signal(false);
    joinOpen = signal(false);
    approvedModalOpen = signal(false);
    copyDone = signal(false);

    createName = '';
    createDescription = '';
    createIsPersonal = false;
    joinCode = '';
    createdProjectId = '';
    createdWasPersonal = false;

    private pollId: ReturnType<typeof window.setInterval> | null = null;
    private hadPendingJoin = false;
    private approvedProjectId: string | null = null;

    readonly me = computed(() => {
        void this.app.notificationTick();
        return this.app.getMemberByEmail(this.auth.currentEmail());
    });

    readonly pendingJoins = computed(() => {
        const uid = this.me()?.uid;
        if (!uid) return [];
        void this.app.notificationTick();
        return this.app.getMyPendingProjectJoins(uid);
    });

    readonly waitingApproval = computed(() => this.pendingJoins().length > 0);

    ngOnInit(): void {
        this.pollId = window.setInterval(() => this.tick(), 400);
    }

    ngOnDestroy(): void {
        if (this.pollId != null) window.clearInterval(this.pollId);
    }

    /** モーダル表示中は自動遷移しない（作成成功で招待コードを確認できるようにする） */
    private landingBlocksAutoNavigate(): boolean {
        return (
            this.createOpen() ||
            this.createdSuccessOpen() ||
            this.joinOpen() ||
            this.approvedModalOpen()
        );
    }

    private tick(): void {
        if (!this.app.ready() || this.auth.loading()) return;
        if (!this.auth.user()) {
            void this.router.navigate(['/top']);
            return;
        }
        const m = this.me();
        if (!m) return;

        if (this.landingBlocksAutoNavigate()) return;

        const pending = this.pendingJoins();
        if (pending.length > 0) {
            this.hadPendingJoin = true;
            return;
        }

        const accessible = this.app.getAccessibleProjectsForMember(m.uid);
        if (accessible.length > 0) {
            if (this.hadPendingJoin && !this.approvedModalOpen()) {
                this.approvedProjectId = accessible[0]?.id ?? null;
                this.approvedModalOpen.set(true);
                this.hadPendingJoin = false;
                return;
            }
            if (!this.hadPendingJoin && !this.approvedModalOpen()) {
                void this.router.navigate(this.app.resolvePostLoginRoute(m.uid));
            }
            return;
        }

        this.hadPendingJoin = pending.length > 0;
    }

    openCreate(): void {
        this.createName = '';
        this.createDescription = '';
        this.createIsPersonal = false;
        this.createOpen.set(true);
    }

    submitCreate(): void {
        const uid = this.me()?.uid;
        if (!uid) return;
        const isPersonal = this.createIsPersonal;
        const id = this.app.createProject(
            this.createName,
            uid,
            [uid],
            isPersonal,
            this.createDescription,
            { navigate: false }
        );
        if (!id) return;
        this.app.setLastOpenedProject(uid, id);
        this.app.projectId = id;
        this.createdProjectId = id;
        this.createdWasPersonal = isPersonal;
        this.createOpen.set(false);
        this.createdSuccessOpen.set(true);
        this.copyDone.set(false);
    }

    createdInviteCode(): string {
        return AppService.projectInviteCode(this.createdProjectId);
    }

    async copyInviteCode(): Promise<void> {
        const code = this.createdInviteCode();
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
            this.copyDone.set(true);
        } catch {
            window.prompt('参加コードをコピーしてください', code);
        }
    }

    closeCreatedSuccess(): void {
        this.createdSuccessOpen.set(false);
        const uid = this.me()?.uid;
        if (uid && this.createdProjectId) {
            this.app.navigateToProject(this.createdProjectId, uid);
        }
        this.createdProjectId = '';
    }

    openJoin(): void {
        this.joinCode = '';
        this.joinOpen.set(true);
    }

    submitJoin(): void {
        const m = this.me();
        if (!m) return;
        const result = this.app.requestJoinProjectByInviteCode(this.joinCode, {
            uid: m.uid,
            email: m.email,
            name: m.name
        });
        if (result === 'not_found') {
            alert('参加コードが見つかりません。');
            return;
        }
        if (result === 'personal') {
            alert('個人プロジェクトには参加コードで参加できません。');
            return;
        }
        if (result === 'already_member') {
            alert('すでにこのプロジェクトのメンバーです。');
            this.joinOpen.set(false);
            void this.router.navigate(this.app.resolvePostLoginRoute(m.uid));
            return;
        }
        if (result === 'already_pending') {
            alert('承認待ちの申請があります。');
            return;
        }
        this.hadPendingJoin = true;
        this.joinOpen.set(false);
    }

    dismissApprovedModal(): void {
        const m = this.me();
        const pid = this.approvedProjectId;
        this.approvedModalOpen.set(false);
        this.approvedProjectId = null;
        if (m && pid) {
            this.app.navigateToProject(pid, m.uid);
        } else if (m) {
            void this.router.navigate(this.app.resolvePostLoginRoute(m.uid));
        }
    }

    projectNameForJoin(p: { projectId: string }): string {
        return this.app.projects.find((proj) => proj.id === p.projectId)?.name ?? 'プロジェクト';
    }

    async logout(): Promise<void> {
        await this.auth.logout();
        void this.router.navigate(['/top']);
    }
}
