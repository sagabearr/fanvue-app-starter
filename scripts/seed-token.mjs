#!/usr/bin/env node
/**
 * Einmaliges Seeden des Fanvue Refresh-Tokens in Redis.
 *
 * Verwendung:
 *   REDIS_URL="redis://..." node scripts/seed-token.mjs "ory_rt_dein_frisches_token"
 *
 * Nach dem ersten erfolgreichen Webhook-Lauf wird das Token automatisch
 * rotiert und in Redis aktualisiert — dieses Script ist danach nicht
 * mehr nötig, kann aber jederzeit erneut genutzt werden.
 */

import { createClient } from "redis";

const KEY = "fanvue:refresh_token";
const token = process.argv[2];

if (!token || !token.startsWith("ory_rt_")) {
  console.error("Fehler: Kein gültiges Refresh-Token übergeben.");
  console.error('  Verwendung: REDIS_URL="redis://..." node scripts/seed-token.mjs "ory_rt_..."');
  process.exit(1);
}

if (!process.env.REDIS_URL) {
  console.error("Fehler: REDIS_URL ist nicht gesetzt.");
  process.exit(1);
}

const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (err) => console.error("Redis-Fehler:", err));

await client.connect();

const existing = await client.get(KEY);
if (existing) {
  console.log(`Hinweis: Key "${KEY}" hat bereits einen Wert — wird überschrieben.`);
}

await client.set(KEY, token);
console.log(`✓ "${KEY}" gesetzt.`);

await client.quit();
