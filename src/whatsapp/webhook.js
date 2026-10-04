import { Router } from 'express';
import crypto from 'node:crypto';
import { findOrCreateContactByWaId } from '../repositories/contacts.js';
import {
  findOpenConversationForContact,
  createConversation,
  touchConversation,
} from '../repositories/conversations.js';
import {
  getDefaultFunnelWithFirstStage,
  findFunnelByMessageKeyword,
  applyFunnelDefaultTagsToContact,
} from '../repositories/funnels.js';
import { insertMessage, updateMessageStatusByWaId } from '../repositories/messages.js';
import { sendTextMessage } from './client.js';
import { broadcast } from '../realtime.js';
import { runTriggersForInboundMessage } from '../automation/engine.js';

export const webhookRouter = Router();

// Verificação inicial exigida pela Meta ao configurar o webhook.
webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  // Fallback só fora de produção (dev local, sem secret configurado ainda).
  // Em produção o boot já recusa subir sem WHATSAPP_APP_SECRET (ver server.js),
  // mas blindamos aqui também — nunca aceitar sem assinatura quando NODE_ENV=production.
  if (!appSecret) return process.env.NODE_ENV !== 'production';
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || '')
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual lança RangeError se os buffers tiverem tamanhos diferentes
  // (em vez de retornar false) — uma assinatura forjada de tamanho errado
  // derrubava a requisição com unhandledRejection antes desta checagem.
  if (sigBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

webhookRouter.post('/', async (req, res) => {
  if (!isValidSignature(req)) {
    return res.sendStatus(401);
  }

  // Responde 200 imediatamente — a Meta reenvia se demorar ou se der erro.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (value?.messages) await handleInboundMessages(value);
        if (value?.statuses) await handleStatusUpdates(value);
      }
    }
  } catch (err) {
    console.error('Erro processando webhook do WhatsApp:', err);
  }
});

async function handleInboundMessages(value) {
  const contactProfile = value.contacts?.[0];
  const waId = contactProfile?.wa_id;
  if (!waId) return;

  const contact = await findOrCreateContactByWaId(waId, {
    name: contactProfile?.profile?.name,
  });

  let conversation = await findOpenConversationForContact(contact.id);
  let isNewConversation = false;
  let matchedCampaign = null;

  if (!conversation) {
    isNewConversation = true;
    const firstMsg = value.messages[0];
    const firstBody = firstMsg?.text?.body || firstMsg?.button?.text || firstMsg?.interactive?.button_reply?.title || '';

    // Roteamento por campanha: se a primeira mensagem contém a palavra-chave de
    // algum link wa.me gerado (ex: link do stand do evento), o lead cai direto
    // no funil daquela campanha em vez do funil padrão.
    matchedCampaign = await findFunnelByMessageKeyword(firstBody);
    const routing = matchedCampaign || (await getDefaultFunnelWithFirstStage());

    conversation = await createConversation(contact.id, {
      funnelId: routing?.funnel.id,
      funnelStageId: routing?.firstStage?.id,
    });

    if (routing?.funnel.id) {
      await applyFunnelDefaultTagsToContact(routing.funnel.id, contact.id);
    }
  }

  for (const msg of value.messages) {
    const body = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null;

    const saved = await insertMessage({
      conversationId: conversation.id,
      waMessageId: msg.id,
      direction: 'inbound',
      senderType: 'contact',
      body,
    });

    // A Meta reenvia webhooks (entrega "pelo menos uma vez"); se a mensagem já
    // existir (wa_message_id duplicado), insertMessage não retorna linha — nesse
    // caso não processa de novo (evita contar não-lida em dobro e automação repetida).
    if (!saved) continue;

    await touchConversation(conversation.id, { incrementUnread: true, isInbound: true });

    broadcast({
      type: 'message:new',
      conversationId: conversation.id,
      message: saved,
    });

    if (isNewConversation && matchedCampaign) {
      // Lead veio de uma campanha com link próprio: manda a boas-vindas específica
      // dela (se configurada) em vez de rodar a automação genérica de "primeira mensagem".
      if (matchedCampaign.funnel.welcome_message) {
        await sendCampaignWelcome(conversation, contact, matchedCampaign.funnel);
      }
      isNewConversation = false; // só se aplica à primeira mensagem do lote
      continue;
    }

    await runTriggersForInboundMessage({ conversation, contact, message: saved });
  }
}

async function sendCampaignWelcome(conversation, contact, funnel) {
  try {
    const sent = await sendTextMessage(contact.wa_id, funnel.welcome_message);
    const saved = await insertMessage({
      conversationId: conversation.id,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'automation',
      body: funnel.welcome_message,
    });
    broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
  } catch (err) {
    console.error('Falha ao enviar boas-vindas da campanha:', err.message);
  }
}

async function handleStatusUpdates(value) {
  for (const status of value.statuses) {
    const updated = await updateMessageStatusByWaId(status.id, status.status);
    if (updated) {
      broadcast({ type: 'message:status', waMessageId: status.id, status: status.status });
    }
  }
}
