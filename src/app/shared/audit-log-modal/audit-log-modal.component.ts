import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { AppService } from '../../app.service';
import { formatAuditAt } from '../../core/audit-log.util';
import { buildAuditExportCsv, csvFilenameBase, downloadCsv } from '../../core/csv-export.util';

@Component({
    selector: 'app-audit-log-modal',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './audit-log-modal.component.html',
    styleUrl: './audit-log-modal.component.css'
})
export class AuditLogModalComponent {
    readonly app = inject(AppService);

    @Input() open = false;
    @Input() projectId = '';
    @Input() projectName = '';
    @Output() readonly closed = new EventEmitter<void>();

    get entries() {
        return this.app.getAuditLogForProject(this.projectId);
    }

    formatAt(at: number): string {
        return formatAuditAt(at);
    }

    close(): void {
        this.closed.emit();
    }

    exportCsv(): void {
        const list = this.entries;
        if (!list.length) {
            alert('エクスポートする監査ログがありません。');
            return;
        }
        const csv = buildAuditExportCsv(list);
        downloadCsv(`${csvFilenameBase(this.projectName)}_audit.csv`, csv);
    }
}
