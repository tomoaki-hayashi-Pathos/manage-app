import { Injectable, NgZone, inject, signal } from '@angular/core';

const STORAGE_KEY = 'manage:adminToast:v1';

/**
 * 管理画面向けトースト。別タブのメンバー画面から localStorage で伝播する。
 */
@Injectable({ providedIn: 'root' })
export class AdminToastService {
  private readonly zone = inject(NgZone);
  readonly message = signal<string | null>(null);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', (ev: StorageEvent) => {
      if (ev.key !== STORAGE_KEY || ev.newValue == null) return;
      try {
        const data = JSON.parse(ev.newValue) as { text?: string };
        if (typeof data.text !== 'string' || !data.text.trim()) return;
        const t = data.text.trim();
        this.zone.run(() => this.showLocal(t));
      } catch {
        /* ignore */
      }
    });
  }

  show(text: string): void {
    const t = text.trim();
    if (!t) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: t, t: Date.now() }));
    } catch {
      /* quota / private mode */
    }
    this.showLocal(t);
  }

  private showLocal(text: string): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.message.set(text);
    this.hideTimer = setTimeout(() => {
      this.message.set(null);
      this.hideTimer = null;
    }, 6500);
  }
}
