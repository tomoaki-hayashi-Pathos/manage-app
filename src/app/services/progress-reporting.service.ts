import { Injectable, computed, inject, signal } from '@angular/core';
import { AppService } from '../app.service';
import type { ChatMessage } from '../core/progress-chat.types';
import type {
  ConsultationLogEntry,
  ConsultationProjectBundle,
  MemberProgressRoundState,
  ProgressBubbleKind,
  ProgressMemberSnapshot,
  ProgressInitialChoice,
  ProgressRound,
  StagnationEntry
} from '../core/progress-chat.types';
import {
  StorageService,
  storageKeyConsultationBundle,
  storageKeyProgressState,
  storageKeyThinkingNudge
} from './storage.service';
import type { Member, TaskStatus } from '../core/interface';

export const PARENT_PROGRESS_ROW = '__parent__';

export interface ProgressBubbleVm {
  memberId: string;
  memberName: string;
  memberPhotoUrl: string | null;
  short: string;
  detail: string;
  isStagnating: boolean;
  /** 「考え中」「停滞中」など、ホバーで詳細を出すとき true */
  expandDetailOnHover: boolean;
  /** @for 用の一意キー（同一メンバーで複数吹き出し） */
  bubbleKey: string;
  /** 詳細テキストを常時表示（停滞の内容など） */
  alwaysShowDetail?: boolean;
}

interface PersistedProgress {
  activeRoundIdByProject: [string, string][];
  rounds: Record<string, ProgressRound>;
  memberStates: Record<string, MemberProgressRoundState>;
}

const THINKING_NUDGE_MS = 60 * 60 * 1000;

/** 全タスク行に同一ラベルで出すグローバル系（停滞は child/parent 単位で別 VM） */
const FANOUT_STATUS_LABELS = new Set(['問題なし', 'もう終わる', '考え中', '質問中', '要回答']);

const PROGRESS_CHECK_INTRO =
  '管理者が進捗確認を送信しました。「もう終わる」「問題なし」「要相談」から選んでください。';

function emptyMemberState(roundId: string): MemberProgressRoundState {
  return {
    roundId,
    stage: 'done',
    bubbleShort: '',
    detailForHover: '',
    rowFallbackShort: '',
    rowFallbackDetail: '',
    stagnationSessionStartedAt: null,
    stagnations: [],
    resolvedStagnationAnchors: undefined,
    thinkingSinceAt: null,
    thinkingChatSnippet: '',
    thinkingDetailLong: '',
    preResponseSnapshot: null,
    anchorDoneKeys: undefined,
    fanoutCoveredKeys: undefined
  };
}

@Injectable({ providedIn: 'root' })
export class ProgressReportingService {
  private readonly app = inject(AppService);
  private readonly storage = inject(StorageService);

  /** UI 秒更新用 */
  readonly tick = signal(0);
  private readonly version = signal(0);

  private readonly activeRoundIdByProject = new Map<string, string>();
  private readonly rounds = new Map<string, ProgressRound>();
  /** key: `${projectId}::${roundId}::${memberId}` */
  private readonly memberStates = new Map<string, MemberProgressRoundState>();

  /** 管理ページ（親タスク管理）表示中のみ停滞 alert / 考え中ナudge を評価 */
  private adminAlertProjectId: string | null = null;

  /** 管理画面左下 OL 付近に出す 1 時間考え中メッセージ（複数行改行） */
  readonly adminThinkingNudgeBanner = signal<string | null>(null);

  private timerStarted = false;
  private unsubscribeProgressWatch: (() => void) | null = null;

  constructor() {
    this.loadProgressFromStorage();
    this.unsubscribeProgressWatch = this.storage.watchKey(storageKeyProgressState(), () => {
      this.loadProgressFromStorage();
      this.version.update((v) => v + 1);
    });
    if (typeof window !== 'undefined' && !this.storage.ready()) {
      const tryReload = window.setInterval(() => {
        if (!this.storage.ready()) return;
        this.loadProgressFromStorage();
        this.version.update((v) => v + 1);
        window.clearInterval(tryReload);
      }, 300);
    }
    if (typeof window !== 'undefined') {
      window.setInterval(() => {
        this.tick.update((x) => x + 1);
        this.scanThinkingNudgesForAdmin();
      }, 1000);
    }
  }

  setAdminPageActive(projectId: string, active: boolean): void {
    this.adminAlertProjectId = active ? projectId : null;
    if (!active) this.adminThinkingNudgeBanner.set(null);
  }

  dismissAdminThinkingNudge(): void {
    this.adminThinkingNudgeBanner.set(null);
  }

  private bump(): void {
    this.version.update((v) => v + 1);
    this.saveProgressToStorage();
  }

  /** テンプレートが依存するダミー computed */
  readonly progressRevision = computed(() => ({ t: this.tick(), v: this.version() }));

  private key(projectId: string, roundId: string, memberId: string): string {
    return `${projectId}::${roundId}::${memberId}`;
  }

  private loadProgressFromStorage(): void {
    const data = this.storage.getJson<PersistedProgress>(storageKeyProgressState());
    if (!data?.rounds || !data.memberStates) return;
    this.activeRoundIdByProject.clear();
    for (const [p, r] of data.activeRoundIdByProject ?? []) {
      this.activeRoundIdByProject.set(p, r);
    }
    this.rounds.clear();
    for (const [id, r] of Object.entries(data.rounds)) {
      this.rounds.set(id, r);
    }
    this.memberStates.clear();
    for (const [k, st] of Object.entries(data.memberStates)) {
      this.memberStates.set(k, this.normalizeLoadedState(st));
    }
  }

  private normalizeLoadedState(st: MemberProgressRoundState): MemberProgressRoundState {
    const rawStage = String((st as MemberProgressRoundState & { stage?: string }).stage ?? '');
    let stage: MemberProgressRoundState['stage'];
    if (rawStage === 'awaiting_post_chat') {
      stage = 'awaiting_initial';
    } else if (rawStage === 'idle' || rawStage === 'awaiting_initial' || rawStage === 'deferred_ai' || rawStage === 'done') {
      stage = rawStage;
    } else {
      stage = 'done';
    }
    const legacy = st as MemberProgressRoundState & {
      stagnationStartedAt?: number | null;
      stagnationParentTaskId?: string | null;
      stagnationChildTaskId?: string | null;
      stagnationReason?: string;
    };
    let stagnations = Array.isArray(st.stagnations) ? st.stagnations.map((x) => this.normalizeStagnationEntry(x)) : [];
    if (stagnations.length === 0 && legacy.stagnationStartedAt && legacy.stagnationParentTaskId) {
      stagnations = [
        {
          id: crypto.randomUUID(),
          parentTaskId: legacy.stagnationParentTaskId,
          childTaskId: legacy.stagnationChildTaskId ?? null,
          reason: (legacy.stagnationReason ?? '').trim(),
          startedAt: legacy.stagnationStartedAt
        }
      ];
    }
    let session = st.stagnationSessionStartedAt ?? null;
    if (session === null && stagnations.length > 0) {
      session = Math.min(...stagnations.map((s) => s.startedAt));
    }
    const bubbleShort = st.bubbleShort ?? '';
    let rowFallbackShort = (st.rowFallbackShort ?? '').trim();
    let rowFallbackDetail = (st.rowFallbackDetail ?? '').trim();
    if (!rowFallbackShort) {
      if (FANOUT_STATUS_LABELS.has(bubbleShort)) {
        rowFallbackShort = bubbleShort;
        rowFallbackDetail = (st.detailForHover ?? '').trim();
      } else if (bubbleShort === '停滞中！') {
        rowFallbackShort = '問題なし';
        rowFallbackDetail =
          'このタスクに停滞報告がない行は、初期報告ベースで問題なしとして表示しています。';
      } else {
        rowFallbackShort = bubbleShort || '問題なし';
        rowFallbackDetail = (st.detailForHover ?? '').trim();
      }
    }

    const rawIc = (st as { initialChoice?: string }).initialChoice;
    let initialChoice: MemberProgressRoundState['initialChoice'];
    if (rawIc === '停滞中') {
      initialChoice = '要相談';
    } else if (rawIc === 'もう終わる' || rawIc === '問題なし' || rawIc === '要相談') {
      initialChoice = rawIc;
    } else {
      initialChoice = st.initialChoice;
    }

    return {
      roundId: st.roundId,
      stage,
      initialChoice,
      bubbleShort,
      detailForHover: st.detailForHover ?? '',
      rowFallbackShort,
      rowFallbackDetail,
      stagnationSessionStartedAt: session,
      stagnations,
      resolvedStagnationAnchors: Array.isArray(st.resolvedStagnationAnchors)
        ? st.resolvedStagnationAnchors.map((a) => ({
            parentTaskId: a.parentTaskId,
            childTaskId: a.childTaskId ?? null
          }))
        : undefined,
      thinkingSinceAt: st.thinkingSinceAt ?? null,
      thinkingChatSnippet: st.thinkingChatSnippet ?? '',
      thinkingDetailLong: st.thinkingDetailLong ?? '',
      preResponseSnapshot: st.preResponseSnapshot ? this.normalizeSnapshot(st.preResponseSnapshot) : st.preResponseSnapshot ?? undefined,
      anchorDoneKeys: Array.isArray(st.anchorDoneKeys) ? [...st.anchorDoneKeys] : undefined,
      fanoutCoveredKeys: Array.isArray(st.fanoutCoveredKeys) ? [...st.fanoutCoveredKeys] : undefined
    };
  }

  private normalizeSnapshot(snap: ProgressMemberSnapshot): ProgressMemberSnapshot {
    const stagnations = Array.isArray(snap.stagnations) ? snap.stagnations.map((x) => this.normalizeStagnationEntry(x)) : [];
    let stagnationSessionStartedAt = snap.stagnationSessionStartedAt ?? null;
    if (stagnationSessionStartedAt === null && stagnations.length > 0) {
      stagnationSessionStartedAt = Math.min(...stagnations.map((s) => s.startedAt));
    }
    return {
      bubbleShort: snap.bubbleShort ?? '',
      detailForHover: snap.detailForHover ?? '',
      rowFallbackShort: snap.rowFallbackShort ?? '',
      rowFallbackDetail: snap.rowFallbackDetail ?? '',
      stagnationSessionStartedAt,
      stagnations,
      resolvedStagnationAnchors: Array.isArray(snap.resolvedStagnationAnchors)
        ? snap.resolvedStagnationAnchors.map((a) => ({
            parentTaskId: a.parentTaskId,
            childTaskId: a.childTaskId ?? null
          }))
        : undefined,
      thinkingSinceAt: snap.thinkingSinceAt ?? null,
      thinkingChatSnippet: snap.thinkingChatSnippet ?? '',
      thinkingDetailLong: snap.thinkingDetailLong ?? ''
    };
  }

  private normalizeStagnationEntry(x: StagnationEntry): StagnationEntry {
    return {
      id: x.id || crypto.randomUUID(),
      parentTaskId: x.parentTaskId,
      childTaskId: x.childTaskId ?? null,
      reason: (x.reason ?? '').trim(),
      startedAt: typeof x.startedAt === 'number' ? x.startedAt : Date.now()
    };
  }

  private emptyProgressSnapshot(): ProgressMemberSnapshot {
    return {
      bubbleShort: '',
      detailForHover: '',
      rowFallbackShort: '',
      rowFallbackDetail: '',
      stagnationSessionStartedAt: null,
      stagnations: [],
      resolvedStagnationAnchors: undefined,
      thinkingSinceAt: null,
      thinkingChatSnippet: '',
      thinkingDetailLong: ''
    };
  }

  private cloneProgressSnapshot(st: MemberProgressRoundState): ProgressMemberSnapshot {
    return this.normalizeSnapshot({
      bubbleShort: st.bubbleShort,
      detailForHover: st.detailForHover,
      rowFallbackShort: st.rowFallbackShort ?? '',
      rowFallbackDetail: st.rowFallbackDetail ?? '',
      stagnationSessionStartedAt: st.stagnationSessionStartedAt,
      stagnations: st.stagnations.map((s) => ({ ...s })),
      resolvedStagnationAnchors: st.resolvedStagnationAnchors
        ? st.resolvedStagnationAnchors.map((a) => ({
            parentTaskId: a.parentTaskId,
            childTaskId: a.childTaskId ?? null
          }))
        : undefined,
      thinkingSinceAt: st.thinkingSinceAt,
      thinkingChatSnippet: st.thinkingChatSnippet,
      thinkingDetailLong: st.thinkingDetailLong
    });
  }

  private restoreFromSnapshot(st: MemberProgressRoundState, snap: ProgressMemberSnapshot): void {
    const n = this.normalizeSnapshot(snap);
    st.bubbleShort = n.bubbleShort;
    st.detailForHover = n.detailForHover;
    st.rowFallbackShort = n.rowFallbackShort;
    st.rowFallbackDetail = n.rowFallbackDetail;
    st.stagnationSessionStartedAt = n.stagnationSessionStartedAt;
    st.stagnations = n.stagnations.map((s) => ({ ...s }));
    st.resolvedStagnationAnchors = n.resolvedStagnationAnchors;
    st.thinkingSinceAt = n.thinkingSinceAt;
    st.thinkingChatSnippet = n.thinkingChatSnippet;
    st.thinkingDetailLong = n.thinkingDetailLong;
  }

  private anchorKey(parentTaskId: string, childTaskId: string | null): string {
    return `${parentTaskId}::${childTaskId ?? ''}`;
  }

  private hasAnchorDone(st: MemberProgressRoundState | undefined, parentTaskId: string, childTaskId: string | null): boolean {
    const keys = st?.anchorDoneKeys;
    if (!keys?.length) return false;
    return keys.includes(this.anchorKey(parentTaskId, childTaskId));
  }

  /** 回答時点で進行中だった親・子行（担当メンバー基準） */
  private captureFanoutCoveredKeys(projectId: string, memberId: string): string[] {
    const keys: string[] = [];
    for (const p of this.app.parentTasks) {
      if (p.projectId !== projectId) continue;
      if (!this.isMemberOfParentTeam(p, memberId)) continue;
      if (p.status === '進行中') {
        keys.push(this.anchorKey(p.id, null));
      }
      for (const c of this.app.getChildTasksByParentId(p.id)) {
        if (c.status === '進行中' && c.assigneeId === memberId) {
          keys.push(this.anchorKey(p.id, c.id));
        }
      }
    }
    return keys;
  }

  private assignFanoutCoveredKeys(projectId: string, memberId: string, st: MemberProgressRoundState): void {
    st.fanoutCoveredKeys = this.captureFanoutCoveredKeys(projectId, memberId);
  }

  /** スナップショット無しの旧データは従来どおり fan-out */
  private isFanoutCovered(st: MemberProgressRoundState, parentTaskId: string, childTaskId: string | null): boolean {
    const keys = st.fanoutCoveredKeys;
    if (!keys?.length) return true;
    return keys.includes(this.anchorKey(parentTaskId, childTaskId));
  }

  private tryUncoveredInProgressBubble(
    st: MemberProgressRoundState,
    mem: Member,
    rid: string,
    parentTaskId: string,
    childTaskId: string | null,
    keySuffix: string,
    taskInProgress: boolean
  ): ProgressBubbleVm[] | null {
    if (!taskInProgress || st.stage !== 'done') return null;
    if (this.isFanoutCovered(st, parentTaskId, childTaskId)) return null;
    return [this.syntheticInProgressVm(mem, rid, keySuffix)];
  }

  private stagnationDisplaySource(st: MemberProgressRoundState): {
    stagnations: StagnationEntry[];
    stagnationSessionStartedAt: number | null;
  } {
    if ((st.stage === 'awaiting_initial' || st.stage === 'deferred_ai') && st.preResponseSnapshot) {
      return {
        stagnations: st.preResponseSnapshot.stagnations,
        stagnationSessionStartedAt: st.preResponseSnapshot.stagnationSessionStartedAt
      };
    }
    return { stagnations: st.stagnations, stagnationSessionStartedAt: st.stagnationSessionStartedAt };
  }

  private appendConsultationEntry(entry: ConsultationLogEntry): void {
    const key = storageKeyConsultationBundle(entry.projectId);
    const raw = this.storage.getJson<ConsultationProjectBundle | null>(key);
    const base: ConsultationProjectBundle =
      raw && Array.isArray(raw.entries) ? raw : { entries: [], adminDismissedAt: 0 };
    if (typeof base.adminDismissedAt !== 'number') base.adminDismissedAt = 0;
    base.entries = [...base.entries, entry];
    this.storage.setJson(key, base);
  }

  private reconcileBubbleAfterStagnationChange(st: MemberProgressRoundState): void {
    if (st.stagnations.length > 0) {
      st.stagnationSessionStartedAt =
        st.stagnationSessionStartedAt ?? Math.min(...st.stagnations.map((s) => s.startedAt));
      st.bubbleShort = '停滞中！';
      if (!st.rowFallbackShort?.trim()) {
        st.rowFallbackShort = '問題なし';
        st.rowFallbackDetail = '停滞報告のないタスクは問題なしとして表示します。';
      }
      return;
    }
    st.stagnationSessionStartedAt = null;
    if (st.bubbleShort === '停滞中！') {
      st.bubbleShort = '問題なし';
      st.detailForHover = '問題なし、と報告しました。';
      st.rowFallbackShort = '問題なし';
      st.rowFallbackDetail = '停滞報告のないタスクは問題なしとして表示します。';
    }
  }

  private awaitingResponseBubbleVm(mem: Member, rid: string, keySuffix: string): ProgressBubbleVm {
    return {
      memberId: mem.uid,
      memberName: mem.name,
      memberPhotoUrl: mem.photoURL ?? null,
      short: '回答待ち',
      detail: '進捗確認への回答待ちです。回答後に表示が更新されます。',
      isStagnating: false,
      expandDetailOnHover: false,
      bubbleKey: `${mem.uid}::await::${rid}${keySuffix}`,
      alwaysShowDetail: true
    };
  }

  private doneAnchorBubbleVm(mem: Member, rid: string, keySuffix: string): ProgressBubbleVm {
    return {
      memberId: mem.uid,
      memberName: mem.name,
      memberPhotoUrl: mem.photoURL ?? null,
      short: 'もう終わる',
      detail: 'もう終わる、と報告したタスクです。',
      isStagnating: false,
      expandDetailOnHover: false,
      bubbleKey: `${mem.uid}::doneA::${rid}${keySuffix}`,
      alwaysShowDetail: true
    };
  }

  private shouldShowAwaitingForChildRow(
    st: MemberProgressRoundState | undefined,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    memberUid: string,
    childStatus: string
  ): boolean {
    if (!st?.preResponseSnapshot) return false;
    if (st.stage !== 'awaiting_initial' && st.stage !== 'deferred_ai') return false;
    if (childStatus !== '進行中') return false;
    return this.isMemberOfParentTeam(parent, memberUid);
  }

  private shouldShowAwaitingForParentSummary(
    st: MemberProgressRoundState | undefined,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    memberUid: string,
    parentStatus: string
  ): boolean {
    if (!st?.preResponseSnapshot) return false;
    if (st.stage !== 'awaiting_initial' && st.stage !== 'deferred_ai') return false;
    if (parentStatus !== '進行中') return false;
    return this.isMemberOfParentTeam(parent, memberUid);
  }

  private saveProgressToStorage(): void {
    const activeRoundIdByProject: [string, string][] = [...this.activeRoundIdByProject.entries()];
    const rounds: Record<string, ProgressRound> = {};
    for (const [id, r] of this.rounds) rounds[id] = r;
    const memberStates: Record<string, MemberProgressRoundState> = {};
    for (const [k, st] of this.memberStates) memberStates[k] = st;
    this.storage.setJson(storageKeyProgressState(), {
      activeRoundIdByProject,
      rounds,
      memberStates
    } satisfies PersistedProgress);
  }

  getActiveRound(projectId: string): ProgressRound | undefined {
    const rid = this.activeRoundIdByProject.get(projectId);
    return rid ? this.rounds.get(rid) : undefined;
  }

  getMemberState(projectId: string, memberId: string): MemberProgressRoundState | null {
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!rid) return null;
    return this.memberStates.get(this.key(projectId, rid, memberId)) ?? null;
  }

  /** プロジェクト削除時: 進捗ラウンド・メンバー状態から除去して保存 */
  purgeProjectProgress(projectId: string): void {
    this.activeRoundIdByProject.delete(projectId);
    for (const [id, r] of [...this.rounds.entries()]) {
      if (r.projectId === projectId) this.rounds.delete(id);
    }
    const pref = `${projectId}::`;
    for (const k of [...this.memberStates.keys()]) {
      if (k.startsWith(pref)) this.memberStates.delete(k);
    }
    this.version.update((v) => v + 1);
    this.saveProgressToStorage();
  }

  /**
   * 親チーム進捗ストリップのアイコン表示用。
   * まだラウンドが無いプロジェクトだけ最小ラウンドを作成し永続化する。
   */
  ensureProgressRoundForProject(projectId: string): void {
    if (this.activeRoundIdByProject.has(projectId)) return;
    this.ensureMinimalRound(projectId);
    this.bump();
  }

  isMemberOfParentTeam(parent: { leadAssigneeId: string | null; memberIds: string[] }, memberId: string): boolean {
    if (parent.leadAssigneeId === memberId) return true;
    return parent.memberIds.includes(memberId);
  }

  /**
   * 子タスク行の担当アバター＋スライド名用（進捗ラウンドに依存しない）。0 または 1 件。
   */
  bubblesForChildAssigneeDisplay(
    projectId: string,
    child: { id: string; assigneeId: string | null }
  ): ProgressBubbleVm[] {
    const aid = child.assigneeId?.trim() ?? '';
    if (!aid) return [];
    const mem = this.app.getMembersByProjectId(projectId).find((m) => m.uid === aid);
    if (!mem) return [];
    return [
      {
        memberId: mem.uid,
        memberName: mem.name,
        memberPhotoUrl: mem.photoURL ?? null,
        short: '',
        detail: '',
        isStagnating: false,
        expandDetailOnHover: false,
        bubbleKey: `child-assignee-display::${child.id}::${mem.uid}`,
        alwaysShowDetail: false
      }
    ];
  }

  /** ヘッダー用：ログイン／表示中メンバーのアバター＋スライド名（進捗ラウンド非依存） */
  bubblesForMemberHeaderDisplay(projectId: string, memberId: string): ProgressBubbleVm[] {
    const uid = memberId?.trim() ?? '';
    if (!uid) return [];
    const mem =
      this.app.getMembersByProjectId(projectId).find((m) => m.uid === uid) ?? this.app.getMemberById(uid);
    if (!mem) return [];
    return [
      {
        memberId: mem.uid,
        memberName: mem.name,
        memberPhotoUrl: mem.photoURL ?? null,
        short: '',
        detail: '',
        isStagnating: false,
        expandDetailOnHover: false,
        bubbleKey: `header-identity::${projectId}::${mem.uid}`,
        alwaysShowDetail: false
      }
    ];
  }

  /** 管理者: 参加メンバーに 3 択を促す（責任者は進行中関与があるときのみ） */
  requestProgressReport(projectId: string, aiDeferredMemberIds: Set<string>): void {
    const oldRid = this.activeRoundIdByProject.get(projectId);
    const members = this.app
      .getMembersByProjectId(projectId)
      .filter((m) => this.app.shouldReceiveProgressCheck(projectId, m.uid));
    const snapByMember = new Map<string, ProgressMemberSnapshot>();
    for (const m of members) {
      if (oldRid) {
        const prev = this.memberStates.get(this.key(projectId, oldRid, m.uid));
        if (prev) {
          snapByMember.set(m.uid, this.cloneProgressSnapshot(prev));
          continue;
        }
      }
      snapByMember.set(m.uid, this.emptyProgressSnapshot());
    }

    const round: ProgressRound = {
      id: crypto.randomUUID(),
      projectId,
      createdAt: Date.now()
    };
    this.rounds.set(round.id, round);
    this.activeRoundIdByProject.set(projectId, round.id);

    for (const m of members) {
      const snap = snapByMember.get(m.uid) ?? this.emptyProgressSnapshot();
      const st: MemberProgressRoundState = {
        roundId: round.id,
        stage: aiDeferredMemberIds.has(m.uid) ? 'deferred_ai' : 'awaiting_initial',
        bubbleShort: aiDeferredMemberIds.has(m.uid) ? '考え中' : '要回答',
        detailForHover: aiDeferredMemberIds.has(m.uid)
          ? 'AI 相談中のため、相談終了後に進捗を報告してください。'
          : PROGRESS_CHECK_INTRO,
        rowFallbackShort: aiDeferredMemberIds.has(m.uid) ? '考え中' : '要回答',
        rowFallbackDetail: aiDeferredMemberIds.has(m.uid)
          ? 'AI 相談中のため、相談終了後に進捗を報告してください。'
          : PROGRESS_CHECK_INTRO,
        stagnationSessionStartedAt: null,
        stagnations: [],
        thinkingSinceAt: aiDeferredMemberIds.has(m.uid) ? Date.now() : null,
        thinkingChatSnippet: '',
        thinkingDetailLong: '',
        preResponseSnapshot: snap,
        anchorDoneKeys: undefined,
        fanoutCoveredKeys: undefined
      };
      this.memberStates.set(this.key(projectId, round.id, m.uid), st);
    }
    this.bump();
  }

  /** AI セッション開始・終了（AiChatService から呼ぶ） */
  onAiSessionStarted(projectId: string, memberId: string): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage === 'awaiting_initial') {
      st.stage = 'deferred_ai';
      st.bubbleShort = '考え中';
      st.detailForHover = 'AI 相談中。終了後に進捗を報告してください。';
      st.rowFallbackShort = '考え中';
      st.rowFallbackDetail = st.detailForHover;
      st.thinkingSinceAt = st.thinkingSinceAt ?? Date.now();
    }
    this.bump();
  }

  onAiSessionEnded(projectId: string, memberId: string): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage === 'deferred_ai') {
      st.stage = 'awaiting_initial';
      st.bubbleShort = '要回答';
      st.detailForHover =
        '相談が終わりました。表示された進捗確認から「もう終わる」「問題なし」「要相談」を選んでください。';
      st.rowFallbackShort = '要回答';
      st.rowFallbackDetail = st.detailForHover;
    }
    this.bump();
  }

  submitInitialChoice(projectId: string, memberId: string, choice: ProgressInitialChoice): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage !== 'awaiting_initial') return;

    st.initialChoice = choice;
    if (choice === '問題なし') {
      st.stage = 'done';
      st.bubbleShort = '問題なし';
      st.detailForHover = '問題なし、と報告しました。';
      st.rowFallbackShort = '問題なし';
      st.rowFallbackDetail = st.detailForHover;
      st.stagnations = [];
      st.stagnationSessionStartedAt = null;
      st.preResponseSnapshot = undefined;
      st.anchorDoneKeys = undefined;
      this.assignFanoutCoveredKeys(projectId, memberId, st);
      this.clearThinkingFields(st);
      this.bump();
    }
  }

  /** 進捗確認「要相談」送信（吹き出しはスナップショット復元、相談はログへ） */
  submitConsultationFromProgressCheck(
    projectId: string,
    memberId: string,
    payload: { parentTaskIds: string[]; noChangeOnly: boolean; content: string }
  ): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage !== 'awaiting_initial' || !st.preResponseSnapshot) return;
    const trimmed = payload.content.trim();
    if (!trimmed) return;

    const mem = this.app.getMemberById(memberId);
    const entry: ConsultationLogEntry = {
      id: crypto.randomUUID(),
      projectId,
      memberId,
      memberName: mem?.name ?? memberId,
      parentTaskIds: payload.noChangeOnly ? [] : [...payload.parentTaskIds],
      noChangeOnly: payload.noChangeOnly,
      content: trimmed,
      at: Date.now()
    };
    this.appendConsultationEntry(entry);

    this.restoreFromSnapshot(st, st.preResponseSnapshot);
    st.preResponseSnapshot = undefined;
    st.stage = 'done';
    st.initialChoice = '要相談';
    st.anchorDoneKeys = undefined;
    this.assignFanoutCoveredKeys(projectId, memberId, st);
    this.clearThinkingFields(st);
    this.bump();
  }

  /** 進捗確認「もう終わる」モーダルで選択したアンカーのみもう終わる表示 */
  submitDoneAnchorsForProgressCheck(
    projectId: string,
    memberId: string,
    items: { parentTaskId: string; childTaskId: string | null }[]
  ): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage !== 'awaiting_initial' || !st.preResponseSnapshot) return;
    if (!items.length) return;

    this.restoreFromSnapshot(st, st.preResponseSnapshot);
    st.preResponseSnapshot = undefined;
    st.stage = 'done';
    st.initialChoice = 'もう終わる';
    st.anchorDoneKeys = items.map((it) => this.anchorKey(it.parentTaskId, it.childTaskId ?? null));

    for (const it of items) {
      const pid = it.parentTaskId;
      const cid = it.childTaskId ?? null;
      st.stagnations = st.stagnations.filter(
        (sg) => !(sg.parentTaskId === pid && (sg.childTaskId ?? null) === cid)
      );
    }
    this.assignFanoutCoveredKeys(projectId, memberId, st);
    this.reconcileBubbleAfterStagnationChange(st);
    this.clearThinkingFields(st);
    this.bump();
  }

  /** 進捗確認モーダルからの停滞（複数タスク） — 現 UI では未使用 */
  submitInitialStagnationBatch(
    projectId: string,
    memberId: string,
    items: { parentTaskId: string; childTaskId: string | null; reason: string }[]
  ): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.stage !== 'awaiting_initial') return;
    if (!items.length) return;
    for (const it of items) {
      if (!it.parentTaskId || !it.reason?.trim()) continue;
      this.applyStagnation(projectId, memberId, st, it.parentTaskId, it.childTaskId ?? null, it.reason.trim());
    }
    st.rowFallbackShort = '問題なし';
    st.rowFallbackDetail = '初期報告で停滞を付けなかったタスクは問題なしとして表示します。';
    this.assignFanoutCoveredKeys(projectId, memberId, st);
    this.bump();
  }

  /** 右上「停滞報告」からの手入力 */
  submitManualStagnationReport(
    projectId: string,
    memberId: string,
    parentTaskId: string,
    childTaskId: string | null,
    reason: string
  ): void {
    this.submitManualStagnationReports(projectId, memberId, [{ parentTaskId, childTaskId, reason }]);
  }

  /** 手動停滞報告（複数タスクまとめて） */
  submitManualStagnationReports(
    projectId: string,
    memberId: string,
    items: { parentTaskId: string; childTaskId: string | null; reason: string }[]
  ): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) {
      this.ensureMinimalRound(projectId);
    }
    const st2 = this.getMemberState(projectId, memberId);
    const rid2 = this.activeRoundIdByProject.get(projectId);
    if (!st2 || !rid2) return;
    if (st2.stage === 'awaiting_initial' && st2.preResponseSnapshot) {
      this.restoreFromSnapshot(st2, st2.preResponseSnapshot);
      st2.preResponseSnapshot = undefined;
    }
    for (const it of items) {
      if (!it.parentTaskId || !it.reason?.trim()) continue;
      this.applyStagnation(projectId, memberId, st2, it.parentTaskId, it.childTaskId, it.reason.trim());
    }
    if (st2.stage === 'done' && !st2.fanoutCoveredKeys?.length) {
      this.assignFanoutCoveredKeys(projectId, memberId, st2);
    }
    this.bump();
  }

  /** 指定 id の停滞を解消。空配列なら全件解消 */
  resolveStagnation(projectId: string, memberId: string, stagnationIds?: string[]): void {
    const st = this.getMemberState(projectId, memberId);
    if (!st) return;
    const snap = st.preResponseSnapshot;
    const useSnap = !!snap && (st.stage === 'awaiting_initial' || st.stage === 'deferred_ai');
    const ids = stagnationIds?.length ? new Set(stagnationIds) : null;

    if (useSnap && snap) {
      let removed: StagnationEntry[];
      if (ids) {
        removed = snap.stagnations.filter((s) => ids.has(s.id));
        snap.stagnations = snap.stagnations.filter((s) => !ids.has(s.id));
      } else {
        removed = [...snap.stagnations];
        snap.stagnations = [];
      }
      if (removed.length > 0) {
        this.mergeResolvedAnchors(
          snap,
          removed.map((r) => ({ parentTaskId: r.parentTaskId, childTaskId: r.childTaskId ?? null }))
        );
      }
      snap.stagnationSessionStartedAt =
        snap.stagnations.length > 0 ? Math.min(...snap.stagnations.map((s) => s.startedAt)) : null;
      if (snap.stagnations.length === 0 && snap.bubbleShort === '停滞中！') {
        snap.bubbleShort = '問題なし';
        snap.detailForHover = '問題なし、と報告しました。';
        snap.rowFallbackShort = '問題なし';
        snap.rowFallbackDetail = '停滞報告のないタスクは問題なしとして表示します。';
      }
    } else {
      let removed: StagnationEntry[];
      if (ids) {
        removed = st.stagnations.filter((s) => ids.has(s.id));
        st.stagnations = st.stagnations.filter((s) => !ids.has(s.id));
      } else {
        removed = [...st.stagnations];
        st.stagnations = [];
      }
      if (removed.length > 0) {
        this.mergeResolvedAnchors(
          st,
          removed.map((r) => ({ parentTaskId: r.parentTaskId, childTaskId: r.childTaskId ?? null }))
        );
      }
      if (st.stagnations.length === 0) {
        st.stagnationSessionStartedAt = null;
        if (st.bubbleShort === '停滞中！') {
          st.bubbleShort = '問題なし';
          st.detailForHover = '問題なし、と報告しました。';
          st.rowFallbackShort = '問題なし';
          st.rowFallbackDetail = '停滞報告のないタスクは問題なしとして表示します。';
        }
      }
    }
    this.clearThinkingFields(st);
    this.bump();
  }

  openStagnations(projectId: string, memberId: string): StagnationEntry[] {
    void this.progressRevision();
    const st = this.getMemberState(projectId, memberId);
    if (!st) return [];
    const src = this.stagnationDisplaySource(st);
    return [...src.stagnations];
  }

  stagnationElapsedLabel(projectId: string, memberId: string): string {
    void this.tick();
    const st = this.getMemberState(projectId, memberId);
    if (!st) return '';
    const src = this.stagnationDisplaySource(st);
    if (!src.stagnationSessionStartedAt || src.stagnations.length === 0) return '';
    return this.formatElapsed(Date.now() - src.stagnationSessionStartedAt);
  }

  isStagnating(projectId: string, memberId: string): boolean {
    void this.tick();
    const st = this.getMemberState(projectId, memberId);
    if (!st) return false;
    const src = this.stagnationDisplaySource(st);
    return src.stagnations.length > 0;
  }

  /** プロジェクト内の全メンバーから (parentId, childId|null) に該当する未解決停滞があるかを返す */
  hasOpenStagnationForTask(
    projectId: string,
    parentTaskId: string,
    childTaskId: string | null
  ): boolean {
    void this.progressRevision();
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!rid) return false;
    const cid = childTaskId ?? null;
    const prefix = `${projectId}::`;
    for (const [k, st] of this.memberStates) {
      if (!k.startsWith(prefix)) continue;
      if (st.roundId !== rid) continue;
      const src = this.stagnationDisplaySource(st);
      for (const sg of src.stagnations) {
        if (sg.parentTaskId !== parentTaskId) continue;
        if ((sg.childTaskId ?? null) !== cid) continue;
        return true;
      }
    }
    return false;
  }

  isAwaitingInitial(projectId: string, memberId: string): boolean {
    void this.progressRevision();
    return this.getMemberState(projectId, memberId)?.stage === 'awaiting_initial';
  }

  /** AI 推測結果を反映 */
  applyInferredFromAi(projectId: string, memberId: string, inferred: ProgressBubbleKind | undefined): void {
    if (inferred !== '問題なし' && inferred !== '考え中' && inferred !== '停滞中') return;
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.preResponseSnapshot && (st.stage === 'awaiting_initial' || st.stage === 'deferred_ai')) return;
    if (inferred === '問題なし') {
      st.stage = 'done';
      st.bubbleShort = '問題なし';
      st.detailForHover = 'AI 回答に基づき問題なしに更新しました。';
      st.rowFallbackShort = '問題なし';
      st.rowFallbackDetail = st.detailForHover;
      st.stagnations = [];
      st.stagnationSessionStartedAt = null;
      this.clearThinkingFields(st);
    } else if (inferred === '考え中') {
      st.stage = 'done';
      st.bubbleShort = '考え中';
      st.detailForHover = 'AI 回答に基づき考え中として更新しました。';
      st.rowFallbackShort = '考え中';
      st.rowFallbackDetail = st.detailForHover;
      st.thinkingSinceAt = st.thinkingSinceAt ?? Date.now();
    } else if (inferred === '停滞中') {
      st.stage = 'done';
      st.bubbleShort = '停滞中！';
      st.detailForHover = 'AI 回答に基づき停滞中としてマークしました。詳細は停滞報告で入力してください。';
      st.rowFallbackShort = '問題なし';
      st.rowFallbackDetail = 'AI 推測で付いた停滞以外のタスク行は問題なしとして表示します。';
      const firstParent = this.app.getSortedParentTasksForProject(projectId, false)[0];
      if (firstParent) {
        this.applyStagnation(projectId, memberId, st, firstParent.id, null, st.detailForHover);
      } else {
        this.clearThinkingFields(st);
      }
    }
    this.bump();
  }

  /** AiChatService から会話更新時に呼ぶ（考え中のホバー文用） */
  patchThinkingFromChat(projectId: string, memberId: string, messages: ChatMessage[]): void {
    const st = this.getMemberState(projectId, memberId);
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!st || !rid || st.roundId !== rid) return;
    if (st.bubbleShort !== '考え中') return;
    const { snippet, long } = summarizeChatForThinking(messages);
    st.thinkingChatSnippet = snippet;
    st.thinkingDetailLong = long;
    this.bump();
  }

  private mergeResolvedAnchors(
    st: MemberProgressRoundState | ProgressMemberSnapshot,
    added: { parentTaskId: string; childTaskId: string | null }[]
  ): void {
    const seen = new Set<string>();
    const list: { parentTaskId: string; childTaskId: string | null }[] = [];
    for (const a of [...(st.resolvedStagnationAnchors ?? []), ...added]) {
      const key = `${a.parentTaskId}::${a.childTaskId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ parentTaskId: a.parentTaskId, childTaskId: a.childTaskId ?? null });
    }
    st.resolvedStagnationAnchors = list.length ? list : undefined;
  }

  private matchesResolvedAnchor(
    st: MemberProgressRoundState,
    parentTaskId: string,
    childTaskId: string | null
  ): boolean {
    const anchors = st.resolvedStagnationAnchors;
    if (!anchors?.length) return false;
    return anchors.some(
      (a) => a.parentTaskId === parentTaskId && (a.childTaskId ?? null) === (childTaskId ?? null)
    );
  }

  private fanoutDetailForRow(
    st: MemberProgressRoundState,
    parentTaskId: string,
    childTaskId: string | null
  ): string {
    if (this.matchesResolvedAnchor(st, parentTaskId, childTaskId)) {
      return '停滞を解決しました。';
    }
    return this.rowFallbackSyntheticState(st).detailForHover;
  }

  private stagnationsOnRow(
    st: MemberProgressRoundState,
    parentTaskId: string,
    childTaskId: string | null
  ): StagnationEntry[] {
    const src = this.stagnationDisplaySource(st);
    return src.stagnations.filter(
      (sg) => sg.parentTaskId === parentTaskId && (sg.childTaskId ?? null) === (childTaskId ?? null)
    );
  }

  /**
   * タスク行の吹き出し（表示層）。進捗ラウンド未登録でも進行中なら合成表示する。
   * 優先: 行の停滞 → 回答待ち → もう終わる → 親要約 → fan-out 未カバー進行中 → 空/合成
   */
  private resolveMemberRowBubbles(
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    mem: Member,
    rid: string,
    keySuffix: string,
    taskStatus: TaskStatus,
    childTaskId: string | null,
    st: MemberProgressRoundState | null,
    parentSummaryWithChildren = false
  ): ProgressBubbleVm[] {
    const parentTaskId = parent.id;
    const inProgress = taskStatus === '進行中';
    const emptyKey = `${mem.uid}::empty::${rid}${keySuffix}`;

    if (taskStatus === '未着手' || taskStatus === '完了') {
      if (st) {
        const todoStalls = this.stagnationsOnRow(st, parentTaskId, childTaskId);
        if (todoStalls.length > 0) {
          return todoStalls.map((sg) =>
            this.toStagnationBubbleVm(mem.uid, mem.name, mem.photoURL ?? null, sg)
          );
        }
        if (
          childTaskId !== null &&
          this.shouldShowAwaitingForChildRow(st, parent, mem.uid, taskStatus)
        ) {
          return [this.awaitingResponseBubbleVm(mem, rid, keySuffix)];
        }
        if (
          childTaskId === null &&
          this.shouldShowAwaitingForParentSummary(st, parent, mem.uid, taskStatus)
        ) {
          return [this.awaitingResponseBubbleVm(mem, rid, keySuffix)];
        }
      }
      return [this.emptyContentBubbleVm(mem.uid, mem.name, mem.photoURL ?? null, emptyKey)];
    }

    if (!st) {
      return [this.syntheticInProgressVm(mem, rid, keySuffix)];
    }

    const rowStalls = this.stagnationsOnRow(st, parentTaskId, childTaskId);
    if (rowStalls.length > 0) {
      return rowStalls.map((sg) =>
        this.toStagnationBubbleVm(mem.uid, mem.name, mem.photoURL ?? null, sg)
      );
    }

    if (childTaskId !== null) {
      if (this.shouldShowAwaitingForChildRow(st, parent, mem.uid, taskStatus)) {
        return [this.awaitingResponseBubbleVm(mem, rid, keySuffix)];
      }
    } else if (this.shouldShowAwaitingForParentSummary(st, parent, mem.uid, taskStatus)) {
      return [this.awaitingResponseBubbleVm(mem, rid, keySuffix)];
    }

    if (this.hasAnchorDone(st, parentTaskId, childTaskId)) {
      return [this.doneAnchorBubbleVm(mem, rid, keySuffix)];
    }

    if (parentSummaryWithChildren && childTaskId === null && st.bubbleShort === '停滞中！') {
      const stallsHere = st.stagnations.filter((sg) => sg.parentTaskId === parentTaskId);
      const parentOnly = stallsHere.filter((sg) => sg.childTaskId == null);
      const childOnly = stallsHere.filter((sg) => sg.childTaskId != null);
      if (parentOnly.length === 0) {
        if (this.matchesResolvedAnchor(st, parentTaskId, null)) {
          return [
            this.toStatusBubbleVm(
              mem.uid,
              mem.name,
              mem.photoURL ?? null,
              {
                ...this.rowFallbackSyntheticState(st),
                bubbleShort: '問題なし',
                detailForHover: '停滞を解決しました。'
              },
              keySuffix
            )
          ];
        }
        const syn = this.rowFallbackSyntheticState(st);
        let detail = syn.detailForHover;
        if (childOnly.length > 0) {
          detail = [detail, '子タスク行の吹き出しで停滞内容を確認できます。'].filter(Boolean).join(' ');
        } else if (stallsHere.length === 0) {
          detail = [detail, 'この親タスクでは停滞報告はありません。'].filter(Boolean).join(' ');
        }
        return [
          this.toStatusBubbleVm(
            mem.uid,
            mem.name,
            mem.photoURL ?? null,
            { ...syn, detailForHover: detail },
            keySuffix
          )
        ];
      }
    }

    const uncovered = this.tryUncoveredInProgressBubble(
      st,
      mem,
      rid,
      parentTaskId,
      childTaskId,
      keySuffix,
      inProgress
    );
    if (uncovered) return uncovered;

    if (!st.bubbleShort?.trim()) {
      return [this.syntheticInProgressVm(mem, rid, keySuffix)];
    }

    if (FANOUT_STATUS_LABELS.has(st.bubbleShort)) {
      if (st.stage === 'done') {
        return [
          this.toStatusBubbleVm(
            mem.uid,
            mem.name,
            mem.photoURL ?? null,
            { ...st, detailForHover: this.fanoutDetailForRow(st, parentTaskId, childTaskId) },
            keySuffix
          )
        ];
      }
      return [this.syntheticInProgressVm(mem, rid, keySuffix)];
    }

    if (st.bubbleShort === '停滞中！') {
      if (this.matchesResolvedAnchor(st, parentTaskId, childTaskId)) {
        return [
          this.toStatusBubbleVm(
            mem.uid,
            mem.name,
            mem.photoURL ?? null,
            {
              ...this.rowFallbackSyntheticState(st),
              bubbleShort: '問題なし',
              detailForHover: '停滞を解決しました。'
            },
            keySuffix
          )
        ];
      }
      return [
        this.toStatusBubbleVm(
          mem.uid,
          mem.name,
          mem.photoURL ?? null,
          this.rowFallbackSyntheticState(st),
          keySuffix
        )
      ];
    }

    return [];
  }

  bubblesForChildRow(
    projectId: string,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    childId: string,
    /** 非表示にするメンバー id（従来互換用）。null なら担当者の吹き出しを全員分表示（管理・メンバー共通） */
    viewerMemberId: string | null,
    /** 子タスクの担当者（未設定なら吹き出しなし） */
    assigneeId: string | null
  ): ProgressBubbleVm[] {
    void this.progressRevision();
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!rid) return [];
    const aid = assigneeId?.trim() ?? '';
    if (!aid) {
      return [
        {
          memberId: '',
          memberName: '',
          memberPhotoUrl: null,
          short: '—',
          detail: '子の担当者が未設定です',
          isStagnating: false,
          expandDetailOnHover: false,
          bubbleKey: `placeholder::child::${parent.id}::${childId}`,
          alwaysShowDetail: true
        }
      ];
    }

    const mem = this.app.getMembersByProjectId(projectId).find((m) => m.uid === aid);
    if (!mem) return [];
    if (viewerMemberId && mem.uid === viewerMemberId) return [];
    if (!this.isMemberOfParentTeam(parent, mem.uid)) return [];

    const child = this.app.childTasks.find((c) => c.id === childId);
    if (!child) return [];

    const keySuf = `::c::${parent.id}::${childId}`;
    const st = this.memberStates.get(this.key(projectId, rid, mem.uid)) ?? null;
    return this.resolveMemberRowBubbles(parent, mem, rid, keySuf, child.status, childId, st);
  }

  /** viewerMemberId が null のとき親チーム全員の吹き出し（管理・メンバー共通） */
  bubblesForParentOnly(
    projectId: string,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    viewerMemberId: string | null
  ): ProgressBubbleVm[] {
    void this.progressRevision();
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!rid) return [];
    const parentTask = this.app.parentTasks.find((p) => p.id === parent.id);
    if (!parentTask) return [];

    const keyP = `::p::${parent.id}`;
    if (parentTask.status === '未着手' || parentTask.status === '完了') {
      return this.emptyBubblesForParentTeam(projectId, parent, viewerMemberId, rid, keyP, parentTask.status);
    }

    const children = this.app.getChildTasksByParentId(parent.id);
    if (children.length === 0) {
      return this.bubblesForAnchor(projectId, parent, PARENT_PROGRESS_ROW, viewerMemberId);
    }
    const out: ProgressBubbleVm[] = [];
    for (const mem of this.app.getMembersByProjectId(projectId)) {
      if (viewerMemberId && mem.uid === viewerMemberId) continue;
      if (!this.isMemberOfParentTeam(parent, mem.uid)) continue;
      const st = this.memberStates.get(this.key(projectId, rid, mem.uid)) ?? null;
      out.push(
        ...this.resolveMemberRowBubbles(
          parent,
          mem,
          rid,
          keyP,
          parentTask.status,
          null,
          st,
          true
        )
      );
    }
    return out;
  }

  private bubblesForAnchor(
    projectId: string,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    anchor: string,
    viewerMemberId: string | null
  ): ProgressBubbleVm[] {
    const rid = this.activeRoundIdByProject.get(projectId);
    if (!rid) return [];
    const parentTask = this.app.parentTasks.find((p) => p.id === parent.id);
    if (!parentTask) return [];

    const keyA = `::anchor::${parent.id}`;
    if (parentTask.status === '未着手' || parentTask.status === '完了') {
      return this.emptyBubblesForParentTeam(projectId, parent, viewerMemberId, rid, keyA, parentTask.status);
    }

    const out: ProgressBubbleVm[] = [];
    for (const mem of this.app.getMembersByProjectId(projectId)) {
      if (viewerMemberId && mem.uid === viewerMemberId) continue;
      if (!this.isMemberOfParentTeam(parent, mem.uid)) continue;
      if (anchor !== PARENT_PROGRESS_ROW) continue;
      const st = this.memberStates.get(this.key(projectId, rid, mem.uid)) ?? null;
      out.push(
        ...this.resolveMemberRowBubbles(parent, mem, rid, keyA, parentTask.status, null, st, false)
      );
    }
    return out;
  }

  private emptyContentBubbleVm(
    memberId: string,
    memberName: string,
    photoUrl: string | null,
    bubbleKey: string
  ): ProgressBubbleVm {
    return {
      memberId,
      memberName,
      memberPhotoUrl: photoUrl,
      short: '',
      detail: '',
      isStagnating: false,
      expandDetailOnHover: false,
      bubbleKey,
      alwaysShowDetail: false
    };
  }

  private syntheticInProgressVm(mem: Member, rid: string, keySuffix: string): ProgressBubbleVm {
    return {
      memberId: mem.uid,
      memberName: mem.name,
      memberPhotoUrl: mem.photoURL ?? null,
      short: '進行中',
      detail: '進行中のタスクです。次の進捗確認または停滞報告で更新されます。',
      isStagnating: false,
      expandDetailOnHover: false,
      bubbleKey: `${mem.uid}::prog::${rid}${keySuffix}`,
      alwaysShowDetail: false
    };
  }

  private emptyBubblesForParentTeam(
    projectId: string,
    parent: { id: string; leadAssigneeId: string | null; memberIds: string[] },
    viewerMemberId: string | null,
    rid: string,
    keySuffix: string,
    taskStatus: TaskStatus
  ): ProgressBubbleVm[] {
    const out: ProgressBubbleVm[] = [];
    for (const mem of this.app.getMembersByProjectId(projectId)) {
      if (viewerMemberId && mem.uid === viewerMemberId) continue;
      if (!this.isMemberOfParentTeam(parent, mem.uid)) continue;
      const st = this.memberStates.get(this.key(projectId, rid, mem.uid)) ?? null;
      out.push(...this.resolveMemberRowBubbles(parent, mem, rid, keySuffix, taskStatus, null, st, false));
    }
    return out;
  }

  private rowFallbackSyntheticState(st: MemberProgressRoundState): MemberProgressRoundState {
    const short = (st.rowFallbackShort ?? '').trim() || '問題なし';
    let detail = (st.rowFallbackDetail ?? '').trim();
    if (!detail) {
      detail =
        short === '問題なし'
          ? '停滞報告のないタスクは問題なしとして表示しています。'
          : st.detailForHover || short;
    }
    return { ...st, bubbleShort: short, detailForHover: detail };
  }

  private toStatusBubbleVm(
    memberId: string,
    memberName: string,
    photoUrl: string | null,
    st: MemberProgressRoundState,
    bubbleKeySuffix = ''
  ): ProgressBubbleVm {
    let detail = st.detailForHover || st.bubbleShort;
    if (st.bubbleShort === '考え中') {
      detail = st.thinkingDetailLong || st.thinkingChatSnippet || st.detailForHover;
    }
    return {
      memberId,
      memberName,
      memberPhotoUrl: photoUrl,
      short: st.bubbleShort,
      detail,
      isStagnating: false,
      expandDetailOnHover: false,
      bubbleKey: `${memberId}::status::${st.roundId}${bubbleKeySuffix}`,
      alwaysShowDetail: true
    };
  }

  private toStagnationBubbleVm(
    memberId: string,
    memberName: string,
    photoUrl: string | null,
    entry: StagnationEntry
  ): ProgressBubbleVm {
    const short = `停滞中！ ${this.formatElapsed(Date.now() - entry.startedAt)}`;
    return {
      memberId,
      memberName,
      memberPhotoUrl: photoUrl,
      short,
      detail: entry.reason || '（内容なし）',
      isStagnating: true,
      expandDetailOnHover: true,
      bubbleKey: `${memberId}::stag::${entry.id}`
    };
  }

  private applyStagnation(
    projectId: string,
    memberId: string,
    st: MemberProgressRoundState,
    parentTaskId: string,
    childTaskId: string | null,
    reason: string
  ): void {
    st.resolvedStagnationAnchors = undefined;
    const wasStagnating = st.stagnations.length > 0;
    const entry: StagnationEntry = {
      id: crypto.randomUUID(),
      parentTaskId,
      childTaskId,
      reason: reason.trim(),
      startedAt: Date.now()
    };
    st.stagnations = [...st.stagnations, entry];
    if (st.stagnationSessionStartedAt === null) {
      st.stagnationSessionStartedAt = entry.startedAt;
    }
    st.stage = 'done';
    st.bubbleShort = '停滞中！';
    st.detailForHover = reason.trim();
    if (!st.rowFallbackShort?.trim()) {
      st.rowFallbackShort = '問題なし';
      st.rowFallbackDetail = '停滞報告のないタスクは問題なしとして表示します。';
    }
    this.clearThinkingFields(st);
    if (!st.fanoutCoveredKeys?.length) {
      this.assignFanoutCoveredKeys(projectId, memberId, st);
    }

    if (!wasStagnating && this.adminAlertProjectId === projectId && typeof window !== 'undefined') {
      const parent = this.app.parentTasks.find((p) => p.id === parentTaskId);
      const child = childTaskId ? this.app.childTasks.find((c) => c.id === childTaskId) : undefined;
      const mem = this.app.getMemberById(memberId);
      const taskTitle = child?.title || parent?.title || '（無題）';
      const assigneeName = mem?.name ?? memberId;
      window.alert(`【停滞中の報告】\nタスク: ${taskTitle}\n担当: ${assigneeName}\n内容: ${reason.trim()}`);
    }
  }

  private ensureMinimalRound(projectId: string): void {
    if (this.activeRoundIdByProject.has(projectId)) return;
    const round: ProgressRound = {
      id: crypto.randomUUID(),
      projectId,
      createdAt: Date.now()
    };
    this.rounds.set(round.id, round);
    this.activeRoundIdByProject.set(projectId, round.id);
    for (const m of this.app.getMembersByProjectId(projectId)) {
      if (!this.app.shouldReceiveProgressCheck(projectId, m.uid)) continue;
      this.memberStates.set(this.key(projectId, round.id, m.uid), emptyMemberState(round.id));
    }
  }

  private clearThinkingFields(st: MemberProgressRoundState): void {
    st.thinkingSinceAt = null;
    st.thinkingChatSnippet = '';
    st.thinkingDetailLong = '';
  }

  private scanThinkingNudgesForAdmin(): void {
    const pid = this.adminAlertProjectId;
    if (!pid) return;
    const rid = this.activeRoundIdByProject.get(pid);
    if (!rid) return;
    const now = Date.now();
    const lines: string[] = [];
    for (const mem of this.app.getMembersByProjectId(pid)) {
      const st = this.memberStates.get(this.key(pid, rid, mem.uid));
      if (!st || st.bubbleShort !== '考え中' || !st.thinkingSinceAt) continue;
      if (now - st.thinkingSinceAt < THINKING_NUDGE_MS) continue;
      const sk = storageKeyThinkingNudge(pid, rid, mem.uid);
      if (this.storage.getJson<unknown>(sk)) continue;
      this.storage.setJson(sk, now);
      const snippet = clip(st.thinkingChatSnippet || st.thinkingDetailLong || '（会話要約なし）', 18);
      lines.push(`${mem.name}さんが1時間以上「考え中」のままです（状況：${snippet}）声をかけてみますか？`);
    }
    if (lines.length) {
      const prev = this.adminThinkingNudgeBanner();
      const next = lines.join('\n');
      if (prev !== next) this.adminThinkingNudgeBanner.set(next);
    }
  }

  private formatElapsed(ms: number): string {
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h > 0) return `${h}時間${mm}分経過`;
    return `${mm}分経過`;
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function summarizeChatForThinking(messages: ChatMessage[]): { snippet: string; long: string } {
  const tail = messages.slice(-6);
  const long = tail
    .map((m) => `${m.role === 'user' ? '自分' : 'OL'}: ${m.text}`)
    .join('\n')
    .slice(0, 400);
  const lastUser = [...tail].reverse().find((m) => m.role === 'user');
  const lastAsst = [...tail].reverse().find((m) => m.role === 'assistant');
  const raw = [lastUser?.text, lastAsst?.text].filter(Boolean).join(' / ') || long;
  return { snippet: clip(raw, 15), long: long || raw };
}
