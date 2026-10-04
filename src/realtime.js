import { WebSocketServer } from 'ws';

let wss;

export function attachRealtime(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
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
