import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AppService } from '../../app.service';
import { MemberNavPageKey } from '../../core/interface';

@Component({
    selector: 'app-member-nav-links',
    standalone: true,
    imports: [CommonModule, RouterLink],
    template: `
        @for (link of entries; track link.key) {
            <a [routerLink]="routeFor(link.key)" class="side-drawer__item side-drawer__item--with-badge" (click)="nav.emit()">
                @if (badgeCount(link.key) > 0) {
                    <span class="nav-notify-badge" aria-live="polite">{{ badgeCount(link.key) }}</span>
                }
                {{ link.label }}
            </a>
        }
        <a routerLink="/top" class="side-drawer__item" (click)="nav.emit()">トップへ戻る</a>
    `,
    styles: `
        :host {
            display: flex;
            flex-direction: column;
            gap: 0.65rem;
        }
        .side-drawer__item {
            display: block;
            text-align: center;
            text-decoration: none;
            border-radius: 14px;
            padding: 0.65rem 0.5rem;
            font-size: 0.78rem;
            font-weight: 700;
            color: #222;
            background: rgba(255, 255, 255, 0.55);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
            border: 1px solid rgba(255, 255, 255, 0.4);
            transition:
                background 0.15s,
                transform 0.1s;
        }
        .side-drawer__item:hover {
            background: rgba(255, 255, 255, 0.92);
        }
        .side-drawer__item--with-badge {
            position: relative;
            padding-left: 2.75rem;
        }
        .nav-notify-badge {
            position: absolute;
            left: 0.15rem;
            top: 50%;
            translate: 0 -50%;
            min-width: 1.35rem;
            height: 1.35rem;
            padding: 0 5px;
            border-radius: 999px;
            background: #e53935;
            color: #fff;
            font-size: 0.72rem;
            font-weight: 700;
            line-height: 1.35rem;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
            pointer-events: none;
        }
    `
})
export class MemberNavLinksComponent {
    readonly appService = inject(AppService);

    @Input({ required: true }) projectId!: string;
    @Input({ required: true }) memberId!: string;
    @Output() readonly nav = new EventEmitter<void>();

    readonly entries: { key: MemberNavPageKey; label: string }[] = [
        { key: 'limit', label: '担当するタスク一覧' },
        { key: 'today', label: '今日やること！' },
        { key: 'not-set', label: '期限が設定されてないタスク' },
        { key: 'completed', label: '完了したタスク' },
        { key: 'shared', label: '共有するタスク' }
    ];

    routeFor(page: MemberNavPageKey): string[] {
        const p = this.projectId;
        const m = this.memberId;
        switch (page) {
            case 'limit':
                return ['/member/limit-tasks', p, m];
            case 'today':
                return ['/member/today-tasks', p, m];
            case 'not-set':
                return ['/member/not-set-tasks', p, m];
            case 'completed':
                return ['/member/completed-tasks', p, m];
            case 'shared':
                return ['/member/shared-tasks', p, m];
        }
    }

    badgeCount(page: MemberNavPageKey): number {
        void this.appService.notificationTick();
        return this.appService.getMemberPageNotificationCount(this.projectId, this.memberId, page);
    }
}
