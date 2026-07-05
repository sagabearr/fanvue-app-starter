// Zwischenspeicher für Telegram-Drafts (escalate-Pfad).
// Draft wird angelegt wenn Milena antwortet, gelöscht wenn [Senden] oder [Verwerfen].

import { getRedis } from "@/lib/redisClient";
import { randomUUID } from "crypto";

export interface StoredDraft {
  fanUuid: string;
  messages: string[];
}

const DRAFT_TTL_SECONDS = 172_800; // 48 h

export async function storeDraft(fanUuid: string, messages: string[]): Promise<string> {
  const r = await getRedis();
  const id = randomUUID();
  await r.setEx(
    `draft:${id}`,
    DRAFT_TTL_SECONDS,
    JSON.stringify({ fanUuid, messages } satisfies StoredDraft),
  );
  return id;
}

export async function loadDraft(id: string): Promise<StoredDraft | null> {
  const r = await getRedis();
  const raw = await r.get(`draft:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredDraft; } catch { return null; }
}

export async function deleteDraft(id: string): Promise<void> {
  const r = await getRedis();
  await r.del(`draft:${id}`);
}
