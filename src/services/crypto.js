import crypto from 'node:crypto';

// AES-256-GCM pra guardar segredos (chaves de API) no banco em vez de só no
// .env — precisa de ENCRYPTION_KEY no ambiente (32 bytes em hex, ex:
// `openssl rand -hex 32`). Formato salvo: "<iv>:<authTag>:<ciphertext>", tudo hex.

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error('ENCRYPTION_KEY não configurada no servidor — não é possível salvar segredos no banco.');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes (64 caracteres hex).');
  return key;
}

export function encryptSecret(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(stored) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
