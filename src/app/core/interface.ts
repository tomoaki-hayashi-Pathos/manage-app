//データ型定義

//プロジェクト

export interface Project {

    id: string,

    name: string,

    adminId: string,

    memberIds: string[],

    /** 個人専用（責任者のみ参加） */
    isPersonal?: boolean

}



/** メンバー画面の設定メニュー別・通知カウント用 */
export type MemberNavPageKey = 'today' | 'limit' | 'not-set' | 'completed' | 'shared';

/** 管理画面のドロワー・通知カウント用 */
export type AdminNavPageKey = 'shared' | 'completed';

export type TaskStatus = '未着手' | '進行中' | '完了';

export type Priority = '高' | '通常';

/** メンション宛先として mentionUserIds に格納するトークン */
export const MENTION_ALL = '@all';

export const MENTION_ADMIN = '@admin';



//親タスク

export interface ParentTask {

    id: string,

    projectId: string,

    title: string,

    deadline: Date | null | string,

    /** 緊急ランプ ON = 高。一覧で最上部に並べる */

    priority: Priority,

    /** 最初にチェックした担当（責任者） */

    leadAssigneeId: string | null,

    /** 2人目以降のメンバー */

    memberIds: string[],

    status: TaskStatus,

    description: string,

    /** メンションがある場合 true（mentionUserIds を基準に更新） */
    isShared: boolean,

    isDraft: boolean,

    /** メンバー画面の MY 判定（作成者）。管理者作成のみの場合は null 可 */
    createdById: string | null,

    //今日やるタスク
    isTodayTask: boolean,

    /** 共有メンション先（個別UID / @all / @admin） */
    mentionUserIds: string[],

    /** 一覧の並び順（小さいほど上） */
    displayOrder?: number,
    /** today-tasks 専用のメンバー別並び順 */
    todayDisplayOrder?: Record<string, number>,

    /** 完了にした操作者のUID */
    completedBy?: string,

    //タスク完了時間
    completedAt?: string;
}



//子タスク

export interface ChildTask {

    id: string,

    parentTaskId: string,

    projectId: string,

    title: string,

    assigneeId: string,

    status: TaskStatus,

    deadline?: Date | null | string,

    isUrgent: boolean,

    //今日やるタスク
    isTodayTask: boolean,

    /** 実施予定日（日単位。「いつやるか」／親の期限内のみ） */
    scheduledDate?: Date | null | string,
    /** today-tasks 専用のメンバー別並び順 */
    todayDisplayOrder?: Record<string, number>,

    //タスク完了時間
    completedAt?: string;

}



/** 明示的な親／子ステータス変更のログ（AI コンテキスト・履歴表示用） */
export interface TaskStatusChangeLogEntry {
    id: string;
    at: number;
    projectId: string;
    kind: 'parent' | 'child';
    taskId: string;
    parentTaskId: string;
    title: string;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    actorMemberUid?: string | null;
}



//メンバー

export interface Member {

    uid: string,

    name: string,

    email: string,

    photoURL: string,
    // ロール（管理画面アクセス可否の判定にも利用）
    role: '' | '管理者' | 'メンバー' | 'ゲスト'

}

export interface PendingLoginMember {
    uid: string,
    name: string,
    email: string,
    photoURL: string,
    requestedAt: number
}

/** 期限未設定ページで「確定」前に保持する編集状態（AppService の実データは確定まで変更しない） */
export type WorkingTaskState = {

    isToday: boolean,

    /** datetime-local 用の文字列 */
    deadlineInput: string

}

/** チーム稼働状況ダッシュボード用・メンバー別負担集計 */
export interface MemberBurdenSummary {

    memberId: string,

    score: number,

    overdueCount: number,

    dueTodayCount: number,

    otherIncompleteCount: number,

    /** 未完了タスクのタイトル（親・子の合算・ホバー一覧用） */
    incompleteTaskTitles: string[]

}

