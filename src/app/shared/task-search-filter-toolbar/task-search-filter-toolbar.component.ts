import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Member, ParentTask } from '../../core/interface';
import {
    defaultToolbarFilterState,
    type TaskToolbarFilterMode,
    type TaskToolbarFilterState
} from './task-search-filter.util';

export type ParentListSortPick = 'deadline' | 'status';

export type TaskListScopeMode = 'involved' | 'all';

@Component({
    selector: 'app-task-search-filter-toolbar',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './task-search-filter-toolbar.component.html',
    styleUrl: './task-search-filter-toolbar.component.css'
})
export class TaskSearchFilterToolbarComponent {
    @Input({ required: true }) filter!: TaskToolbarFilterState;
    @Output() readonly filterChange = new EventEmitter<TaskToolbarFilterState>();

    @Input({ required: true }) members!: Member[];
    @Input({ required: true }) candidateParents!: ParentTask[];
    @Input() filterMode: TaskToolbarFilterMode = 'manage';
    /** limit / today: ヘッダー overflow で切られないよう fixed 配置 */
    @Input() useFixedPanel = false;
    /** personal など停滞が無い画面では停滞フィルタを非表示 */
    @Input() hideStagnationFilter = false;
    @Input() showSortMenu = false;
    @Input() showListScopeFilter = false;
    @Input() listScope: TaskListScopeMode = 'involved';
    @Output() readonly listScopeChange = new EventEmitter<TaskListScopeMode>();
    @Output() readonly parentSortPicked = new EventEmitter<ParentListSortPick>();

    menuOpen = false;
    sortMenuOpen = false;
    leadSubOpen = false;
    taskNameSubOpen = false;
    leadExpanded = false;
    taskNameExpanded = false;

    panelFixedTop: number | null = null;
    panelFixedRight: number | null = null;

    @ViewChild('filterBtn', { read: ElementRef }) private filterBtn?: ElementRef<HTMLButtonElement>;

    private emit(next: TaskToolbarFilterState): void {
        this.filterChange.emit(next);
    }

    patch(part: Partial<TaskToolbarFilterState>): void {
        this.emit({ ...this.filter, ...part });
    }

    toggleMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.menuOpen = !this.menuOpen;
        if (this.menuOpen) {
            this.sortMenuOpen = false;
            if (this.useFixedPanel) {
                queueMicrotask(() => this.syncPanelFixedPosition());
            }
        } else {
            this.leadSubOpen = false;
            this.taskNameSubOpen = false;
            this.panelFixedTop = null;
            this.panelFixedRight = null;
        }
    }

    private syncPanelFixedPosition(): void {
        const el = this.filterBtn?.nativeElement;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        this.panelFixedTop = Math.round(rect.bottom + 6);
        this.panelFixedRight = Math.round(Math.max(8, window.innerWidth - rect.right));
    }

    toggleSortMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.sortMenuOpen = !this.sortMenuOpen;
        if (this.sortMenuOpen) {
            this.menuOpen = false;
            this.leadSubOpen = false;
            this.taskNameSubOpen = false;
        }
    }

    closeMenu(): void {
        this.menuOpen = false;
        this.sortMenuOpen = false;
        this.leadSubOpen = false;
        this.taskNameSubOpen = false;
        this.panelFixedTop = null;
        this.panelFixedRight = null;
    }

    pickSortDeadline(): void {
        this.parentSortPicked.emit('deadline');
        this.sortMenuOpen = false;
    }

    pickSortStatus(): void {
        this.parentSortPicked.emit('status');
        this.sortMenuOpen = false;
    }

    toggleFlag(key: 'stagnation' | 'deadlineOverdue' | 'deadlineToday' | 'deadlineWithin3' | 'statusTodo' | 'statusProgress'): void {
        this.patch({ [key]: !this.filter[key] });
    }

    toggleLeadSub(ev: MouseEvent): void {
        ev.stopPropagation();
        this.leadSubOpen = !this.leadSubOpen;
        if (this.leadSubOpen) this.taskNameSubOpen = false;
    }

    toggleTaskNameSub(ev: MouseEvent): void {
        ev.stopPropagation();
        this.taskNameSubOpen = !this.taskNameSubOpen;
        if (this.taskNameSubOpen) this.leadSubOpen = false;
    }

    isLeadSelected(uid: string): boolean {
        return this.filter.leadAssigneeUids.includes(uid);
    }

    toggleLead(uid: string): void {
        const cur = this.filter.leadAssigneeUids;
        const next = cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid];
        this.patch({ leadAssigneeUids: next });
    }

    isParentSelected(id: string): boolean {
        return this.filter.taskParentIds.includes(id);
    }

    toggleParent(id: string): void {
        const cur = this.filter.taskParentIds;
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        this.patch({ taskParentIds: next });
    }

    pickListScope(scope: TaskListScopeMode): void {
        this.listScopeChange.emit(scope);
    }

    resetAll(): void {
        this.emit(defaultToolbarFilterState());
        this.leadExpanded = false;
        this.taskNameExpanded = false;
        this.closeMenu();
    }

    showStagnation(): boolean {
        if (this.hideStagnationFilter) return false;
        return this.filterMode === 'manage' || this.filterMode === 'member';
    }

    showDeadline(): boolean {
        return this.filterMode === 'manage' || this.filterMode === 'member';
    }

    showStatus(): boolean {
        return this.filterMode === 'manage' || this.filterMode === 'member';
    }

    showLead(): boolean {
        return this.filterMode === 'manage' || this.filterMode === 'completed';
    }

    showTaskName(): boolean {
        return true;
    }

    @HostListener('document:click', ['$event'])
    onDocClick(ev: MouseEvent): void {
        if (!this.menuOpen && !this.sortMenuOpen) return;
        const el = ev.target as HTMLElement;
        if (el.closest('.tsf-root')) return;
        this.closeMenu();
    }

    @HostListener('window:scroll')
    @HostListener('window:resize')
    onViewportChange(): void {
        if (this.menuOpen && this.useFixedPanel) {
            this.syncPanelFixedPosition();
        }
    }

    readonly leadSliceCap = 10;
    readonly taskSliceCap = 10;

    leadList(): Member[] {
        return [...this.members].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    }

    visibleLeads(): Member[] {
        const list = this.leadList();
        return this.leadExpanded ? list : list.slice(0, this.leadSliceCap);
    }

    visibleParentsForPick(): ParentTask[] {
        const list = [...this.candidateParents].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
        return this.taskNameExpanded ? list : list.slice(0, this.taskSliceCap);
    }
}
