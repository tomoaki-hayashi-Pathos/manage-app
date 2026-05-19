import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../app.service';
import { AuthSessionService } from './auth-session.service';

@Injectable({ providedIn: 'root' })
export class AdminProjectAccessService {
  private readonly app = inject(AppService);
  private readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  /**
   * @returns true if navigated away (forbidden). false if allowed or still waiting for project list.
   */
  redirectIfForbidden(projectId: string): boolean {
    if (!this.app.ready() || this.auth.loading()) return false;
    const project = this.app.projects.find((p) => p.id === projectId);
    if (!project) return false;
    const admin = this.app.getMemberByEmail(this.auth.currentEmail());
    if (admin && project.adminId === admin.uid) return false;
    void this.router.navigate(['/landing']);
    return true;
  }
}
