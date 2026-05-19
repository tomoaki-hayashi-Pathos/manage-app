import type { AuditLogEntry, TaskStatus } from './interface';

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function pruneAuditLogEntries(entries: AuditLogEntry[]): AuditLogEntry[] {
    const cutoff = Date.now() - AUDIT_RETENTION_MS;
    return entries.filter((e) => e.at >= cutoff);
}

export function auditSummaryStatusChange(
    kind: 'parent' | 'child',
    title: string,
    from: TaskStatus,
    to: TaskStatus
): string {
    const label = kind === 'parent' ? '親' : '子';
    return `${label}「${title}」: ${from} → ${to}`;
}

export function formatAuditAt(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
