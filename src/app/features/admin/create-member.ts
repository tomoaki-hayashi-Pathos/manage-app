import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { AppService } from '../../app.service';
import { Member } from '../../core/interface';

@Component({
    selector: 'app-create-member',
    standalone: true,
    imports: [FormsModule, RouterLink],
    templateUrl: './create-member.html',
    styleUrls: ['./create-member.css']
})
export class CreateMemberComponent {
    readonly appService = inject(AppService);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    role: Member['role'] = 'メンバー';
    readonly roleOptions: Member['role'][] = ['管理者', 'メンバー'];
    selectedPendingEmails: string[] = [];
    projectId = this.route.snapshot.paramMap.get('projectId') as string;

    isChecked(email: string): boolean {
        return this.selectedPendingEmails.includes(email);
    }

    onPendingChange(email: string, checked: boolean): void {
        if (checked) {
            if (!this.selectedPendingEmails.includes(email)) this.selectedPendingEmails.push(email);
            return;
        }
        this.selectedPendingEmails = this.selectedPendingEmails.filter((x) => x !== email);
    }

    approveSelected(): void {
        if (!this.selectedPendingEmails.length) {
            alert('承認するメンバーを選択してください');
            return;
        }
        this.appService.approvePendingMembers(this.selectedPendingEmails, this.role);
        this.selectedPendingEmails = [];
        alert('承認が完了しました');
    }

    goTop(): void {
        void this.router.navigate(['/top']);
    }
}
