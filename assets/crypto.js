// Passphrase encryption for the data file (AES-256-GCM, key from PBKDF2-SHA256).
// Pure WebCrypto, so the same module runs in the browser and in Node >= 20.

const ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJSON(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
  // Chunk the base64 conversion: spreading a large array into fromCharCode overflows the stack.
  let bin = "";
  for (let i = 0; i < ct.length; i += 0x8000) bin += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return {
    format: "portfolio-encrypted",
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    data: btoa(bin),
  };
}

export async function decryptJSON(payload, passphrase) {
  const key = await deriveKey(passphrase, fromB64(payload.salt), payload.iterations);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv) }, key, fromB64(payload.data));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error("Wrong passphrase");
  }
}

export const isEncrypted = (obj) => obj && obj.format === "portfolio-encrypted";
