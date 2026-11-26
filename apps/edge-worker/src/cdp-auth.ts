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

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
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

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: apiKeyId.trim(),
    nonce: randomHex16(),
  };
  const payload = {
    sub: apiKeyId.trim(),
    iss: "cdp",
    nbf: now,
    exp: now + expiresInSeconds,
    uris: [`${requestMethod.toUpperCase()} ${requestHost}${requestPath}`],
  };

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const pkcs8Bytes = toPkcs8DerBytes(apiKeySecret.trim());
  const pkcs8Buffer = pkcs8Bytes.buffer.slice(
    pkcs8Bytes.byteOffset,
    pkcs8Bytes.byteOffset + pkcs8Bytes.byteLength
  ) as ArrayBuffer;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Buffer,
    { name: "Ed25519" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuffer))}`;
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
