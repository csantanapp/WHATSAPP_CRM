import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { renderPlain } from '../automation/variables.js';
import { getNewContactsSync, getSheet, saveRecord } from './google.js';
import { logger } from '../logger.js';

// Valores extras das variáveis de planilha ({{data}}, {{canal}}, {{funil}}...).
export async function sheetExtras(contact, conversation) {
  const now = new Date();
  const tz = { timeZone: 'America/Sao_Paulo' };
  let funil = '';
  if (conversation?.funnel_id) {
    funil = (await query('SELECT name FROM funnels WHERE id = $1', [conversation.funnel_id])).rows[0]?.name || '';
  }
  const interest = (await query(
    'SELECT product FROM contact_interests WHERE contact_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [contact.id]
  )).rows[0]?.product || '';
  return {
    data: now.toLocaleDateString('pt-BR', tz),
    hora: now.toLocaleTimeString('pt-BR', { ...tz, hour: '2-digit', minute: '2-digit' }),
    canal: contact.channel === 'instagram' ? 'Instagram' : 'WhatsApp',
    funil,
    produto_interesse: interest,
    id: String(contact.id),
  };
}

// Colunas padrão do "Enviar todo contato novo".
const NEW_CONTACT_COLUMNS = [
  ['Data', '{{data}} {{hora}}'],
  ['Nome', '{{nome}}'],
  ['Telefone', '{{telefone}}'],
  ['E-mail', '{{email}}'],
  ['Canal', '{{canal}}'],
  ['Funil', '{{funil}}'],
];

// Chamado quando chega um lead novo (conversa criada). Nunca derruba o
// atendimento: erro do Google vira só log.
export async function syncNewContactToSheet(conversation) {
  try {
    const cfg = await getNewContactsSync();
    if (!cfg.enabled || !cfg.sheet_id || !cfg.tab) return null;
    const tenantId = await getDefaultTenantId();
    const sheet = await getSheet(tenantId, cfg.sheet_id);
    if (!sheet) return null;
    const contact = (await query('SELECT * FROM contacts WHERE id = $1', [conversation.contact_id])).rows[0];
    if (!contact) return null;
    const extra = await sheetExtras(contact, conversation);
    const record = Object.fromEntries(NEW_CONTACT_COLUMNS.map(([h, tpl]) => [h, renderPlain(tpl, contact, extra)]));
    return await saveRecord(tenantId, sheet.spreadsheet_id, cfg.tab, record, { matchColumn: 'Telefone' });
  } catch (err) {
    logger.error('sheets_new_contact_failed', { conversationId: conversation?.id, message: err.message });
    return null;
  }
}
