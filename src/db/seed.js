import { pool, query } from './pool.js';

async function seed() {
  const funnels = [
    { name: 'Funil de Vendas', color: '#12A37D', position: 0, is_default: true },
    { name: 'Funil de Suporte', color: '#2563EB', position: 1, is_default: false },
    { name: 'Funil de Reativação', color: '#7C3AED', position: 2, is_default: false },
  ];

  for (const f of funnels) {
    const existing = await query('SELECT id FROM funnels WHERE name = $1', [f.name]);
    if (existing.rows[0]) continue;

    const inserted = await query(
      'INSERT INTO funnels (name, color, position, is_default) VALUES ($1,$2,$3,$4) RETURNING id',
      [f.name, f.color, f.position, f.is_default]
    );
    const funnelId = inserted.rows[0].id;

    if (f.name === 'Funil de Vendas') {
      const stages = [
        { name: 'Novo lead', color: '#12A37D' },
        { name: 'Em atendimento', color: '#2563EB' },
        { name: 'Aguardando cliente', color: '#D97706' },
        { name: 'Fechado', color: '#7C3AED', is_closed_stage: true },
      ];
      for (let i = 0; i < stages.length; i++) {
        const s = stages[i];
        await query(
          'INSERT INTO funnel_stages (funnel_id, name, color, position, is_closed_stage) VALUES ($1,$2,$3,$4,$5)',
          [funnelId, s.name, s.color, i, !!s.is_closed_stage]
        );
      }
    }
  }

  const existingFlow = await query("SELECT id FROM automation_flows WHERE name = 'Primeira mensagem'");
  if (!existingFlow.rows[0]) {
    const flow = await query(
      `INSERT INTO automation_flows (name, trigger_type, trigger_config, is_active)
       VALUES ($1,$2,$3,true) RETURNING id`,
      ['Primeira mensagem', 'first_message', '{}']
    );
    await query(
      `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position)
       VALUES ($1,'send_message',$2,0)`,
      [flow.rows[0].id, JSON.stringify({ text: 'Olá! Obrigado por entrar em contato com a FullHouse 👋 Em que podemos ajudar hoje?' })]
    );
  }

  console.log('Seed aplicado com sucesso.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Falha no seed:', err);
  process.exit(1);
});
