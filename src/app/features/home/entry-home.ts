import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
  selector: 'app-entry-home',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './entry-home.html',
  styleUrl: './entry-home.css'
})
export class EntryHomeComponent {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  memberProjectId = '';

  readonly me = computed(() => {
    this.app.notificationTick();
    return this.app.getMemberByEmail(this.auth.currentEmail());
  });
  readonly isApproved = computed(() => !!this.me());
  readonly isAdmin = computed(() => this.me()?.role === '管理者');
  readonly assignedProjects = computed(() => {
    this.app.notificationTick();
    const uid = this.me()?.uid;
    if (!uid) return [];
    return this.app.projects.filter((p) => p.memberIds.includes(uid));
  });

  private readonly adminRedirectEffect = effect(() => {
    if (!this.app.ready() || this.auth.loading()) return;
    if (this.me()?.role !== '管理者') return;
    void this.router.navigate(['/admin/menu']);
  });

  async login(): Promise<void> {
    await this.auth.signInWithGoogle();
  }

  async logout(): Promise<void> {
    await this.auth.logout();
  }

  goProjectCreateEdit(): void {
    void this.router.navigate(['/admin/create-project']);
  }

  goProjectApproval(): void {
    void this.router.navigate(['/admin/create-member']);
  }

  openMemberProject(): void {
    const mid = this.me()?.uid;
    if (!mid || !this.memberProjectId) return;
    void this.router.navigate(['/member/today-tasks', this.memberProjectId, mid]);
  }
}
