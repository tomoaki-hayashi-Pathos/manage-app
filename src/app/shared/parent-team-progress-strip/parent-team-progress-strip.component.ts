import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ParentTask } from '../../core/interface';
import type { ProgressBubbleVm } from '../../services/progress-reporting.service';
import { MemberProgressBubblesComponent } from '../member-progress-bubbles/member-progress-bubbles.component';
import { buildParentTeamProgressSlots, type ParentTeamProgressSlot } from './parent-team-progress-strip.util';

@Component({
  selector: 'app-parent-team-progress-strip',
  standalone: true,
  imports: [CommonModule, MemberProgressBubblesComponent],
  templateUrl: './parent-team-progress-strip.component.html',
  styleUrls: ['./parent-team-progress-strip.component.css']
})
export class ParentTeamProgressStripComponent {
  @Input({ required: true }) parent!: Pick<ParentTask, 'leadAssigneeId' | 'memberIds'>;
  @Input() bubbles: ProgressBubbleVm[] = [];
  /** true のとき担当・メンバー列の上段吹き出しを非表示（子タスクがある親など） */
  @Input() hideProgressSpeech = false;

  get slots() {
    return buildParentTeamProgressSlots(this.parent, this.bubbles);
  }

  get leadSlots(): ParentTeamProgressSlot[] {
    return this.slots.filter((s) => s.isLead);
  }

  get memberSlots(): ParentTeamProgressSlot[] {
    return this.slots.filter((s) => !s.isLead);
  }
}
