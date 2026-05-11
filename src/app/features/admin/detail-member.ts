import { Component, effect, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AppService } from '../../app.service';
import { AdminProjectAccessService } from '../../services/admin-project-access.service';

@Component({
    selector: 'app-detail-member',
    standalone: true,
    imports: [CommonModule, RouterLink],
    templateUrl: './detail-member.html',
    styleUrls: ['./Manage-tasks.css', './detail-member.css']
})
export class DetailMemberComponent {
    readonly appService = inject(AppService);
    readonly route = inject(ActivatedRoute);
    private readonly adminAccess = inject(AdminProjectAccessService);

    readonly projectId = this.route.snapshot.params['projectId'] as string;
    readonly memberId = this.route.snapshot.params['memberId'] as string;
    private readonly accessEffect = effect(() => {
        this.adminAccess.redirectIfForbidden(this.projectId);
    });

    get projectName(): string {
        return this.appService.projects.find((p) => p.id === this.projectId)?.name ?? '';
    }

    get member() {
        return this.appService.getMemberById(this.memberId);
    }

    get burden() {
        return this.appService.getMemberBurdenSummaries(this.projectId).find((x) => x.memberId === this.memberId);
    }
}
