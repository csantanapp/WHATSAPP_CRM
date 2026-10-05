// Provider real via OpenAI Chat Completions — chamada HTTP direta.

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function completeOpenAI({ system, messages, apiKey }) {
  if (!apiKey) throw new Error('Chave da OpenAI não configurada');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
    throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  }

  return {
    text: data.choices?.[0]?.message?.content || '',
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
  };
}
