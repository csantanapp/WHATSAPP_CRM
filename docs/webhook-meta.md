# Configuração do Webhook da Meta — estado atual (documentado em 2026-10-04)

## App e número

- **App Meta**: "Tractom Whats" (app_id `2530369790765391`)
- **⚠️ Correção importante (2026-10-04)**: o sistema estava configurado com o **número de teste da Meta** (`+1 555-150-6330`), não com o número real da Tractom. Corrigido:
  - `WHATSAPP_PHONE_NUMBER_ID` = `862747723583228` (**real**: +55 44 3101-0272, "Cristiano - TRACTOM Marketing Estratégico")
  - `WHATSAPP_BUSINESS_ACCOUNT_ID` (WABA) = `994468479393590` (**real** — antes estava `2001578900552069`, que é a WABA do número de teste)
  - Essa WABA real **não tinha nenhum app inscrito pra receber webhook** (`GET /{waba-id}/subscribed_apps` retornava vazio) — é por isso que mensagens pro número real nunca chegariam ao sistema, mesmo com tudo mais certo. Inscrito via `POST /{waba-id}/subscribed_apps` com o token de sistema existente.
  - Token de acesso é SYSTEM_USER (não expira por tempo — `expires_at: 0` no `debug_token`), escopos `whatsapp_business_management` + `whatsapp_business_messaging`.
- `WHATSAPP_ACCESS_TOKEN`: configurado, confirmado como token de sistema permanente
- `WHATSAPP_VERIFY_TOKEN`: configurado, usado na verificação `GET /webhook/whatsapp`
- **Número de teste** (`1278704765331255` / WABA `2001578900552069`) continua existindo na mesma conta Meta, só não é mais o configurado no `.env.production` — útil pra testes futuros sem usar o número real.

## URL do webhook

`https://wh.tractom.com.br/webhook/whatsapp` — único endpoint, GET (verificação) e POST (eventos).

## ⚠️ ACHADO CRÍTICO — validação HMAC efetivamente desligada

`WHATSAPP_APP_SECRET` **está vazio** em `.env.production`. O código em `src/whatsapp/webhook.js` tem o seguinte comportamento, por design, para permitir rodar em dev sem configurar nada:

```js
if (!appSecret) return true; // permite rodar sem validação em dev, se não configurado
```

**Efeito em produção**: qualquer requisição POST para `/webhook/whatsapp` é aceita como legítima, sem checar se veio mesmo da Meta. Alguém que descubra essa URL pode:
- injetar mensagens falsas de "clientes" no CRM;
- disparar automações (inclusive envio de mensagens reais pelo WhatsApp da Tractom) escolhendo o número de origem;
- gerar custo de IA/automação e risco de banimento do número por comportamento anômalo.

**Correção necessária (ação do Cris, não minha):** pegar o **App Secret** em Meta for Developers → app → Configurações → Básico → "Chave secreta do aplicativo", e configurar `WHATSAPP_APP_SECRET` em `/root/whatsapp-crm-fullhouse/.env.production` na VPS. Depois disso, redeployar (`docker compose up -d`) — a validação HMAC passa a ser obrigatória automaticamente, sem mudança de código.

Enquanto isso não for feito, uma correção de código que já apliquei na Fase 0 evita pelo menos que uma assinatura malformada **derrube o processo** (ver "Bug corrigido" abaixo) — mas a validação em si continua desligada até o secret ser configurado.

## Campos do webhook assinados

**Confirmado por Cris em 2026-10-04**: o campo `messages` está marcado/inscrito no painel (WhatsApp → Configuração → Webhooks → Gerenciar). É o único campo necessário até aqui — o código hoje só processa `value.messages` e `value.statuses`.

**Pendente para a Fase 2:** marcar também `message_template_status_update` nesse mesmo painel, quando o gerenciamento de templates (seção 2.6 do roadmap) for implementado — sem isso, atualizações de status de template aprovado/rejeitado pela Meta não chegam ao sistema.

## Bug corrigido na Fase 0

`isValidSignature()` usava `crypto.timingSafeEqual()` diretamente nos buffers da assinatura recebida e da esperada. Essa função **lança `RangeError`** (em vez de retornar `false`) quando os dois buffers têm tamanhos diferentes — o que acontece com qualquer assinatura forjada de tamanho "errado". Como a rota é `async` e o erro não era capturado, isso virava uma `unhandledRejection` por requisição malformada — um vetor de negação de serviço trivial assim que `WHATSAPP_APP_SECRET` for configurado (hoje não é explorável só porque a validação está desligada, ver acima).

**Correção**: comparar o tamanho dos buffers antes de chamar `timingSafeEqual`, retornando `false` para tamanhos diferentes sem lançar exceção. Coberto pelo teste `webhook POST com assinatura HMAC inválida é rejeitado (401)` em `test/regression.test.js`.
