import type { AppService } from '../../app.service';
import type { MemberTaskRouteMode } from '../../features/member/member-task-route-context';

export function showProjectTopMemberEdit(
    app: AppService,
    mode: MemberTaskRouteMode,
    projectId: string,
    memberId: string
): boolean {
    if (mode === 'personal') return false;
    const adminId = app.getProjectAdminId(projectId);
    return !!adminId && adminId === memberId;
}
