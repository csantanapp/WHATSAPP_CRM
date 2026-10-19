import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Lido na hora do uso (não no import), pra respeitar a configuração do ambiente.
const mediaRoot = () => process.env.MEDIA_STORAGE_PATH || '/data/media';

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
  const dir = path.join(mediaRoot(), String(tenantId));
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
  return path.join(mediaRoot(), String(tenantId), filename);
}

// "/api/media/<tenant>/<arquivo>" (como fica salvo em messages.media_url) → caminho no disco.
function pathFromServePath(servePath) {
  const m = String(servePath || '').match(/^\/api\/media\/(\d+)\/([^/]+)$/);
  return m ? mediaFilePath(m[1], m[2]) : null;
}

// Apaga os arquivos de mídia (ex: ao excluir um contato). Arquivo que já não
// existe é ignorado; nunca lança erro pra não travar a exclusão.
export async function deleteMediaFiles(servePaths) {
  let deleted = 0;
  for (const sp of servePaths || []) {
    const file = pathFromServePath(sp);
    if (!file) continue;
    try {
      await unlink(file);
      deleted += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}

// Limpeza de arquivos que nenhuma mensagem usa mais. Só apaga arquivos com
// mais de `minAgeMs` (padrão 1h) pra nunca pegar um upload em andamento.
// `referenced`: conjunto de servePaths ainda usados.
export async function cleanupOrphanMedia(referenced, { minAgeMs = 60 * 60 * 1000, dryRun = false } = {}) {
  const root = mediaRoot();
  const result = { deleted: [], kept: 0, bytes: 0 };
  let tenants;
  try {
    tenants = await readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    throw err;
  }
  const now = Date.now();
  for (const tenant of tenants) {
    if (!/^\d+$/.test(tenant)) continue;
    let files;
    try { files = await readdir(path.join(root, tenant)); } catch { continue; }
    for (const filename of files) {
      const servePath = `/api/media/${tenant}/${filename}`;
      const full = path.join(root, tenant, filename);
      if (referenced.has(servePath)) { result.kept += 1; continue; }
      let info;
      try { info = await stat(full); } catch { continue; }
      if (!info.isFile() || now - info.mtimeMs < minAgeMs) { result.kept += 1; continue; }
      if (!dryRun) await unlink(full);
      result.deleted.push(full);
      result.bytes += info.size;
    }
  }
  return result;
}
