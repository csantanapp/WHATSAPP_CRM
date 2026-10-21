import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Identidade visual por instalação (BRAND_NAME). Sem a variável, ou com
// "chattrack", nada muda — é a instalação da Tractom. Com "chatpipe", as
// páginas trocam nome, ícone e o verde da marca na hora de servir.

const CHATPIPE = {
  name: 'chatpipe',
  // verde antigo → verde chatpipe (#72E86F); fundo suave e texto sobre ele
  colors: [
    [/#C8F542/gi, '#72E86F'],
    [/rgba\(200,\s*245,\s*66,/g, 'rgba(114,232,111,'],
    [/#F0FBD2/gi, '#E3FAE2'],
    [/#3B4A00/gi, '#0B0B0B'],
    [/#14EF5D/gi, '#72E86F'],
  ],
  // ícone desenhado direto na barra lateral do app
  inlineMark: [/<svg class="sb-mark" viewBox="48\.93 31\.06 132\.22 132\.22"[^>]*>[\s\S]*?<\/svg>/g,
    '<svg class="sb-mark" viewBox="0 0 512 512" width="36" height="36" aria-hidden="true" focusable="false"><rect width="512" height="512" rx="115.2" fill="#0B0B0B"/><rect x="97.28" y="178.58" width="317.44" height="154.85" rx="77.42" fill="#72E86F"/><circle cx="337.3" cy="256" r="55.75" fill="#0B0B0B"/></svg>'],
  files: { '/logo-mark.svg': 'brand/chatpipe/logo-mark.svg', '/favicon.svg': 'brand/chatpipe/favicon.svg' },
};

export function currentBrand() {
  const name = (process.env.BRAND_NAME || '').trim().toLowerCase();
  return name === 'chatpipe' ? CHATPIPE : null;
}

export function applyBrand(text, ext, brand) {
  let out = text;
  for (const [re, to] of brand.colors) out = out.replace(re, to);
  if (ext === '.html') {
    out = out.replace(brand.inlineMark[0], brand.inlineMark[1]);
    out = out.replace(/chattrack/g, brand.name).replace(/Chattrack/g, brand.name.charAt(0).toUpperCase() + brand.name.slice(1));
  }
  return out;
}

// Middleware: páginas, CSS e JS com a identidade; ícones trocados.
export function brandedAssets(publicDir) {
  const cache = new Map();
  return async (req, res, next) => {
    const brand = currentBrand();
    if (!brand || req.method !== 'GET') return next();
    let rel = decodeURIComponent(req.path);
    if (rel.endsWith('/')) rel += 'index.html';
    const swap = brand.files[rel];
    if (swap) return res.type('image/svg+xml').sendFile(path.join(publicDir, swap));
    const ext = path.extname(rel);
    if (!['.html', '.css', '.js'].includes(ext)) return next();
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return next();
    try {
      let body = cache.get(file);
      if (body === undefined) {
        body = applyBrand(await readFile(file, 'utf8'), ext, brand);
        cache.set(file, body);
      }
      res.type(ext === '.html' ? 'html' : ext === '.css' ? 'css' : 'application/javascript').send(body);
    } catch {
      next();
    }
  };
}

// Instalação de cliente: a tela de login é a do site (chatpipe.com.br/login),
// já com o endereço da empresa preenchido.
export function loginPortalRedirect(req, res, next) {
  const portal = (process.env.LOGIN_PORTAL_URL || '').trim();
  if (!portal || req.method !== 'GET' || req.path !== '/login.html') return next();
  const slug = String(req.hostname || '').split('.')[0];
  const url = new URL(portal);
  if (/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) url.searchParams.set('empresa', slug);
  res.redirect(302, url.toString());
}
