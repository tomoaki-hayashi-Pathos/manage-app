import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
  selector: 'app-entry-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './entry-home.html',
  styleUrl: './entry-home.css'
})
export class EntryHomeComponent implements OnInit {
  readonly app = inject(AppService);
  readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);

  ngOnInit(): void {
    const id = window.setInterval(() => {
      if (!this.app.ready() || this.auth.loading()) return;
      const user = this.auth.user();
      const email = this.auth.currentEmail();
      // 未ログインのまま ready になっても、ここでタイマーを止めない（ログイン直後に遷移できる）
      if (!user || !email) return;

      window.clearInterval(id);
      const m = this.app.getMemberByEmail(email);
      if (!m) {
        void this.router.navigate(['/landing']);
        return;
      }
      void this.router.navigate(this.app.resolvePostLoginRoute(m.uid));
    }, 50);
  }

  async login(): Promise<void> {
    await this.auth.signInWithGoogle();
  }
}
