import { createClient } from "redis";

const KEY_AT  = "fanvue:access_token";
const KEY_EXP = "fanvue:access_token_expiry";
const KEY_RT  = "fanvue:refresh_token";

const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (err) => console.error("[tokenStore] Redis error:", err));

let connectPromise: Promise<void> | null = null;

async function connect(): Promise<void> {
  if (client.isReady) return;
  if (!connectPromise) {
    connectPromise = client.connect().then(() => undefined).finally(() => { connectPromise = null; });
  }
  await connectPromise;
}

/**
 * Returns the stored access token and whether it has expired (60s safety buffer).
 * Returns null if no access token is stored yet.
 */
export async function getAccessToken(): Promise<{ token: string; expired: boolean } | null> {
  await connect();
  const [token, expStr] = await Promise.all([client.get(KEY_AT), client.get(KEY_EXP)]);
  if (!token) return null;
  const expiry = expStr ? parseInt(expStr, 10) : 0;
  return { token, expired: Date.now() >= expiry - 60_000 };
}

/** Reads the current refresh token from Redis. No env-var fallback. */
export async function getRefreshToken(): Promise<string | null> {
  await connect();
  return client.get(KEY_RT);
}

/**
 * Persists access token + expiry + optional refresh token atomically.
 * Call this after every token exchange (login) or refresh.
 */
export async function setTokens(
  accessToken: string,
  expiresIn: number,
  refreshToken?: string | null,
): Promise<void> {
  await connect();
  const expiry = String(Date.now() + expiresIn * 1000);
  const ops: Promise<unknown>[] = [
    client.set(KEY_AT, accessToken),
    client.set(KEY_EXP, expiry),
  ];
  if (refreshToken) ops.push(client.set(KEY_RT, refreshToken));
  await Promise.all(ops);
}

/** Convenience: update only the refresh token (e.g. from legacy code paths). */
export async function setRefreshToken(token: string): Promise<void> {
  await connect();
  await client.set(KEY_RT, token);
}
