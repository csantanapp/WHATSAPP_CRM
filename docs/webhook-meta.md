# Configuração do Webhook da Meta — estado atual (documentado em 2026-10-04)

## App e número

- **App Meta**: não identificado pelo nome nesta sessão — confirmar no Meta for Developers com o `WHATSAPP_BUSINESS_ACCOUNT_ID` abaixo.
- `WHATSAPP_PHONE_NUMBER_ID` = `1278704765331255`
- `WHATSAPP_BUSINESS_ACCOUNT_ID` (WABA) = `2001578900552069`
- `WHATSAPP_ACCESS_TOKEN`: configurado (não é token de teste de 24h — não foi possível confirmar validade/expiração sem consultar o Meta for Developers diretamente)
- `WHATSAPP_VERIFY_TOKEN`: configurado, usado na verificação `GET /webhook/whatsapp`

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

Não foi possível confirmar pela API quais campos (`messages`, `message_template_status_update` etc.) estão marcados como assinados no painel da Meta — isso só é visível no Meta for Developers (WhatsApp → Configuração → Webhooks → Gerenciar). O código hoje só processa `value.messages` e `value.statuses`; qualquer outro campo assinado seria recebido mas ignorado silenciosamente.

**Ação recomendada:** confirmar no painel que pelo menos `messages` está marcado. Os demais campos (ex: status de template) passam a importar a partir da Fase 2 deste roadmap.

## Bug corrigido na Fase 0

`isValidSignature()` usava `crypto.timingSafeEqual()` diretamente nos buffers da assinatura recebida e da esperada. Essa função **lança `RangeError`** (em vez de retornar `false`) quando os dois buffers têm tamanhos diferentes — o que acontece com qualquer assinatura forjada de tamanho "errado". Como a rota é `async` e o erro não era capturado, isso virava uma `unhandledRejection` por requisição malformada — um vetor de negação de serviço trivial assim que `WHATSAPP_APP_SECRET` for configurado (hoje não é explorável só porque a validação está desligada, ver acima).

**Correção**: comparar o tamanho dos buffers antes de chamar `timingSafeEqual`, retornando `false` para tamanhos diferentes sem lançar exceção. Coberto pelo teste `webhook POST com assinatura HMAC inválida é rejeitado (401)` em `test/regression.test.js`.
