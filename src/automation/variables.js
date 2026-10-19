// Variáveis nas mensagens das automações: {{nome}}, {{primeiro_nome}},
// {{email}}, {{telefone}} ou o nome de um campo do formulário ({{Interesse}}).
// Nome do campo não diferencia maiúscula/acento/espaço ({{interesse}} e
// {{ Interesse }} funcionam igual). Variável sem valor some do texto e a
// pontuação em volta é ajustada ("Olá, {{nome}}!" vira "Olá!").

function normalizeKey(key) {
  return String(key).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
}

function variablesFor(contact) {
  const name = (contact?.name || '').trim();
  const values = {
    nome: name,
    'primeiro nome': name.split(/\s+/)[0] || '',
    email: contact?.email || '',
    telefone: contact?.phone_display || '',
  };
  for (const [field, value] of Object.entries(contact?.custom_fields || {})) {
    const key = normalizeKey(field);
    if (!(key in values)) values[key] = value == null ? '' : String(value);
  }
  return values;
}

export function renderTemplate(text, contact) {
  if (!text || !text.includes('{{')) return text || '';
  const values = variablesFor(contact);
  let removed = false;
  const rendered = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
    const value = String(values[normalizeKey(key)] || '').trim();
    if (!value) removed = true;
    return value;
  });
  if (!removed) return rendered;
  return rendered
    .replace(/,[ \t]*([!?.])/g, '$1') // "Olá, !" -> "Olá!"
    .replace(/[ \t]+([,!?.])/g, '$1') // "Olá !" -> "Olá!"
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t,]+/gm, '');
}

// Valor "cru" pra planilha (Google Sheets): troca as variáveis sem mexer na
// pontuação. Além das de mensagem, aceita {{data}}, {{hora}}, {{canal}},
// {{funil}}, {{produto_interesse}} e {{id}} (passados em `extra`).
export function renderPlain(text, contact, extra = {}) {
  if (!text || !String(text).includes('{{')) return text == null ? '' : String(text);
  const values = variablesFor(contact);
  for (const [k, v] of Object.entries(extra)) values[normalizeKey(k)] = v == null ? '' : String(v);
  return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => String(values[normalizeKey(key)] ?? '').trim());
}
