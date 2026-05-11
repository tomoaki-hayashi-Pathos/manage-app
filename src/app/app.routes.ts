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

export const routes: Routes = [
    {path: '', component: EntryHomeComponent},
    {path: 'top', component: EntryHomeComponent},
    {path: 'admin/menu', component: AdminMenuComponent},
    {path: 'admin/manage-tasks/:projectId', component: ManageTasksComponent},
    {path: 'admin/ops-status/:projectId', component: OpsStatusComponent},
    {path: 'admin/detail-member/:projectId/:memberId', component: DetailMemberComponent},
    {path: 'admin/shared-tasks/:projectId', component: SharedTasksComponent},
    {path: 'admin/completed-tasks/:projectId', component: CompletedTasksComponent},
    {path: 'member/limit-tasks/:projectId/:memberId', component: LimitTasksComponent},
    {path: 'member/today-tasks/:projectId/:memberId', component: TodayTasksComponent},
    {path: 'member/not-set-tasks/:projectId/:memberId', component: NotSetTasksComponent},
    {path: 'member/shared-tasks/:projectId/:memberId', component: SharedTasksComponent},
    {path: 'member/completed-tasks/:projectId/:memberId', component: CompletedTasksComponent},
    {path: 'admin/create-project', component: CreateProjectComponent},
    {path: 'admin/create-member', component: CreateMemberComponent},
    {path: 'admin/create-member/:projectId', component: CreateMemberComponent}
];
