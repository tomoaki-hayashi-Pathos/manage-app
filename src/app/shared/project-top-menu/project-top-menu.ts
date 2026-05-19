import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import type { Member, PendingProjectJoin, Project } from '../../core/interface';

@Component({
    selector: 'app-project-top-menu',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './project-top-menu.html',
    styleUrl: './project-top-menu.css'
})
export class ProjectTopMenuComponent {
    readonly app = inject(AppService);
    readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);

    readonly currentProjectId = input('');
    readonly showApproveMembers = input(false);
    readonly showMemberEdit = input(false);

    createOpen = signal(false);
    createdSuccessOpen = signal(false);
    createdProjectId = '';
    createdWasPersonal = false;
    copyDone = signal(false);
    joinOpen = signal(false);
    approveOpen = signal(false);
    approveCopyDone = signal(false);
    guestInviteCopyDone = signal(false);
    memberEditOpen = signal(false);
    teamPickerOpen = signal(false);
    personalPickerOpen = signal(false);

    createName = '';
    createDescription = '';
    createIsPersonal = false;
    joinCode = '';
    teamPickId = '';
    personalPickId = '';
    approveSelected = new Set<string>();

    readonly me = computed(() => {
        void this.app.notificationTick();
        return this.app.getMemberByEmail(this.auth.currentEmail());
    });

    readonly teamProjects = computed(() => {
        void this.app.notificationTick();
        void this.app.projectsRev();
        const uid = this.me()?.uid;
        if (!uid) return [];
        return this.app.getTeamProjectsForMember(uid);
    });

    readonly personalProjects = computed(() => {
        void this.app.notificationTick();
        void this.app.projectsRev();
        const uid = this.me()?.uid;
        if (!uid) return [];
        return this.app.getPersonalProjectsForMember(uid);
    });

    readonly pendingForApprove = computed((): PendingProjectJoin[] => {
        const pid = this.currentProjectId();
        if (!pid || !this.showApproveMembers()) return [];
        void this.app.notificationTick();
        return this.app.getPendingProjectJoinsForProject(pid);
    });

    readonly unseenApprovedTeamCount = computed(() => {
        const uid = this.me()?.uid;
        if (!uid) return 0;
        void this.app.notificationTick();
        return this.app.getUnseenApprovedTeamProjectIds(uid).length;
    });

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
            return;
        }
        if (result === 'already_pending') {
            alert('承認待ちの申請があります。');
            return;
        }
        alert('参加申請を送信しました。責任者の承認をお待ちください。');
        this.joinOpen.set(false);
    }

    openTeamPicker(): void {
        const uid = this.me()?.uid;
        if (uid) this.app.clearUnseenApprovedTeamProjects(uid);
        const list = this.teamProjects();
        const current = this.currentProjectId();
        this.teamPickId =
            (current && list.some((p) => p.id === current) ? current : '') || list[0]?.id || '';
        this.teamPickerOpen.set(true);
    }

    pickTeam(project: Project): void {
        const uid = this.me()?.uid;
        if (!uid) return;
        this.teamPickerOpen.set(false);
        this.app.navigateToProject(project.id, uid);
    }

    openPersonalPicker(): void {
        const list = this.personalProjects();
        const current = this.currentProjectId();
        const currentProject = current ? this.app.projects.find((p) => p.id === current) : undefined;
        this.personalPickId =
            (current && currentProject?.isPersonal ? current : '') || list[0]?.id || '';
        this.personalPickerOpen.set(true);
    }

    pickPersonal(project: Project): void {
        const uid = this.me()?.uid;
        if (!uid) return;
        this.personalPickerOpen.set(false);
        this.app.navigateToProject(project.id, uid);
    }

    readonly showApproveInviteCode = computed(() => {
        const pid = this.currentProjectId();
        if (!pid) return false;
        const p = this.app.projects.find((x) => x.id === pid);
        return !!p && !p.isPersonal;
    });

    currentInviteCode(): string {
        const pid = this.currentProjectId();
        return pid ? AppService.projectInviteCode(pid) : '';
    }

    openApprove(): void {
        this.approveSelected = new Set();
        this.approveCopyDone.set(false);
        this.guestInviteCopyDone.set(false);
        this.approveOpen.set(true);
    }

    guestInviteCode(): string {
        const pid = this.currentProjectId();
        if (!pid) return '';
        void this.app.projectsRev();
        return this.app.guestInviteCodeForProject(pid);
    }

    issueGuestInviteCode(): void {
        const pid = this.currentProjectId();
        if (!pid) return;
        const code = this.app.ensureGuestInviteCode(pid);
        if (!code) {
            alert('ゲスト用コードを発行できませんでした。もう一度お試しください。');
            return;
        }
        this.guestInviteCopyDone.set(false);
    }

    async copyGuestInviteCode(): Promise<void> {
        const pid = this.currentProjectId();
        if (!pid) return;
        let code = this.app.guestInviteCodeForProject(pid);
        if (!code) {
            code = this.app.ensureGuestInviteCode(pid) ?? '';
        }
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
            this.guestInviteCopyDone.set(true);
        } catch {
            window.prompt('ゲスト用参加コードをコピーしてください', code);
        }
    }

    pendingJoinRoleLabel(p: PendingProjectJoin): string {
        return p.joinRole === 'guest' ? '（ゲスト・閲覧のみ）' : '';
    }

    async copyApproveInviteCode(): Promise<void> {
        const code = this.currentInviteCode();
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
            this.approveCopyDone.set(true);
        } catch {
            window.prompt('参加コードをコピーしてください', code);
        }
    }

    toggleApprove(uid: string, checked: boolean): void {
        if (checked) this.approveSelected.add(uid);
        else this.approveSelected.delete(uid);
    }

    submitApprove(): void {
        const pid = this.currentProjectId();
        if (!pid) return;
        this.app.approvePendingProjectJoins(pid, [...this.approveSelected]);
        this.approveOpen.set(false);
    }

    openMemberEdit(): void {
        this.memberEditOpen.set(true);
    }

    projectMembers(): Member[] {
        const pid = this.currentProjectId();
        if (!pid) return [];
        return this.app.getMembersByProjectId(pid);
    }

    removeFromProject(memberUid: string, name: string): void {
        const pid = this.currentProjectId();
        if (!pid) return;
        if (!confirm(`${name} をこのプロジェクトから外しますか？`)) return;
        this.app.removeMemberFromProject(pid, memberUid);
    }

    isProjectAdmin(memberUid: string): boolean {
        const pid = this.currentProjectId();
        if (!pid) return false;
        return this.app.getProjectAdminId(pid) === memberUid;
    }

    confirmTeamPick(): void {
        const p = this.teamProjects().find((proj) => proj.id === this.teamPickId);
        if (p) this.pickTeam(p);
    }

    confirmPersonalPick(): void {
        const p = this.personalProjects().find((proj) => proj.id === this.personalPickId);
        if (p) this.pickPersonal(p);
    }

    canDeleteTeamPick(): boolean {
        const uid = this.me()?.uid;
        return !!uid && !!this.teamPickId && this.app.isAdminProjectOwner(this.teamPickId, uid);
    }

    canDeletePersonalPick(): boolean {
        const uid = this.me()?.uid;
        return !!uid && !!this.personalPickId && this.app.isAdminProjectOwner(this.personalPickId, uid);
    }

    deleteSelectedTeamProject(): void {
        this.deleteProjectById(this.teamPickId, true);
    }

    deleteSelectedPersonalProject(): void {
        this.deleteProjectById(this.personalPickId, false);
    }

    goTrash(): void {
        const pid = this.currentProjectId();
        const uid = this.me()?.uid;
        if (!pid || !uid) return;
        if (AppService.isPersonalWorkspaceProjectId(pid) || this.app.projects.find((p) => p.id === pid)?.isPersonal) {
            void this.router.navigate(['/personal/trash-tasks']);
            return;
        }
        const adminId = this.app.getProjectAdminId(pid);
        if (adminId === uid) {
            void this.router.navigate(['/admin/trash-tasks', pid]);
            return;
        }
        void this.router.navigate(['/member/trash-tasks', pid, uid]);
    }

    private deleteProjectById(projectId: string, fromTeamPicker: boolean): void {
        const uid = this.me()?.uid;
        if (!uid || !projectId) return;
        if (!this.app.isAdminProjectOwner(projectId, uid)) {
            alert('このプロジェクトを削除する権限がありません。');
            return;
        }
        const name = this.app.projects.find((p) => p.id === projectId)?.name ?? 'プロジェクト';
        if (!confirm(`「${name}」と関連タスクをすべて削除します。よろしいですか？`)) return;
        const wasCurrent = this.currentProjectId() === projectId;
        this.app.deleteProject(projectId);
        if (fromTeamPicker) {
            this.teamPickerOpen.set(false);
            const list = this.teamProjects();
            this.teamPickId = list[0]?.id ?? '';
        } else {
            this.personalPickerOpen.set(false);
            const list = this.personalProjects();
            this.personalPickId = list[0]?.id ?? '';
        }
        if (wasCurrent) {
            void this.router.navigate(this.app.resolvePostLoginRoute(uid));
        }
    }
}
