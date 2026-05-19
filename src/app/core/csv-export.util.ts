import type { AppService } from '../app.service';
import { formatAuditAt } from './audit-log.util';
import type { AuditLogEntry } from './interface';

function escapeCsvCell(v: string): string {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function rowsToCsv(headers: string[], rows: string[][]): string {
    const lines = [
        headers.map(escapeCsvCell).join(','),
        ...rows.map((row) => row.map(escapeCsvCell).join(','))
    ];
    return `\uFEFF${lines.join('\r\n')}`;
}

export function downloadCsv(filename: string, csv: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function csvFilenameBase(projectName: string): string {
    const safe = (projectName || 'project').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    return `${safe}_${stamp}`;
}

function formatDeadlineCsv(deadline: Date | string | null | undefined): string {
    if (!deadline) return '';
    const d = new Date(deadline);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ja-JP');
}

/** プロジェクトの親・子タスク（ゴミ箱外・一覧用） */
export function buildTasksExportCsv(app: AppService, projectId: string): string {
    const headers = ['種別', 'タイトル', 'ステータス', '期限', '優先度', 'リード', '子担当', 'タスクID'];
    const rows: string[][] = [];

    for (const p of app.parentTasks.filter((t) => t.projectId === projectId)) {
        const lead = p.leadAssigneeId ? app.getMemberById(p.leadAssigneeId)?.name ?? '' : '';
        rows.push([
            '親',
            p.title?.trim() || '（無題）',
            p.status,
            formatDeadlineCsv(p.deadline),
            p.priority ?? '',
            lead,
            '',
            p.id
        ]);
        for (const c of app.childTasks.filter((ch) => ch.parentTaskId === p.id)) {
            const assignee = c.assigneeId ? app.getMemberById(c.assigneeId)?.name ?? '' : '';
            rows.push([
                '子',
                c.title?.trim() || '（無題）',
                c.status,
                formatDeadlineCsv(c.deadline),
                '',
                '',
                assignee,
                c.id
            ]);
        }
    }

    return rowsToCsv(headers, rows);
}

export function buildAuditExportCsv(entries: AuditLogEntry[]): string {
    const headers = ['日時', '実行者', '操作', '対象', '概要'];
    const rows = entries.map((e) => [
        formatAuditAt(e.at),
        e.actorName,
        e.action,
        e.title,
        e.summary
    ]);
    return rowsToCsv(headers, rows);
}
