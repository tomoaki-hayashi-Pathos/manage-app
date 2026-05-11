/**
 * 環境値の参照口。機密は `generated-env.local.ts`（gitignore）のみに書き出す。
 */
import * as defaults from './generated-env.defaults';
import * as local from './generated-env.local';

function pick(key: keyof typeof defaults): string {
  const lv = (local as Record<string, string | undefined>)[key as string];
  if (typeof lv === 'string' && lv.trim()) return lv.trim();
  const dv = (defaults as Record<string, string | undefined>)[key as string];
  return typeof dv === 'string' ? dv.trim() : '';
}

export function getGeminiApiKey(): string | undefined {
  const k = pick('NG_APP_GEMINI_API_KEY');
  return k || undefined;
}

export function getGeminiModel(): string {
  const m = pick('NG_APP_GEMINI_MODEL');
  return m || 'gemini-2.0-flash';
}

export function getFirebasePublicConfig(): {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
} {
  return {
    apiKey: pick('NG_APP_FIREBASE_API_KEY') || undefined,
    authDomain: pick('NG_APP_FIREBASE_AUTH_DOMAIN') || undefined,
    projectId: pick('NG_APP_FIREBASE_PROJECT_ID') || undefined,
    storageBucket: pick('NG_APP_FIREBASE_STORAGE_BUCKET') || undefined,
    messagingSenderId: pick('NG_APP_FIREBASE_MESSAGING_SENDER_ID') || undefined,
    appId: pick('NG_APP_FIREBASE_APP_ID') || undefined
  };
}
