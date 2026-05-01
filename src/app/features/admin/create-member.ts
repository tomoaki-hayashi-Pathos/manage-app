import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { AppService } from '../../app.service';
import { Member } from '../../core/interface';

@Component({
    selector: 'app-create-member',
    standalone: true,
    imports: [FormsModule, RouterLink],
    templateUrl: './create-member.html',
    styleUrls: ['./create-member.css']
})
export class CreateMemberComponent {
    readonly appService = inject(AppService);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    name = '';
    email = '';
    photoPreviewUrl = '';
    role: Member['role'] = 'メンバー';

    readonly roleOptions: Member['role'][] = ['メンバー', 'ゲスト'];

    private resolvedFileDataUrl = '';

    //Manage-tasksから来たプロジェクトIDを変数に保存
    projectId = this.route.snapshot.paramMap.get('projectId') as string;


    onFileChange(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file || !file.type.startsWith('image/')) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            this.resolvedFileDataUrl = result;
            this.photoPreviewUrl = result;
        };
        reader.readAsDataURL(file);
    }

    /** プレビュー用（テンプレートから参照） */
    get avatarPreviewSrc(): string {
        if (this.photoPreviewUrl) {
            return this.photoPreviewUrl;
        }
        if (this.name.trim()) {
            return this.avatarFromInitials(this.name);
        }
        return '';
    }

    private avatarFromInitials(name: string): string {
        const letters = name.trim().slice(0, 2) || '?';
        const safe = letters.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="%23ff2d2d" rx="64"/>
  <text x="64" y="78" font-size="48" fill="white" text-anchor="middle" font-family="Segoe UI,Meiryo,sans-serif" font-weight="700">${safe}</text>
</svg>`;
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    private resolvePhotoUrlForSave(): string {
        if (this.resolvedFileDataUrl) {
            return this.resolvedFileDataUrl;
        }
        return this.avatarFromInitials(this.name);
    }

    createMemberAndGoToProject(): void {
        if (!this.submitMember()) {
            return;
        }
        this.router.navigate(['/admin/create-project']);
    }

    createMemberAndContinue(): void {
        if (!this.submitMember()) {
            return;
        }
        this.resetForm();
    }

    private submitMember(): boolean {
        if (!this.name.trim() || !this.email.trim()) {
            alert('名前とメールアドレスを入力してください');
            return false;
        }
        const before = this.appService.members.length;
        const photoURL = this.resolvePhotoUrlForSave();
        this.appService.createMember(this.name, this.email, photoURL, this.role);
        return this.appService.members.length > before;
    }

    private resetForm(): void {
        this.name = '';
        this.email = '';
        this.photoPreviewUrl = '';
        this.resolvedFileDataUrl = '';
        this.role = 'メンバー';
    }
}
