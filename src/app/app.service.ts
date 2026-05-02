//サービスファイル

import { Injectable } from '@angular/core';

import { Project, ParentTask, ChildTask, Member, TaskStatus, Priority, MemberBurdenSummary } from './core/interface';

import { Router } from '@angular/router';



@Injectable({

    providedIn: 'root'

})

export class AppService {



    projectId: string = crypto.randomUUID();

    projects: Project[] = [];

    parentTasks: ParentTask[] = [];

    childTasks: ChildTask[] = [];

    members: Member[] = [];



    constructor(private router: Router) {}



    createProject(projectName: string, adminId: string, selectedMemberIds: string[]): void {

        if (!projectName?.trim()) {

            alert('プロジェクト名を入力してください');

            return;

        }

        if (!selectedMemberIds?.length) {

            alert('メンバーを1人以上選択してください');

            return;

        }

        const newProjectId = crypto.randomUUID();

        this.projects.push({

            id: newProjectId,

            name: projectName.trim(),

            adminId: adminId || selectedMemberIds[0],

            memberIds: [...selectedMemberIds]

        });

        this.projectId = newProjectId;

        this.router.navigate(['/admin/manage-tasks', newProjectId]);

    }



    /** 緊急 ON → 優先度「高」 */

    CreateParentTask(

        projectId: string,

        title: string,

        deadline: Date | string | null,

        isUrgent: boolean,

        leadAssigneeId: string | null,

        memberIds: string[],

        isShared: boolean,

        description: string,

        isTodayTask: boolean = false,

        createdById: string | null = null

    ): void {

        if (!title?.trim()) {

            alert('タイトルを入力してください');

            return;

        }



        const hasLead = !!leadAssigneeId;

        const isDraft = !deadline || !hasLead;



        const priority: Priority = isUrgent ? '高' : '通常';



        this.parentTasks.push({

            id: crypto.randomUUID(),

            projectId,

            title: title.trim(),

            deadline: deadline || null,

            priority,

            leadAssigneeId: hasLead ? leadAssigneeId : null,

            memberIds: hasLead ? memberIds.filter((id) => id !== leadAssigneeId) : [],

            status: '未着手',

            description: description ?? '',

            isShared,

            isDraft,

            isTodayTask,

            createdById: createdById ?? null

        });

    }



    CreateChildTask(

        projectId: string,

        parentTaskId: string,

        title: string,

        assigneeId: string,

        isTodayTask: boolean = false

    ): void {

        if (!title?.trim()) {

            alert('子タスクのタイトルを入力してください');

            return;

        }

        if (!assigneeId) {

            alert('担当メンバーを選択してください');

            return;

        }



        this.childTasks.push({

            id: crypto.randomUUID(),

            parentTaskId,

            projectId,

            title: title.trim(),

            assigneeId,

            status: '未着手',

            isUrgent: false,

            isTodayTask

        });

        this.syncParentStatusWithChildren(parentTaskId);

    }



    setChildTaskStatus(childTaskId: string, status: TaskStatus): void {

        const child = this.childTasks.find((c) => c.id === childTaskId);

        if (!child) return;

        child.status = status;

        this.syncParentStatusWithChildren(child.parentTaskId);

    }



    setParentTaskStatus(parentTaskId: string, status: TaskStatus): void {

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return;

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        if (status === '完了' && children.length > 0 && !children.every((c) => c.status === '完了')) {

            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');

            return;

        }

        parent.status = status;

    }



    /**

     * 子タスクの状況に応じて親を同期。

     * - 子が全て完了 → 親も完了

     * - いずれかが進行中 → 親は進行中

     * - 全て未着手 → 親は未着手

     * - 上記以外の混在 → 親は進行中

     */

    private syncParentStatusWithChildren(parentTaskId: string): void {

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent || children.length === 0) return;



        const allDone = children.every((c) => c.status === '完了');

        const anyProgress = children.some((c) => c.status === '進行中');

        const allTodo = children.every((c) => c.status === '未着手');



        if (allDone) {

            parent.status = '完了';

        } else if (anyProgress) {

            parent.status = '進行中';

        } else if (allTodo) {

            parent.status = '未着手';

        } else {

            parent.status = '進行中';

        }

    }



    /** 巨大ボタン用：親タスクのステータスを 未着手→進行中→完了→… と進める */

    /**cycleParentTaskStatus(parentTaskId: string): void {

        const parent = this.parentTasks.find((p) => p.id === parentTaskId);

        if (!parent) return;

        const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

        const order: TaskStatus[] = ['未着手', '進行中', '完了'];

        const idx = order.indexOf(parent.status);

        const next = order[(idx + 1) % order.length];

        if (next === '完了' && children.length > 0 && !children.every((c) => c.status === '完了')) {

            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');

            return;

        }

        parent.status = next;

    }



     巨大ボタン用：子タスクのステータスを循環 

    cycleChildTaskStatus(childTaskId: string): void {

        const child = this.childTasks.find((c) => c.id === childTaskId);

        if (!child) return;

        const order: TaskStatus[] = ['未着手', '進行中', '完了'];

        const idx = order.indexOf(child.status);

        child.status = order[(idx + 1) % order.length];

        this.syncParentStatusWithChildren(child.parentTaskId);

    } */

    /** 巨大ボタン用：親タスクのステータスを進める */
cycleParentTaskStatus(parentTaskId: string): void {
    const parent = this.parentTasks.find((p) => p.id === parentTaskId);
    if (!parent) return;

    // すでに「完了」なら、このボタンでは何もしない（ループさせない）
    if (parent.status === '完了') return;

    const children = this.childTasks.filter((c) => c.parentTaskId === parentTaskId);
    const order: TaskStatus[] = ['未着手', '進行中', '完了'];
    const idx = order.indexOf(parent.status);
    const next = order[idx + 1]; // モジュロ演算 (%) を外して、完了で止まるように変更

    if (next === '完了') {
        if (children.length > 0 && !children.every((c) => c.status === '完了')) {
            alert('すべての子タスクが完了になるまで、親タスクを完了にできません。');
            return;
        }
        // 完了した瞬間を記録
        parent.completedAt = new Date().toISOString();
    }

    parent.status = next;
}

/** 巨大ボタン用：子タスクのステータスを循環 */
cycleChildTaskStatus(childTaskId: string): void {
    const child = this.childTasks.find((c) => c.id === childTaskId);
    if (!child) return;

    // すでに「完了」なら、このボタンでは何もしない
    if (child.status === '完了') return;

    const order: TaskStatus[] = ['未着手', '進行中', '完了'];
    const idx = order.indexOf(child.status);
    const next = order[idx + 1];

    if (next === '完了') {
        child.completedAt = new Date().toISOString();
    }

    child.status = next;
    this.syncParentStatusWithChildren(child.parentTaskId);
}



    getMembersByProjectId(projectId: string): Member[] {

        const project = this.projects.find((p) => p.id === projectId);

        if (!project || !project.memberIds) {

            return [];

        }

        return this.members.filter((member) => project.memberIds.includes(member.uid));

    }



    getMembersByUids(uids: (string | null | undefined)[]): Member[] {

        const set = new Set(uids.filter((u): u is string => !!u));

        return this.members.filter((m) => set.has(m.uid));

    }



    getMemberById(uid: string | null | undefined): Member | undefined {

        if (!uid) return undefined;

        return this.members.find((m) => m.uid === uid);

    }



    filterChildTasksByAssigneeId(assigneeId: string): Member | undefined {

        return this.getMemberById(assigneeId);

    }



    getChildTasksByParentId(parentTaskId: string): ChildTask[] {

        return this.childTasks.filter((c) => c.parentTaskId === parentTaskId);

    }



    /** プロジェクトに属する親タスク（絞り込み用・下書き含む） */

    getAllParentTasksForProject(projectId: string): ParentTask[] {

        return this.parentTasks.filter((t) => t.projectId === projectId);

    }



    patchParentTask(

        taskId: string,

        patch: Partial<

            Pick<

                ParentTask,

                'title' | 'description' | 'deadline' | 'leadAssigneeId' | 'memberIds' | 'priority' | 'isTodayTask' | 'createdById'

            >

        >

    ): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        if (patch.title !== undefined) t.title = patch.title.trim();

        if (patch.description !== undefined) t.description = patch.description;

        if (patch.deadline !== undefined) t.deadline = patch.deadline;

        if (patch.leadAssigneeId !== undefined) t.leadAssigneeId = patch.leadAssigneeId;

        if (patch.memberIds !== undefined) t.memberIds = [...patch.memberIds];

        if (patch.priority !== undefined) t.priority = patch.priority;

        if (patch.isTodayTask !== undefined) t.isTodayTask = patch.isTodayTask;

        if (patch.createdById !== undefined) t.createdById = patch.createdById;

        this.recalcParentDraft(t);

    }



    /** チェック順で担当・メンバーを更新 */

    setParentMemberOrder(taskId: string, orderedMemberUids: string[]): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (!t) return;

        const lead = orderedMemberUids[0] ?? null;

        t.leadAssigneeId = lead;

        t.memberIds = lead ? orderedMemberUids.slice(1).filter((id) => id !== lead) : [];

        this.recalcParentDraft(t);

    }



    private recalcParentDraft(t: ParentTask): void {

        t.isDraft = !(t.deadline && t.leadAssigneeId);

    }



    deleteParentTask(taskId: string): void {

        this.parentTasks = this.parentTasks.filter((p) => p.id !== taskId);

        this.childTasks = this.childTasks.filter((c) => c.parentTaskId !== taskId);

    }



    patchChildTask(childId: string, patch: Partial<Pick<ChildTask, 'title' | 'assigneeId' | 'isTodayTask'>>): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        if (patch.title !== undefined) c.title = patch.title.trim();

        if (patch.assigneeId !== undefined) c.assigneeId = patch.assigneeId;

        if (patch.isTodayTask !== undefined) c.isTodayTask = patch.isTodayTask;

        this.syncParentStatusWithChildren(c.parentTaskId);

    }



    deleteChildTask(childId: string): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (!c) return;

        const parentId = c.parentTaskId;

        this.childTasks = this.childTasks.filter((x) => x.id !== childId);

        this.syncParentStatusWithChildren(parentId);

    }



    toggleParentTodayTask(taskId: string): void {

        const t = this.parentTasks.find((p) => p.id === taskId);

        if (t) t.isTodayTask = !t.isTodayTask;

    }



    toggleChildTodayTask(childId: string): void {

        const c = this.childTasks.find((x) => x.id === childId);

        if (c) c.isTodayTask = !c.isTodayTask;

    }



    /** 同一プロジェクト内の親タスクを表示用にソート（高優先度 → 期限昇順） */

    getSortedParentTasksForProject(projectId: string, includeDraft: boolean): ParentTask[] {

        const list = this.parentTasks.filter((t) => t.projectId === projectId && (includeDraft || !t.isDraft));

        return list.sort((a, b) => {

            const pr = a.priority === '高' ? 0 : 1;

            const qr = b.priority === '高' ? 0 : 1;

            if (pr !== qr) return pr - qr;

            const ad = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;

            const bd = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;

            return ad - bd;

        });

    }



    createMember(name: string, email: string, photoURL: string, role: '' |'メンバー' | 'ゲスト'): void {

        if (!name?.trim() || !email?.trim()) {

            alert('名前とメールアドレスを入力してください');

            return;

        }

        this.members.push({

            uid: crypto.randomUUID(),

            name: name.trim(),

            email: email.trim(),

            photoURL: photoURL || '',

            role: role

        });

    }



    /** ローカル日の 0:00（期限は日付のみで比較） */
    private static startOfLocalDay(d: Date): Date {

        const x = new Date(d.getTime());

        x.setHours(0, 0, 0, 0);

        return x;

    }



    private static todayLocalStart(): Date {

        return AppService.startOfLocalDay(new Date());

    }



    /** 未完了タスク1件分の期限区分（時刻は無視し日付のみ） */
    private classifyDeadlineForBurden(deadline: Date | string | null | undefined): 'overdue' | 'today' | 'other' {

        const today = AppService.todayLocalStart();

        if (deadline === null || deadline === undefined) {

            return 'other';

        }

        if (typeof deadline === 'string' && !deadline.trim()) {

            return 'other';

        }

        const raw = new Date(deadline as Date | string);

        if (Number.isNaN(raw.getTime())) {

            return 'other';

        }

        const day = AppService.startOfLocalDay(raw);

        const tt = today.getTime();

        const td = day.getTime();

        if (td < tt) {

            return 'overdue';

        }

        if (td === tt) {

            return 'today';

        }

        return 'other';

    }



    /** メンバーが親タスクの担当に含まれるか（リードまたはメンバー一覧） */
    memberAssignedToParent(task: ParentTask, memberId: string): boolean {

        return task.leadAssigneeId === memberId || task.memberIds.includes(memberId);

    }



    /**

     * プロジェクト内メンバーの負担度集計。

     * スコア = 期限切れ×5 + 本日期限×3 + その他未完了×1

     * 親は下書き以外・未完了のみ。子は担当の未完了のみ。

     */
    getMemberBurdenSummaries(projectId: string): MemberBurdenSummary[] {

        const members = this.getMembersByProjectId(projectId);

        const parents = this.parentTasks.filter((t) => t.projectId === projectId && !t.isDraft);

        //const children = this.childTasks.filter((c) => c.projectId === projectId);

        const result: MemberBurdenSummary[] = [];

        for (const m of members) {

            let overdueCount = 0;

            let dueTodayCount = 0;

            let otherIncompleteCount = 0;

            const incompleteTaskTitles: string[] = [];

            for (const p of parents) {

                if (!this.memberAssignedToParent(p, m.uid)) {

                    continue;

                }

                if (p.status === '完了') {

                    continue;

                }

                const bucket = this.classifyDeadlineForBurden(p.deadline);

                if (bucket === 'overdue') {

                    overdueCount++;

                } else if (bucket === 'today') {

                    dueTodayCount++;

                } else {

                    otherIncompleteCount++;

                }

                incompleteTaskTitles.push(p.title?.trim() || '（無題）');

            }
           /** 
            for (const c of children) {

                if (c.assigneeId !== m.uid) {

                    continue;

                }

                if (c.status === '完了') {

                    continue;

                }

                const bucket = this.classifyDeadlineForBurden(c.deadline);

                if (bucket === 'overdue') {

                    overdueCount++;

                } else if (bucket === 'today') {

                    dueTodayCount++;

                } else {

                    otherIncompleteCount++;

                }

                incompleteTaskTitles.push(c.title?.trim() || '（無題）');

            }*/

            const score = overdueCount * 5 + dueTodayCount * 3 + otherIncompleteCount * 1;

            result.push({

                memberId: m.uid,

                score,

                overdueCount,

                dueTodayCount,

                otherIncompleteCount,

                incompleteTaskTitles

            });

        }

        result.sort((a, b) => {

            if (b.score !== a.score) {

                return b.score - a.score;

            }

            return a.memberId.localeCompare(b.memberId);

        });

        return result;

    }

}

