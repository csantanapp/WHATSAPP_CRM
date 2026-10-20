// Tela de login do site (chatpipe.com.br/login) entrando direto na instalação
// da empresa (<cliente>.chatpipe.com.br). Só a origem configurada em
// LOGIN_PORTAL_ORIGINS, e só para entrar e trocar a senha — o resto da API
// continua aceitando apenas o próprio domínio.
// O cookie de sessão (SameSite=Lax) vale porque os dois endereços são do
// mesmo site (chatpipe.com.br).
const PORTAL_PATHS = new Set(['/api/auth/login', '/api/auth/change-password']);

function allowedOrigins() {
  return (process.env.LOGIN_PORTAL_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loginPortalCors(req, res, next) {
  const origin = req.get('origin');
  if (!origin || !PORTAL_PATHS.has(req.path)) return next();
  if (!allowedOrigins().includes(origin)) return next();

  req.fromLoginPortal = true;
  res.set({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Cross-Origin-Resource-Policy': 'same-site',
    Vary: 'Origin',
  });
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.sendStatus(204);
  }
  next();
}
