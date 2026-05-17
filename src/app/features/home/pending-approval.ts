import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
  selector: 'app-pending-approval',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pending-approval.html',
  styleUrl: './entry-home.css'
})
export class PendingApprovalComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthSessionService);
  readonly app = inject(AppService);
  private readonly router = inject(Router);

  private pollId: ReturnType<typeof window.setInterval> | null = null;

  ngOnInit(): void {
    this.pollId = window.setInterval(() => {
      if (!this.app.ready() || this.auth.loading()) return;

      if (!this.auth.user()) {
        window.clearInterval(this.pollId!);
        this.pollId = null;
        void this.router.navigate(['/top']);
        return;
      }

      const email = this.auth.currentEmail();
      if (!email) {
        window.clearInterval(this.pollId!);
        this.pollId = null;
        void this.router.navigate(['/top']);
        return;
      }

      const emailNorm = email.trim().toLowerCase();
      const m = this.app.getMemberByEmail(email);
      const stillPending = this.app.pendingLoginMembers.some(
        (p) => p.email.trim().toLowerCase() === emailNorm
      );
      if (!m || stillPending) return;

      window.clearInterval(this.pollId!);
      this.pollId = null;
      if (this.app.isAppOwner(m.uid)) void this.router.navigate(['/owner/menu']);
      else void this.router.navigate(['/member/hub']);
    }, 50);
  }

  ngOnDestroy(): void {
    if (this.pollId != null) {
      window.clearInterval(this.pollId);
      this.pollId = null;
    }
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/top']);
  }
}
