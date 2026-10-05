import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { findOrCreateContactByIgUserId } from '../repositories/contacts.js';
import {
  findOpenConversationForContact,
  createConversation,
  touchConversation,
} from '../repositories/conversations.js';
import { getDefaultFunnelWithFirstStage } from '../repositories/funnels.js';
import { insertMessage } from '../repositories/messages.js';
import { getInstagramProfile } from './client.js';
import { broadcast } from '../realtime.js';
import { runTriggersForInboundMessage } from '../automation/engine.js';
import { runAiAgentsForInboundMessage } from '../automation/aiAgents.js';

export const instagramWebhookRouter = Router();

// Verificação inicial exigida pela Meta ao configurar o webhook do produto Instagram.
instagramWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function isValidSignature(req) {
  // Mesmo app secret do WhatsApp por padrão — na prática é o mesmo app da
  // Meta assinando os dois produtos, a menos que INSTAGRAM_APP_SECRET seja
  // configurado separadamente (app diferente).
  const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return process.env.NODE_ENV !== 'production';
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || '')
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

instagramWebhookRouter.post('/', async (req, res) => {
  if (!isValidSignature(req)) {
    return res.sendStatus(401);
  }

  // Responde 200 imediatamente — a Meta reenvia se demorar ou se der erro.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        // is_echo = mensagem que o próprio Instagram da empresa mandou (via
        // app oficial, não por aqui) — ignora pra não duplicar no histórico.
        if (event.message && !event.message.is_echo) {
          await handleInboundMessage(event);
        }
      }
    }
  } catch (err) {
    console.error('Erro processando webhook do Instagram:', err);
  }
});

async function handleInboundMessage(event) {
  const igsid = event.sender?.id;
  if (!igsid) return;

  let contact = await findOrCreateContactByIgUserId(igsid);

  // Contato novo sem nome — tenta enriquecer com o perfil via Graph API
  // (melhor esforço, não bloqueia o resto se falhar).
  if (!contact.name) {
    const profile = await getInstagramProfile(igsid);
    if (profile?.username) {
      const display = '@' + profile.username;
      await query('UPDATE contacts SET name = $2, phone_display = $2 WHERE id = $1', [contact.id, display]);
      contact = { ...contact, name: display, phone_display: display };
    }
  }

  let conversation = await findOpenConversationForContact(contact.id);
  if (!conversation) {
    const routing = await getDefaultFunnelWithFirstStage();
    conversation = await createConversation(contact.id, {
      funnelId: routing?.funnel.id,
      funnelStageId: routing?.firstStage?.id,
    });
  }

  const body = event.message.text || null;
  const saved = await insertMessage({
    conversationId: conversation.id,
    waMessageId: event.message.mid, // reaproveita a mesma coluna/índice de dedupe — mid do Instagram é único globalmente
    direction: 'inbound',
    senderType: 'contact',
    body,
  });

  // Reentrega da Meta (mesmo mid já processado) — insertMessage não retorna
  // linha nesse caso, não processa de novo.
  if (!saved) return;

  await touchConversation(conversation.id, { incrementUnread: true, isInbound: true });
  broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });

  await runTriggersForInboundMessage({ conversation, contact, message: saved });
  await runAiAgentsForInboundMessage({ conversation, contact, message: saved });
}
