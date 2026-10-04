<!-- BEGIN:nextjs-agent-rules -->

# CRM WhatsApp — instruções para agentes

Stack: Node.js puro (ESM) + Express + PostgreSQL (`pg`) + WebSocket (`ws`). Frontend em HTML/CSS/JS
vanilla (sem React/Next/build step). Integração com WhatsApp via API oficial da Meta (Cloud API),
nunca via WAHA ou BSPs terceirizados.

- Regras de negócio (automação, kanban, mensagens) ficam em `src/repositories/` e `src/automation/`,
  nunca direto nas rotas.
- Toda mudança de estado relevante (nova mensagem, etapa alterada) deve passar por `broadcast()` em
  `src/realtime.js` para refletir em tempo real no frontend.
- `public/index.html` é o protótipo visual de referência — replicar fielmente antes de "melhorar"
  design por conta própria.

<!-- END:nextjs-agent-rules -->
