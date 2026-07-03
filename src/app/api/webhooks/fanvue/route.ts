import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { refreshAccessToken } from "@/lib/oauth";
import { getRefreshToken, setRefreshToken } from "@/lib/tokenStore";

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

export async function POST(request: Request) {
  // Raw body lesen — muss vor jeder anderen Verarbeitung passieren
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

  // Timestamp check (optional — warns only until ENFORCE_TIMESTAMP = true)
  const ts = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    if (ENFORCE_TIMESTAMP) {
      console.warn(`[webhook/fanvue] stale timestamp: ${timestamp}`);
      return NextResponse.json({ error: "timestamp out of range" }, { status: 401 });
    }
    console.warn(`[webhook/fanvue] stale timestamp (not enforced): ${timestamp}`);
  }

  // HMAC-SHA256 over "{timestamp}.{rawBody}"
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

  // Auto-Antwort: nur auf Fan-Nachrichten, die an Milena adressiert sind
  const senderUuid = (event.sender as { uuid?: string } | undefined)?.uuid;
  const recipientUuid = event.recipientUuid as string | undefined;

  if (
    recipientUuid === MILENA_UUID &&
    senderUuid &&
    senderUuid !== MILENA_UUID
  ) {
    // 1. Refresh-Token aus Redis holen (mit Env-Fallback)
    const refreshToken = await getRefreshToken();
    console.log(`[webhook/fanvue] refresh_token aus Redis gelesen: ${refreshToken ? "ja" : "nein"}`);

    if (!refreshToken) {
      console.error("[webhook/fanvue] kein refresh_token verfügbar — skipping auto-reply");
    } else {
      let accessToken: string | null = null;

      try {
        // 2. Neues Access-Token + rotiertes Refresh-Token holen
        const refreshed = await refreshAccessToken(refreshToken);
        accessToken = refreshed.access_token;
        console.log("[webhook/fanvue] Token geholt: ja");

        // 3. Rotiertes Refresh-Token SOFORT in Redis schreiben — BEVOR gesendet wird.
        //    Reihenfolge ist kritisch: bei Absturz nach dem Refresh aber vor dem Speichern
        //    wäre das Token verbrannt.
        if (refreshed.refresh_token) {
          await setRefreshToken(refreshed.refresh_token);
          console.log("[webhook/fanvue] neues refresh_token gespeichert: ja");
        } else {
          console.warn("[webhook/fanvue] neues refresh_token gespeichert: nein (Antwort enthielt keins)");
        }
      } catch (e) {
        console.error("[webhook/fanvue] Token geholt: nein —", String(e));
      }

      // 4. Nachricht senden
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
    }
  }

  // Immer 200 zurück — Fanvue soll bei Sendefehlern nicht retryen
  return NextResponse.json({ received: true }, { status: 200 });
}
