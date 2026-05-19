import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

/** 旧 URL `/admin/menu` 用。オーナー／メンバー／承認待ちへ振り分ける */
@Component({
  selector: 'app-admin-menu',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-menu.html',
  styleUrl: './admin-menu.css'
})
export class AdminMenuComponent implements OnInit {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

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

      window.clearInterval(id);
      const m = this.app.getMemberByEmail(email);
      if (!m) {
        void this.router.navigate(['/pending-approval']);
        return;
      }
      void this.router.navigate(this.app.resolvePostLoginRoute(m.uid));
    }, 50);
  }
}
