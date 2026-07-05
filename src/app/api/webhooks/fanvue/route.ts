import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getRedis } from "@/lib/redisClient";
import { resolveAccessToken, sendFanvueMessage, loadFanvueHistory, MILENA_UUID } from "@/lib/fanvueApi";
import { handleFanMessage, TelegramDraft } from "@/lib/persona/handleFanMessage";
import { storeDraft } from "@/lib/drafts";

const MAX_AGE_SECONDS = 300;
const ENFORCE_TIMESTAMP = false;

// ─── ENV check (logged once on cold start) ────────────────────────────────────
const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[webhook/fanvue] FEHLER: Umgebungsvariable ${key} fehlt — Handler wird deaktiviert`);
  }
}

// ─── Redis helpers ────────────────────────────────────────────────────────────
async function redisGet(key: string): Promise<string> {
  const r = await getRedis();
  return (await r.get(key)) ?? "";
}

async function redisAppend(key: string, value: string): Promise<void> {
  const r = await getRedis();
  const existing = (await r.get(key)) ?? "";
  const date = new Date().toISOString().slice(0, 10);
  await r.set(key, existing ? `${existing}\n[${date}] ${value}` : `[${date}] ${value}`);
}

// ─── Telegram draft ───────────────────────────────────────────────────────────
async function sendTelegramDraft(
  payload: TelegramDraft,
  botToken: string,
  chatId: string,
): Promise<void> {
  const routeEmoji = payload.route === "block" ? "🔴 BLOCK" : "🟡 ESCALATE";
  const fanShort = payload.fanUuid.slice(0, 8);

  let text = `${routeEmoji} | Fan: <code>${fanShort}…</code>\n\n`;
  if (payload.incomingText) {
    text += `<b>Fan:</b> ${escapeHtml(payload.incomingText.slice(0, 300))}\n\n`;
  }
  if (payload.messages.length > 0) {
    text += `<b>Draft:</b>\n${payload.messages.map((m, i) => `${i + 1}. ${escapeHtml(m)}`).join("\n")}\n\n`;
  }
  text += `<i>Grund: ${escapeHtml(payload.reason)}</i>`;

  let reply_markup: Record<string, unknown> | undefined;

  if (payload.actionable && payload.messages.length > 0) {
    const draftId = await storeDraft(payload.fanUuid, payload.messages);
    reply_markup = {
      inline_keyboard: [[
        { text: "✅ Senden", callback_data: `send:${draftId}` },
        { text: "✏️ Bearbeiten", callback_data: `edit:${draftId}` },
        { text: "🗑 Verwerfen", callback_data: `discard:${draftId}` },
      ]],
    };
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(reply_markup ? { reply_markup } : {}),
    }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const rawBody = await request.text();

  const signingSecret = process.env.FANVUE_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[webhook/fanvue] FANVUE_SIGNING_SECRET fehlt");
    return NextResponse.json({ error: "server misconfiguration" }, { status: 500 });
  }

  const sigHeader = request.headers.get("x-fanvue-signature") ?? "";
  const parts: Record<string, string> = {};
  for (const segment of sigHeader.split(",")) {
    const eq = segment.indexOf("=");
    if (eq > 0) parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }

  const timestamp = parts["t"];
  const receivedSig = parts["v0"];

  if (!timestamp || !receivedSig) {
    console.warn("[webhook/fanvue] fehlendes X-Fanvue-Signature-Header");
    return NextResponse.json({ error: "missing signature" }, { status: 401 });
  }

  const ts = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    if (ENFORCE_TIMESTAMP) {
      console.warn(`[webhook/fanvue] staler Timestamp: ${timestamp}`);
      return NextResponse.json({ error: "timestamp out of range" }, { status: 401 });
    }
    console.warn(`[webhook/fanvue] staler Timestamp (nicht erzwungen): ${timestamp}`);
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
    console.warn("[webhook/fanvue] Signaturprüfung fehlgeschlagen");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.log("[webhook/fanvue] event (non-JSON):", rawBody.slice(0, 200));
    return NextResponse.json({ received: true }, { status: 200 });
  }
  console.log("[webhook/fanvue] event received:", JSON.stringify(event));

  const senderUuid = (event.sender as { uuid?: string } | undefined)?.uuid;
  const recipientUuid = event.recipientUuid as string | undefined;

  console.log(`[webhook/fanvue] senderUuid=${senderUuid ?? "n/a"} recipientUuid=${recipientUuid ?? "n/a"}`);

  if (recipientUuid === MILENA_UUID && senderUuid && senderUuid !== MILENA_UUID) {
    const apiKey       = process.env.ANTHROPIC_API_KEY;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!apiKey || !telegramToken || !telegramChatId) {
      console.error("[webhook/fanvue] fehlende ENV-Variablen (ANTHROPIC_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      console.error("[webhook/fanvue] kein Access-Token — Antwort nicht möglich");
      return NextResponse.json({ received: true }, { status: 200 });
    }

    try {
      await handleFanMessage(senderUuid, {
        loadPersona:    () => redisGet("milena:persona"),
        loadCanon:      () => redisGet("milena:canon"),
        loadFanMemory:  (uuid) => redisGet(`milena:fan:${uuid}`),
        loadHistory:    (uuid) => loadFanvueHistory(accessToken, uuid),
        sendToFanvue:   async (uuid, messages) => {
          for (const text of messages) {
            const r = await sendFanvueMessage(accessToken, uuid, text);
            console.log(`[webhook/fanvue] gesendet an ${uuid}: Status=${r.status}`);
          }
        },
        sendTelegramDraft: (p) => sendTelegramDraft(p, telegramToken, telegramChatId),
        appendCanon:    (fact) => redisAppend("milena:canon", fact),
        appendFanMemory: (uuid, note) => redisAppend(`milena:fan:${uuid}`, note),
        apiKey,
      });
    } catch (e) {
      console.error("[webhook/fanvue] handleFanMessage fehlgeschlagen:", String(e));
    }
  } else {
    console.log("[webhook/fanvue] Guard nicht erfüllt — kein Auto-Reply");
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
