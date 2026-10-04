// Middleware de autenticação/autorização. A sessão guarda só IDs — nunca
// senha nem token do WhatsApp — e req.user/req.tenantId são preenchidos a
// partir dela em toda requisição autenticada.

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: { code: 'not_authenticated', message: 'Sessão expirada ou inexistente. Faça login novamente.' } });
  }
  req.user = req.session.user;
  req.tenantId = req.session.user.tenantId;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'not_authenticated', message: 'Sessão expirada.' } });
    }
    if (req.user.isPlatformAdmin) return next(); // super-admin Tractom sempre passa
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Você não tem permissão para essa ação.' } });
    }
    next();
  };
}

// CSRF básico: SameSite=Lax no cookie já bloqueia a maioria dos casos; isso
// adiciona uma segunda camada verificando que o Origin da requisição mutável
// é o nosso próprio domínio (quando o navegador manda o header, o que faz na
// imensa maioria dos POST/PATCH/DELETE modernos).
export function verifyOrigin(req, res, next) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // alguns clientes legítimos (ex: curl, apps nativos) não mandam Origin
  const host = req.get('host');
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: { code: 'invalid_origin', message: 'Origem da requisição não confere.' } });
  }
  // Comparação exata do host (não endsWith — "evilwh.tractom.com.br" não pode
  // passar só porque termina com o nosso domínio).
  if (originHost !== host) {
    return res.status(403).json({ error: { code: 'invalid_origin', message: 'Origem da requisição não confere.' } });
  }
  next();
}
