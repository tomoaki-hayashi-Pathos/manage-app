import { Component, EventEmitter, inject, Output } from '@angular/core';
import { Router } from '@angular/router';
import { AuthSessionService } from '../../services/auth-session.service';

@Component({
    selector: 'app-drawer-logout',
    standalone: true,
    template: `
        <button type="button" class="side-drawer__item side-drawer__item--logout" (click)="onLogout()">ログアウト</button>
    `,
    styles: `
        .side-drawer__item--logout {
            margin-top: 0.35rem;
            background: rgba(229, 57, 53, 0.12);
            border-color: rgba(229, 57, 53, 0.35);
            color: #b71c1c;
        }
        .side-drawer__item--logout:hover {
            background: rgba(229, 57, 53, 0.2);
        }
    `
})
export class DrawerLogoutComponent {
    private readonly auth = inject(AuthSessionService);
    private readonly router = inject(Router);

    @Output() readonly nav = new EventEmitter<void>();

    async onLogout(): Promise<void> {
        this.nav.emit();
        await this.auth.logout();
        void this.router.navigate(['/top']);
    }
}
