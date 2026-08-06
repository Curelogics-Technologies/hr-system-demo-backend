import crypto from 'crypto';

/**
 * Symmetric encryption for secrets stored at rest (e.g. per-company Indeed
 * credentials). AES-256-GCM: confidential + tamper-evident (auth tag).
 *
 * The master key is derived (SHA-256) from CREDENTIALS_ENCRYPTION_KEY, falling
 * back to JWT_SECRET so the feature works without extra configuration. Set a
 * dedicated CREDENTIALS_ENCRYPTION_KEY in production and keep it stable —
 * rotating it makes previously-stored values undecryptable (they'd read back as
 * null and need re-entering).
 *
 * Stored format: "v1:<ivB64>:<authTagB64>:<cipherTextB64>".
 */
const VERSION = 'v1';

function getKey(): Buffer | null {
  const masterSecret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!masterSecret) return null;
  return crypto.createHash('sha256').update(masterSecret, 'utf8').digest(); // 32 bytes
}

/** True when a master key is available (so encryption can succeed). */
export function isSecretCryptoAvailable(): boolean {
  return getKey() !== null;
}

/**
 * Encrypts a plaintext secret. Throws if no master key is configured — callers
 * must not silently store an unencrypted value.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) {
    throw new Error('Cannot encrypt: no CREDENTIALS_ENCRYPTION_KEY or JWT_SECRET configured.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a value produced by encryptSecret. Returns null on any problem
 * (missing key, wrong format, tampered/rotated key) rather than throwing, so a
 * bad stored value degrades to "not configured" instead of crashing a request.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const key = getKey();
  if (!key) return null;

  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

/** Non-sensitive display hint, e.g. "••••1234" — safe to send to the browser. */
export function maskSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  const last4 = plaintext.slice(-4);
  return `••••${last4}`;
}
