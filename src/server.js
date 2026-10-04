import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app.js';
import { attachRealtime, closeRealtime } from './realtime.js';
import { logger } from './logger.js';

const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  logger.info('server_started', { port });
});

// Encerramento gracioso: o Docker manda SIGTERM ao parar/recriar o container
// (ex: deploy). Sem isso, conexões WebSocket abertas atrasam o shutdown até o
// timeout forçado do Docker (SIGKILL), o que aparece como "demorou pra subir".
process.on('SIGTERM', () => {
  logger.info('shutdown_started');
  closeRealtime();
  server.close(() => {
    logger.info('shutdown_complete');
    process.exit(0);
  });
});
