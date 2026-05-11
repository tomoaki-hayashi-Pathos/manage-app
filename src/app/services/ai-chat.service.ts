import { Injectable, inject, signal } from '@angular/core';
import { AppService } from '../app.service';
import type {
  ChatContext,
  ChatMessage,
  ChatOutcomeCallback,
  ChatReply,
  ChatViewerRole,
  ConsultationLogEntry,
  ConsultationProjectBundle,
  SharedKnowledgeEntry,
  StagnationEntry
} from '../core/progress-chat.types';
import type { ProgressBubbleKind } from '../core/progress-chat.types';
import { getGeminiApiKey, getGeminiModel } from '../env/public-env';
import { StorageService, storageKeyConsultationBundle } from './storage.service';
import { ProgressReportingService } from './progress-reporting.service';
import { AuthSessionService } from './auth-session.service';

const MOCK_DELAY_MS = 1400;

@Injectable({ providedIn: 'root' })
export class AiChatService {
  private readonly app = inject(AppService);
  private readonly storage = inject(StorageService);
  private readonly progress = inject(ProgressReportingService);
  private readonly auth = inject(AuthSessionService);

  readonly chatOpen = signal(false);
  readonly projectIdOpen = signal<string | null>(null);
  readonly memberIdOpen = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);

  private outcomeCallback: ChatOutcomeCallback | null = null;
  private unsubscribeOpenChatContext: (() => void) | null = null;

  setOutcomeCallback(cb: ChatOutcomeCallback | null): void {
    this.outcomeCallback = cb;
  }

  isChatActiveFor(projectId: string, memberId: string): boolean {
    return this.chatOpen() && this.projectIdOpen() === projectId && this.memberIdOpen() === memberId;
  }
//---------------------------------------------------------------------
  /**openChat(projectId: string, memberId: string): void {
    this.projectIdOpen.set(projectId);
    this.memberIdOpen.set(memberId);
    this.unsubscribeOpenChatContext?.();
    const roomOwnerId = this.currentChatRoomOwnerId(memberId);
    this.messages.set(this.storage.getAiMemberContext(projectId, memberId, roomOwnerId).messages);
    this.unsubscribeOpenChatContext = this.watchOpenChatContext(projectId, memberId, roomOwnerId);
    this.chatOpen.set(true);
    this.syncThinkingSnippet();
    void this.prepareFirestoreContext(projectId, memberId).then(() => {
      if (!this.isChatActiveFor(projectId, memberId)) return;
      const readyRoomOwnerId = this.currentChatRoomOwnerId(memberId);
      if (readyRoomOwnerId !== roomOwnerId) {
        this.unsubscribeOpenChatContext?.();
        this.unsubscribeOpenChatContext = this.watchOpenChatContext(projectId, memberId, readyRoomOwnerId);
      }
      this.messages.set(this.storage.getAiMemberContext(projectId, memberId, readyRoomOwnerId).messages);
      this.syncThinkingSnippet();
    });
  }*/

    openChat(projectId: string, memberId: string): void {
      this.projectIdOpen.set(projectId);
      this.memberIdOpen.set(memberId);
      this.unsubscribeOpenChatContext?.();
      
      const roomOwnerId = this.currentChatRoomOwnerId(memberId);
      
      // 1. まずチャット画面を開く
      this.chatOpen.set(true);
    
      // 2. 「最新データ」をFirestoreから強制的に取得し直す (await的な処理)
      void this.prepareFirestoreContext(projectId, memberId).then(() => {
        // コンテキストが準備できてから、最新のメッセージを取得する
        const readyRoomOwnerId = this.currentChatRoomOwnerId(memberId);
        const freshContext = this.storage.getAiMemberContext(projectId, memberId, readyRoomOwnerId);
        
        // 3. 最新のメッセージをセット
        this.messages.set(freshContext.messages);
        
        // 4. 最新の状態を監視開始
        this.unsubscribeOpenChatContext = this.watchOpenChatContext(projectId, memberId, readyRoomOwnerId);
        
        this.syncThinkingSnippet();
        console.log("Firestoreとの同期が完了し、最新のコンテキストを読み込みました");
      });
    }
//-------------------------------------------------------------------------

  closeChat(): void {
    void this.persistMessages();
    this.unsubscribeOpenChatContext?.();
    this.unsubscribeOpenChatContext = null;
    this.chatOpen.set(false);
    this.projectIdOpen.set(null);
    this.memberIdOpen.set(null);
    this.messages.set([]);
  }

  buildContext(stagnationElapsedLabel: string | null, viewerRole: ChatViewerRole): ChatContext | null {
    const pid = this.projectIdOpen();
    const mid = this.memberIdOpen();
    if (!pid || !mid) return null;
    const mem = this.app.getMemberById(mid);
    const tasks = this.app
      .getSortedParentTasksForProject(pid, false)
      .slice(0, 5)
      .map((t) => t.title || '（無題）')
      .join(' / ');
    const stagnationMap = this.buildStagnationMap(pid, mid);
    const currentTaskDetail = this.currentTaskDetail(pid, mid, stagnationMap);
    const topStatusSummary = this.buildTopStatusSummary(pid, mid, stagnationElapsedLabel);
    const storedContext = this.storage.getAiMemberContext(pid, mid, this.currentChatRoomOwnerId(mid));
    const history = this.messages().length ? this.messages() : storedContext.messages;
    const personalRecent = history.slice(-40);
    const conversationSummary = storedContext.conversationSummary.trim();
    const latestUserText = [...personalRecent].reverse().find((m) => m.role === 'user')?.text ?? '';
    const sharedHints = this.searchSharedHints(pid, latestUserText).slice(0, 3);
    const progressAndReportsBlock = this.buildProgressAndReportsBlock(pid, mid, viewerRole);
    return {
      projectId: pid,
      memberId: mid,
      memberName: mem?.name ?? mid,
      viewerRole,
      currentTaskTitle: tasks || '（タスクなし）',
      stagnationElapsedLabel,
      history: [...history],
      currentTaskDetail,
      topStatusSummary,
      progressAndReportsBlock,
      personalRecent,
      sharedHints,
      conversationSummary
    };
  }

  private stagnationKey(parentTaskId: string, childTaskId: string | null): string {
    return `${parentTaskId}::${childTaskId ?? ''}`;
  }

  private buildStagnationMap(projectId: string, memberId: string): Map<string, StagnationEntry[]> {
    const map = new Map<string, StagnationEntry[]>();
    for (const sg of this.progress.openStagnations(projectId, memberId)) {
      const key = this.stagnationKey(sg.parentTaskId, sg.childTaskId ?? null);
      const bag = map.get(key) ?? [];
      bag.push(sg);
      map.set(key, bag);
    }
    return map;
  }

  private stagnationInlineTag(sgs: StagnationEntry[] | undefined): string {
    if (!sgs || sgs.length === 0) return '';
    const parts = sgs.map((s) => {
      const when = new Date(s.startedAt).toLocaleString('ja-JP');
      const reason = (s.reason || '').trim() || '（理由未記入）';
      return `${when}〜停滞中: 「${reason}」`;
    });
    return `（停滞報告あり: ${parts.join(' / ')}）`;
  }

  private buildTopStatusSummary(projectId: string, memberId: string, stagnationElapsedLabel: string | null): string {
    const stagnations = this.progress.openStagnations(projectId, memberId);
    if (stagnations.length === 0) return '現在、未解決の停滞報告はありません。';
    const lines = stagnations.map((s) => {
      const parent = this.app.parentTasks.find((p) => p.id === s.parentTaskId && p.projectId === projectId);
      const pTitle = parent?.title || '（親タスク不明）';
      let label = `親「${pTitle}」`;
      if (s.childTaskId) {
        const child = this.app.childTasks.find((c) => c.id === s.childTaskId);
        label += ` / 子「${child?.title || '（無題）'}」`;
      }
      const when = new Date(s.startedAt).toLocaleString('ja-JP');
      const reason = (s.reason || '').trim() || '（理由未記入）';
      return `- ${label} は ${when} から停滞中。停滞理由: 「${reason}」`;
    });
    const elapsed = stagnationElapsedLabel ? ` 停滞経過: ${stagnationElapsedLabel}。` : '';
    return `対象ユーザーは現在、以下のタスクで停滞報告を出しています。${elapsed}\n${lines.join('\n')}`;
  }

  async sendUserMessage(
    text: string,
    stagnationElapsedLabel: string | null,
    isPublic = false,
    viewerRole: ChatViewerRole = 'member'
  ): Promise<ChatReply> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { assistantText: '' };
    }

    const pid = this.projectIdOpen();
    const mid = this.memberIdOpen();
    if (!pid || !mid) {
      return { assistantText: '' };
    }

    this.sending.set(true);
    try {
      await this.prepareFirestoreContext(pid, mid);
      this.messages.set(this.storage.getAiMemberContext(pid, mid, this.currentChatRoomOwnerId(mid)).messages);

      const userMsg: ChatMessage = { role: 'user', text: trimmed, at: Date.now() };
      this.messages.update((xs) => [...xs, userMsg]);
      await this.persistMessages();
      this.syncThinkingSnippet();

      const ctx = this.buildContext(stagnationElapsedLabel, viewerRole);
      if (!ctx) {
        return { assistantText: '' };
      }

      const reply = await this.dispatchToModel(ctx);
      const inferred = reply.inferredBubble ?? this.heuristicInference(reply.assistantText);
      const enriched: ChatReply = { ...reply, inferredBubble: inferred };
      const asst: ChatMessage = { role: 'assistant', text: reply.assistantText, at: Date.now() };
      this.messages.update((xs) => [...xs, asst]);
      await this.persistMessages();
      if (isPublic) {
        void this.persistSharedKnowledge(ctx, userMsg.text, asst.text);
      }
      this.syncThinkingSnippet();
      this.outcomeCallback?.(ctx.projectId, ctx.memberId, enriched);
      void this.refreshConversationSummary(ctx, trimmed, reply.assistantText);
      return enriched;
    } finally {
      this.sending.set(false);
    }
  }

  private async prepareFirestoreContext(projectId: string, memberId: string): Promise<void> {
    await Promise.all([
      this.waitUntil(() => !this.auth.loading()),
      this.waitUntil(() => this.app.ready()),
      this.waitUntil(() => this.storage.ready())
    ]);
    await this.app.refreshStateFromFirestore();
    await Promise.all([
      this.storage.ensureAiMemberContext(projectId, memberId, this.currentChatRoomOwnerId(memberId)),
      this.storage.ensureAiSharedKnowledge(projectId)
    ]);
  }

  private currentChatRoomOwnerId(targetMemberId: string): string {
    this.app.notificationTick();
    return this.app.getMemberByEmail(this.auth.currentEmail())?.uid ?? targetMemberId;
  }

  private watchOpenChatContext(projectId: string, memberId: string, roomOwnerId: string): () => void {
    return this.storage.watchAiMemberContext(projectId, memberId, roomOwnerId, () => {
      if (!this.isChatActiveFor(projectId, memberId)) return;
      this.messages.set(this.storage.getAiMemberContext(projectId, memberId, roomOwnerId).messages);
      this.syncThinkingSnippet();
    });
  }

  private buildProgressAndReportsBlock(projectId: string, memberId: string, viewerRole: ChatViewerRole): string {
    const lines: string[] = [];
    const round = this.progress.getActiveRound(projectId);
    if (round) {
      lines.push(
        `【進捗確認ラウンド】管理者が ${new Date(round.createdAt).toLocaleString('ja-JP')} に進捗確認（もう終わる／問題なし／要相談）を送信したラウンドが有効です。`
      );
    } else {
      lines.push('【進捗確認ラウンド】現在アクティブな進捗確認ラウンドはありません。');
    }

    const st = this.progress.getMemberState(projectId, memberId);
    if (!st) {
      lines.push('【対象メンバーの進捗吹き出し】このラウンドの状態が未登録です。');
    } else {
      lines.push('【対象メンバーの進捗吹き出し】');
      lines.push(`吹き出し: ${st.bubbleShort || '（空）'}`);
      lines.push(`ステージ: ${st.stage}`);
      if (st.initialChoice) lines.push(`直近の進捗確認での選択: ${st.initialChoice}`);
      lines.push(`ホバー詳細: ${(st.detailForHover || '').trim() || '（なし）'}`);
      if (st.thinkingSinceAt) {
        lines.push(`「考え中」開始: ${new Date(st.thinkingSinceAt).toLocaleString('ja-JP')}`);
      }
      if (st.thinkingChatSnippet || st.thinkingDetailLong) {
        lines.push(`AI相談スニペット: ${(st.thinkingChatSnippet || '').trim()}`);
        lines.push(`AI相談詳細: ${(st.thinkingDetailLong || '').trim().slice(0, 400)}`);
      }
    }

    const stagnations = this.progress.openStagnations(projectId, memberId);
    if (stagnations.length === 0) {
      lines.push('【対象メンバーの停滞報告】未解決の停滞報告はありません。');
    } else {
      lines.push('【対象メンバーの停滞報告（未解決）】');
      for (const sg of stagnations) {
        lines.push(this.formatStagnationLine(projectId, sg));
      }
    }

    const rawBundle = this.storage.getJson<ConsultationProjectBundle | null>(storageKeyConsultationBundle(projectId));
    const entries =
      rawBundle && Array.isArray(rawBundle.entries) ? [...rawBundle.entries].sort((a, b) => b.at - a.at) : [];

    if (viewerRole === 'admin') {
      lines.push('【要相談ログ（管理者向け・実名・新しい順・最大12件）】');
      if (entries.length === 0) {
        lines.push('（ログなし）');
      } else {
        for (const e of entries.slice(0, 12)) {
          const taskLabel = this.consultationTaskLabel(projectId, e);
          const when = new Date(e.at).toLocaleString('ja-JP');
          const body = e.content.replace(/\s+/g, ' ').trim();
          lines.push(`・${e.memberName}／対象: ${taskLabel}／${when}／${body}`);
        }
      }
      lines.push('【他メンバーの進捗状況（管理者向け・実名）】');
      const peerLines: string[] = [];
      for (const m of this.app.getMembersByProjectId(projectId)) {
        if (m.uid === memberId) continue;
        const peerSt = this.progress.getMemberState(projectId, m.uid);
        const peerStalls = this.progress.openStagnations(projectId, m.uid);
        if (!peerSt && peerStalls.length === 0) continue;
        const bubble = peerSt?.bubbleShort?.trim() || '—';
        const stage = peerSt?.stage ?? '—';
        peerLines.push(`・${m.name}: 吹き出し「${bubble}」 ステージ ${stage} 未解決停滞 ${peerStalls.length} 件`);
      }
      lines.push(peerLines.length ? peerLines.join('\n') : '（他メンバーで特記する状態なし）');
    } else {
      lines.push(
        '【プロジェクト内の要相談ログ抜粋（メンバー向け・投稿者名は含めない。回答で誰の相談か推測・明言しないこと）】'
      );
      if (entries.length === 0) {
        lines.push('（ログなし）');
      } else {
        for (const e of entries.slice(0, 8)) {
          const taskLabel = this.consultationTaskLabel(projectId, e);
          const when = new Date(e.at).toLocaleString('ja-JP');
          const body = e.content.replace(/\s+/g, ' ').trim();
          lines.push(`・対象: ${taskLabel}／${when}／${body}`);
        }
      }
    }

    return lines.join('\n');
  }

  private consultationTaskLabel(projectId: string, e: ConsultationLogEntry): string {
    if (e.noChangeOnly) return '現状変化なし';
    return (
      e.parentTaskIds
        .map((id) => this.app.parentTasks.find((p) => p.id === id && p.projectId === projectId)?.title || id)
        .join('、') || '（対象タスクなし）'
    );
  }

  private formatStagnationLine(projectId: string, sg: StagnationEntry): string {
    const parent = this.app.parentTasks.find((p) => p.id === sg.parentTaskId && p.projectId === projectId);
    const pTitle = parent?.title || '（親タスク不明）';
    let tail = '';
    if (sg.childTaskId) {
      const child = this.app.childTasks.find((c) => c.id === sg.childTaskId);
      tail = ` / 子「${child?.title || '（無題）'}」`;
    }
    const when = new Date(sg.startedAt).toLocaleString('ja-JP');
    return `- 親「${pTitle}」${tail} / 報告時刻: ${when} / 内容: ${(sg.reason || '').trim() || '（なし）'}`;
  }

  private async waitUntil(predicate: () => boolean): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        if (!predicate()) return;
        window.clearInterval(timer);
        resolve();
      }, 50);
    });
  }

  private async dispatchToModel(ctx: ChatContext): Promise<ChatReply> {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return this.mockReply(ctx);
    }
    return this.geminiGenerate(ctx, apiKey);
  }

  private async mockReply(ctx: ChatContext): Promise<ChatReply> {
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    const base = `（Mock）${ctx.memberName}さん、メモありがとうございます。「${ctx.currentTaskTitle}」の件を把握しました。`;
    return {
      assistantText: `${base} 本番では .env の NG_APP_GEMINI_API_KEY を設定すると Gemini が応答します。`
    };
  }

  private async geminiGenerate(ctx: ChatContext, apiKey: string): Promise<ChatReply> {
    const model = getGeminiModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const transcript = ctx.personalRecent.map((h) => `${h.role}: ${h.text}`).join('\n');
    const latestUserMessage = [...ctx.personalRecent].reverse().find((m) => m.role === 'user')?.text ?? '';
    const currentStatusQuery = /現状|進捗|状況|今|現在|報告|どうなって|ステータス|状態/.test(latestUserMessage);
    const viewerIsMember = ctx.viewerRole === 'member';
    const sharedHintText = ctx.sharedHints.length
      ? ctx.sharedHints
          .map((x, i) =>
            viewerIsMember
              ? `- 事例${i + 1}: 課題「${x.userText}」→ 参考「${x.assistantText}」`
              : `- 事例${i + 1}(${x.memberName}): 課題「${x.userText}」→ 解決「${x.assistantText}」`
          )
          .join('\n')
      : '（該当なし）';
    const summaryBlock = currentStatusQuery
      ? '（現状報告では使用禁止。現在の事実データだけを根拠にすること）'
      : ctx.conversationSummary || '（まだ要約がありません）';
    const transcriptBlock = currentStatusQuery
      ? `user: ${latestUserMessage || '現状を教えてください。'}`
      : transcript;
    const sharedHintBlock = currentStatusQuery
      ? '（現状報告では使用禁止。解決策を求められた場合のみ参考にすること）'
      : sharedHintText;
    const viewerPolicy =
      ctx.viewerRole === 'admin'
        ? '【閲覧者】管理者向け。要相談ログ・共有ナレッジ・他メンバー欄に実名が含まれる場合があります。補助データとして正確に扱ってよい。'
        : '【閲覧者】メンバー向け。共有ナレッジ・要相談抜粋は投稿者名を含まないヒントです。回答で特定人物を推測・特定しないこと（「誰が」「○○さんが」等は禁止）。一般化したパターンとして述べること。';

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `あなたはタスク管理アプリの相談相手です。対象ユーザー名: ${ctx.memberName}。

                      ${viewerPolicy}

                      【最重要方針】
                      ユーザーが「現状」「進捗」「今どうなっているか」「状況を報告して」など現在状態を聞いた場合は、必ず下の【現在の事実データ】だけを根拠に答えてください。
                      過去の要約、直近会話、共有ナレッジは古い可能性があります。現在の事実データと矛盾する場合は、現在の事実データを必ず優先してください。
                      事実データに記載されている停滞理由・タスク名・時刻は、求められたら省略せずそのまま用いること（不明扱いにしないこと）。
                      事実データに無い未来予測・主観評価は推測しないでください。分からない項目だけ「このデータ上では確認できません」と明示してください。

                      【現在の最重要事実（必ず最優先で参照）】
                      ${ctx.topStatusSummary}

                      【現在の事実データ（最優先）】
                      プロジェクト内タスク概要:
                      ${ctx.currentTaskTitle}

                      対象ユーザーの現在タスク詳細・現在ステータス・直近ステータス履歴（停滞報告は該当タスク行に括弧書きで内包）:
                      ${ctx.currentTaskDetail}

                      停滞経過ラベル:
                      ${ctx.stagnationElapsedLabel ?? 'なし'}

                      進捗吹き出し・停滞報告・要相談ログ等（アプリ内の進捗報告系データ）:
                      ${ctx.progressAndReportsBlock}

                      【補助データ（現状報告では現在事実より低優先）】
                      過去の相談要約:
                      ${summaryBlock}

                      直近の会話履歴:
                      ${transcriptBlock}

                      共有ナレッジ:
                      ${sharedHintBlock}

                      【回答ルール】
                      1. 現状/進捗/停滞に関する質問では、上記「現在の最重要事実」と「現在の事実データ」に記載された停滞理由・タスク名・時刻・吹き出し・進捗ラウンドの内容を必ず取り込んで答える。停滞がある場合は理由を引用すること。
                      2. 「順調そう」「たぶん完了」など、データにない評価や推測は書かない。
                      3. 悩み・解決策を求められたら、現在の事実を前提に、共有ナレッジとあなたの知識を使って具体的な次の一手を提案する。
                      4. 共有ナレッジを使う場合は、現在の事実と混同せず「過去の参考例として」と分かるように述べる。
                      5. メンバー向けモードでは、共有ナレッジ・要相談抜粋から人物を推測しても本文に名前や肩書で特定しないこと。
                      6. 簡潔な日本語で、聞かれたことに直接答える。

                      ユーザーの最新メッセージ:
                      ${latestUserMessage || '現状を教えてください。'}`
            }
          ]
        }
      ]
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        assistantText: `Gemini API エラー (${res.status}): ${errText.slice(0, 400)}`
      };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      '（回答を取得できませんでした）';
    return { assistantText: text };
  }

  private async persistMessages(): Promise<void> {
    const pid = this.projectIdOpen();
    const mid = this.memberIdOpen();
    if (!pid || !mid) return;
    const xs = this.messages();
    const capped = xs.length > 240 ? xs.slice(-240) : xs;
    await this.storage.saveAiMessages(pid, mid, this.currentChatRoomOwnerId(mid), capped);
  }

  private async persistSharedKnowledge(ctx: ChatContext, userText: string, assistantText: string): Promise<void> {
    const entry: SharedKnowledgeEntry = {
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      memberId: ctx.memberId,
      memberName: ctx.memberName,
      taskSummary: ctx.currentTaskDetail || ctx.currentTaskTitle,
      userText: userText.trim(),
      assistantText: assistantText.trim(),
      at: Date.now()
    };
    await this.storage.addAiSharedKnowledge(ctx.projectId, entry);
  }

  private searchSharedHints(projectId: string, query: string): SharedKnowledgeEntry[] {
    const list = this.storage.getAiSharedKnowledge(projectId);
    if (list.length === 0) return [];
    const q = this.normalizeForMatch(query);
    if (!q) return [...list].slice(-3).reverse();

    const queryTokens = this.extractQueryTokens(q);
    const now = Date.now();
    const scored = list
      .map((x) => {
        const user = this.normalizeForMatch(x.userText);
        const asst = this.normalizeForMatch(x.assistantText);
        const task = this.normalizeForMatch(x.taskSummary);
        const all = `${user} ${asst} ${task}`;

        let score = 0;
        // 強一致（悩み文そのものに近い過去事例）を優先
        if (user.includes(q)) score += 6;
        if (task.includes(q)) score += 4;
        if (all.includes(q)) score += 2;

        // キーワード一致（task > user > assistant の順に重み）
        for (const tk of queryTokens) {
          if (task.includes(tk)) score += 3;
          if (user.includes(tk)) score += 2;
          if (asst.includes(tk)) score += 1;
        }

        // 新しい知見を少し優先（最大 +2）
        const ageDays = Math.max(0, (now - x.at) / 86400000);
        score += Math.max(0, 2 - ageDays * 0.12);

        return { x, score };
      })
      .filter((r) => r.score >= 2)
      .sort((a, b) => b.score - a.score || b.x.at - a.x.at)
      .map((r) => r.x);
    if (scored.length > 0) return scored;
    return [...list].slice(-3).reverse();
  }

  private normalizeForMatch(s: string): string {
    return s
      .toLowerCase()
      .replace(/[「」『』（）()［］\[\]【】]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractQueryTokens(q: string): string[] {
    const stop = new Set(['です', 'ます', 'する', 'した', 'こと', 'ため', 'よう', 'これ', 'それ', 'どこ', 'なぜ', 'どう']);
    const words = q
      .split(/[\s、。,.!?！？:：;；/／-]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && !stop.has(x));
    // 日本語連文でも一致しやすいように 2-gram を補助トークンとして追加
    const compact = q.replace(/\s+/g, '');
    const bi: string[] = [];
    for (let i = 0; i < compact.length - 1; i += 1) {
      const g = compact.slice(i, i + 2);
      if (g.length === 2 && !stop.has(g)) bi.push(g);
    }
    return [...new Set([...words, ...bi].filter((x) => x.length >= 2))].slice(0, 36);
  }

  private currentTaskDetail(projectId: string, memberId: string, stagnationMap: Map<string, StagnationEntry[]>): string {
    const child = this.app.childTasks
      .filter((c) => c.projectId === projectId && c.assigneeId === memberId && c.status !== '完了')
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'))[0];
    let base: string;
    if (child) {
      const parent = this.app.parentTasks.find((p) => p.id === child.parentTaskId);
      const p = parent?.title || '（親タスク不明）';
      const tag = this.stagnationInlineTag(stagnationMap.get(this.stagnationKey(child.parentTaskId, child.id)));
      base = `子タスク「${child.title || '（無題）'}」(親: ${p}) / ステータス: ${child.status}${tag}`;
    } else {
      const parent = this.app.parentTasks.find(
        (p) =>
          p.projectId === projectId &&
          p.status !== '完了' &&
          (p.leadAssigneeId === memberId || p.memberIds.includes(memberId))
      );
      if (parent) {
        const tag = this.stagnationInlineTag(stagnationMap.get(this.stagnationKey(parent.id, null)));
        base = `親タスク「${parent.title || '（無題）'}」 / ステータス: ${parent.status}${tag}`;
      } else {
        base = '現在進行中タスクは特定できませんでした。';
      }
    }
    const now = new Date().toLocaleString('ja-JP'); // 現在時刻を取得
    const hist = this.app.getRecentTaskStatusChangeLines(projectId, memberId, 8);
    const peerHist = this.app.getRecentPeerTaskStatusChangeLines(projectId, memberId, 8);
    const activeTaskLines = this.currentActiveTaskLines(projectId, memberId, stagnationMap);
    const blocks = [
      `現在時刻: ${now}`, // AIに「今」がいつか教える
      base
    ];
    if (activeTaskLines) blocks.push(`【対象ユーザーの未完了タスク一覧】\n${activeTaskLines}`);
    if (hist) blocks.push(`【直近のステータス変更】\n${hist}`);
    if (peerHist) blocks.push(`【同一プロジェクトの他メンバー動向】\n${peerHist}`);
    return blocks.join('\n');
  }

  private currentActiveTaskLines(projectId: string, memberId: string, stagnationMap: Map<string, StagnationEntry[]>): string {
    const childLines = this.app.childTasks
      .filter((c) => c.projectId === projectId && c.assigneeId === memberId && c.status !== '完了')
      .map((c) => {
        const parent = this.app.parentTasks.find((p) => p.id === c.parentTaskId);
        const tag = this.stagnationInlineTag(stagnationMap.get(this.stagnationKey(c.parentTaskId, c.id)));
        return `- 子「${c.title || '（無題）'}」 / 親「${parent?.title || '（親タスク不明）'}」 / 現在ステータス: ${c.status}${tag}`;
      });
    const childParentIds = new Set(
      this.app.childTasks
        .filter((c) => c.projectId === projectId && c.assigneeId === memberId)
        .map((c) => c.parentTaskId)
    );
    const parentLines = this.app.parentTasks
      .filter(
        (p) =>
          p.projectId === projectId &&
          p.status !== '完了' &&
          !childParentIds.has(p.id) &&
          (p.leadAssigneeId === memberId || p.memberIds.includes(memberId))
      )
      .map((p) => {
        const tag = this.stagnationInlineTag(stagnationMap.get(this.stagnationKey(p.id, null)));
        return `- 親「${p.title || '（無題）'}」 / 現在ステータス: ${p.status}${tag}`;
      });
    return [...childLines, ...parentLines].slice(0, 12).join('\n');
  }

  private fallbackMergeConversationSummary(prev: string, userText: string, assistantText: string): string {
    const line = `- ${userText.slice(0, 160)} → ${assistantText.slice(0, 240)}`;
    const merged = prev ? `${prev}\n${line}` : line;
    return merged.length > 4500 ? merged.slice(-4500) : merged;
  }

  private async mergeConversationSummaryWithGemini(
    prev: string,
    userText: string,
    assistantText: string,
    apiKey: string
  ): Promise<string> {
    const model = getGeminiModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt = `あなたは要約担当です。過去の相談要約と新しい1往復のチャットを統合し、今後の相談に役立つ日本語にまとめてください（600文字以内）。前置きや説明文は書かないこと。

過去の要約:
${prev || '（なし）'}

新しいやりとり:
ユーザー: ${userText}
アシスタント: ${assistantText}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`summary ${res.status}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')?.trim() ?? '';
    return text || this.fallbackMergeConversationSummary(prev, userText, assistantText);
  }

  private async refreshConversationSummary(ctx: ChatContext, userText: string, assistantText: string): Promise<void> {
    const prev = this.storage.getAiMemberContext(ctx.projectId, ctx.memberId, this.currentChatRoomOwnerId(ctx.memberId)).conversationSummary;
    const apiKey = getGeminiApiKey();
    let next: string;
    if (apiKey) {
      try {
        next = await this.mergeConversationSummaryWithGemini(prev, userText, assistantText, apiKey);
      } catch {
        next = this.fallbackMergeConversationSummary(prev, userText, assistantText);
      }
    } else {
      next = this.fallbackMergeConversationSummary(prev, userText, assistantText);
    }
    const capped = next.length > 6000 ? next.slice(-6000) : next;
    await this.storage.saveAiConversationSummary(ctx.projectId, ctx.memberId, this.currentChatRoomOwnerId(ctx.memberId), capped);
  }

  private syncThinkingSnippet(): void {
    const pid = this.projectIdOpen();
    const mid = this.memberIdOpen();
    if (!pid || !mid) return;
    this.progress.patchThinkingFromChat(pid, mid, this.messages());
  }

  private heuristicInference(assistantText: string): ProgressBubbleKind | undefined {
    const t = assistantText;
    if (/問題なし|解決|完了しました|順調に進んで/.test(t)) return '問題なし';
    if (/停滞|ブロック|止まって|難航/.test(t)) return '停滞中';
    if (/検討|考え中|少し時間/.test(t)) return '考え中';
    return undefined;
  }

  /** 進捗確認「要相談」ログをメンバー別に箇条書き要約（API 未設定時は箇条書きのみ） */
  async summarizeConsultationEntries(entries: ConsultationLogEntry[], projectId: string): Promise<string> {
    if (!entries.length) return '';
    const rawLines = entries.map((e) => {
      const tasks = e.noChangeOnly
        ? '現状変化なし'
        : e.parentTaskIds
            .map((id) => this.app.parentTasks.find((p) => p.id === id && p.projectId === projectId)?.title || id)
            .join('、');
      return `${e.memberName}／対象: ${tasks}／相談: ${e.content.replace(/\s+/g, ' ').trim()}`;
    });
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return rawLines.map((l) => `・${l}`).join('\n');
    }
    const model = getGeminiModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt = `以下はタスク管理アプリのメンバーからの「要相談」報告です。管理者向けに、メンバーごとに1行ずつ「・」で始まる箇条書き（日本語・簡潔・最大${Math.min(12, entries.length + 6)}行）に要約してください。前置きや説明文は書かないこと。

${rawLines.join('\n')}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
      });
      if (!res.ok) {
        return rawLines.map((l) => `・${l}`).join('\n');
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')?.trim() ?? '';
      return text || rawLines.map((l) => `・${l}`).join('\n');
    } catch {
      return rawLines.map((l) => `・${l}`).join('\n');
    }
  }
}
