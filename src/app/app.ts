import { Component, computed, inject, signal } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { AdminToastService } from './services/admin-toast.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('manage');
  private readonly router = inject(Router);
  readonly adminToast = inject(AdminToastService);

  /** ナビゲーションとトーストの両方で再評価される */
  private readonly urlPath = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url.split('?')[0]),
      startWith(this.router.url.split('?')[0])
    ),
    { initialValue: this.router.url.split('?')[0] }
  );

  /**
   * メンバー画面では非表示。トップ（/ /top）と /admin/** で表示（管理者がトップにいるときも見える）。
   */
  readonly adminToastBanner = computed(() => {
    const path = this.urlPath();
    const msg = this.adminToast.message();
    if (!msg) return null;
    if (path.startsWith('/member')) return null;
    const allow =
      path.startsWith('/admin') || path === '' || path === '/' || path.startsWith('/top');
    return allow ? msg : null;
  });
}
