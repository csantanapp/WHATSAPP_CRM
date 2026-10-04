// Checagens de boot que impedem o processo de subir em produção com
// configuração insegura. Lança erro (não chama process.exit diretamente) pra
// ser testável — quem chama em produção real decide como reagir ao erro.
export function assertProductionSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') return;

  if (!env.WHATSAPP_APP_SECRET) {
    throw new Error(
      'WHATSAPP_APP_SECRET ausente em produção (NODE_ENV=production). ' +
      'Sem ele, o webhook da Meta aceitaria qualquer requisição como legítima. ' +
      'Configure WHATSAPP_APP_SECRET em .env.production (Meta for Developers → ' +
      'app → Configurações → Básico → Chave secreta do aplicativo) antes de subir.'
    );
  }

  if (!env.SESSION_SECRET) {
    throw new Error(
      'SESSION_SECRET ausente em produção (NODE_ENV=production). ' +
      'Sem ele, as sessões de login usam o segredo padrão de desenvolvimento, ' +
      'o que permitiria forjar cookies de sessão válidos. Configure SESSION_SECRET ' +
      'em .env.production (qualquer string longa e aleatória, ex: openssl rand -hex 32).'
    );
  }
}
