import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { refreshAccessToken } from "@/lib/oauth";
import { getAccessToken, getRefreshToken, setTokens } from "@/lib/tokenStore";

const MAX_AGE_SECONDS = 300;
const ENFORCE_TIMESTAMP = false;
const MILENA_UUID = "a866d63a-3221-4731-929a-5c544aa7115a";
const API_BASE = "https://api.fanvue.com";
const API_VERSION = "2025-06-26";
const TEST_REPLY = "Test 123 — automatische Antwort";

async function sendMessage(
  accessToken: string,
  fanUuid: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${API_BASE}/chats/${fanUuid}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Fanvue-API-Version": API_VERSION,
    },
    body: JSON.stringify({ text: TEST_REPLY }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/** Returns a valid access token from Redis, refreshing only if expired. */
async function resolveAccessToken(): Promise<string | null> {
  const stored = await getAccessToken();

  if (stored && !stored.expired) {
    console.log("[webhook/fanvue] access_token: aus Redis, noch gültig");
    return stored.token;
  }

  console.log(`[webhook/fanvue] access_token: ${stored ? "abgelaufen" : "fehlt"} — Refresh nötig`);

  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    console.error("[webhook/fanvue] kein refresh_token in Redis — Login erforderlich");
    return null;
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken);
    // Neue Tokens SOFORT sichern, bevor irgendetwas anderes passiert
    await setTokens(refreshed.access_token, refreshed.expires_in, refreshed.refresh_token);
    console.log(`[webhook/fanvue] Token-Refresh: ok, neues RT gespeichert: ${refreshed.refresh_token ? "ja" : "nein"}`);
    return refreshed.access_token;
  } catch (e) {
    console.error("[webhook/fanvue] Token-Refresh fehlgeschlagen:", String(e));
    return null;
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  const signingSecret = process.env.FANVUE_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[webhook/fanvue] FANVUE_SIGNING_SECRET is not set");
    return NextResponse.json({ error: "server misconfiguration" }, { status: 500 });
  }

  // Header format: "t={timestamp},v0={signature}"
  const sigHeader = request.headers.get("x-fanvue-signature") ?? "";
  const parts: Record<string, string> = {};
  for (const segment of sigHeader.split(",")) {
    const eq = segment.indexOf("=");
    if (eq > 0) parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }

  const timestamp = parts["t"];
  const receivedSig = parts["v0"];

  if (!timestamp || !receivedSig) {
    console.warn("[webhook/fanvue] missing or malformed X-Fanvue-Signature header");
    return NextResponse.json({ error: "missing signature" }, { status: 401 });
  }

  const ts = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    if (ENFORCE_TIMESTAMP) {
      console.warn(`[webhook/fanvue] stale timestamp: ${timestamp}`);
      return NextResponse.json({ error: "timestamp out of range" }, { status: 401 });
    }
    console.warn(`[webhook/fanvue] stale timestamp (not enforced): ${timestamp}`);
  }

  const expected = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  let valid = false;
  try {
    valid = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(receivedSig, "utf8"));
  } catch {
    valid = false;
  }

  if (!valid) {
    console.warn("[webhook/fanvue] signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Event parsen und loggen
  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.log("[webhook/fanvue] event received (non-JSON):", rawBody);
    return NextResponse.json({ received: true }, { status: 200 });
  }
  console.log("[webhook/fanvue] event received:", JSON.stringify(event));

  // Absender- und Empfänger-UUID aus dem Event lesen
  const senderUuid = (event.sender as { uuid?: string } | undefined)?.uuid;
  const recipientUuid = event.recipientUuid as string | undefined;

  console.log(`[webhook/fanvue] senderUuid=${senderUuid ?? "n/a"} recipientUuid=${recipientUuid ?? "n/a"}`);

  if (
    recipientUuid === MILENA_UUID &&
    senderUuid &&
    senderUuid !== MILENA_UUID
  ) {
    const accessToken = await resolveAccessToken();

    if (accessToken) {
      try {
        const result = await sendMessage(accessToken, senderUuid);
        console.log(
          `[webhook/fanvue] Sende-Versuch an ${senderUuid}: Status=${result.status} Body=${result.body}`,
        );
      } catch (e) {
        console.error("[webhook/fanvue] Sende-Fehler:", String(e));
      }
    }
  } else {
    console.log("[webhook/fanvue] Guard nicht erfüllt — kein Auto-Reply");
  }

  // Immer 200 — kein Fanvue-Retry bei Sendefehlern
  return NextResponse.json({ received: true }, { status: 200 });
}
