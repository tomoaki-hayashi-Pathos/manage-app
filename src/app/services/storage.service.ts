import { Injectable, signal } from '@angular/core';
import { Firestore, Unsubscribe, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, setDoc } from '@angular/fire/firestore';
import { inject } from '@angular/core';
import type { ChatMessage, SharedKnowledgeEntry } from '../core/progress-chat.types';

/** localStorage 用キー（将来 Firebase 等に差し替えやすいよう集約） */
export const STORAGE_PREFIX = 'manage:';

export function storageKeyProgressState(): string {
  return `${STORAGE_PREFIX}progressState:v1`;
}

export function storageKeyThinkingNudge(projectId: string, roundId: string, memberId: string): string {
  return `${STORAGE_PREFIX}thinkingNudge:v1:${projectId}:${roundId}:${memberId}`;
}

export function storageKeyConsultationBundle(projectId: string): string {
  return `${STORAGE_PREFIX}consultationBundle:v1:${projectId}`;
}

interface AiMemberContextState {
  messages: ChatMessage[];
  conversationSummary: string;
}

const AI_SHARED_SCOPE_KEY = 'global';

@Injectable({ providedIn: 'root' })
export class StorageService {
  private readonly firestore = inject(Firestore);
  private readonly cache = new Map<string, string>();
  private readonly keyListeners = new Map<string, Set<() => void>>();
  private readonly aiMemberCache = new Map<string, AiMemberContextState>();
  private readonly aiSharedCache = new Map<string, SharedKnowledgeEntry[]>();
  private readonly aiMemberListeners = new Map<string, Set<() => void>>();
  private readonly aiMemberUnsubscribes = new Map<string, Unsubscribe>();
  private readonly aiSharedUnsubscribes = new Map<string, Unsubscribe>();
  private readonly aiMemberLoadPromises = new Map<string, Promise<void>>();
  private readonly aiSharedLoadPromises = new Map<string, Promise<void>>();
  private unsubscribeRealtime: Unsubscribe | null = null;
  readonly ready = signal(false);

  constructor() {
    void this.loadFromFirestore();
  }

  private async loadFromFirestore(): Promise<void> {
    try {
      const snap = await getDocs(collection(this.firestore, 'appKv'));
      snap.forEach((d) => {
        const data = d.data() as { key?: string; value?: string };
        if (data.key && typeof data.value === 'string') {
          this.cache.set(data.key, data.value);
        }
      });
    } catch {
      // Firestore unavailable: keep local fallback only.
    } finally {
      this.bindRealtime();
      this.ready.set(true);
    }
  }

  private bindRealtime(): void {
    this.unsubscribeRealtime?.();
    this.unsubscribeRealtime = onSnapshot(collection(this.firestore, 'appKv'), (snap) => {
      const next = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data() as { key?: string; value?: string };
        if (data.key && typeof data.value === 'string') {
          next.set(data.key, data.value);
        }
      });
      const changed = new Set<string>();
      for (const [k, v] of next.entries()) {
        if (this.cache.get(k) !== v) changed.add(k);
      }
      for (const k of this.cache.keys()) {
        if (!next.has(k)) changed.add(k);
      }
      this.cache.clear();
      for (const [k, v] of next.entries()) this.cache.set(k, v);
      changed.forEach((k) => this.notifyKey(k));
    });
  }

  private notifyKey(key: string): void {
    const listeners = this.keyListeners.get(key);
    if (!listeners) return;
    listeners.forEach((cb) => cb());
  }

  watchKey(key: string, cb: () => void): () => void {
    const bag = this.keyListeners.get(key) ?? new Set<() => void>();
    bag.add(cb);
    this.keyListeners.set(key, bag);
    return () => {
      const cur = this.keyListeners.get(key);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) this.keyListeners.delete(key);
    };
  }

  private docId(key: string): string {
    return encodeURIComponent(key);
  }

  private aiMemberKey(memberId: string, roomOwnerId: string): string {
    return `${memberId}::${roomOwnerId}`;
  }

  private aiMemberContextRef(memberId: string, roomOwnerId: string) {
    return doc(this.firestore, 'members', memberId, 'aiContext', roomOwnerId);
  }

  private aiSharedKnowledgeCollection() {
    return collection(this.firestore, 'aiContext', 'sharedKnowledge', 'entries');
  }

  private sanitizeAiMemberContext(data: Partial<AiMemberContextState> | null | undefined): AiMemberContextState {
    return {
      messages: Array.isArray(data?.messages) ? data.messages : [],
      conversationSummary: typeof data?.conversationSummary === 'string' ? data.conversationSummary : ''
    };
  }

  private notifyAiMember(projectId: string, memberId: string, roomOwnerId: string): void {
    const listeners = this.aiMemberListeners.get(this.aiMemberKey(memberId, roomOwnerId));
    if (!listeners) return;
    listeners.forEach((cb) => cb());
  }

  private bindAiMemberContext(projectId: string, memberId: string, roomOwnerId: string): void {
    const key = this.aiMemberKey(memberId, roomOwnerId);
    if (this.aiMemberUnsubscribes.has(key)) return;
    const ref = this.aiMemberContextRef(memberId, roomOwnerId);
    const unsubscribe = onSnapshot(ref, (snap) => {
      const next = this.sanitizeAiMemberContext(snap.exists() ? (snap.data() as Partial<AiMemberContextState>) : null);
      this.aiMemberCache.set(key, next);
      this.notifyAiMember(projectId, memberId, roomOwnerId);
    });
    this.aiMemberUnsubscribes.set(key, unsubscribe);
  }

  private bindAiSharedKnowledge(projectId: string): void {
    if (this.aiSharedUnsubscribes.has(AI_SHARED_SCOPE_KEY)) return;
    const unsubscribe = onSnapshot(this.aiSharedKnowledgeCollection(), (snap) => {
      const next = snap.docs
        .map((d) => d.data() as SharedKnowledgeEntry)
        .filter((x) => typeof x?.id === 'string')
        .sort((a, b) => a.at - b.at);
      this.aiSharedCache.set(AI_SHARED_SCOPE_KEY, next);
    });
    this.aiSharedUnsubscribes.set(AI_SHARED_SCOPE_KEY, unsubscribe);
  }

  async ensureAiMemberContext(projectId: string, memberId: string, roomOwnerId: string): Promise<void> {
    const key = this.aiMemberKey(memberId, roomOwnerId);
    const existing = this.aiMemberLoadPromises.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const snap = await getDoc(this.aiMemberContextRef(memberId, roomOwnerId));
        const next = this.sanitizeAiMemberContext(snap.exists() ? (snap.data() as Partial<AiMemberContextState>) : null);
        this.aiMemberCache.set(key, next);
      } catch {
        this.aiMemberCache.set(key, this.aiMemberCache.get(key) ?? { messages: [], conversationSummary: '' });
      } finally {
        this.bindAiMemberContext(projectId, memberId, roomOwnerId);
        this.notifyAiMember(projectId, memberId, roomOwnerId);
      }
    })();
    this.aiMemberLoadPromises.set(key, promise);
    return promise;
  }

  async ensureAiSharedKnowledge(projectId: string): Promise<void> {
    const existing = this.aiSharedLoadPromises.get(AI_SHARED_SCOPE_KEY);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const snap = await getDocs(this.aiSharedKnowledgeCollection());
        const next = snap.docs
          .map((d) => d.data() as SharedKnowledgeEntry)
          .filter((x) => typeof x?.id === 'string')
          .sort((a, b) => a.at - b.at);
        this.aiSharedCache.set(AI_SHARED_SCOPE_KEY, next);
      } catch {
        this.aiSharedCache.set(AI_SHARED_SCOPE_KEY, this.aiSharedCache.get(AI_SHARED_SCOPE_KEY) ?? []);
      } finally {
        this.bindAiSharedKnowledge(projectId);
      }
    })();
    this.aiSharedLoadPromises.set(AI_SHARED_SCOPE_KEY, promise);
    return promise;
  }

  getAiMemberContext(projectId: string, memberId: string, roomOwnerId: string): AiMemberContextState {
    return this.aiMemberCache.get(this.aiMemberKey(memberId, roomOwnerId)) ?? { messages: [], conversationSummary: '' };
  }

  getAiSharedKnowledge(projectId: string): SharedKnowledgeEntry[] {
    return this.aiSharedCache.get(AI_SHARED_SCOPE_KEY) ?? [];
  }

  watchAiMemberContext(projectId: string, memberId: string, roomOwnerId: string, cb: () => void): () => void {
    const key = this.aiMemberKey(memberId, roomOwnerId);
    const bag = this.aiMemberListeners.get(key) ?? new Set<() => void>();
    bag.add(cb);
    this.aiMemberListeners.set(key, bag);
    return () => {
      const cur = this.aiMemberListeners.get(key);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) this.aiMemberListeners.delete(key);
    };
  }

  async saveAiMessages(projectId: string, memberId: string, roomOwnerId: string, messages: ChatMessage[]): Promise<void> {
    const key = this.aiMemberKey(memberId, roomOwnerId);
    const prev = this.getAiMemberContext(projectId, memberId, roomOwnerId);
    const next = {
      ...prev,
      messages: messages.length > 240 ? messages.slice(-240) : messages
    };
    this.aiMemberCache.set(key, next);
    this.notifyAiMember(projectId, memberId, roomOwnerId);
    await setDoc(
      this.aiMemberContextRef(memberId, roomOwnerId),
      {
        messages: next.messages,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  }

  async saveAiConversationSummary(projectId: string, memberId: string, roomOwnerId: string, conversationSummary: string): Promise<void> {
    const key = this.aiMemberKey(memberId, roomOwnerId);
    const prev = this.getAiMemberContext(projectId, memberId, roomOwnerId);
    const next = { ...prev, conversationSummary };
    this.aiMemberCache.set(key, next);
    this.notifyAiMember(projectId, memberId, roomOwnerId);
    await setDoc(
      this.aiMemberContextRef(memberId, roomOwnerId),
      {
        conversationSummary,
        summaryUpdatedAt: Date.now(),
        updatedAt: Date.now()
      },
      { merge: true }
    );
  }

  async addAiSharedKnowledge(projectId: string, entry: SharedKnowledgeEntry): Promise<void> {
    const list = [...this.getAiSharedKnowledge(projectId), entry].sort((a, b) => a.at - b.at).slice(-500);
    this.aiSharedCache.set(AI_SHARED_SCOPE_KEY, list);
    await setDoc(doc(this.aiSharedKnowledgeCollection(), entry.id), entry);
  }

  private readLocalRaw(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  getJson<T>(key: string): T | null {
    try {
      const rawFromCache = this.cache.get(key);
      const raw = rawFromCache ?? this.readLocalRaw(key);
      if (!raw) return null;
      if (rawFromCache == null) this.cache.set(key, raw);
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    let raw = '';
    try {
      raw = JSON.stringify(value);
      this.cache.set(key, raw);
      this.notifyKey(key);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, raw);
      }
      void setDoc(doc(this.firestore, 'appKv', this.docId(key)), {
        key,
        value: raw,
        updatedAt: Date.now()
      });
    } catch {
      /* quota / private mode */
    }
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.notifyKey(key);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
      void deleteDoc(doc(this.firestore, 'appKv', this.docId(key)));
    } catch {
      /* ignore */
    }
  }
}
