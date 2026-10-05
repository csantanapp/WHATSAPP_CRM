import 'dotenv/config';

const GRAPH_VERSION = 'v21.0';

function apiUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function callGraphApi(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const message = data?.error?.message || `WhatsApp API error (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function sendTextMessage(toWaId, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return callGraphApi(`${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

// Lista os templates de mensagem aprovados pela Meta pra essa conta (WABA) —
// únicos que podem ser enviados fora da janela de 24h. Degrada pra lista
// vazia (em vez de lançar) se a conta ainda não tiver WABA/token configurado,
// pra não quebrar a tela de templates antes da conexão real estar pronta.
export async function listMessageTemplates() {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!wabaId || !token) return [];

  const res = await fetch(apiUrl(`${wabaId}/message_templates?fields=name,language,status,category,components&limit=100`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Falha ao listar templates (${res.status})`);
  }
  return (data.data || []).filter((t) => t.status === 'APPROVED');
}

export async function sendTemplateMessage(toWaId, { name, language, components }) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return callGraphApi(`${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: components || [],
    },
  });
}

export async function markMessageAsRead(waMessageId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return callGraphApi(`${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: waMessageId,
  });
}

// Faz uma chamada de leitura simples (GET) contra o número configurado, só pra
// confirmar que o token/phone_number_id são válidos — usado na tela de Configurações.
export async function checkConnectionStatus() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    return { configured: false, connected: false, message: 'Credenciais não configuradas no .env' };
  }

  try {
    const res = await fetch(apiUrl(`${phoneNumberId}?fields=display_phone_number,verified_name`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return { configured: true, connected: false, message: data?.error?.message || 'Falha ao validar credenciais' };
    }
    return {
      configured: true,
      connected: true,
      phoneNumber: data.display_phone_number,
      verifiedName: data.verified_name,
    };
  } catch (err) {
    return { configured: true, connected: false, message: err.message };
  }
}

// --- Mídia ---

// 1) Pega a URL temporária (expira em minutos) + mime type de um media_id recebido.
// 2) Baixa os bytes de verdade com o token de acesso (a URL sozinha não é pública).
export async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const metaRes = await fetch(apiUrl(mediaId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta?.error?.message || 'Falha ao obter URL da mídia');

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Falha ao baixar mídia (${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return { buffer, mimeType: meta.mime_type, sizeBytes: meta.file_size };
}

// Envia o arquivo (multipart/form-data) pra Meta antes de poder mandar como
// mensagem — a API exige um media_id próprio dela, não aceita bytes direto.
export async function uploadMedia(buffer, mimeType, filename) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(apiUrl(`${phoneNumberId}/media`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao enviar mídia pra Meta');
  return data.id;
}

export async function sendMediaMessage(toWaId, mediaId, type, caption) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const body = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type,
    [type]: { id: mediaId, ...(caption && type !== 'audio' ? { caption } : {}) },
  };
  return callGraphApi(`${phoneNumberId}/messages`, body);
}
