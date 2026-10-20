import crypto from 'node:crypto';
import { getSetting, setSetting } from '../repositories/settings.js';
import { encryptSecret, decryptSecret } from '../services/crypto.js';
import { logger } from '../logger.js';

// Credenciais do WhatsApp (Cloud API): podem ser salvas pela tela Conexões
// (banco, segredos criptografados) — o que cada instalação de cliente usa —
// ou vir do .env (instalação da Tractom). O que estiver salvo no banco vale.
// Leitura síncrona via wa(): o banco é carregado no boot e a cada gravação.

const KEY = 'whatsapp_credentials';
let saved = {}; // { phoneNumberId, wabaId, verifyToken, accessToken, appSecret }

export async function loadWhatsAppCredentials() {
  try {
    const raw = await getSetting(KEY);
    const data = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : {};
    saved = {
      phoneNumberId: data.phone_number_id || null,
      wabaId: data.waba_id || null,
      verifyToken: data.verify_token || null,
      accessToken: data.access_token_encrypted ? decryptSecret(data.access_token_encrypted) : null,
      appSecret: data.app_secret_encrypted ? decryptSecret(data.app_secret_encrypted) : null,
    };
  } catch (err) {
    logger.error('whatsapp_credentials_load_failed', { message: err.message });
    saved = {};
  }
  return saved;
}

export function wa() {
  return {
    accessToken: saved.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || null,
    phoneNumberId: saved.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    wabaId: saved.wabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    appSecret: saved.appSecret || process.env.WHATSAPP_APP_SECRET || null,
    verifyToken: saved.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || null,
    source: saved.accessToken ? 'panel' : (process.env.WHATSAPP_ACCESS_TOKEN ? 'env' : null),
  };
}

// O que a tela pode ver: nunca os segredos, só se existem.
export function describeWhatsAppCredentials() {
  const c = wa();
  return {
    phone_number_id: c.phoneNumberId,
    waba_id: c.wabaId,
    verify_token: c.verifyToken,
    has_access_token: Boolean(c.accessToken),
    has_app_secret: Boolean(c.appSecret) && !String(c.appSecret).startsWith('pendente-'),
    source: c.source,
  };
}

// Campos vazios mantêm o valor atual (o token e a chave secreta não voltam pra tela).
export async function saveWhatsAppCredentials({ phoneNumberId, wabaId, accessToken, appSecret, verifyToken }) {
  const raw = await getSetting(KEY);
  const current = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : {};
  const clean = (v) => (v == null ? '' : String(v).trim());
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const phone = clean(phoneNumberId) || current.phone_number_id || '';
  const waba = clean(wabaId) || current.waba_id || '';
  if (!/^\d{6,25}$/.test(phone)) throw bad('Informe o ID do número de telefone (só números, está em WhatsApp → Configuração da API).');
  if (waba && !/^\d{6,25}$/.test(waba)) throw bad('O ID da conta do WhatsApp Business tem só números.');
  if (!clean(accessToken) && !current.access_token_encrypted) throw bad('Cole o token de acesso permanente (usuário do sistema).');
  if (!clean(appSecret) && !current.app_secret_encrypted) throw bad('Cole a chave secreta do app (Configurações → Básico).');
  const next = {
    phone_number_id: phone,
    waba_id: waba || null,
    verify_token: clean(verifyToken) || current.verify_token || wa().verifyToken || crypto.randomBytes(12).toString('hex'),
    access_token_encrypted: clean(accessToken) ? encryptSecret(clean(accessToken)) : current.access_token_encrypted,
    app_secret_encrypted: clean(appSecret) ? encryptSecret(clean(appSecret)) : current.app_secret_encrypted,
    updated_at: new Date().toISOString(),
  };
  await setSetting(KEY, JSON.stringify(next));
  await loadWhatsAppCredentials();
  return describeWhatsAppCredentials();
}

// Inscreve o app na conta do WhatsApp Business, pra Meta mandar as mensagens
// pro webhook. Idempotente.
export async function subscribeAppToWaba() {
  const c = wa();
  if (!c.wabaId || !c.accessToken) return { ok: false, message: 'Sem ID da conta do WhatsApp Business.' };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${c.wabaId}/subscribed_apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data?.error?.message || `Meta respondeu ${res.status}` };
    return { ok: Boolean(data.success), message: 'App inscrito para receber as mensagens.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
