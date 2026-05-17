import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ProgressBubbleVm } from '../../services/progress-reporting.service';

@Component({
  selector: 'app-member-progress-bubbles',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './member-progress-bubbles.component.html',
  styleUrls: ['./member-progress-bubbles.component.css']
})
export class MemberProgressBubblesComponent {
  @Input() bubbles: ProgressBubbleVm[] = [];
  @Input() layout: 'row' | 'inline' | 'single' = 'row';
  /** 親チームストリップ等：アバター横に名前がホバーで展開 */
  @Input() slidingName = false;
  /** false のとき吹き出しのみ（子行などで別に担当アバタがある場合） */
  @Input() showAvatar = true;
  /** false のとき上段の進捗吹き出しを出さない（親ストリップで子ありのときなど） */
  @Input() showSpeechBubble = true;

  initials(name: string): string {
    const n = name.trim();
    if (!n) return '?';
    const seg = n.split(/\s+/).filter(Boolean);
    if (seg.length >= 2) return (seg[0].charAt(0) + seg[1].charAt(0)).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
}
