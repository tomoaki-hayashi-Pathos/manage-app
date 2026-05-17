import { Routes } from '@angular/router';
import { ManageTasksComponent } from './features/admin/Manage-tasks';
import { CreateProjectComponent } from './features/admin/first-create-project';
import { CreateMemberComponent } from './features/admin/create-member';
import { LimitTasksComponent } from './features/member/limit-tasks';
import { TodayTasksComponent } from './features/member/today-tasks';
import { NotSetTasksComponent } from './features/member/not-set-tasks';
import { OpsStatusComponent } from './features/admin/ops-status';
import { DetailMemberComponent } from './features/admin/detail-member';
import { SharedTasksComponent } from './features/member/shared-tasks';
import { CompletedTasksComponent } from './features/member/completed-tasks';
import { EntryHomeComponent } from './features/home/entry-home';
import { AdminMenuComponent } from './features/admin/admin-menu';
import { PendingApprovalComponent } from './features/home/pending-approval';
import { MemberHubComponent } from './features/home/member-hub';
import { OwnerMenuComponent } from './features/admin/owner-menu';
import { PersonalProgressSummaryComponent } from './features/personal/personal-progress-summary';

export const routes: Routes = [
    { path: '', component: EntryHomeComponent },
    { path: 'top', component: EntryHomeComponent },
    { path: 'pending-approval', component: PendingApprovalComponent },
    { path: 'member/hub', component: MemberHubComponent },
    { path: 'owner/menu', component: OwnerMenuComponent },
    { path: 'owner/approve-members', component: CreateMemberComponent },
    { path: 'personal', redirectTo: 'personal/today-tasks', pathMatch: 'full' },
    { path: 'personal/summary', component: PersonalProgressSummaryComponent },
    { path: 'personal/today-tasks', component: TodayTasksComponent, data: { memberPage: 'personal' } },
    { path: 'personal/limit-tasks', component: LimitTasksComponent, data: { memberPage: 'personal' } },
    { path: 'personal/not-set-tasks', component: NotSetTasksComponent, data: { memberPage: 'personal' } },
    { path: 'personal/shared-tasks', component: SharedTasksComponent, data: { memberPage: 'personal' } },
    { path: 'personal/completed-tasks', component: CompletedTasksComponent, data: { memberPage: 'personal' } },
    { path: 'admin/menu', component: AdminMenuComponent },
    { path: 'admin/manage-tasks/:projectId', component: ManageTasksComponent },
    { path: 'admin/ops-status/:projectId', component: OpsStatusComponent },
    { path: 'admin/detail-member/:projectId/:memberId', component: DetailMemberComponent },
    { path: 'admin/shared-tasks/:projectId', component: SharedTasksComponent },
    { path: 'admin/completed-tasks/:projectId', component: CompletedTasksComponent },
    { path: 'admin/my-tasks/:projectId/:memberId/today-tasks', component: TodayTasksComponent, data: { memberPage: 'adminSelf' } },
    { path: 'admin/my-tasks/:projectId/:memberId/limit-tasks', component: LimitTasksComponent, data: { memberPage: 'adminSelf' } },
    { path: 'admin/my-tasks/:projectId/:memberId/not-set-tasks', component: NotSetTasksComponent, data: { memberPage: 'adminSelf' } },
    { path: 'admin/my-tasks/:projectId/:memberId/shared-tasks', component: SharedTasksComponent, data: { memberPage: 'adminSelf' } },
    { path: 'admin/my-tasks/:projectId/:memberId/completed-tasks', component: CompletedTasksComponent, data: { memberPage: 'adminSelf' } },
    { path: 'member/limit-tasks/:projectId/:memberId', component: LimitTasksComponent, data: { memberPage: 'team' } },
    { path: 'member/today-tasks/:projectId/:memberId', component: TodayTasksComponent, data: { memberPage: 'team' } },
    { path: 'member/not-set-tasks/:projectId/:memberId', component: NotSetTasksComponent, data: { memberPage: 'team' } },
    { path: 'member/shared-tasks/:projectId/:memberId', component: SharedTasksComponent, data: { memberPage: 'team' } },
    { path: 'member/completed-tasks/:projectId/:memberId', component: CompletedTasksComponent, data: { memberPage: 'team' } },
    { path: 'admin/create-project', component: CreateProjectComponent },
    { path: 'admin/create-member', component: CreateMemberComponent },
    { path: 'admin/create-member/:projectId', component: CreateMemberComponent }
];
