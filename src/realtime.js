import { WebSocketServer } from 'ws';
import { createSessionMiddleware } from './auth/session.js';

let wss;

// Canal de tempo real (/ws). Só aceita quem está logado: o upgrade passa pela
// mesma sessão (cookie) do resto do sistema — sem isso, qualquer pessoa na
// internet receberia as mensagens dos clientes em tempo real. Também recusa
// conexões abertas a partir de outro domínio (Origin diferente do Host).
export function attachRealtime(httpServer) {
  const sessionMiddleware = createSessionMiddleware();
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== '/ws') return reject(404, 'Not Found');

    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* inválido */ }
      if (originHost !== req.headers.host) return reject(403, 'Forbidden');
    }

    sessionMiddleware(req, {}, () => {
      const user = req.session?.user;
      if (!user) return reject(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user;
        wss.emit('connection', ws, req);
      });
    });
  });

}

export function broadcast(payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// Usado em testes e num shutdown gracioso: encerra todas as conexões
// WebSocket ativas antes de fechar o servidor HTTP, senão `server.close()`
// fica pendurado esperando conexões que nunca terminam o handshake de close.
export function closeRealtime() {
  if (!wss) return;
  for (const client of wss.clients) client.terminate();
  wss.close();
}
