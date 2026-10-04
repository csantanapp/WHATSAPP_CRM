import { query } from '../db/pool.js';

export async function getSetting(key) {
  const result = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}
