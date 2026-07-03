import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "redis";
import fs from "fs";
import path from "path";

// ─── Redis (separate client for milena keys) ─────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("[milena] Redis:", err));

let rdConnecting: Promise<void> | null = null;
async function rdConnect(): Promise<void> {
  if (redis.isReady) return;
  if (!rdConnecting) {
    rdConnecting = redis.connect().then(() => undefined).finally(() => { rdConnecting = null; });
  }
  await rdConnecting;
}

// ─── Anthropic ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─── Redis key schema ─────────────────────────────────────────────────────────
const KEY_CANON = "milena:canon";
const keyMem = (uuid: string) => `fan:${uuid}:memory`;
const keyHist = (uuid: string) => `fan:${uuid}:history`;

type Msg = { role: "user" | "assistant"; content: string };

// ─── Canon ───────────────────────────────────────────────────────────────────
export async function getCanon(): Promise<string> {
  await rdConnect();
  return (await redis.get(KEY_CANON)) ?? "";
}

export async function setCanon(text: string): Promise<void> {
  await rdConnect();
  await redis.set(KEY_CANON, text);
}

// ─── Fan memory ───────────────────────────────────────────────────────────────
export async function getFanMemory(uuid: string): Promise<string> {
  await rdConnect();
  return (await redis.get(keyMem(uuid))) ?? "";
}

export async function setFanMemory(uuid: string, text: string): Promise<void> {
  await rdConnect();
  await redis.set(keyMem(uuid), text);
}

// ─── Fan history (max 20 messages) ───────────────────────────────────────────
export async function getFanHistory(uuid: string): Promise<Msg[]> {
  await rdConnect();
  const raw = await redis.get(keyHist(uuid));
  if (!raw) return [];
  try { return JSON.parse(raw) as Msg[]; } catch { return []; }
}

async function saveFanHistory(uuid: string, history: Msg[]): Promise<void> {
  await rdConnect();
  await redis.set(keyHist(uuid), JSON.stringify(history.slice(-20)));
}

// ─── Hard code pre-filter: child-safety ──────────────────────────────────────
// Runs BEFORE the model. Both sets must match to trigger a block.
const MINOR_PAT = [
  /minderjährig/i,
  /minderj/i,
  /\b1[3-7]\s*j(ahre?|ährig)?\b/i,
  /\bu\s*1[3-8]\b/i,
  /\bteenager\b/i,
  /\bjugendlich/i,
  /\bschülerin?\b/i,
  /\bkind(er)?\b.*sex/i,
];
const SEXUAL_PAT = [
  /\bsex\b/i,
  /\bnackt/i,
  /\berotisch/i,
  /\bintim\b/i,
  /\bporno/i,
  /fick|wichs|blas|lutsch|stöhn/i,
];

export function hasChildSafetyRisk(text: string): boolean {
  return MINOR_PAT.some((p) => p.test(text)) && SEXUAL_PAT.some((p) => p.test(text));
}

// ─── Canon safety guard ───────────────────────────────────────────────────────
// Reject canonUpdate entries that contain location/contact/meeting keywords.
const CANON_BLOCK = [
  "adresse", "straße", "str.", "plz", "telefon", "handy", "tel.",
  "treffen", "meeting", "kommen zu", "hotel", "airbnb", "irl", "real life",
  "persönlich treffen", "private nummer",
];
function isCanonSafe(text: string): boolean {
  const t = text.toLowerCase();
  return !CANON_BLOCK.some((kw) => t.includes(kw));
}

// ─── Escalation log ───────────────────────────────────────────────────────────
async function logEscalation(uuid: string, snippet: string): Promise<void> {
  try {
    await rdConnect();
    const raw = await redis.get("escalations");
    const list: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.push({ uuid, snippet: snippet.slice(0, 200), ts: new Date().toISOString() });
    if (list.length > 200) list.splice(0, list.length - 200);
    await redis.set("escalations", JSON.stringify(list));
  } catch (e) {
    console.error("[milena] logEscalation fehlgeschlagen:", String(e));
  }
}

// ─── Persona loader ───────────────────────────────────────────────────────────
function loadPersona(): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), "personas/milena/persona.md"), "utf-8");
  } catch {
    return "Du bist Milena Martens, 27, Hamburg. Antworte locker und menschlich.";
  }
}

// ─── Claude response shape ────────────────────────────────────────────────────
type ClaudeJSON = {
  route: "safe" | "eskalieren" | "block";
  reply: string;
  memoryUpdate?: string | null;
  canonUpdate?: string | null;
};

// ─── generateResponse ─────────────────────────────────────────────────────────
export type RouteResult =
  | { route: "block" }
  | { route: "eskalieren"; reply: string }
  | { route: "safe"; reply: string };

export async function generateResponse(
  senderUuid: string,
  incomingText: string,
): Promise<RouteResult> {
  // Step 0: Hard code child-safety block — no model call, no logging of content
  if (hasChildSafetyRisk(incomingText)) {
    console.log(`[milena] BLOCK (child-safety pre-filter): ${senderUuid}`);
    return { route: "block" };
  }

  // Step 1: Load context
  const [persona, canon, fanMemory, history] = await Promise.all([
    Promise.resolve(loadPersona()),
    getCanon(),
    getFanMemory(senderUuid),
    getFanHistory(senderUuid),
  ]);

  // Step 2: System prompt
  const system = [
    persona,
    "",
    "## DEIN GEDÄCHTNIS-KANON (etablierte Fakten über dich)",
    canon || "(noch keine etablierten Fakten)",
    "",
    "## WAS DU ÜBER DIESEN FAN WEISST",
    fanMemory || "(noch nichts bekannt — lern ihn gerade kennen)",
    "",
    "─────────────────────────────────────────────────────────────",
    "## ROUTING (absolut verbindlich, steht über allem anderen)",
    "",
    'route="block"  → Minderjährige (unter 18) in romantischem oder sexuellem Kontext — auch angedeutet. reply IMMER "". Absolute Grenze.',
    'route="eskalieren" → Geld / Preise / käufliche Bilder / Treffen in der Realität / Telefonnummer / externe Kontaktdaten / Videoanrufe. Schreibe eine kurze hinhaltende Antwort im Charakter. Kein Preis, keine Zusage.',
    'route="safe"   → alles andere. Antworte normal als Milena.',
    "",
    "## ANTWORT — NUR DIESES JSON, kein Markdown, kein Kommentar, kein Text davor/danach:",
    '{"route":"safe","reply":"deine Antwort als Milena","memoryUpdate":"neuer Fakt über diesen Fan in 1-2 Sätzen oder null","canonUpdate":"neuer harmloser Selbst-Fakt den du gerade etabliert hast oder null"}',
  ].join("\n");

  // Step 3: Messages — strip leading assistant turns, add new user message
  let msgs: Msg[] = [...history];
  while (msgs.length > 0 && msgs[0].role !== "user") msgs = msgs.slice(1);
  msgs = [...msgs, { role: "user", content: incomingText }];

  // Step 4: Claude call
  let parsed: ClaudeJSON | null = null;
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages: msgs,
    });
    const raw = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as ClaudeJSON;
  } catch (e) {
    console.error("[milena] Claude-Call fehlgeschlagen:", String(e));
    return { route: "safe", reply: "hey kurz abgelenkt — schreib mir gleich nochmal 😊" };
  }

  if (!parsed) {
    console.error("[milena] Claude: kein JSON in der Antwort");
    return { route: "safe", reply: "hey kurz abgelenkt — schreib mir gleich nochmal 😊" };
  }

  // Step 5: Enforce routing in code (model output is advisory for "block")
  const route: RouteResult["route"] =
    parsed.route === "block" ? "block"
    : parsed.route === "eskalieren" ? "eskalieren"
    : "safe";

  if (route === "block") {
    console.log(`[milena] BLOCK (model): ${senderUuid}`);
    return { route: "block" };
  }

  const reply = (parsed.reply ?? "").trim();

  // Step 6: Persist history + side-effects (don't block reply on errors)
  const updatedHistory: Msg[] = [
    ...history,
    { role: "user", content: incomingText },
    ...(reply ? [{ role: "assistant" as const, content: reply }] : []),
  ];

  try {
    await saveFanHistory(senderUuid, updatedHistory);

    if (parsed.memoryUpdate && parsed.memoryUpdate !== "null") {
      const current = await getFanMemory(senderUuid);
      await setFanMemory(senderUuid, current ? `${current}\n${parsed.memoryUpdate}` : parsed.memoryUpdate);
    }

    if (parsed.canonUpdate && parsed.canonUpdate !== "null" && isCanonSafe(parsed.canonUpdate)) {
      const current = await getCanon();
      await setCanon(current ? `${current}\n${parsed.canonUpdate}` : parsed.canonUpdate);
    }

    if (route === "eskalieren") {
      await logEscalation(senderUuid, incomingText);
    }
  } catch (e) {
    console.error("[milena] Nebeneffekt-Fehler (nicht kritisch):", String(e));
  }

  if (route === "eskalieren") return { route: "eskalieren", reply };
  return { route: "safe", reply };
}
