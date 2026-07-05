#!/usr/bin/env tsx
/**
 * Seed milena:persona und milena:canon nach Redis — nur wenn der Key noch leer ist.
 * Den bestehenden Canon NIEMALS überschreiben (der Bot schreibt ihn zur Laufzeit fort).
 *
 * Einmalig ausführen:
 *   REDIS_URL="redis://..." pnpm tsx scripts/seed-persona.ts
 */

import { createClient } from "redis";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) {
    console.error("Fehler: REDIS_URL ist nicht gesetzt.");
    process.exit(1);
  }

  const client = createClient({ url: REDIS_URL });
  client.on("error", (err) => console.error("Redis-Fehler:", err));
  await client.connect();

  const root = join(process.cwd(), "personas", "milena");

  async function seedIfEmpty(key: string, filePath: string): Promise<void> {
    const existing = await client.get(key);
    if (existing) {
      console.log(`⏭  "${key}" bereits gesetzt (${existing.length} Zeichen) — überspringe`);
      return;
    }
    const content = readFileSync(filePath, "utf-8");
    await client.set(key, content);
    console.log(`✓  "${key}" gesetzt (${content.length} Zeichen)`);
  }

  await seedIfEmpty("milena:persona", join(root, "persona.md"));
  await seedIfEmpty("milena:canon",   join(root, "canon.md"));

  await client.quit();
  console.log("Fertig.");
}

main().catch((e) => { console.error(e); process.exit(1); });
