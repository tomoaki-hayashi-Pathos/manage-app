import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
  selector: 'app-owner-menu',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './owner-menu.html',
  styleUrl: './admin-menu.css'
})
export class OwnerMenuComponent implements OnInit {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  readonly me = computed(() => {
    this.app.notificationTick();
    return this.app.getMemberByEmail(this.auth.currentEmail());
  });

  readonly membersList = computed(() => {
    this.app.notificationTick();
    return [...this.app.members];
  });

  readonly headMembers = computed(() => this.membersList().slice(0, 2));

  readonly tailMembers = computed(() => this.membersList().slice(2));

  ngOnInit(): void {
    const id = window.setInterval(() => {
      if (!this.app.ready() || this.auth.loading()) return;

      if (!this.auth.user()) {
        window.clearInterval(id);
        void this.router.navigate(['/top']);
        return;
      }
      const email = this.auth.currentEmail();
      if (!email) {
        window.clearInterval(id);
        void this.router.navigate(['/top']);
        return;
      }

      const m = this.app.getMemberByEmail(email);
      if (!m) {
        window.clearInterval(id);
        void this.router.navigate(['/pending-approval']);
        return;
      }
      if (!this.app.isAppOwner(m.uid)) {
        window.clearInterval(id);
        void this.router.navigate(['/member/hub']);
        return;
      }

      window.clearInterval(id);
    }, 50);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/top']);
  }

  goApprove(): void {
    void this.router.navigate(['/owner/approve-members']);
  }

  goMemberHub(): void {
    void this.router.navigate(['/member/hub']);
  }

  isRowOwner(uid: string): boolean {
    return this.app.isAppOwner(uid);
  }

  makeOwner(uid: string): void {
    if (!confirm('このメンバーをオーナーにしますか？（あなたはメンバーになります）')) return;
    this.app.transferAppOwnership(uid);
  }

  removeMember(uid: string, name: string): void {
    if (!confirm(`${name} をアプリから削除しますか？`)) return;
    this.app.removeMemberByUid(uid);
  }

  resetApp(): void {
    if (!confirm('プロジェクト・タスク・承認待ちをすべて消去し、オーナー（あなた）だけ残します。よろしいですか？')) return;
    this.app.resetAppWorkspaceForOwner();
    alert('リセットしました。');
    void this.router.navigate(['/member/hub']);
  }
}
