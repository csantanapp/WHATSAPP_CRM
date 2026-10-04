import { query } from '../db/pool.js';

export async function listTags() {
  const result = await query('SELECT * FROM tags ORDER BY name ASC');
  return result.rows;
}

export async function createTag(name, color) {
  const result = await query(
    `INSERT INTO tags (name, color) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET color = tags.color
     RETURNING *`,
    [name, color || '#5B5F58']
  );
  return result.rows[0];
}

export async function deleteTag(id) {
  await query('DELETE FROM tags WHERE id = $1', [id]);
}
