import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import { Project } from '../../core/interface';

/** チーム: チェック順の先頭が adminId。個人: メンバー選択なし（自分のみ） */
@Component({
    selector: 'app-create-project',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink],
    templateUrl: './first-create-project.html',
    styleUrls: ['./first-create-project.css']
})
export class CreateProjectComponent {
    readonly appService = inject(AppService);
    readonly auth = inject(AuthSessionService);

    projectName = '';
    selectedExistingProjectId = '';
    /** 選択順。先頭 uid が Project.adminId（責任者）。個人プロジェクトでは [adminId] のみ */
    memberSelectionOrder: string[] = [];
    readonly newProjectOptionValue = '__new__';
    readonly newPersonalProjectOptionValue = '__new_personal__';

    get selectableMembers() {
        return this.appService.members;
    }

    get currentAdminId(): string {
        return this.appService.getMemberByEmail(this.auth.currentEmail())?.uid ?? '';
    }

    get ownedProjects(): Project[] {
        return this.appService.getAdminOwnedProjects(this.currentAdminId);
    }

    get selectedProjectForEdit(): Project | undefined {
        const id = this.selectedExistingProjectId;
        if (!id || id === this.newProjectOptionValue || id === this.newPersonalProjectOptionValue) return undefined;
        return this.appService.projects.find((x) => x.id === id);
    }

    /** 参加メンバー UI を出さない（個人新規・個人既存編集） */
    get hideMemberPicker(): boolean {
        if (this.isNewPersonalProjectMode) return true;
        return this.isExistingProjectMode && !!this.selectedProjectForEdit?.isPersonal;
    }

    get projectLeadUid(): string {
        return this.memberSelectionOrder[0] ?? '';
    }

    get formLocked(): boolean {
        const id = this.selectedExistingProjectId;
        if (!id || id === this.newProjectOptionValue || id === this.newPersonalProjectOptionValue) return false;
        return !this.appService.isAdminProjectOwner(id, this.currentAdminId);
    }

    get isNewProjectMode(): boolean {
        return this.selectedExistingProjectId === this.newProjectOptionValue;
    }

    get isNewPersonalProjectMode(): boolean {
        return this.selectedExistingProjectId === this.newPersonalProjectOptionValue;
    }

    get isExistingProjectMode(): boolean {
        return (
            !!this.selectedExistingProjectId &&
            this.selectedExistingProjectId !== this.newProjectOptionValue &&
            this.selectedExistingProjectId !== this.newPersonalProjectOptionValue
        );
    }

    get primaryButtonLabel(): string {
        if (this.isNewPersonalProjectMode) return '個人プロジェクト作成';
        if (this.isNewProjectMode) return 'プロジェクト作成';
        if (this.isExistingProjectMode) return 'プロジェクト編集';
        return 'プロジェクトを選択してください';
    }

    get canSubmitPrimary(): boolean {
        if (!this.selectedExistingProjectId || this.formLocked) return false;
        if (this.isNewPersonalProjectMode) {
            return !!this.projectName?.trim() && !!this.currentAdminId;
        }
        if (this.isNewProjectMode || this.isExistingProjectMode) {
            return this.memberSelectionOrder.length > 0 && !!this.projectName?.trim();
        }
        return false;
    }

    get showDeleteProject(): boolean {
        return this.isExistingProjectMode && !this.formLocked;
    }

    projectOptionLabel(p: Project): string {
        return p.isPersonal ? `${p.name}（個人）` : p.name;
    }

    isSelected(uid: string): boolean {
        return this.memberSelectionOrder.includes(uid);
    }

    onMemberCheckboxChange(uid: string, checked: boolean): void {
        if (this.formLocked) return;
        if (checked) {
            if (!this.memberSelectionOrder.includes(uid)) {
                this.memberSelectionOrder.push(uid);
            }
        } else {
            this.memberSelectionOrder = this.memberSelectionOrder.filter((id) => id !== uid);
        }
    }

    onProjectSelect(projectId: string): void {
        this.selectedExistingProjectId = projectId;

        if (projectId === this.newProjectOptionValue || projectId === this.newPersonalProjectOptionValue) {
            this.projectName = '';
            this.memberSelectionOrder = [];
            return;
        }

        if (!projectId) {
            this.projectName = '';
            this.memberSelectionOrder = [];
            return;
        }

        const p = this.ownedProjects.find((x) => x.id === projectId);
        if (!p) return;
        this.projectName = p.name;
        if (p.isPersonal) {
            this.memberSelectionOrder = [p.adminId];
        } else {
            this.memberSelectionOrder = [p.adminId, ...p.memberIds.filter((id) => id !== p.adminId)];
        }
    }

    submitProject(): void {
        if (!this.selectedExistingProjectId) {
            alert('プロジェクトを選択してください');
            return;
        }
        if (this.formLocked) {
            alert('このプロジェクトを編集できるのは責任者のみです');
            return;
        }
        if (!this.projectName?.trim()) {
            alert('プロジェクト名を入力してください');
            return;
        }

        if (this.isNewPersonalProjectMode) {
            const uid = this.currentAdminId;
            if (!uid) {
                alert('ログイン情報を確認してください');
                return;
            }
            this.appService.createProject(this.projectName.trim(), uid, [uid], true);
            return;
        }

        if (this.isExistingProjectMode) {
            if (!this.appService.isAdminProjectOwner(this.selectedExistingProjectId, this.currentAdminId)) {
                alert('このプロジェクトを編集する権限がありません');
                return;
            }
            const leadUid = this.memberSelectionOrder[0];
            if (!leadUid) {
                alert('メンバーを1人以上選択してください');
                return;
            }
            const memberIds = this.selectedProjectForEdit?.isPersonal ? [leadUid] : [...this.memberSelectionOrder];
            this.appService.updateProject(this.selectedExistingProjectId, this.projectName.trim(), leadUid, memberIds);
            alert('プロジェクトを更新しました');
            return;
        }

        const leadUid = this.memberSelectionOrder[0];
        if (!leadUid) {
            alert('メンバーを1人以上選択してください');
            return;
        }
        this.appService.createProject(this.projectName.trim(), leadUid, [...this.memberSelectionOrder], false);
    }

    confirmDeleteProject(): void {
        const id = this.selectedExistingProjectId;
        if (!this.isExistingProjectMode || this.formLocked) return;
        if (!this.appService.isAdminProjectOwner(id, this.currentAdminId)) {
            alert('このプロジェクトを削除する権限がありません');
            return;
        }
        if (!confirm('このプロジェクトを削除しますか？関連タスクもすべて削除されます。')) return;
        this.appService.deleteProject(id);
        this.onProjectSelect('');
    }
}
