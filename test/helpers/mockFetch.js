// Troca o fetch global por um mock controlável nos testes, pra nunca bater
// na Graph API de verdade. Cada teste chama `withMockFetch(handler)` dentro
// de um try/finally que restaura o fetch original ao final.
const realFetch = globalThis.fetch;

export function installMockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

export function restoreFetch() {
  globalThis.fetch = realFetch;
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
