import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
    selector: 'app-create-member',
    standalone: true,
    imports: [FormsModule],
    templateUrl: './create-member.html',
    styleUrls: ['./create-member.css']
})
export class CreateMemberComponent implements OnInit {
    readonly appService = inject(AppService);
    private readonly router = inject(Router);
    private readonly auth = inject(AuthSessionService);

    readonly role = 'メンバー' as const;
    selectedPendingEmails: string[] = [];

    ngOnInit(): void {
        const id = window.setInterval(() => {
            if (!this.appService.ready() || this.auth.loading()) return;
            const user = this.auth.user();
            const email = this.auth.currentEmail();
            if (!user || !email) return;

            window.clearInterval(id);
            const me = this.appService.getMemberByEmail(email);
            if (!me) {
                void this.router.navigate(['/pending-approval']);
                return;
            }
            if (!this.appService.isAppOwner(me.uid)) void this.router.navigate(['/landing']);
        }, 50);
    }

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

    goOwnerMenu(): void {
        void this.router.navigate(['/owner/menu']);
    }
}
