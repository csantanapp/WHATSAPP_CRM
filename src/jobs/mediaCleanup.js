import { query } from '../db/pool.js';
import { cleanupOrphanMedia } from '../services/mediaStorage.js';
import { logger } from '../logger.js';

// Limpeza diária de mídias que nenhuma mensagem usa mais (ex: de contatos
// excluídos antes de existir a exclusão de arquivos).
export async function runMediaCleanup(opts = {}) {
  const rows = (await query('SELECT media_url FROM messages WHERE media_url IS NOT NULL')).rows;
  const referenced = new Set(rows.map((r) => r.media_url));
  const result = await cleanupOrphanMedia(referenced, opts);
  if (result.deleted.length) {
    logger.info('media_cleanup', { deleted: result.deleted.length, kept: result.kept, bytes: result.bytes, dryRun: Boolean(opts.dryRun) });
  }
  return result;
}
