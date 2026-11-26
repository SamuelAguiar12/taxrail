/**
 * Pure WebCrypto Ed25519 JWT authentication for Coinbase Developer Platform (CDP) x402 Facilitator.
 * Works natively on Cloudflare Workers and Node 22+ without any Node-specific dependencies.
 */

const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonToBase64Url(obj: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeApiKeyId(raw: string): string {
  const clean = stripQuotes(raw);
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean) as { id?: string; name?: string };
      if (parsed.id) return parsed.id.trim();
      if (parsed.name) return parsed.name.trim();
    } catch {
      // Fall through to raw string
    }
  }
  return clean;
}

function base64ToBytes(rawSecret: string): Uint8Array {
  let clean = stripQuotes(rawSecret).replace(/\\n/g, "\n");
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean) as { privateKey?: string; secret?: string };
      clean = (parsed.privateKey || parsed.secret || clean).replace(/\\n/g, "\n");
    } catch {
      // Fall through
    }
  }

  clean = clean
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rem = clean.length % 4;
  if (rem === 2) clean += "==";
  else if (rem === 3) clean += "=";

  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function signEd25519Pkcs8(
  pkcs8Buffer: ArrayBuffer,
  messageBytes: Uint8Array
): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buffer,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, messageBytes);
    return new Uint8Array(sig);
  } catch {
    // Fallback for Cloudflare Workers runtimes using legacy NODE-ED25519 identifier
    const legacyAlg = {
      name: "NODE-ED25519",
      namedCurve: "NODE-ED25519",
    } as unknown as Parameters<typeof crypto.subtle.importKey>[2];
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buffer,
      legacyAlg,
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      { name: "NODE-ED25519" } as unknown as Parameters<typeof crypto.subtle.sign>[0],
      key,
      messageBytes
    );
    return new Uint8Array(sig);
  }
}

function toPkcs8DerBytes(secret: string): Uint8Array {
  const decoded = base64ToBytes(secret);
  // 48-byte RFC 8410 PKCS#8 Ed25519 private key (16-byte prefix + 32-byte seed)
  if (decoded.length === 48 && decoded[0] === 0x30 && decoded[1] === 0x2e) {
    return decoded;
  }
  // Coinbase CDP standard 64-byte base64 Ed25519 secret (32-byte seed + 32-byte public key)
  // or raw 32-byte Ed25519 seed
  if (decoded.length === 64 || decoded.length === 32) {
    const seed = decoded.subarray(0, 32);
    const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
    return pkcs8;
  }
  throw new Error(
    `Unsupported Ed25519 secret key length (${decoded.length} bytes); expected 32, 48 (PKCS#8), or 64 (CDP Ed25519).`
  );
}

function randomHex16(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a short-lived EdDSA (`Ed25519`) JWT signed for a specific Coinbase CDP REST endpoint.
 */
export async function createCdpJwt(params: {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: "GET" | "POST";
  requestHost: string;
  requestPath: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const {
    apiKeyId,
    apiKeySecret,
    requestMethod,
    requestHost,
    requestPath,
    expiresInSeconds = 120,
  } = params;

  const keyId = normalizeApiKeyId(apiKeyId);
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: keyId,
    nonce: randomHex16(),
  };
  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + expiresInSeconds,
    uris: [`${requestMethod.toUpperCase()} ${requestHost}${requestPath}`],
  };

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const pkcs8Bytes = toPkcs8DerBytes(apiKeySecret);
  const pkcs8Buffer = pkcs8Bytes.buffer.slice(
    pkcs8Bytes.byteOffset,
    pkcs8Bytes.byteOffset + pkcs8Bytes.byteLength
  ) as ArrayBuffer;

  const sigBytes = await signEd25519Pkcs8(
    pkcs8Buffer,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bytesToBase64Url(sigBytes)}`;
}

/**
 * Builds the per-endpoint `createAuthHeaders` callback expected by `@x402/core/http`'s
 * `HTTPFacilitatorClient` for Coinbase CDP (`https://api.cdp.coinbase.com/platform/v2/x402`).
 */
export function createCdpFacilitatorAuthHeaders(
  apiKeyId: string,
  apiKeySecret: string
): () => Promise<{
  verify: Record<string, string>;
  settle: Record<string, string>;
  supported: Record<string, string>;
}> {
  const host = "api.cdp.coinbase.com";
  return async () => {
    const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
      createCdpJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "POST",
        requestHost: host,
        requestPath: "/platform/v2/x402/verify",
      }),
      createCdpJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "POST",
        requestHost: host,
        requestPath: "/platform/v2/x402/settle",
      }),
      createCdpJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "GET",
        requestHost: host,
        requestPath: "/platform/v2/x402/supported",
      }),
    ]);

    return {
      verify: { Authorization: `Bearer ${verifyJwt}` },
      settle: { Authorization: `Bearer ${settleJwt}` },
      supported: { Authorization: `Bearer ${supportedJwt}` },
    };
  };
}
