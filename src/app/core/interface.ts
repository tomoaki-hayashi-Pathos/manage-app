//データ型定義

//プロジェクト

export interface Project {

    id: string,

    name: string,

    adminId: string,

    memberIds: string[]

}



export type TaskStatus = '未着手' | '進行中' | '完了';

export type Priority = '高' | '通常';



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

    isShared: boolean,

    isDraft: boolean,

    /** メンバー画面の MY 判定（作成者）。管理者作成のみの場合は null 可 */
    createdById: string | null,

    //今日やるタスク
    isTodayTask: boolean,

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

    //タスク完了時間
    completedAt?: string;

}



//メンバー

export interface Member {

    uid: string,

    name: string,

    email: string,

    photoURL: string,
    //ログイン機能ができるまでは管理者は空白でいく
    role: '' | 'メンバー' | 'ゲスト'

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

