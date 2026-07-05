// Fanvue HTTP helpers — shared by fanvue webhook and telegram callback handler.

import { getAccessToken, getRefreshToken, setTokens } from "@/lib/tokenStore";
import { refreshAccessToken } from "@/lib/oauth";
import type { ChatTurn } from "@/lib/persona/generateReply";

export const FANVUE_API_BASE = "https://api.fanvue.com";
export const FANVUE_API_VERSION = "2025-06-26";
export const MILENA_UUID = "a866d63a-3221-4731-929a-5c544aa7115a";

export async function resolveAccessToken(): Promise<string | null> {
  const stored = await getAccessToken();

  if (stored && !stored.expired) {
    console.log("[fanvueApi] access_token: aus Redis, noch gültig");
    return stored.token;
  }

  console.log(`[fanvueApi] access_token: ${stored ? "abgelaufen" : "fehlt"} — Refresh nötig`);
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    console.error("[fanvueApi] kein refresh_token in Redis — Login erforderlich");
    return null;
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await setTokens(refreshed.access_token, refreshed.expires_in, refreshed.refresh_token);
    console.log(`[fanvueApi] Token-Refresh ok, RT gespeichert: ${refreshed.refresh_token ? "ja" : "nein"}`);
    return refreshed.access_token;
  } catch (e) {
    console.error("[fanvueApi] Token-Refresh fehlgeschlagen:", String(e));
    return null;
  }
}

export async function sendFanvueMessage(
  accessToken: string,
  fanUuid: string,
  text: string,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${FANVUE_API_BASE}/chats/${fanUuid}/message`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Fanvue-API-Version": FANVUE_API_VERSION,
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[fanvueApi] sendMessage ${res.status}: ${body}`);
  }
  return { ok: res.ok, status: res.status };
}

export async function loadFanvueHistory(
  accessToken: string,
  fanUuid: string,
): Promise<ChatTurn[]> {
  const res = await fetch(
    `${FANVUE_API_BASE}/chats/${fanUuid}/messages?limit=50`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Fanvue-API-Version": FANVUE_API_VERSION,
      },
    },
  );
  if (!res.ok) {
    console.error(`[fanvueApi] loadHistory ${res.status}`);
    return [];
  }

  const data = (await res.json()) as Record<string, unknown>;
  const items = (
    (data.messages ?? data.items ?? data.data ?? []) as Array<{
      senderUuid?: string;
      sender?: { uuid?: string };
      text?: string;
      body?: string;
      createdAt?: string;
      created_at?: string;
    }>
  );

  return items
    .filter((m) => (m.text ?? m.body ?? "").trim().length > 0)
    .sort((a, b) => {
      const ta = a.createdAt ?? a.created_at ?? "";
      const tb = b.createdAt ?? b.created_at ?? "";
      return ta.localeCompare(tb);
    })
    .map((m) => {
      const sender = m.senderUuid ?? m.sender?.uuid ?? "";
      return {
        role: sender === MILENA_UUID ? ("assistant" as const) : ("user" as const),
        content: (m.text ?? m.body ?? "").trim(),
      };
    });
}
