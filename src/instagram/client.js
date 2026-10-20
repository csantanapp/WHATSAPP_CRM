import 'dotenv/config';
import { getInstagramToken } from './token.js';

const GRAPH_VERSION = 'v21.0';

// Instagram API com login do Instagram (fluxo mais novo, sem Página do
// Facebook no meio) usa host próprio — graph.instagram.com, não
// graph.facebook.com — e autentica com o token da própria conta do
// Instagram, não um token de Página. Ver:
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
function igApiUrl(path) {
  return `https://graph.instagram.com/${GRAPH_VERSION}/${path}`;
}

// Envia uma mensagem de texto pro Instagram DM via Messaging API — usa o
// token de acesso da própria conta profissional do Instagram (gerado na
// tela "Instagram API com login do Instagram" do app, não um token de
// Página) e o ID numérico dessa conta (INSTAGRAM_PAGE_ID).
export async function sendInstagramMessage(igsid, text) {
  const igToken = await getInstagramToken();
  const igBusinessId = process.env.INSTAGRAM_PAGE_ID;
  if (!igToken) throw new Error('Token do Instagram não configurado');
  if (!igBusinessId) throw new Error('INSTAGRAM_PAGE_ID não configurado');

  const res = await fetch(igApiUrl(`${igBusinessId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${igToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: igsid },
      message: { text },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Instagram API error (${res.status})`);
  }
  return data; // { recipient_id, message_id }
}

// "Digitando..." no Instagram DM (sender_action da mesma Messaging API).
export async function sendInstagramTyping(igsid) {
  const igToken = await getInstagramToken();
  const igBusinessId = process.env.INSTAGRAM_PAGE_ID;
  if (!igToken || !igBusinessId) return null;
  const res = await fetch(igApiUrl(`${igBusinessId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${igToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, sender_action: 'typing_on' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Instagram API error (${res.status})`);
  }
  return true;
}

// Busca nome/username/foto do remetente — o webhook do Instagram não manda o
// perfil junto (diferente do WhatsApp), então enriquecemos num passo à parte,
// melhor esforço (nunca derruba o processamento da mensagem se falhar).
export async function getInstagramProfile(igsid) {
  const igToken = await getInstagramToken();
  if (!igToken) return null;
  try {
    const res = await fetch(igApiUrl(`${igsid}?fields=name,username,profile_pic`), {
      headers: { Authorization: `Bearer ${igToken}` },
    });
    const data = await res.json();
    if (!res.ok) return null;
    return data;
  } catch {
    return null;
  }
}

// Checagem de saúde da conexão — mesma ideia do checkConnectionStatus do
// WhatsApp, usada na tela de Conexões. No fluxo "login do Instagram" não há
// Página pra consultar: validamos o token direto perguntando "quem sou eu".
export async function checkInstagramConnectionStatus() {
  const igToken = await getInstagramToken();
  const igBusinessId = process.env.INSTAGRAM_PAGE_ID;

  if (!igToken || !igBusinessId) {
    return { configured: false, connected: false, message: 'Credenciais não configuradas no .env' };
  }

  try {
    const res = await fetch(igApiUrl(`me?fields=user_id,username,name`), {
      headers: { Authorization: `Bearer ${igToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return { configured: true, connected: false, message: data?.error?.message || 'Falha ao validar credenciais' };
    }
    return {
      configured: true,
      connected: true,
      pageName: data.name || data.username,
      igUsername: data.username,
    };
  } catch (err) {
    return { configured: true, connected: false, message: err.message };
  }
}
