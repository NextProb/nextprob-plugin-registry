import crypto from 'node:crypto';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function keyId(key) {
  const publicKey = key.type === 'public' ? key : crypto.createPublicKey(key);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export function sign(data, privateKey) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.sign(null, bytes, privateKey).toString('base64');
}

export function verify(data, signature, publicKey) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const signatureBytes = Buffer.from(String(signature).trim(), 'base64');
  try {
    return crypto.verify(null, bytes, publicKey, signatureBytes);
  } catch {
    return false;
  }
}

export function signatureFile(signature) {
  return `${signature}\n`;
}
