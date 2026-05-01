import { Component, HostListener, inject } from '@angular/core';
import { AppService } from '../../app.service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ParentTask, WorkingTaskState } from '../../core/interface';

@Component({
    selector: 'app-not-set-tasks',
    standalone: true,
    imports: [FormsModule, CommonModule, RouterLink],
    templateUrl: './not-set-tasks.html',
    styleUrls: ['../admin/Manage-tasks.css', './limit-tasks.css', './not-set-tasks.css']
})
export class NotSetTasksComponent {
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

    /** 一覧対象: 自分が担当かつ期限なしかつ「今日やる」のみ未整理（isTodayTask で今日ページへ振り分け済みは除外） */
    get eligibleParents(): ParentTask[] {
        return this.appService.parentTasks.filter(
            (t) =>
                t.projectId === this.projectId &&
                t.leadAssigneeId === this.memberId &&
                NotSetTasksComponent.deadlineUnset(t.deadline) &&
                !t.isTodayTask
        );
    }

    get parentTasksForFilter(): ParentTask[] {
        return [...this.eligibleParents].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
    }

    get visibleParents(): ParentTask[] {
        let list = this.eligibleParents;
        if (this.parentTaskFilterId !== 'all') {
            list = list.filter((t) => t.id === this.parentTaskFilterId);
        }
        return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
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
                    this.appService.patchParentTask(task.id, {
                        isTodayTask: today,
                        deadline: finalDeadline
                    });

    
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
