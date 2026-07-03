import { createClient } from "redis";

const KEY = "fanvue:refresh_token";

// Module-level client — wiederverwendet über Lambda-Aufrufe hinweg.
// Kein quit() — Vercel Node.js hält den Prozess warm.
const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (err) => console.error("[tokenStore] Redis error:", err));

let connectPromise: Promise<void> | null = null;

async function connect(): Promise<void> {
  if (client.isReady) return;
  if (!connectPromise) {
    connectPromise = client.connect().finally(() => {
      connectPromise = null;
    });
  }
  await connectPromise;
}

export async function getRefreshToken(): Promise<string | null> {
  await connect();
  const stored = await client.get(KEY);
  if (stored) return stored;

  // Env-Fallback: Falls Redis-Key noch leer ist (erster Start / nach Reset),
  // wird FANVUE_REFRESH_TOKEN einmalig gelesen und in Redis persistiert.
  const envToken = process.env.FANVUE_REFRESH_TOKEN;
  if (envToken) {
    await client.set(KEY, envToken);
  }
  return envToken ?? null;
}

export async function setRefreshToken(token: string): Promise<void> {
  await connect();
  await client.set(KEY, token);
}
