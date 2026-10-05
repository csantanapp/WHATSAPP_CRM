import 'dotenv/config';

const GRAPH_VERSION = 'v21.0';

function apiUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

// Envia uma mensagem de texto pro Instagram DM via Send API da Página
// (mesmo mecanismo do Messenger — o IGSID é o "sender.id" que chega no
// webhook). Usa o token de acesso da Página, não o do app do WhatsApp.
export async function sendInstagramMessage(igsid, text) {
  const pageToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!pageToken) throw new Error('INSTAGRAM_PAGE_ACCESS_TOKEN não configurado');

  const res = await fetch(apiUrl('me/messages'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: igsid },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Instagram API error (${res.status})`);
  }
  return data; // { recipient_id, message_id }
}

// Busca nome/username do remetente — o webhook do Instagram não manda o
// perfil junto (diferente do WhatsApp), então enriquecemos num passo à parte,
// melhor esforço (nunca derruba o processamento da mensagem se falhar).
export async function getInstagramProfile(igsid) {
  const pageToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!pageToken) return null;
  try {
    const res = await fetch(apiUrl(`${igsid}?fields=name,username`), {
      headers: { Authorization: `Bearer ${pageToken}` },
    });
    const data = await res.json();
    if (!res.ok) return null;
    return data;
  } catch {
    return null;
  }
}

// Checagem de saúde da conexão — mesma ideia do checkConnectionStatus do
// WhatsApp, usada na tela de Conexões.
export async function checkInstagramConnectionStatus() {
  const pageToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  const pageId = process.env.INSTAGRAM_PAGE_ID;

  if (!pageToken || !pageId) {
    return { configured: false, connected: false, message: 'Credenciais não configuradas no .env' };
  }

  try {
    const res = await fetch(apiUrl(`${pageId}?fields=name,instagram_business_account{username,name}`), {
      headers: { Authorization: `Bearer ${pageToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return { configured: true, connected: false, message: data?.error?.message || 'Falha ao validar credenciais' };
    }
    if (!data.instagram_business_account) {
      return { configured: true, connected: false, message: 'Essa Página não tem uma conta profissional do Instagram vinculada.' };
    }
    return {
      configured: true,
      connected: true,
      pageName: data.name,
      igUsername: data.instagram_business_account.username,
    };
  } catch (err) {
    return { configured: true, connected: false, message: err.message };
  }
}
