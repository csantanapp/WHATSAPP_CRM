import { query } from '../db/pool.js';
import { getSetting, setSetting } from '../repositories/settings.js';
import { sendTypingIndicator } from '../whatsapp/client.js';
import { sendInstagramTyping } from '../instagram/client.js';
import { logger } from '../logger.js';

// "Digitando..." antes das mensagens automáticas (fluxos, formulários, agente
// de IA, boas-vindas de campanha): mostra o indicador pro lead e espera um
// tempo proporcional ao tamanho do texto, pra conversa parecer humana.
// Melhor esforço: se o indicador falhar, a mensagem sai do mesmo jeito.
//
// TYPING_SIMULATION=off desliga por completo (usado na suíte de testes).

const DEFAULT_MAX_SECONDS = 5;

export async function getTypingConfig() {
  const enabled = (await getSetting('typing_enabled')) !== 'false'; // ligado por padrão
  const max = parseInt(await getSetting('typing_max_seconds'), 10);
  return { enabled, maxSeconds: Number.isNaN(max) ? DEFAULT_MAX_SECONDS : max };
}

export async function updateTypingConfig({ enabled, maxSeconds }) {
  if (enabled !== undefined) await setSetting('typing_enabled', enabled ? 'true' : 'false');
  if (maxSeconds !== undefined) {
    const n = Math.max(1, Math.min(15, parseInt(maxSeconds, 10) || DEFAULT_MAX_SECONDS));
    await setSetting('typing_max_seconds', String(n));
  }
  return getTypingConfig();
}

// ~40ms por caractere (bem mais rápido que uma pessoa, pra não irritar),
// mínimo 1,2s e no máximo `maxSeconds`.
export function typingDelayMs(text, maxSeconds = DEFAULT_MAX_SECONDS) {
  const chars = String(text || '').length;
  return Math.min(maxSeconds * 1000, Math.max(1200, 600 + chars * 40));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function simulateTyping({ conversationId, contact, text }) {
  if (process.env.TYPING_SIMULATION === 'off') return;
  try {
    const config = await getTypingConfig();
    if (!config.enabled) return;

    try {
      if (contact.channel === 'instagram') {
        await sendInstagramTyping(contact.ig_user_id);
      } else {
        // O indicador do WhatsApp precisa de uma mensagem RECEBIDA do contato.
        const last = await query(
          `SELECT wa_message_id FROM messages
           WHERE conversation_id = $1 AND direction = 'inbound' AND wa_message_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [conversationId]
        );
        if (last.rows[0]) await sendTypingIndicator(last.rows[0].wa_message_id);
      }
    } catch (err) {
      logger.info('typing_indicator_failed', { conversationId, message: err.message });
    }

    await sleep(typingDelayMs(text, config.maxSeconds));
  } catch (err) {
    logger.info('typing_simulation_failed', { conversationId, message: err.message });
  }
}
