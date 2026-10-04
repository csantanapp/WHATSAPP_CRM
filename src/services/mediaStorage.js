import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MEDIA_ROOT = process.env.MEDIA_STORAGE_PATH || '/data/media';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

// Salva em /data/media/<tenant_id>/<uuid>.<ext> — isolado por tenant no
// próprio caminho, nunca servido por express.static (sempre via rota
// autenticada que confere o tenant do arquivo contra o da sessão).
export async function saveMediaFile(tenantId, buffer, mimeType) {
  const ext = EXT_BY_MIME[mimeType] || 'bin';
  const filename = `${crypto.randomUUID()}.${ext}`;
  const dir = path.join(MEDIA_ROOT, String(tenantId));
  await mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, buffer);

  return {
    storagePath: fullPath,
    servePath: `/api/media/${tenantId}/${filename}`,
  };
}

export function mediaFilePath(tenantId, filename) {
  // Impede path traversal — filename só pode ser o nome gerado por nós (uuid.ext).
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return null;
  return path.join(MEDIA_ROOT, String(tenantId), filename);
}
