// Provider real via Mistral AI — API compatível com o formato Chat Completions.

const MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';

export async function completeMistral({ system, messages, apiKey }) {
  if (!apiKey) throw new Error('Chave da Mistral não configurada');

  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Mistral API error (${res.status})`);
  }

  return {
    text: data.choices?.[0]?.message?.content || '',
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
  };
}
