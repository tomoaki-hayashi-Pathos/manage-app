import type { Member, ParentTask } from './interface';
import type { AdminTaskChangeBundle, MemberTaskChangeBundle } from './progress-chat.types';
import type { StorageService } from '../services/storage.service';
import { storageKeyAdminTaskChangeBundle, storageKeyMemberTaskChangeBundle } from '../services/storage.service';

function deadlineUnset(d: ParentTask['deadline']): boolean {
  if (d === null || d === undefined) return true;
  if (typeof d === 'string' && !String(d).trim()) return true;
  const t = new Date(d as Date | string);
  return Number.isNaN(t.getTime());
}

function deadlineMs(d: ParentTask['deadline']): number | null {
  if (d == null || deadlineUnset(d)) return null;
  const x = new Date(d as Date | string).getTime();
  return Number.isNaN(x) ? null : x;
}

function formatDeadlineLabel(d: ParentTask['deadline']): string {
  if (d == null || deadlineUnset(d)) return '期限未設定';
  const dt = new Date(d as Date | string);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日${dt.getHours()}時まで`;
}

function memberIdsSignature(parent: ParentTask): string {
  const ids = parent.leadAssigneeId ? [parent.leadAssigneeId, ...parent.memberIds] : [...parent.memberIds];
  return ids.join('\0');
}

function assigneeChanged(before: ParentTask, after: ParentTask): boolean {
  return memberIdsSignature(before) !== memberIdsSignature(after);
}

function formatAssigneeLabel(parent: ParentTask, getMemberById: (uid: string | null | undefined) => Member | undefined): string {
  const lead = parent.leadAssigneeId;
  if (!lead) return '未設定';
  const leadName = getMemberById(lead)?.name ?? '担当者';
  const others = parent.memberIds
    .map((id) => getMemberById(id)?.name)
    .filter((n): n is string => !!n);
  if (others.length === 0) return `${leadName}さん`;
  return `${leadName}さん（メンバー: ${others.join('、')}）`;
}

function taskLabel(parent: ParentTask): string {
  const t = (parent.title || '').trim();
  return t || '（無題）';
}

export function buildMemberTaskChangeMessages(
  parentBefore: ParentTask,
  parentAfter: ParentTask,
  getMemberById: (uid: string | null | undefined) => Member | undefined
): string[] {
  const label = taskLabel(parentAfter);
  const messages: string[] = [];

  if ((parentBefore.title || '').trim() !== (parentAfter.title || '').trim()) {
    messages.push(`タスク：${label}のタイトルを「${(parentAfter.title || '').trim()}」に変更しました。`);
  }

  const descBefore = parentBefore.description ?? '';
  const descAfter = parentAfter.description ?? '';
  if (descBefore !== descAfter) {
    if (descAfter.startsWith(descBefore) && descAfter.length > descBefore.length) {
      const added = descAfter.slice(descBefore.length).trim();
      if (added) {
        messages.push(`タスク：${label}の備考欄に追記：\n${added}`);
      } else {
        messages.push(`タスク：${label}の備考欄を更新しました。`);
      }
    } else {
      messages.push(`タスク：${label}の備考欄を更新しました。`);
    }
  }

  if (deadlineMs(parentBefore.deadline) !== deadlineMs(parentAfter.deadline)) {
    messages.push(`タスク：${label}の期限を${formatDeadlineLabel(parentAfter.deadline)}に変更しました。`);
  }

  if (assigneeChanged(parentBefore, parentAfter)) {
    messages.push(`タスク：${label}の担当を${formatAssigneeLabel(parentAfter, getMemberById)}に変更しました。`);
  }

  return messages;
}

function collectRelatedMemberIds(parent: ParentTask, childAssigneeIds: string[]): Set<string> {
  const ids = new Set<string>();
  if (parent.leadAssigneeId) ids.add(parent.leadAssigneeId);
  for (const id of parent.memberIds) ids.add(id);
  for (const id of childAssigneeIds) ids.add(id);
  return ids;
}

export function appendMemberTaskChangeMessages(
  storage: StorageService,
  projectId: string,
  memberId: string,
  messages: string[]
): void {
  if (!messages.length) return;
  const key = storageKeyMemberTaskChangeBundle(projectId, memberId);
  const raw = storage.getJson<MemberTaskChangeBundle | null>(key);
  const base: MemberTaskChangeBundle =
    raw && Array.isArray(raw.entries)
      ? { entries: raw.entries, memberDismissedAt: raw.memberDismissedAt ?? 0 }
      : { entries: [], memberDismissedAt: 0 };
  const now = Date.now();
  for (const message of messages) {
    base.entries.push({
      id: crypto.randomUUID(),
      message,
      at: now
    });
  }
  storage.setJson(key, base);
}

export function getPendingMemberTaskChangeText(
  storage: StorageService,
  projectId: string,
  memberId: string
): string | null {
  const bundle = storage.getJson<MemberTaskChangeBundle | null>(
    storageKeyMemberTaskChangeBundle(projectId, memberId)
  );
  if (!bundle || !Array.isArray(bundle.entries)) return null;
  const dismissed = bundle.memberDismissedAt ?? 0;
  const pending = bundle.entries.filter((e) => e.at > dismissed);
  if (!pending.length) return null;
  return pending.map((e) => e.message).join('\n\n');
}

export function dismissMemberTaskChangeBundle(storage: StorageService, projectId: string, memberId: string): void {
  const key = storageKeyMemberTaskChangeBundle(projectId, memberId);
  const bundle = storage.getJson<MemberTaskChangeBundle | null>(key);
  if (!bundle || !Array.isArray(bundle.entries)) return;
  bundle.memberDismissedAt = Date.now();
  storage.setJson(key, bundle);
}

export function getPendingAdminTaskChangeText(storage: StorageService, projectId: string): string | null {
  const bundle = storage.getJson<AdminTaskChangeBundle | null>(storageKeyAdminTaskChangeBundle(projectId));
  if (!bundle || !Array.isArray(bundle.entries)) return null;
  const dismissed = bundle.adminDismissedAt ?? 0;
  const pending = bundle.entries.filter((e) => e.at > dismissed);
  if (!pending.length) return null;
  return pending.map((e) => e.message).join('\n\n');
}

export function dismissAdminTaskChangeBundle(storage: StorageService, projectId: string): void {
  const key = storageKeyAdminTaskChangeBundle(projectId);
  const bundle = storage.getJson<AdminTaskChangeBundle | null>(key);
  if (!bundle || !Array.isArray(bundle.entries)) return;
  bundle.adminDismissedAt = Date.now();
  storage.setJson(key, bundle);
}

function appendAdminTaskChangeMessages(storage: StorageService, projectId: string, messages: string[]): void {
  if (!messages.length) return;
  const key = storageKeyAdminTaskChangeBundle(projectId);
  const raw = storage.getJson<AdminTaskChangeBundle | null>(key);
  const base: AdminTaskChangeBundle =
    raw && Array.isArray(raw.entries)
      ? { entries: raw.entries, adminDismissedAt: raw.adminDismissedAt ?? 0 }
      : { entries: [], adminDismissedAt: 0 };
  const now = Date.now();
  for (const message of messages) {
    base.entries.push({
      id: crypto.randomUUID(),
      message,
      at: now
    });
  }
  storage.setJson(key, base);
}

function messagesWithActorPrefix(
  messages: string[],
  actorMemberUid: string,
  getMemberById: (uid: string | null | undefined) => Member | undefined,
  asAdmin = false
): string[] {
  const actorName = getMemberById(actorMemberUid)?.name ?? (asAdmin ? '責任者' : 'メンバー');
  const label = asAdmin ? `${actorName}さん（責任者）` : `${actorName}さん`;
  return messages.map((m) => `【${label}】${m}`);
}

export function recordAdminTaskChangeNotifications(
  storage: StorageService,
  projectId: string,
  parentBefore: ParentTask,
  parentAfter: ParentTask,
  actorMemberUid: string | null | undefined,
  getMembersByProjectId: (pid: string) => Member[],
  getMemberById: (uid: string | null | undefined) => Member | undefined,
  getProjectAdminId: (pid: string) => string | undefined
): void {
  if (!actorMemberUid) return;
  const adminId = getProjectAdminId(projectId);
  if (adminId && actorMemberUid === adminId) return;

  const members = getMembersByProjectId(projectId);
  if (!members.some((m) => m.uid === actorMemberUid)) return;

  const changes = buildMemberTaskChangeMessages(parentBefore, parentAfter, getMemberById);
  if (!changes.length) return;

  appendAdminTaskChangeMessages(storage, projectId, messagesWithActorPrefix(changes, actorMemberUid, getMemberById));
}

export function recordMemberTaskChangeNotifications(
  storage: StorageService,
  projectId: string,
  parentBefore: ParentTask,
  assigneesBefore: string[],
  parentAfter: ParentTask,
  assigneesAfter: string[],
  actorMemberUid: string | null | undefined,
  getMembersByProjectId: (pid: string) => Member[],
  getMemberById: (uid: string | null | undefined) => Member | undefined,
  getProjectAdminId: (pid: string) => string | undefined
): void {
  const changes = buildMemberTaskChangeMessages(parentBefore, parentAfter, getMemberById);
  if (!changes.length) return;

  recordAdminTaskChangeNotifications(
    storage,
    projectId,
    parentBefore,
    parentAfter,
    actorMemberUid,
    getMembersByProjectId,
    getMemberById,
    getProjectAdminId
  );

  const members = getMembersByProjectId(projectId);
  const adminId = getProjectAdminId(projectId);
  const isMemberActor = !!actorMemberUid && members.some((m) => m.uid === actorMemberUid);
  const isAdminActor = !!actorMemberUid && !!adminId && actorMemberUid === adminId;

  let peerMessages = changes;
  if (isMemberActor) {
    peerMessages = messagesWithActorPrefix(changes, actorMemberUid, getMemberById);
  } else if (isAdminActor) {
    peerMessages = messagesWithActorPrefix(changes, actorMemberUid, getMemberById, true);
  }

  const related = new Set<string>();
  for (const id of collectRelatedMemberIds(parentBefore, assigneesBefore)) related.add(id);
  for (const id of collectRelatedMemberIds(parentAfter, assigneesAfter)) related.add(id);

  for (const m of members) {
    if (!related.has(m.uid)) continue;
    if (actorMemberUid && m.uid === actorMemberUid) continue;
    appendMemberTaskChangeMessages(storage, projectId, m.uid, peerMessages);
  }
}
