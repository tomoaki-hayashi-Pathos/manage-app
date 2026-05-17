import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Member, ParentTask } from '../../core/interface';
import { defaultToolbarFilterState, type TaskToolbarFilterState } from './task-search-filter.util';

export type ParentListSortPick = 'deadline' | 'status';

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
    @Input() hideAssigneeFilter = false;
    @Input() showSortMenu = false;
    @Output() readonly parentSortPicked = new EventEmitter<ParentListSortPick>();

    menuOpen = false;
    sortMenuOpen = false;
    assigneeSubOpen = false;
    taskNameSubOpen = false;
    assigneeExpanded = false;
    taskNameExpanded = false;

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
        }
        if (!this.menuOpen) {
            this.assigneeSubOpen = false;
            this.taskNameSubOpen = false;
        }
    }

    toggleSortMenu(ev: MouseEvent): void {
        ev.stopPropagation();
        this.sortMenuOpen = !this.sortMenuOpen;
        if (this.sortMenuOpen) {
            this.menuOpen = false;
            this.assigneeSubOpen = false;
            this.taskNameSubOpen = false;
        }
    }

    closeMenu(): void {
        this.menuOpen = false;
        this.sortMenuOpen = false;
        this.assigneeSubOpen = false;
        this.taskNameSubOpen = false;
    }

    pickSortDeadline(): void {
        this.parentSortPicked.emit('deadline');
        this.sortMenuOpen = false;
    }

    pickSortStatus(): void {
        this.parentSortPicked.emit('status');
        this.sortMenuOpen = false;
    }

    toggleIncomplete(): void {
        this.patch({ incompleteOnly: !this.filter.incompleteOnly });
    }

    toggleAssigneeSub(ev: MouseEvent): void {
        ev.stopPropagation();
        this.assigneeSubOpen = !this.assigneeSubOpen;
        if (this.assigneeSubOpen) this.taskNameSubOpen = false;
    }

    toggleTaskNameSub(ev: MouseEvent): void {
        ev.stopPropagation();
        this.taskNameSubOpen = !this.taskNameSubOpen;
        if (this.taskNameSubOpen) this.assigneeSubOpen = false;
    }

    pickAssignee(uid: string | null): void {
        this.patch({ assigneeUid: uid });
    }

    pickParent(id: string | null): void {
        this.patch({ pickParentId: id });
    }

    resetAll(): void {
        this.emit(defaultToolbarFilterState());
        this.assigneeExpanded = false;
        this.taskNameExpanded = false;
        this.closeMenu();
    }

    @HostListener('document:click', ['$event'])
    onDocClick(ev: MouseEvent): void {
        if (!this.menuOpen && !this.sortMenuOpen) return;
        const el = ev.target as HTMLElement;
        if (el.closest('.tsf-root')) return;
        this.closeMenu();
    }

    readonly assigneeSliceCap = 10;
    readonly taskSliceCap = 10;

    assigneeList(): Member[] {
        return [...this.members].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    }

    visibleAssignees(): Member[] {
        const list = this.assigneeList();
        return this.assigneeExpanded ? list : list.slice(0, this.assigneeSliceCap);
    }

    visibleParentsForPick(): ParentTask[] {
        const list = [...this.candidateParents].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
        return this.taskNameExpanded ? list : list.slice(0, this.taskSliceCap);
    }
}
