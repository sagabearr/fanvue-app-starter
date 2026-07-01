import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

// Reject events older than 5 minutes (non-blocking for first test: logs warning, doesn't 401)
const MAX_AGE_SECONDS = 300;
const ENFORCE_TIMESTAMP = false;

export async function POST(request: Request) {
  // Read raw body BEFORE any parsing — required for correct HMAC verification
  const rawBody = await request.text();

  const signingSecret = process.env.FANVUE_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[webhook/fanvue] FANVUE_SIGNING_SECRET is not set");
    return NextResponse.json({ error: "server misconfiguration" }, { status: 500 });
  }

  // Header format: "t={timestamp},v0={signature}"
  const sigHeader = request.headers.get("x-fanvue-signature") ?? "";
  const parts: Record<string, string> = {};
  for (const segment of sigHeader.split(",")) {
    const eq = segment.indexOf("=");
    if (eq > 0) parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }

  const timestamp = parts["t"];
  const receivedSig = parts["v0"];

  if (!timestamp || !receivedSig) {
    console.warn("[webhook/fanvue] missing or malformed X-Fanvue-Signature header");
    return NextResponse.json({ error: "missing signature" }, { status: 401 });
  }

  // Timestamp check (optional — warns only until ENFORCE_TIMESTAMP = true)
  const ts = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    if (ENFORCE_TIMESTAMP) {
      console.warn(`[webhook/fanvue] stale timestamp: ${timestamp}`);
      return NextResponse.json({ error: "timestamp out of range" }, { status: 401 });
    }
    console.warn(`[webhook/fanvue] stale timestamp (not enforced): ${timestamp}`);
  }

  // HMAC-SHA256 over "{timestamp}.{rawBody}"
  const expected = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  let valid = false;
  try {
    valid = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(receivedSig, "utf8"));
  } catch {
    // Lengths differ -> definitely invalid
    valid = false;
  }

  if (!valid) {
    console.warn("[webhook/fanvue] signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Valid event — parse and log for Vercel log inspection
  let event: unknown = rawBody;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // non-JSON body, logged as-is
  }
  console.log("[webhook/fanvue] event received:", JSON.stringify(event));

  return NextResponse.json({ received: true }, { status: 200 });
}
