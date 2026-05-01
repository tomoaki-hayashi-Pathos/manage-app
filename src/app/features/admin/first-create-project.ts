import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AppService } from '../../app.service';

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

    projectName = '';
    /** 選択順。先頭 uid が Project.adminId 相当（管理者） */
    memberSelectionOrder: string[] = [];

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

    createProject(): void {
        if (!this.memberSelectionOrder.length) {
            alert('メンバーを1人以上選択してください');
            return;
        }
        const adminId = this.memberSelectionOrder[0];
        this.appService.createProject(this.projectName, adminId, [...this.memberSelectionOrder]);
    }
}
