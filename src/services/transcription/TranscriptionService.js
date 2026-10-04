import { query } from '../../db/pool.js';
import { logger } from '../../logger.js';

// Mesma filosofia do AIService: nunca quebra o recebimento da mensagem se a
// transcrição falhar ou não tiver chave configurada — só fica sem o texto.
async function transcribeMock() {
  return { text: '[Transcrição automática indisponível — configure OPENAI_API_KEY para transcrição real de áudio.]' };
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
  const hasKey = !!process.env.OPENAI_API_KEY;
  try {
    const result = hasKey
      ? await transcribeOpenAI(buffer, mimeType, filename)
      : await transcribeMock();
    await query('UPDATE messages SET transcription = $2 WHERE id = $1', [messageId, result.text]);
    logger.info('audio_transcribed', { messageId, provider: hasKey ? 'openai' : 'mock' });
    return result.text;
  } catch (err) {
    logger.error('audio_transcription_failed', { messageId, message: err.message });
    return null;
  }
}
