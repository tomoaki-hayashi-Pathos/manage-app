import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Auth, GoogleAuthProvider, User, onAuthStateChanged, signInWithPopup, signOut } from '@angular/fire/auth';
import { AppService } from '../app.service';

// signInWithPopup の代わりに signInWithRedirect を使う
import { signInWithRedirect } from '@angular/fire/auth';

@Injectable({ providedIn: 'root' })
export class AuthSessionService {
  private readonly auth = inject(Auth);
  private readonly app = inject(AppService);
  private readonly zone = inject(NgZone);

  readonly user = signal<User | null>(null);
  readonly loading = signal(true);

  constructor() {
    onAuthStateChanged(this.auth, (u) => {
      this.zone.run(() => {
        this.user.set(u);
        this.loading.set(false);
        if (!u?.email) return;
        this.app.upsertPendingLoginMember({
          uid: u.uid,
          name: u.displayName || u.email,
          email: u.email,
          photoURL: u.photoURL || ''
        });
      });
    }, () => {
      this.zone.run(() => this.loading.set(false));
    });
  }

  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    // ログイン時に必ずアカウント選択画面を出す設定
    provider.setCustomParameters({ prompt: 'select_account' });
    //await signInWithPopup(this.auth, new GoogleAuthProvider());
    try {
      await signInWithPopup(this.auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  }

  async logout(): Promise<void> {
    await signOut(this.auth);
  }

  currentEmail(): string | null {
    return this.user()?.email ?? null;
  }
}
