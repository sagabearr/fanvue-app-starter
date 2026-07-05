import { createClient } from "redis";

// Shared Redis client for persona/canon/fan-memory operations.
// Token operations use their own client in tokenStore.ts (not touching that).
const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (err) => console.error("[redis] error:", err));

let connectPromise: Promise<void> | null = null;

export async function getRedis() {
  if (client.isReady) return client;
  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(() => undefined)
      .finally(() => { connectPromise = null; });
  }
  await connectPromise;
  return client;
}
