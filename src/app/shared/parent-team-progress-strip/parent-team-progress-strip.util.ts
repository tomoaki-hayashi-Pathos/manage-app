import type { ProgressBubbleVm } from '../../services/progress-reporting.service';

export type ParentTeamProgressSlot = {
  role: '担当' | 'メンバー';
  bubble: ProgressBubbleVm;
  isLead: boolean;
};

export function buildParentTeamProgressSlots(
  parent: { leadAssigneeId: string | null; memberIds: string[] },
  bubbles: ProgressBubbleVm[]
): ParentTeamProgressSlot[] {
  const byId = new Map(bubbles.map((b) => [b.memberId, b]));
  const slots: ParentTeamProgressSlot[] = [];

  if (parent.leadAssigneeId) {
    const leadBubble = byId.get(parent.leadAssigneeId);
    if (leadBubble) {
      slots.push({ role: '担当', bubble: leadBubble, isLead: true });
    }
  }

  for (const uid of parent.memberIds) {
    if (uid === parent.leadAssigneeId) continue;
    const bubble = byId.get(uid);
    if (bubble) {
      slots.push({ role: 'メンバー', bubble, isLead: false });
    }
  }

  return slots;
}
