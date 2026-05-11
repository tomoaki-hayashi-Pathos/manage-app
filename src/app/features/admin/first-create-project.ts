import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

/** 登録メンバーを「チェックした順」に保持。先頭を adminId として project.memberIds に渡す。 */
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
    /** 選択順。先頭 uid が Project.adminId 相当（管理者） */
    memberSelectionOrder: string[] = [];
    readonly newProjectOptionValue = '__new__';

    get selectableMembers() {
        return this.appService.members.filter((m) => m.role !== '管理者');
    }

    get currentAdminId(): string {
        return this.appService.getMemberByEmail(this.auth.currentEmail())?.uid ?? '';
    }

    get ownedProjects() {
        return this.appService.getAdminOwnedProjects(this.currentAdminId);
    }

    isSelected(uid: string): boolean {
        return this.memberSelectionOrder.includes(uid);
    }

    onMemberCheckboxChange(uid: string, checked: boolean): void {
        if (checked) {
            if (!this.memberSelectionOrder.includes(uid)) {
                this.memberSelectionOrder.push(uid);
            }
        } else {
            this.memberSelectionOrder = this.memberSelectionOrder.filter((id) => id !== uid);
        }
    }

   /**  onProjectSelect(projectId: string): void {
        if (projectId === this.newProjectOptionValue) {
            this.selectedExistingProjectId = '';
            this.projectName = '';
            this.memberSelectionOrder = [];
            return;
        }
        this.selectedExistingProjectId = projectId;
        if (!projectId) return;
        const p = this.appService.projects.find((x) => x.id === projectId);
        if (!p) return;
        this.projectName = p.name;
        this.memberSelectionOrder = [...p.memberIds];
    }*/

        onProjectSelect(projectId: string): void {
            // 1. まず選ばれた値を代入する（これをしないと @if が反応しない）
            this.selectedExistingProjectId = projectId;
        
            if (projectId === this.newProjectOptionValue) {
                // 新規作成モード：名前などを空にするが、projectId は '__new__' のまま維持
                this.projectName = '';
                this.memberSelectionOrder = [];
                return;
            }
        
            if (!projectId) {
                this.projectName = '';
                this.memberSelectionOrder = [];
                return;
            }
        
            // 既存プロジェクトの読み込み処理
            const p = this.ownedProjects.find((x) => x.id === projectId);
            if (!p) return;
            this.projectName = p.name;
            this.memberSelectionOrder = [...p.memberIds];
        }

    createProject(): void {
        if (!this.selectedExistingProjectId) {
            alert('プロジェクトを選択してください');
            return;
        }
        const adminId = this.currentAdminId;
        if (!adminId) {
            alert('管理者としてログインしてください');
            return;
        }
        if (!this.memberSelectionOrder.length) {
            alert('メンバーを1人以上選択してください');
            return;
        }
        if (this.selectedExistingProjectId !== this.newProjectOptionValue) {
            if (!this.appService.isAdminProjectOwner(this.selectedExistingProjectId, adminId)) {
                alert('このプロジェクトを編集する権限がありません');
                return;
            }
            this.appService.updateProject(this.selectedExistingProjectId, this.projectName, adminId, [...this.memberSelectionOrder]);
            alert('プロジェクトを更新しました');
            return;
        }
        this.appService.createProject(this.projectName, adminId, [...this.memberSelectionOrder]);
    }
}
