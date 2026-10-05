// Provider determinístico pra dev/teste — nunca chama rede, nunca custa nada.
// Usado quando ai_settings.provider = 'mock' (padrão até alguém configurar
// uma chave real) ou quando o provider real falha (degrada, não quebra).

export async function completeMock({ system, messages, feature }) {
  const lastUserMessage = messages[messages.length - 1]?.content || '';

  // Resumo de conversa: devolve um JSON plausível reconhecendo que é mock.
  if (feature === 'summarize_conversation') {
    return {
      text: JSON.stringify({
        summary: '[mock] Resumo gerado sem IA real configurada — configure ANTHROPIC_API_KEY pra respostas de verdade.',
        need: '—',
        objection: '—',
        product: '—',
        next_step: 'Revisar manualmente',
        temperature: 'morno',
      }),
      tokensIn: lastUserMessage.length,
      tokensOut: 40,
    };
  }

  if (feature === 'daily_radar') {
    return {
      text: JSON.stringify({
        priorities: ['[mock] Configure ANTHROPIC_API_KEY para o radar gerar prioridades reais.'],
      }),
      tokensIn: lastUserMessage.length,
      tokensOut: 20,
    };
  }

  if (feature === 'ai_agent_reply') {
    return {
      text: '[mock] Resposta automática do agente de IA — configure uma chave real em Configurações para respostas de verdade.',
      tokensIn: lastUserMessage.length,
      tokensOut: 20,
    };
  }

  if (feature === 'classify_automation') {
    return { text: JSON.stringify({ result: false }), tokensIn: lastUserMessage.length, tokensOut: 10 };
  }

  return { text: '[mock] resposta genérica', tokensIn: 0, tokensOut: 0 };
}
