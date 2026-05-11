import { Component, Input, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ParentTask } from '../../core/interface';
import { AppService } from '../../app.service';
import { ProgressReportingService } from '../../services/progress-reporting.service';
import { AiChatService } from '../../services/ai-chat.service';
import { AdminToastService } from '../../services/admin-toast.service';
import type { ProgressInitialChoice } from '../../core/progress-chat.types';
import type { StagnationEntry } from '../../core/progress-chat.types';

type StagnationPhase =
  | 'manual'
  | 'resolve'
  | 'consult'
  | 'done-pick'
  | 'after-stagnation'
  | null;

@Component({
  selector: 'app-progress-member-shell',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './progress-member-shell.component.html',
  styleUrls: ['../../progress-ai.css', './progress-member-shell.component.css']
})
export class ProgressMemberShellComponent implements OnInit, OnDestroy {
  private readonly appService = inject(AppService);
  readonly progress = inject(ProgressReportingService);
  readonly aiChat = inject(AiChatService);
  private readonly adminToast = inject(AdminToastService);

  @Input({ required: true }) projectId!: string;
  @Input({ required: true }) memberId!: string;
  @Input({ required: true }) parentTasks!: ParentTask[];
  @Input() showOlDock = true;

  stagnationChildId = '';
  stagnationReason = '';
  stagnationPhase: StagnationPhase = null;

  /** 停滞報告: 親タスクは1件のみ（ラジオ） */
  selectedReportParentId = '';

  /** 解決モーダル: 選択した停滞 id */
  resolveSelectedIds: string[] = [];

  /** 要相談モーダル */
  consultNoChange = false;
  consultParentChecked: Record<string, boolean> = {};
  consultContent = '';

  /** もう終わる選択: key は parent::id または child::parentId::childId */
  donePickChecked: Record<string, boolean> = {};

  chatDraft = '';
  chatPublicOn = true;

  get activeParentTasks(): ParentTask[] {
    return this.parentTasks.filter((parent) => {
      const isParentActive = parent.status === '進行中';
      const children = this.appService.getChildTasksByParentId(parent.id);
      const hasActiveChild = children.some(
        (c) => c.assigneeId === this.memberId && c.status === '進行中'
      );
      return isParentActive || hasActiveChild;
    });
  }

  ngOnInit(): void {
    this.aiChat.setOutcomeCallback((pid, mid, reply) => {
      if (pid === this.projectId && mid === this.memberId && reply.inferredBubble) {
        this.progress.applyInferredFromAi(pid, mid, reply.inferredBubble);
      }
    });
  }

  ngOnDestroy(): void {
    this.aiChat.setOutcomeCallback(null);
  }

  stagnationElapsed(): string {
    return this.progress.stagnationElapsedLabel(this.projectId, this.memberId);
  }

  isStagnatingSelf(): boolean {
    return this.progress.isStagnating(this.projectId, this.memberId);
  }

  stagnationEntries(): StagnationEntry[] {
    return this.progress.openStagnations(this.projectId, this.memberId);
  }

  stagnationRowLabel(e: StagnationEntry): string {
    const p = this.parentTasks.find((x) => x.id === e.parentTaskId);
    const ptitle = p?.title ?? '（親）';
    if (!e.childTaskId) return ptitle;
    const c = this.appService.getChildTasksByParentId(e.parentTaskId).find((x) => x.id === e.childTaskId);
    return `${ptitle} / ${c?.title ?? '（子）'}`;
  }

  selectReportParent(pid: string): void {
    this.selectedReportParentId = pid;
    this.stagnationChildId = '';
  }

  openOlChat(): void {
    this.aiChat.openChat(this.projectId, this.memberId);
    this.progress.onAiSessionStarted(this.projectId, this.memberId);
  }

  closeOlChat(): void {
    this.progress.onAiSessionEnded(this.projectId, this.memberId);
    this.aiChat.closeChat();
  }

  async sendOlChat(): Promise<void> {
    const t = this.chatDraft.trim();
    if (!t) return;
    this.chatDraft = '';
    await this.aiChat.sendUserMessage(t, this.stagnationElapsed() || null, this.chatPublicOn, 'member');
  }

  pickInitial(c: ProgressInitialChoice): void {
    if (c === '要相談') {
      this.stagnationPhase = 'consult';
      this.resetConsultDraft();
      return;
    }
    if (c === 'もう終わる') {
      this.stagnationPhase = 'done-pick';
      this.resetDonePickDraft();
      return;
    }
    this.progress.submitInitialChoice(this.projectId, this.memberId, c);
    this.stagnationPhase = null;
    if (c === '問題なし') {
      window.alert('「問題なし」で報告しました。');
    }
  }

  private resetConsultDraft(): void {
    this.consultContent = '';
    this.consultNoChange = false;
    const chk: Record<string, boolean> = {};
    for (const t of this.activeParentTasks) {
      chk[t.id] = false;
    }
    this.consultParentChecked = chk;
  }

  toggleConsultNoChange(checked: boolean): void {
    this.consultNoChange = checked;
    if (checked) {
      const next: Record<string, boolean> = { ...this.consultParentChecked };
      for (const k of Object.keys(next)) {
        next[k] = false;
      }
      this.consultParentChecked = next;
    }
  }

  toggleConsultParent(pid: string, checked: boolean): void {
    this.consultParentChecked = { ...this.consultParentChecked, [pid]: checked };
    if (checked) {
      this.consultNoChange = false;
    }
  }

  openStagnationFromConsultModal(): void {
    this.stagnationPhase = 'manual';
    this.resetStagnationDraft();
  }

  submitConsultModal(): void {
    const content = this.consultContent.trim();
    if (!content) {
      window.alert('相談内容を入力してください');
      return;
    }
    if (!this.consultNoChange) {
      const pids = this.activeParentTasks.filter((t) => this.consultParentChecked[t.id]).map((t) => t.id);
      if (!pids.length) {
        window.alert('対象の親タスクを1件以上選ぶか、「現状変化なし」を選んでください');
        return;
      }
      this.progress.submitConsultationFromProgressCheck(this.projectId, this.memberId, {
        parentTaskIds: pids,
        noChangeOnly: false,
        content
      });
    } else {
      this.progress.submitConsultationFromProgressCheck(this.projectId, this.memberId, {
        parentTaskIds: [],
        noChangeOnly: true,
        content
      });
    }
    this.stagnationPhase = null;
    this.resetConsultDraft();
    window.alert('送信しました。');
  }

  cancelConsultModal(): void {
    this.stagnationPhase = null;
    this.resetConsultDraft();
  }

  /** もう終わる: 自分担当の進行中の親・子の一覧 */
  get donePickRows(): { key: string; label: string }[] {
    const rows: { key: string; label: string }[] = [];
    const parents = this.appService.getSortedParentTasksForProject(this.projectId, false);
    for (const p of parents) {
      if (p.status !== '進行中') continue;
      const onTeam =
        p.leadAssigneeId === this.memberId || p.memberIds.includes(this.memberId);
      if (!onTeam) continue;
      rows.push({
        key: `parent::${p.id}`,
        label: `${p.title || '（無題）'}（親）`
      });
      for (const c of this.appService.getChildTasksByParentId(p.id)) {
        if (c.status !== '進行中' || c.assigneeId !== this.memberId) continue;
        rows.push({
          key: `child::${p.id}::${c.id}`,
          label: `${p.title || '（無題）'} / ${c.title || '（子）'}`
        });
      }
    }
    return rows;
  }

  private resetDonePickDraft(): void {
    const next: Record<string, boolean> = {};
    for (const r of this.donePickRows) {
      next[r.key] = false;
    }
    this.donePickChecked = next;
  }

  toggleDonePick(key: string, checked: boolean): void {
    this.donePickChecked = { ...this.donePickChecked, [key]: checked };
  }

  isDonePickChecked(key: string): boolean {
    return !!this.donePickChecked[key];
  }

  submitDonePickModal(): void {
    const keys = this.donePickRows.filter((r) => this.donePickChecked[r.key]).map((r) => r.key);
    if (!keys.length) {
      window.alert('対象を1件以上選んでください');
      return;
    }
    const items: { parentTaskId: string; childTaskId: string | null }[] = [];
    for (const k of keys) {
      if (k.startsWith('parent::')) {
        items.push({ parentTaskId: k.slice('parent::'.length), childTaskId: null });
      } else if (k.startsWith('child::')) {
        const rest = k.slice('child::'.length);
        const i = rest.indexOf('::');
        if (i < 0) continue;
        items.push({
          parentTaskId: rest.slice(0, i),
          childTaskId: rest.slice(i + 2) || null
        });
      }
    }
    if (!items.length) {
      window.alert('対象を1件以上選んでください');
      return;
    }
    this.progress.submitDoneAnchorsForProgressCheck(this.projectId, this.memberId, items);
    this.stagnationPhase = null;
    this.resetDonePickDraft();
    window.alert('「もう終わる」を報告しました。');
  }

  cancelDonePickModal(): void {
    this.stagnationPhase = null;
    this.resetDonePickDraft();
  }

  private buildStagnationReportItems(): { parentTaskId: string; childTaskId: string | null; reason: string }[] {
    const reason = this.stagnationReason.trim();
    const pid = this.selectedReportParentId.trim();
    if (!pid || !reason) return [];
    let child = (this.stagnationChildId || '').trim() || null;
    const allowed = new Set(this.childOptionsForStagnation(pid).map((o) => o.id));
    if (child && !allowed.has(child)) {
      child = null;
    }
    return [{ parentTaskId: pid, childTaskId: child, reason }];
  }

  openManualStagnationModal(): void {
    this.stagnationPhase = 'manual';
    this.resetStagnationDraft();
  }

  openResolveStagnationModal(): void {
    const list = this.stagnationEntries();
    if (!list.length) {
      window.alert('解決する停滞がありません');
      return;
    }
    this.resolveSelectedIds = list.map((x) => x.id);
    this.stagnationPhase = 'resolve';
  }

  toggleResolveId(id: string, checked: boolean): void {
    if (checked) {
      if (!this.resolveSelectedIds.includes(id)) this.resolveSelectedIds = [...this.resolveSelectedIds, id];
    } else {
      this.resolveSelectedIds = this.resolveSelectedIds.filter((x) => x !== id);
    }
  }

  isResolveChecked(id: string): boolean {
    return this.resolveSelectedIds.includes(id);
  }

  submitResolveStagnation(): void {
    if (!this.resolveSelectedIds.length) {
      window.alert('解決する停滞を1件以上選んでください');
      return;
    }
    this.progress.resolveStagnation(this.projectId, this.memberId, this.resolveSelectedIds);
    this.stagnationPhase = null;
    this.resolveSelectedIds = [];
    window.alert('選択した停滞を解決しました。');
  }

  private finalizeStagnationSubmit(): void {
    this.stagnationPhase = 'after-stagnation';
  }

  submitManualStagnation(): void {
    if (!this.stagnationReason.trim()) {
      window.alert('停滞内容を入力してください');
      return;
    }
    const items = this.buildStagnationReportItems();
    if (!items.length) {
      window.alert('対象の親タスクを1件選んでください');
      return;
    }
    this.notifyAdminStagnationSubmitted();
    this.progress.submitManualStagnationReports(this.projectId, this.memberId, items);
    this.resetStagnationDraft();
    this.finalizeStagnationSubmit();
  }

  cancelStagnationModal(): void {
    this.stagnationPhase = null;
    this.resolveSelectedIds = [];
    this.resetStagnationDraft();
  }

  private resetStagnationDraft(): void {
    this.stagnationChildId = '';
    this.stagnationReason = '';
    this.selectedReportParentId = this.activeParentTasks[0]?.id ?? '';
  }

  childOptionsForStagnation(parentId: string): { id: string; title: string }[] {
    return this.appService
      .getChildTasksByParentId(parentId)
      .filter((c) => c.assigneeId === this.memberId && c.status === '進行中')
      .map((c) => ({ id: c.id, title: c.title || '（無題）' }));
  }

  private notifyAdminStagnationSubmitted(): void {
    const name = this.appService.getMemberById(this.memberId)?.name?.trim() || 'メンバー';
    this.adminToast.show(`${name}さんが停滞報告を送信しました。`);
  }

  confirmAnotherStagnation(): void {
    this.stagnationPhase = 'manual';
    this.resetStagnationDraft();
  }

  closeAfterStagnationPrompt(): void {
    this.stagnationPhase = null;
  }
}
