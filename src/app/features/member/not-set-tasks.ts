import { Component, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ParentTask, WorkingTaskState } from '../../core/interface';
import { MemberNavLinksComponent } from './member-nav-links';

@Component({
    selector: 'app-not-set-tasks',
    standalone: true,
    imports: [FormsModule, CommonModule, MemberNavLinksComponent],
    templateUrl: './not-set-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './not-set-tasks.css']
})
export class NotSetTasksComponent implements OnInit, OnDestroy {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    readonly memberId = this.route.snapshot.params['memberId'] as string;

    projectName = this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';

    parentTaskFilterId: string | 'all' = 'all';

    /** タスク id → 編集中の状態 */
    working: Record<string, WorkingTaskState> = {};

    rightMenuOpen = false;

    /** 一括確定処理中 */
    isSaving = false;

    ngOnInit(): void {
        this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, 'not-set');
        this.appService.clearMemberPageNotifications(this.projectId, this.memberId, 'not-set');
    }

    ngOnDestroy(): void {
        this.appService.setMemberCurrentNavPage(this.projectId, this.memberId, null);
    }

    get gearNotifyTotal(): number {
        void this.appService.notificationTick();
        return this.appService.getMemberGearNotificationTotal(this.projectId, this.memberId);
    }

    get memberDisplayName(): string {
        return this.appService.getMemberById(this.memberId)?.name ?? '';
    }

    /** 期限未設定（null / 空 / 無効日付） */
    static deadlineUnset(d: ParentTask['deadline']): boolean {
        if (d === null || d === undefined) return true;
        if (typeof d === 'string' && !String(d).trim()) return true;
        const t = new Date(d as Date | string);
        return Number.isNaN(t.getTime());
    }

    /** 一覧対象: 自分がリードまたはメンバーに含まれ、期限なし・「今日やる」未振り分けのもの */
    get eligibleParents(): ParentTask[] {
        return this.appService.parentTasks.filter(
            (t) =>
                t.projectId === this.projectId &&
                (t.leadAssigneeId === this.memberId || t.memberIds.includes(this.memberId)) &&
                NotSetTasksComponent.deadlineUnset(t.deadline) &&
                !t.isTodayTask
        );
    }

    /** リード本人なら true（編集UIの出し分け／確定の安全弁に使用） */
    isLead(task: ParentTask): boolean {
        return task.leadAssigneeId === this.memberId;
    }

    /** リード担当者の Member（未設定なら undefined） */
    leadMember(task: ParentTask) {
        return task.leadAssigneeId ? this.appService.getMemberById(task.leadAssigneeId) : undefined;
    }

    initials(name: string | undefined | null): string {
        const s = (name ?? '').trim();
        if (!s) return '';
        return s.slice(0, 2);
    }

    private sortEligibleParents(a: ParentTask, b: ParentTask): number {
        const pr = a.priority === '高' ? 0 : 1;
        const qr = b.priority === '高' ? 0 : 1;
        if (pr !== qr) return pr - qr;
        return (a.title || '').localeCompare(b.title || '', 'ja');
    }

    get parentTasksForFilter(): ParentTask[] {
        return [...this.eligibleParents].sort((a, b) => this.sortEligibleParents(a, b));
    }

    get visibleParents(): ParentTask[] {
        let list = this.eligibleParents;
        if (this.parentTaskFilterId !== 'all') {
            list = list.filter((t) => t.id === this.parentTaskFilterId);
        }
        return list.sort((a, b) => this.sortEligibleParents(a, b));
    }

    toggleToday(task: ParentTask): void {
        if (!this.working[task.id]) {
            this.working[task.id] = { isToday: false, deadlineInput: '' };
        }
        this.working[task.id].isToday = !this.working[task.id].isToday;
    }

    onDeadlineInput(task: ParentTask, value: string): void {
        if (!this.working[task.id]) {
            this.working[task.id] = { isToday: false, deadlineInput: '' };
        }
        this.working[task.id].deadlineInput = value;
    }

    /** 行に変更があるか（確定対象） */
    hasPendingChange(task: ParentTask): boolean {
        const w = this.working[task.id];
        if (!w) return false;
        const hasDate = !!w.deadlineInput?.trim();
        return w.isToday || hasDate;
    }

    /** 一覧内に確定対象が 1 件でもあるか（ボタンの活性判定） */
    get hasAnyPendingChange(): boolean {
        return this.eligibleParents.some((t) => this.hasPendingChange(t));
    }

//---------------------------------------修正版-------------------------------
    confirmAll(): void {
        const targets = this.eligibleParents.filter((t) => this.hasPendingChange(t));
        if (targets.length === 0) {
            alert('変更があるタスクがありません。');
            return;
        }
        this.isSaving = true;
        window.setTimeout(() => {
            try {
                for (const task of targets) {
                    const w = this.working[task.id];
                    if (!w) continue;
                    if (!this.isLead(task)) continue;
    
                    const hasDate = !!w.deadlineInput?.trim();
                    const today = w.isToday;

                    let finalDeadline: Date | null = null;

                    if (hasDate) {
                        // ユーザーが入力した期限がある場合
                        finalDeadline = new Date(w.deadlineInput);
                    } else if (today) {
                        // ★ここを合わせる！
                        // 期限未入力で「今日やる」がONなら、今日の23:59:59をセット
                        const end = new Date();
                        end.setHours(23, 59, 59, 999);
                        finalDeadline = end;
                    }
    
                    // 1. 親タスクの更新
                    this.appService.patchParentTask(
                        task.id,
                        {
                            isTodayTask: today,
                            deadline: finalDeadline
                        },
                        { actorMemberUid: this.memberId }
                    );

    
                    delete this.working[task.id];
                }
            } finally {
                this.isSaving = false;
            }
        }, 280);
    }

//---------------------------------------------------------------------------

    tooltipDescription(task: ParentTask): string {
        const d = (task.description || '').trim();
        return d ? d : '（備考なし）';
    }

    toggleRightMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.rightMenuOpen = !this.rightMenuOpen;
    }

    closeRightMenu(): void {
        this.rightMenuOpen = false;
    }

    scrollToTop(): void {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        this.rightMenuOpen = false;
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(ev: MouseEvent): void {
        if (!this.rightMenuOpen) return;
        const t = ev.target as HTMLElement;
        if (t.closest('.side-drawer') || t.closest('.icon-gear-wrap')) return;
        this.rightMenuOpen = false;
    }
}
