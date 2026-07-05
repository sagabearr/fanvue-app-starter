// Ruft Anthropic Sonnet auf und parst das strukturierte JSON.
// Modell bewusst als Konstante — Sonnet, NIE Opus (Kostenregel).

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, PromptParts } from "./buildSystemPrompt";

const MODEL = "claude-sonnet-4-6"; // NIE Opus für den Chatbetrieb
const MAX_TOKENS = 700;

export type Route = "safe" | "escalate" | "block";

export interface MilenaReply {
  route: Route;
  messages: string[];
  reason: string;
  canon_update: string | null;
  memory_update: string | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateArgs extends PromptParts {
  history: ChatTurn[];
  apiKey: string;
}

function safeParse(raw: string): MilenaReply {
  let txt = raw.trim();
  txt = txt.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    const obj = JSON.parse(txt);
    if (!obj.route || !Array.isArray(obj.messages)) throw new Error("shape mismatch");
    return {
      route: obj.route as Route,
      messages: obj.messages as string[],
      reason: typeof obj.reason === "string" ? obj.reason : "",
      canon_update: obj.canon_update ?? null,
      memory_update: obj.memory_update ?? null,
    };
  } catch {
    return {
      route: "escalate",
      messages: [],
      reason: "Modellantwort konnte nicht als JSON geparst werden — manuell prüfen.",
      canon_update: null,
      memory_update: null,
    };
  }
}

export async function generateReply(args: GenerateArgs): Promise<MilenaReply> {
  const system = buildSystemPrompt({
    personaMd: args.personaMd,
    canonMd: args.canonMd,
    fanMemoryMd: args.fanMemoryMd,
  });

  const client = new Anthropic({ apiKey: args.apiKey });

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: args.history.map((t) => ({ role: t.role, content: t.content })),
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return safeParse(text);
}
