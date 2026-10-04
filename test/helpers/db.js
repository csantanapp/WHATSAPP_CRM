import { pool } from '../../src/db/pool.js';

// Trava de segurança crítica: resetDb() faz TRUNCATE em toda tabela de
// negócio. Se por engano a suíte rodar contra DATABASE_URL de produção (ex:
// variável de ambiente esquecida, .env errado), isso apagaria dados reais.
// Abortamos o processo inteiro na primeira importação deste arquivo se o nome
// do banco não terminar em "_test" — não dá pra confiar só em convenção.
function assertTestDatabase() {
  const url = process.env.DATABASE_URL || '';
  const match = url.match(/\/([^/?]+)(\?.*)?$/);
  const dbName = match ? match[1] : '';

  if (!dbName.endsWith('_test')) {
    // eslint-disable-next-line no-console
    console.error(
      `[SEGURANÇA] DATABASE_URL aponta para "${dbName || '(desconhecido)'}", que NÃO termina em "_test". ` +
      'Recusando rodar a suíte de testes — ela faz TRUNCATE em todas as tabelas de negócio e ' +
      'rodar contra o banco de produção apagaria dados reais. Configure DATABASE_URL para um ' +
      'banco cujo nome termine em "_test" antes de rodar "npm test".'
    );
    process.exit(1);
  }
}

assertTestDatabase();

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
