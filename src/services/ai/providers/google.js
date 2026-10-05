// Provider real via Google Gemini (Generative Language API) — chamada HTTP direta.

const MODEL = process.env.GOOGLE_MODEL || 'gemini-2.0-flash';

export async function completeGoogle({ system, messages, apiKey }) {
  if (!apiKey) throw new Error('Chave do Google (Gemini) não configurada');

  const userText = messages.map((m) => m.content).join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Google API error (${res.status})`);
  }

  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    tokensIn: data.usageMetadata?.promptTokenCount || 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount || 0,
  };
}
