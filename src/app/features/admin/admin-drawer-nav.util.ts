import { Router } from '@angular/router';

export type AdminDrawerNavTarget = 'manage' | 'ops' | 'shared' | 'completed';

const match = { paths: 'exact' as const, queryParams: 'ignored' as const, matrixParams: 'ignored' as const, fragment: 'ignored' as const };

/** 右ドロワー用: その admin ページにいるときは同じ先のリンクを出さない */
export function showAdminDrawerLink(router: Router, projectId: string, target: AdminDrawerNavTarget): boolean {
    const commands: Record<AdminDrawerNavTarget, [string, string]> = {
        manage: ['/admin/manage-tasks', projectId],
        ops: ['/admin/ops-status', projectId],
        shared: ['/admin/shared-tasks', projectId],
        completed: ['/admin/completed-tasks', projectId],
    };
    return !router.isActive(router.createUrlTree(commands[target]), match);
}
