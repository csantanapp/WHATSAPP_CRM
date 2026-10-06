import { query } from '../../db/pool.js';
import { logger } from '../../logger.js';

// Mesma filosofia do AIService: nunca quebra o recebimento da mensagem se a
// transcrição falhar ou não tiver provedor configurado — só fica sem o texto.
async function transcribeMock() {
  return { text: '[Transcrição automática indisponível — nenhum provedor de transcrição configurado.]' };
}

// Provedor local: whisper-asr-webservice (faster-whisper) rodando em
// container próprio na mesma rede Docker — sem custo por uso, sem API key.
async function transcribeLocal(buffer, mimeType, filename) {
  const baseUrl = process.env.WHISPER_LOCAL_URL;
  if (!baseUrl) throw new Error('WHISPER_LOCAL_URL não configurada');

  const form = new FormData();
  form.append('audio_file', new Blob([buffer], { type: mimeType }), filename || 'audio.ogg');

  const res = await fetch(`${baseUrl}/asr?output=json&language=pt&task=transcribe`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || `Whisper local error (${res.status})`);
  return { text: (data.text || '').trim() };
}

async function transcribeOpenAI(buffer, mimeType, filename) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  return { text: data.text };
}

export async function transcribeAudio({ tenantId, messageId, buffer, mimeType, filename }) {
  const hasLocal = !!process.env.WHISPER_LOCAL_URL;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const provider = hasLocal ? 'local' : hasOpenAI ? 'openai' : 'mock';

  try {
    const result = provider === 'local'
      ? await transcribeLocal(buffer, mimeType, filename)
      : provider === 'openai'
        ? await transcribeOpenAI(buffer, mimeType, filename)
        : await transcribeMock();
    await query('UPDATE messages SET transcription = $2 WHERE id = $1', [messageId, result.text]);
    logger.info('audio_transcribed', { messageId, provider });
    return result.text;
  } catch (err) {
    logger.error('audio_transcription_failed', { messageId, provider, message: err.message });
    return null;
  }
}
