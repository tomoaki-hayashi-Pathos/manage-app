import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import { ProgressReportingService } from '../../services/progress-reporting.service';

@Component({
  selector: 'app-admin-menu',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-menu.html',
  styleUrl: './admin-menu.css'
})
export class AdminMenuComponent {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);
  private readonly progress = inject(ProgressReportingService);

  adminProjectId = '';
  removeMemberUid = '';
  removeProjectId = '';

  readonly me = computed(() => {
    this.app.notificationTick();
    return this.app.getMemberByEmail(this.auth.currentEmail());
  });

  readonly ownedProjects = computed(() => {
    this.app.notificationTick();
    const uid = this.me()?.uid;
    return uid ? this.app.getAdminOwnedProjects(uid) : [];
  });

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/top']);
  }

  goProjectCreateEdit(): void {
    void this.router.navigate(['/admin/create-project']);
  }

  goProjectApproval(): void {
    void this.router.navigate(['/admin/create-member']);
  }

  openAdminProject(): void {
    if (!this.adminProjectId) return;
    void this.router.navigate(['/admin/manage-tasks', this.adminProjectId]);
  }

  removeMember(): void {
    if (!this.removeMemberUid) return;
    if (!confirm('メンバーを削除しますか？')) return;
    this.app.removeMemberByUid(this.removeMemberUid);
    this.removeMemberUid = '';
  }

  removeProject(): void {
    if (!this.removeProjectId) return;
    const p = this.ownedProjects().find((x) => x.id === this.removeProjectId);
    if (!p) return;
    if (!confirm(`プロジェクト「${p.name}」を削除しますか？\n関連するタスク・進捗データは失われます。`)) return;
    const deletedId = p.id;
    this.app.deleteProject(deletedId);
    this.progress.purgeProjectProgress(deletedId);
    this.removeProjectId = '';
    if (this.adminProjectId === deletedId) {
      this.adminProjectId = '';
    }
  }
}
