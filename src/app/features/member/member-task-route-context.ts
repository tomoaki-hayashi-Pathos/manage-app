import { ActivatedRoute, Router } from '@angular/router';
import { AppService } from '../../app.service';
import { AuthSessionService } from '../../services/auth-session.service';
import type { MemberAccessService } from '../../services/member-access.service';

export type MemberTaskRouteMode = 'team' | 'adminSelf' | 'personal';

export function readMemberTaskRouteMode(route: ActivatedRoute): MemberTaskRouteMode {
    const raw = route.snapshot.data['memberPage'];
    if (raw === 'personal') return 'personal';
    if (raw === 'adminSelf') return 'adminSelf';
    return 'team';
}

/** メンバー系画面の projectId / memberId をルート種別に応じて解決する */
export class MemberTaskRouteContext {
    constructor(
        private readonly route: ActivatedRoute,
        private readonly app: AppService,
        private readonly auth: AuthSessionService,
        private readonly router: Router
    ) {}

    get mode(): MemberTaskRouteMode {
        return readMemberTaskRouteMode(this.route);
    }

    get projectId(): string {
        if (this.mode === 'personal') {
            const uid = this.app.getMemberByEmail(this.auth.currentEmail())?.uid;
            return uid ? this.app.resolvePersonalTaskProjectIdForMember(uid) : '';
        }
        return this.route.snapshot.paramMap.get('projectId') ?? '';
    }

    get memberId(): string {
        if (this.mode === 'personal') {
            return this.app.getMemberByEmail(this.auth.currentEmail())?.uid ?? '';
        }
        return this.route.snapshot.paramMap.get('memberId') ?? '';
    }

    /** 個人モードでログインとメンバー紐付けが取れないときはトップへ */
    ensurePersonalMemberOrRedirect(): boolean {
        if (this.mode !== 'personal') return true;
        if (!this.memberId || !this.projectId) {
            void this.router.navigate(['/top']);
            return false;
        }
        return true;
    }

    /** ログイン維持・プロジェクト参加（personal / team / adminSelf） */
    ensureMemberAccess(memberAccess: MemberAccessService): boolean {
        if (this.mode === 'personal' && !this.ensurePersonalMemberOrRedirect()) return false;
        return memberAccess.ensureMemberTaskRoute(this.mode, this.projectId, this.memberId);
    }
}
