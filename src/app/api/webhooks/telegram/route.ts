// Empfängt Telegram callback_query (Inline-Button-Klicks) und führt die Aktion aus.
// Muss als Webhook bei Telegram registriert werden:
//   https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://DEINE_APP.vercel.app/api/webhooks/telegram

import { NextResponse } from "next/server";
import { loadDraft, deleteDraft } from "@/lib/drafts";
import { resolveAccessToken, sendFanvueMessage } from "@/lib/fanvueApi";

async function answerCallback(token: string, callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

async function editMessage(token: string, chatId: number, messageId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const cq = body.callback_query as {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  } | undefined;

  if (!cq?.data) {
    return NextResponse.json({ ok: true });
  }

  const chatId = cq.message?.chat.id ?? 0;
  const messageId = cq.message?.message_id ?? 0;
  const colonIdx = cq.data.indexOf(":");
  const action = colonIdx > -1 ? cq.data.slice(0, colonIdx) : cq.data;
  const draftId = colonIdx > -1 ? cq.data.slice(colonIdx + 1) : "";

  if (action === "send") {
    const draft = await loadDraft(draftId);
    if (!draft) {
      await answerCallback(botToken, cq.id, "Draft nicht gefunden oder bereits verarbeitet.");
      return NextResponse.json({ ok: true });
    }

    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      await answerCallback(botToken, cq.id, "Kein Access-Token — Login erforderlich.");
      return NextResponse.json({ ok: true });
    }

    for (const text of draft.messages) {
      await sendFanvueMessage(accessToken, draft.fanUuid, text);
    }
    await deleteDraft(draftId);
    await answerCallback(botToken, cq.id, "✅ Gesendet");
    if (chatId && messageId) await editMessage(botToken, chatId, messageId, "✅ Gesendet an Fan.");

  } else if (action === "discard") {
    await deleteDraft(draftId);
    await answerCallback(botToken, cq.id, "🗑 Verworfen");
    if (chatId && messageId) await editMessage(botToken, chatId, messageId, "🗑 Draft verworfen.");

  } else if (action === "edit") {
    const draft = await loadDraft(draftId);
    const preview = draft?.messages.join("\n---\n") ?? "(Draft nicht gefunden)";
    await answerCallback(botToken, cq.id, "Text kopieren und manuell anpassen:");
    if (chatId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: preview }),
      });
    }
  }

  return NextResponse.json({ ok: true });
}
