// Logger JSON mínimo, sem dependência nova. Nunca logar credenciais —
// os chamadores são responsáveis por não passar segredos em `meta`.
function log(level, message, meta = {}) {
  const entry = { level, message, ts: new Date().toISOString(), ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};

// Middleware Express: loga rota, status e duração de cada requisição.
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
}
