// Orchestriert einen Antwort-Zyklus: Laden → Generieren → Routen → Persistieren.
// Kein DRY_RUN-Modus: safe-Antworten gehen autonom raus.

import { generateReply, MilenaReply, ChatTurn } from "./generateReply";

export interface TelegramDraft {
  fanUuid: string;
  route: MilenaReply["route"];
  incomingText: string;
  messages: string[];
  reason: string;
  actionable: boolean;
}

export interface HandleDeps {
  loadPersona: () => Promise<string>;
  loadCanon: () => Promise<string>;
  loadFanMemory: (fanUuid: string) => Promise<string>;
  loadHistory: (fanUuid: string) => Promise<ChatTurn[]>;
  sendToFanvue: (fanUuid: string, messages: string[]) => Promise<void>;
  sendTelegramDraft: (payload: TelegramDraft) => Promise<void>;
  appendCanon: (fact: string) => Promise<void>;
  appendFanMemory: (fanUuid: string, note: string) => Promise<void>;
  apiKey: string;
}

export async function handleFanMessage(
  fanUuid: string,
  deps: HandleDeps,
): Promise<MilenaReply> {
  const [personaMd, canonMd, fanMemoryMd, history] = await Promise.all([
    deps.loadPersona(),
    deps.loadCanon(),
    deps.loadFanMemory(fanUuid),
    deps.loadHistory(fanUuid),
  ]);

  if (!personaMd) {
    console.error("[handleFanMessage] milena:persona ist leer — seed-persona.ts ausführen!");
  }

  const reply = await generateReply({ personaMd, canonMd, fanMemoryMd, history, apiKey: deps.apiKey });

  // Letzte Fan-Nachricht als Kontext für Telegram
  const incomingText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";

  // Canon/Memory immer persistieren (kein dryRun-Gate)
  if (reply.canon_update) {
    deps.appendCanon(reply.canon_update).catch((e) =>
      console.error("[handleFanMessage] appendCanon fehlgeschlagen:", String(e)),
    );
  }
  if (reply.memory_update) {
    deps.appendFanMemory(fanUuid, reply.memory_update).catch((e) =>
      console.error("[handleFanMessage] appendFanMemory fehlgeschlagen:", String(e)),
    );
  }

  switch (reply.route) {
    case "block":
      await deps
        .sendTelegramDraft({
          fanUuid,
          route: "block",
          incomingText,
          messages: [],
          reason: reply.reason,
          actionable: false,
        })
        .catch((e) => console.error("[handleFanMessage] telegram (block) fehlgeschlagen:", String(e)));
      return reply;

    case "escalate":
      await deps
        .sendTelegramDraft({
          fanUuid,
          route: "escalate",
          incomingText,
          messages: reply.messages,
          reason: reply.reason,
          actionable: true,
        })
        .catch((e) => console.error("[handleFanMessage] telegram (escalate) fehlgeschlagen:", String(e)));
      return reply;

    case "safe":
      if (reply.messages.length > 0) {
        await deps.sendToFanvue(fanUuid, reply.messages);
      }
      return reply;
  }
}
