import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../app.service';
import { AuthSessionService } from './auth-session.service';

@Injectable({ providedIn: 'root' })
export class AdminProjectAccessService {
  private readonly app = inject(AppService);
  private readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  redirectIfForbidden(projectId: string): boolean {
    if (!this.app.ready() || this.auth.loading()) return false;
    this.app.notificationTick();
    const admin = this.app.getMemberByEmail(this.auth.currentEmail());
    const allowed = !!admin && this.app.getProjectAdminId(projectId) === admin.uid;
    if (allowed) return false;
    void this.router.navigate(['/member/hub']);
    return true;
  }
}
