import 'dotenv/config';
import { query, pool } from './pool.js';
import { hashPassword } from '../auth/password.js';

// Provisiona o primeiro admin do tenant Tractom. Idempotente: se o e-mail já
// existir nesse tenant, só atualiza a senha (útil pra reset manual via SSH).
// Uso: ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME=... npm run seed:admin
// ADMIN_PLATFORM=false cria um admin comum (o do cliente); o padrão é o
// super-admin da agência (passa por todas as permissões).
// ADMIN_MUST_CHANGE=true obriga a criar uma senha nova no primeiro acesso.
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Admin';
  const platform = process.env.ADMIN_PLATFORM !== 'false';
  const mustChange = process.env.ADMIN_MUST_CHANGE === 'true';

  if (!email || !password) {
    console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD antes de rodar: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD precisa ter pelo menos 8 caracteres.');
    process.exit(1);
  }

  const tenantResult = await query("SELECT id FROM tenants WHERE slug = 'tractom'");
  const tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) {
    console.error('Tenant "tractom" não encontrado — rode as migrations primeiro (npm run migrate).');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role, is_platform_admin, must_change_password)
     VALUES ($1, $2, $3, $4, 'admin', $5, $6)
     ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       must_change_password = EXCLUDED.must_change_password, updated_at = now()
     RETURNING id, email, role, is_platform_admin, must_change_password`,
    [tenantId, name, email, passwordHash, platform, mustChange]
  );

  console.log('Admin pronto:', result.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error('Falha ao criar admin:', err);
  process.exit(1);
});
