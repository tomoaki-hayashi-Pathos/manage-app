/** 進捗報告・AI 相談（タスク CRUD とは独立したドメイン） */

export type ProgressInitialChoice = 'もう終わる' | '問題なし' | '要相談';

/** 進捗確認直前のメンバー状態（回答待ち中は表示用に保持） */
export interface ProgressMemberSnapshot {
  bubbleShort: string;
  detailForHover: string;
  rowFallbackShort: string;
  rowFallbackDetail: string;
  stagnationSessionStartedAt: number | null;
  stagnations: StagnationEntry[];
  resolvedStagnationAnchors?: { parentTaskId: string; childTaskId: string | null }[];
  thinkingSinceAt: number | null;
  thinkingChatSnippet: string;
  thinkingDetailLong: string;
}

/** メンバーが進捗確認「要相談」で送信した相談ログ */
export interface ConsultationLogEntry {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string;
  parentTaskIds: string[];
  noChangeOnly: boolean;
  content: string;
  at: number;
}

/** プロジェクト単位の相談ログと管理の確認済み時刻 */
export interface ConsultationProjectBundle {
  entries: ConsultationLogEntry[];
  adminDismissedAt: number;
}

/** 親タスク変更のメンバー向け AI 吹き出し1件 */
export interface MemberTaskChangeEntry {
  id: string;
  message: string;
  at: number;
}

/** メンバー×プロジェクト単位の変更通知バンドル */
export interface MemberTaskChangeBundle {
  entries: MemberTaskChangeEntry[];
  memberDismissedAt: number;
}

/** 責任者向け：メンバーによる親タスク変更通知バンドル */
export interface AdminTaskChangeBundle {
  entries: MemberTaskChangeEntry[];
  adminDismissedAt: number;
}

export type ProgressBubbleKind =
  | '問題なし'
  | '考え中'
  | '停滞中'
  | 'もう終わる'
  | '質問中';

export interface ProgressRound {
  id: string;
  projectId: string;
  createdAt: number;
}

/** 1 件の停滞（管理側吹き出しの経過は startedAt 基準） */
export interface StagnationEntry {
  id: string;
  parentTaskId: string;
  childTaskId: string | null;
  reason: string;
  startedAt: number;
}

export interface MemberProgressRoundState {
  roundId: string;
  stage: 'idle' | 'awaiting_initial' | 'deferred_ai' | 'done';
  initialChoice?: ProgressInitialChoice;
  bubbleShort: string;
  detailForHover: string;
  /**
   * 停滞が付いていないタスク行・親サマリ用の表示ベース（初期の「問題なし」「もう終わる」等）。
   * bubbleShort が「停滞中！」でも、該当タスクに停滞エントリがなければこちらを出す。
   */
  rowFallbackShort?: string;
  rowFallbackDetail?: string;
  /** メンバー画面上部「停滞から〜」用。最初の停滞が付いた時刻。全件解決まで据え置き */
  stagnationSessionStartedAt: number | null;
  stagnations: StagnationEntry[];
  /**
   * 直近に解消した停滞の行（親／子）。吹き出しで「停滞を解決しました。」をその行のみに出す。
   * 新しい停滞報告または次の進捗確認ラウンドでクリア。
   */
  resolvedStagnationAnchors?: { parentTaskId: string; childTaskId: string | null }[];
  /** 「考え中」になった時刻（1時間ナudge判定用） */
  thinkingSinceAt: number | null;
  /** ホバー用短文（AI ログから最大約 15 文字） */
  thinkingChatSnippet: string;
  /** ホバー展開用のやや長い要約 */
  thinkingDetailLong: string;
  /** 管理が進捗確認を送った直前の状態（回答待ち解除時に復元） */
  preResponseSnapshot?: ProgressMemberSnapshot | null;
  /** 進捗確認「もう終わる」で選択したアンカー（キー: parentId::childId 空は親行） */
  anchorDoneKeys?: string[];
  /**
   * 進捗確認回答時点で fan-out 対象だった行（parentId::childId、親のみは child 空）。
   * 含まれない進行中行は「進行中」吹き出し until 次ラウンド等。
   */
  fanoutCoveredKeys?: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface SharedKnowledgeEntry {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string;
  taskSummary: string;
  userText: string;
  assistantText: string;
  at: number;
}

/** AI 相談チャットの閲覧者（プロンプトの匿名化方針に使用） */
export type ChatViewerRole = 'admin' | 'member';

export interface ChatContext {
  projectId: string;
  memberId: string;
  memberName: string;
  /** 管理者は実名ベースの補助データ、メンバーは事例の匿名ヒント方針 */
  viewerRole: ChatViewerRole;
  currentTaskTitle: string;
  stagnationElapsedLabel: string | null;
  history: ChatMessage[];
  /** 現在タスクの説明・直近ステータス履歴を含む */
  currentTaskDetail: string;
  /** プロンプト冒頭に出す最重要事実の1〜数行サマリー（停滞理由を含む） */
  topStatusSummary: string;
  /** 進捗吹き出し・停滞・要相談ログ・（管理者のみ）他メンバー状況の整形済みテキスト */
  progressAndReportsBlock: string;
  personalRecent: ChatMessage[];
  sharedHints: SharedKnowledgeEntry[];
  /** appKv に保存した会話要約 */
  conversationSummary: string;
}

export interface ChatReply {
  assistantText: string;
  inferredBubble?: ProgressBubbleKind;
}

export type ChatOutcomeCallback = (projectId: string, memberId: string, reply: ChatReply) => void;
