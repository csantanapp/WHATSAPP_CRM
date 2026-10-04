import { pool } from '../../src/db/pool.js';

// Limpa todas as tabelas de negócio entre testes, preservando o schema.
// TRUNCATE ... CASCADE é seguro aqui porque o banco de teste nunca tem
// dados que importam fora da execução do teste.
export async function resetDb() {
  await pool.query(`
    TRUNCATE TABLE
      automation_run_answers, automation_runs, automation_flow_steps, automation_flows,
      activity_log, messages, conversations, funnel_stages, funnels, contacts, tags, app_settings
    RESTART IDENTITY CASCADE
  `);
}

export async function closeDb() {
  await pool.end();
}
