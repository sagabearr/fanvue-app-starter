// Setzt den System-Prompt zusammen.
// Reihenfolge fix: Persona → Canon → Fan-Memory → Ausgabe-Vertrag.
// Inhaltliche Regeln stehen in den .md-Dateien in Redis — nicht hier.

export interface PromptParts {
  personaMd: string;
  canonMd: string;
  fanMemoryMd: string;
}

const OUTPUT_CONTRACT = `
# ─── AUSGABE-VERTRAG (nicht verhandelbar) ───
Du antwortest AUSSCHLIESSLICH mit einem einzigen JSON-Objekt. Kein Text davor,
kein Text danach, keine Markdown-Code-Fences. Schema:

{
  "route": "safe" | "escalate" | "block",
  "messages": string[],
  "reason": string,
  "canon_update": string | null,
  "memory_update": string | null
}

ROUTING-REGELN:
- "block": Nachricht berührt Minderjährige in sexuellem/romantischem Kontext (in
  JEDER Form, auch angedeutet) → SCHUTZSCHICHT 2. "messages" muss leer sein [].
  Wird nie an den Fan gesendet.
- "escalate": alles, was ein Mensch entscheiden muss, bevor es rausgeht:
  * konkrete Geld-/Preis-/PPV-/Kauf-Themen
  * Drängen auf Treffen/Telefon/Videocall/Kontaktdaten, das über die charmante
    Standard-Abwehr hinausgeht
  * Beschwerden, Refund-Forderungen, Drohungen, echte persönliche Krise des Fans
  * ernste, direkte "Bist du eine KI?"-Frage
  * alles, wo du unsicher bist
  In "messages" trotzdem einen Antwort-VORSCHLAG liefern (Draft), aber route=escalate.
- "safe": normale Konversation im Milena-Rahmen. Wird autonom an den Fan gesendet.

canon_update NUR setzen, wenn Milena einen neuen, NÜCHTERNEN, harmlosen Selbst-Fakt
etabliert hat (kein Ironie-Fakt, nichts Richtung Identifizierbarkeit/Ort/Treffen).
Sonst null. Im Zweifel null.
`.trim();

export function buildSystemPrompt(parts: PromptParts): string {
  const fanBlock =
    parts.fanMemoryMd.trim().length > 0
      ? `# ─── WAS DU ÜBER DIESEN FAN WEISST (Fan-Memory) ───\n${parts.fanMemoryMd.trim()}`
      : `# ─── NEUER FAN ───\nDu weißt noch nichts über ihn. Erfinde NICHTS. Sei neugierig, frag beiläufig.`;

  return [
    parts.personaMd.trim(),
    `# ─── DEIN KANON (etablierte Selbst-Fakten — bei jeder Antwort beachten) ───\n${parts.canonMd.trim()}`,
    fanBlock,
    OUTPUT_CONTRACT,
  ].join("\n\n");
}
