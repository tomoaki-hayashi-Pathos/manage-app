import { Routes } from '@angular/router';
import { ManageTasksComponent } from './features/admin/Manage-tasks';
import { CreateProjectComponent } from './features/admin/first-create-project';
import { CreateMemberComponent } from './features/admin/create-member';
import { LimitTasksComponent } from './features/member/limit-tasks';
import { TodayTasksComponent } from './features/member/today-tasks';
import { NotSetTasksComponent } from './features/member/not-set-tasks';
import { OpsStatusComponent } from './features/admin/ops-status';
import { DetailMemberComponent } from './features/admin/detail-member';

export const routes: Routes = [
    {path: '', component: CreateProjectComponent},
    {path: 'admin/manage-tasks/:projectId', component: ManageTasksComponent},
    {path: 'admin/ops-status/:projectId', component: OpsStatusComponent},
    {path: 'admin/detail-member/:projectId/:memberId', component: DetailMemberComponent},
    {path: 'member/limit-tasks/:projectId/:memberId', component: LimitTasksComponent},
    {path: 'member/today-tasks/:projectId/:memberId', component: TodayTasksComponent},
    {path: 'member/not-set-tasks/:projectId/:memberId', component: NotSetTasksComponent},
    {path: 'admin/create-project', component: CreateProjectComponent},
    {path: 'admin/create-member', component: CreateMemberComponent},
    {path: 'admin/create-member/:projectId', component: CreateMemberComponent}
];
