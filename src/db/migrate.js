import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

// Runner de migrations incrementais e idempotentes. A primeira migration
// (000_baseline.sql) é o schema.sql histórico, registrado sem reexecução
// quando o banco já o tem aplicado (detectado pela existência de `contacts`),
// pra não reprocessar DDL em produção à toa.
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function alreadyApplied(id) {
  const result = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function markApplied(id) {
  await pool.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

async function schemaAlreadyExists() {
  const result = await pool.query(`
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'contacts'
  `);
  return result.rowCount > 0;
}

async function migrate() {
  await ensureMigrationsTable();

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // nomes NNN_descricao.sql garantem ordem

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (await alreadyApplied(id)) {
      console.log(`[skip] ${id} (já aplicada)`);
      continue;
    }

    // Caso específico do baseline: se o schema já existe no banco (instalação
    // antiga, antes deste runner existir), só registra sem reexecutar o DDL.
    if (id === '000_baseline' && (await schemaAlreadyExists())) {
      console.log(`[baseline] schema já existe — registrando ${id} sem reexecutar`);
      await markApplied(id);
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[run] ${id}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      console.log(`[ok] ${id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[erro] ${id} falhou, rollback aplicado:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('Migrações em dia.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Falha na migração:', err);
  process.exit(1);
});
