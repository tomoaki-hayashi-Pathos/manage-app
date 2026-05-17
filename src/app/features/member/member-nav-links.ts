import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AppService } from '../../app.service';
import { MemberNavPageKey } from '../../core/interface';

type NavLinkKey = MemberNavPageKey | 'summary';

@Component({
    selector: 'app-member-nav-links',
    standalone: true,
    imports: [CommonModule, RouterLink],
    template: `
        @for (link of filteredDisplayEntries; track link.key) {
            <a [routerLink]="routeFor(link.key)" class="side-drawer__item side-drawer__item--with-badge" (click)="nav.emit()">
                @if (badgeCountSafe(link.key) > 0) {
                    <span class="nav-notify-badge" aria-live="polite">{{ badgeCountSafe(link.key) }}</span>
                }
                {{ link.label }}
            </a>
        }
        @if (navMode === 'adminSelf') {
            <a [routerLink]="['/admin/manage-tasks', projectId]" class="side-drawer__item side-drawer__item--back-manage" (click)="nav.emit()">親タスク管理に戻る</a>
        }
        <a routerLink="/member/hub" class="side-drawer__item side-drawer__item--back-hub" (click)="nav.emit()">メンバーページに戻る</a>
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
        .side-drawer__item--back-hub {
            background: #aed581;
            border-color: rgba(104, 159, 56, 0.55);
            color: #1a1a1a;
        }
        .side-drawer__item--back-hub:hover {
            background: #c5e1a5;
        }
        .side-drawer__item--back-manage {
            background: #ffb74d;
            border-color: rgba(255, 152, 0, 0.55);
            color: #1a1a1a;
        }
        .side-drawer__item--back-manage:hover {
            background: #ffcc80;
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
    /** 既定: チームのメンバー画面。adminSelf / personal でリンク先とラベルを切替 */
    @Input() navMode: 'member' | 'adminSelf' | 'personal' = 'member';
    /** 個人モードで「進捗サマリー」リンクを出さない（進捗サマリー画面自身用） */
    @Input() personalOmitSummaryLink = false;
    /** 今開いているページに対応するナビ項目を出さない */
    @Input() currentNavKey: NavLinkKey | null = null;
    @Output() readonly nav = new EventEmitter<void>();

    private readonly teamEntries: { key: MemberNavPageKey; label: string }[] = [
        { key: 'limit', label: '担当するタスク一覧' },
        { key: 'today', label: '今日やること！' },
        { key: 'not-set', label: '期限が設定されてないタスク' },
        { key: 'completed', label: '完了したタスク' },
        { key: 'shared', label: '共有するタスク' }
    ];

    private readonly personalEntries: { key: NavLinkKey; label: string }[] = [
        { key: 'limit', label: 'MYタスク一覧' },
        { key: 'today', label: '今日やること' },
        { key: 'not-set', label: '期限が設定されていないタスク一覧' },
        { key: 'completed', label: '完了したタスク' },
        { key: 'summary', label: '進捗サマリー' }
    ];

    get displayEntries(): { key: NavLinkKey; label: string }[] {
        if (this.navMode === 'personal') {
            return this.personalOmitSummaryLink ? this.personalEntries.filter((e) => e.key !== 'summary') : this.personalEntries;
        }
        return this.teamEntries;
    }

    get filteredDisplayEntries(): { key: NavLinkKey; label: string }[] {
        const omit = this.currentNavKey;
        if (!omit) return this.displayEntries;
        return this.displayEntries.filter((e) => e.key !== omit);
    }

    private pageSegment(page: MemberNavPageKey): string {
        switch (page) {
            case 'limit':
                return 'limit-tasks';
            case 'today':
                return 'today-tasks';
            case 'not-set':
                return 'not-set-tasks';
            case 'completed':
                return 'completed-tasks';
            case 'shared':
                return 'shared-tasks';
        }
    }

    routeFor(page: NavLinkKey): string[] {
        if (page === 'summary') {
            return ['/personal/summary'];
        }
        const p = this.projectId;
        const m = this.memberId;
        const seg = this.pageSegment(page);
        if (this.navMode === 'adminSelf') {
            return ['/admin/my-tasks', p, m, seg];
        }
        if (this.navMode === 'personal') {
            return ['/personal', seg];
        }
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

    badgeCountSafe(key: NavLinkKey): number {
        if (key === 'summary') return 0;
        return this.badgeCount(key);
    }
}
