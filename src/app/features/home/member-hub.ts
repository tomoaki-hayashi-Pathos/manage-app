import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
  selector: 'app-member-hub',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './member-hub.html',
  styleUrl: './entry-home.css'
})
export class MemberHubComponent implements OnInit {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  memberProjectId = '';
  projectPickerOpen = false;

  readonly me = computed(() => {
    this.app.notificationTick();
    return this.app.getMemberByEmail(this.auth.currentEmail());
  });

  readonly assignedProjects = computed(() => {
    this.app.notificationTick();
    const uid = this.me()?.uid;
    if (!uid) return [];
    return this.app.projects.filter((p) => p.memberIds.includes(uid));
  });

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

      window.clearInterval(id);
    }, 50);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigate(['/top']);
  }

  openProjectPicker(): void {
    this.projectPickerOpen = true;
  }

  goProjectCreateEdit(): void {
    void this.router.navigate(['/admin/create-project']);
  }

  goOwnerMenu(): void {
    void this.router.navigate(['/owner/menu']);
  }

  openMemberProject(): void {
    const mid = this.me()?.uid;
    if (!mid || !this.memberProjectId) return;
    const p = this.app.projects.find((x) => x.id === this.memberProjectId);
    if (p?.isPersonal && p.memberIds.includes(mid)) {
      this.app.projectId = this.memberProjectId;
      void this.router.navigate(['/personal/today-tasks']);
      return;
    }
    const adminId = this.app.getProjectAdminId(this.memberProjectId);
    if (adminId === mid) {
      void this.router.navigate(['/admin/manage-tasks', this.memberProjectId]);
      return;
    }
    void this.router.navigate(['/member/limit-tasks', this.memberProjectId, mid]);
  }
}
