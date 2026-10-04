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
