import type { StorageService } from '../../services/storage.service';
import { storageKeyMemberTaskChangeBundle } from '../../services/storage.service';
import {
  dismissMemberTaskChangeBundle,
  getPendingMemberTaskChangeText
} from '../../core/member-task-change-notify.util';

export function watchMemberTaskChangeBundle(
  storage: StorageService,
  projectId: string,
  memberId: string,
  cb: () => void
): () => void {
  return storage.watchKey(storageKeyMemberTaskChangeBundle(projectId, memberId), cb);
}

export function readPendingMemberTaskChangeBubble(
  storage: StorageService,
  projectId: string,
  memberId: string
): { text: string } | null {
  const text = getPendingMemberTaskChangeText(storage, projectId, memberId);
  if (!text) return null;
  return { text };
}

export function confirmMemberTaskChangeBubble(storage: StorageService, projectId: string, memberId: string): void {
  dismissMemberTaskChangeBundle(storage, projectId, memberId);
}
