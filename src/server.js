import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app.js';
import { attachRealtime, closeRealtime } from './realtime.js';
import { logger } from './logger.js';
import { assertProductionSecrets } from './startupChecks.js';
import { startJobWorker, stopJobWorker } from './jobs/worker.js';

try {
  assertProductionSecrets();
} catch (err) {
  logger.error('startup_check_failed', { message: err.message });
  process.exit(1);
}

const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  logger.info('server_started', { port });
  startJobWorker();
});

// Encerramento gracioso: o Docker manda SIGTERM ao parar/recriar o container
// (ex: deploy). Sem isso, conexões WebSocket abertas atrasam o shutdown até o
// timeout forçado do Docker (SIGKILL), o que aparece como "demorou pra subir".
process.on('SIGTERM', () => {
  logger.info('shutdown_started');
  stopJobWorker();
  closeRealtime();
  server.close(() => {
    logger.info('shutdown_complete');
    process.exit(0);
  });
});
