# CRM WhatsApp — FullHouse

CRM próprio de atendimento via WhatsApp: Kanban multi-funil, conversas em tempo real e automações
(fluxo visual estilo ManyChat, usado principalmente como formulário conversacional de qualificação
de lead na primeira mensagem).

Stack nativa, sem frameworks pesados: **Node.js + Express + PostgreSQL + HTML/CSS/JS puro**.
Integração com a **API oficial do WhatsApp (Meta Cloud API)** — sem WAHA, sem BSP terceirizado.

## Estrutura

```
src/
  server.js              # bootstrap do Express + WebSocket
  realtime.js            # broadcast de eventos (novas mensagens, mudança de etapa) via WS
  db/
    schema.sql           # schema Postgres (contacts, funnels, conversations, messages, automations)
    pool.js               # pool de conexão pg
    migrate.js / seed.js  # scripts de setup
  whatsapp/
    client.js            # chamadas à Graph API (enviar mensagem, marcar como lida)
    webhook.js            # recebe mensagens/status da Meta, valida assinatura HMAC
  automation/
    engine.js             # motor de fluxo: send_message, ask_question, add_tag, move_stage
  repositories/           # acesso a dados (contacts, conversations, messages)
  routes/api.js           # API REST usada pelo frontend
public/
  index.html              # protótipo navegável (telas: Kanban, Conversa, Automações, Construtor de fluxo)
```

## Setup local (já feito nesta máquina)

- Postgres via Homebrew rodando, banco `whatsapp_crm` criado
- `npm install`, `npm run migrate`, `npm run seed` já executados
- Servidor validado de ponta a ponta: webhook simulado → contato/conversa criados → aparece no Kanban real

Para rodar do zero em outra máquina:
```bash
cp .env.example .env      # preencher DATABASE_URL e credenciais da Meta (ver checklist abaixo)
npm install
npm run migrate
npm run seed
npm run dev
```
Acesse `http://localhost:3000`.

## Checklist — conectar a um número real de WhatsApp (Meta Cloud API)

1. **Criar o app na Meta for Developers**
   - Acesse https://developers.facebook.com/apps → "Criar app" → tipo **"Negócios"**.
   - Dentro do app, adicione o produto **WhatsApp**.

2. **Pegar as credenciais de teste (fase de desenvolvimento)**
   - Em WhatsApp → **Configuração da API**, a Meta já libera um número de teste.
   - Copie para o `.env`:
     - `WHATSAPP_ACCESS_TOKEN` — token temporário (~24h) mostrado na página; depois trocar por um token permanente (ver passo 5).
     - `WHATSAPP_PHONE_NUMBER_ID` — ID do número de teste, mostrado na mesma página.
     - `WHATSAPP_BUSINESS_ACCOUNT_ID` — ID da conta comercial (WABA), também na mesma página.

3. **Adicionar destinatários de teste**
   - Ainda em fase de teste, a Meta só entrega mensagens para números cadastrados como destinatários.
   - Em WhatsApp → Configuração da API → "To" → adicione seu próprio celular e confirme pelo código recebido.

4. **Expor o servidor local e configurar o webhook**
   - `ngrok` já está instalado nesta máquina (`brew install ngrok`).
   - Rode `ngrok http 3000` — ele te dá uma URL pública tipo `https://xxxx.ngrok-free.app`.
   - No app da Meta → WhatsApp → **Configuração** → **Webhook** → "Editar":
     - Callback URL: `https://xxxx.ngrok-free.app/webhook/whatsapp`
     - Verify token: o mesmo valor que está em `WHATSAPP_VERIFY_TOKEN` no `.env`
   - Clique em "Verificar e salvar" (o servidor já implementa a verificação em `src/whatsapp/webhook.js`).
   - Em "Campos do Webhook", ative pelo menos `messages`.

5. **Gerar o App Secret (para validar a assinatura do webhook)**
   - Configurações do app → Básico → "Chave secreta do aplicativo" → copiar para `WHATSAPP_APP_SECRET`.

6. **Testar de verdade**
   - Mande uma mensagem do seu celular (o número cadastrado como destinatário de teste) para o número de teste da Meta.
   - Ela deve aparecer no Kanban (`http://localhost:3000`) na etapa "Novo lead" do Funil de Vendas, com atualização em tempo real via WebSocket.
   - Responda pela tela — deve chegar de verdade no WhatsApp do celular.

7. **Ir para produção (quando validar com o número de teste)**
   - Trocar o número de teste por um número comercial real (comprar/portar um número dedicado — não pode ser um WhatsApp pessoal já em uso).
   - Gerar um token de acesso permanente (System User com permissão `whatsapp_business_messaging`, em Configurações do Negócio → Usuários do sistema).
   - Passar pela verificação de negócio da Meta (Business Verification) para tirar os limites de mensagens da fase de teste.
   - Trocar o túnel (ngrok) por um domínio real com HTTPS válido apontando pro servidor em produção.

## Estado atual

- [x] Schema do banco (contatos, funis/etapas, conversas, mensagens, fluxos de automação)
- [x] Webhook de recebimento (mensagens + status de entrega) com validação de assinatura
- [x] Envio de mensagens via Graph API
- [x] Motor de automação básico (gatilho "primeira mensagem", passos sequenciais, pausa em pergunta)
- [x] API REST (contatos, funis, conversas, mensagens, mover etapa)
- [x] WebSocket para atualização em tempo real do Kanban/conversa
- [x] Frontend ligado na API real (Kanban e Conversa não usam mais dados mockados)
- [x] Testado ponta a ponta localmente com Postgres real (webhook → contato → conversa → Kanban)
- [x] Fluxo de automação "Primeira mensagem" real cadastrado no banco (via seed) e disparando de verdade
- [x] `automation_runs` não trava mais em "running" quando um passo falha (ex: erro da Graph API) — marca `stopped`
- [x] API de fluxos de automação (`GET/POST /api/automation-flows`, ativar/desativar)
- [x] `ngrok` instalado, pronto para expor o webhook em desenvolvimento
- [x] **Deploy em produção**: `https://wh.tractom.com.br`, rodando em containers próprios (app + Postgres) na VPS da Tractom (2.25.198.220), atrás do Caddy compartilhado, isolado dos outros produtos
- [x] Dashboard real (contatos totais, conversas abertas, fechadas na semana, automações ativas, conversas recentes)
- [x] Tela de Contatos real (listar, buscar por nome/telefone, criar contato manualmente)
- [x] Tela de Configurações real (status da conexão WhatsApp validado contra a Graph API, gestão de funis e etapas — criar funil, criar etapa)
- [x] Busca funcional no Kanban (filtra por nome/telefone), exportar contatos em CSV, criar contato direto do Kanban
- [x] Toda a barra lateral é funcional — nenhum ícone é só decorativo
- [ ] Credenciais reais da Meta ainda não configuradas em produção — depende de você criar o app (checklist acima)
- [ ] Construtor de Fluxo (o canvas visual) ainda é só protótipo estático — não lê/grava do banco; a lista de Automações (que já é real) permite ativar/desativar fluxos, mas criar um fluxo novo via UI ainda depende da API diretamente
- [ ] Importar contatos via CSV (removido do protótipo por ora — exportar já funciona)
- [ ] Autenticação de atendentes (login, times, atribuição de conversas)
