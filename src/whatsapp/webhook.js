import { Router } from 'express';
import { query } from '../db/pool.js';
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
import { recordConversationSource } from '../repositories/conversationSources.js';
import { sendTextMessage, downloadMedia } from './client.js';
import { saveMediaFile } from '../services/mediaStorage.js';
import { transcribeAudio } from '../services/transcription/TranscriptionService.js';
import { getDefaultTenantId } from '../tenant.js';
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

    // Origem do lead (Fase 3) — captura o referral de anúncio Click-to-WhatsApp
    // se vier, senão a palavra-chave de campanha que já roteou pro funil.
    const firstMsgForSource = value.messages[0];
    await recordConversationSource({
      conversationId: conversation.id,
      contactId: contact.id,
      referral: firstMsgForSource?.referral || null,
      campaignKey: matchedCampaign?.funnel?.entry_keyword || null,
    });
  }

  for (const msg of value.messages) {
    const body = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null;
    const media = await processInboundMedia(msg);

    const saved = await insertMessage({
      conversationId: conversation.id,
      waMessageId: msg.id,
      direction: 'inbound',
      senderType: 'contact',
      body: body || media?.caption || null,
      mediaUrl: media?.servePath,
      mediaType: media?.mimeType,
      mediaFilename: media?.filename,
      mediaSizeBytes: media?.sizeBytes,
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

    if (msg.type === 'audio' && saved.media_url) {
      transcribeAudio({
        tenantId: await getDefaultTenantId(),
        messageId: saved.id,
        buffer: media.buffer,
        mimeType: media.mimeType,
        filename: media.filename,
      }).then((text) => {
        if (text) broadcast({ type: 'message:transcribed', conversationId: conversation.id, messageId: saved.id, transcription: text });
      }).catch((err) => console.error('Falha ao transcrever áudio:', err.message));
    }

    // Opt-out (LGPD): "SAIR"/"PARAR"/"CANCELAR" marca o contato e confirma —
    // nenhuma automação de marketing roda depois disso pra ele (ver engine.js).
    if (await handleOptOutIfRequested(conversation, contact, body)) continue;

    await runTriggersForInboundMessage({ conversation, contact, message: saved });
  }
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];

// Baixa e salva a mídia de uma mensagem recebida, se houver. Nunca lança —
// uma falha de download não pode travar o resto do processamento do webhook.
async function processInboundMedia(msg) {
  if (!MEDIA_TYPES.includes(msg.type)) return null;
  const mediaRef = msg[msg.type];
  if (!mediaRef?.id) return null;

  try {
    const { buffer, mimeType, sizeBytes } = await downloadMedia(mediaRef.id);
    const tenantId = await getDefaultTenantId();
    const { servePath } = await saveMediaFile(tenantId, buffer, mimeType);
    return {
      servePath,
      mimeType,
      sizeBytes,
      filename: mediaRef.filename || `${msg.type}.${(mimeType || '').split('/')[1] || 'bin'}`,
      caption: mediaRef.caption || null,
      buffer, // só usado internamente pra transcrição de áudio, não sobe pra insertMessage
    };
  } catch (err) {
    console.error(`Falha ao baixar mídia (${msg.type}, ${mediaRef.id}):`, err.message);
    return null;
  }
}

const OPT_OUT_KEYWORDS = ['sair', 'parar', 'cancelar'];

async function handleOptOutIfRequested(conversation, contact, body) {
  const normalized = (body || '').trim().toLowerCase();
  if (!OPT_OUT_KEYWORDS.includes(normalized)) return false;

  await query("UPDATE contacts SET opted_out_at = now(), marketing_opt_in = false WHERE id = $1", [contact.id]);

  try {
    const confirmText = 'Você não vai mais receber mensagens automáticas da gente por aqui. Se precisar de algo, é só chamar quando quiser.';
    const sent = await sendTextMessage(contact.wa_id, confirmText);
    const saved = await insertMessage({
      conversationId: conversation.id,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'automation',
      body: confirmText,
    });
    broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
  } catch (err) {
    console.error('Falha ao confirmar opt-out:', err.message);
  }

  return true;
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
