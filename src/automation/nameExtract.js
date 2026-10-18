// Extrai só o nome de uma resposta livre à pergunta "Qual é o seu nome?".
//
//   "me chamo Cristiano"                    → "Cristiano"
//   "Oi, boa tarde! Meu nome é ana paula"   → "Ana Paula"
//   "Sou a Maria, tudo bem?"                → "Maria"
//   "CRISTIANO SANTANA aqui 😊"             → "Cristiano Santana"
//   "quero saber o preço"                   → null (não parece um nome — a pergunta é refeita)
//
// Sem IA: regras de português cobrindo as formas comuns de se apresentar.
// Devolve null quando a resposta não parece um nome.

// Cumprimentos/enrolação no começo da frase.
const GREETING = /^(oi+e?|ol[aá]+|opa|eai|e a[ií]|hey|bom dia|boa tarde|boa noite|tudo bem|tudo bom|td bem|td bom|blz|beleza|tranquilo|claro|sim|ok|okay|certo|pois n[aã]o|ent[aã]o|bem|ah+|eh+|hm+)\b[\s,!.;:?-]*/i;

// Forma de se apresentar antes do nome.
// Artigo opcional só conta se vier separado ("sou a Maria"), senão "sou Ana" perderia o "A".
const ART = '(?:[oa]\\s+)?';
const INTRO = new RegExp(
  '^(?:o\\s+)?(?:meu\\s+nome\\s+(?:completo\\s+)?(?:é|e|eh|seria)\\s+' + ART +
  '|(?:eu\\s+)?me\\s+chamo\\s+' +
  '|chamo-me\\s+' +
  '|(?:eu\\s+)?sou\\s+' + ART +
  '|aqui\\s+(?:é|e|eh)\\s+' + ART +
  '|quem\\s+fala\\s+(?:é|e)\\s+' + ART +
  '|(?:é|eh)\\s+' + ART +
  '|pode\\s+me\\s+chamar\\s+de\\s+' +
  '|(?:me\\s+)?chama\\s+de\\s+' +
  '|nome\\s*:\\s*)',
  'i'
);

// Palavras que indicam que a resposta não é um nome (pergunta, recusa, assunto).
const NOT_A_NAME = new RegExp(
  '(?<![\\p{L}])(?:n[aã]o|quero|queria|gostaria|saber|pre[cç]o|valor|quanto|custa|informa[cç](?:ão|ões|ao|oes)|curso|or[cç]amento' +
  '|obrigad[oa]|por\\s+que|pq|porque|pra\\s+que|para\\s+que|nenhum|ningu[eé]m|teste|bot|rob[oô]|atendente|humano|sim|ok' +
  '|voc[eê]|vc|seu|sua|estou|t[oô]|tenho|preciso|vim|procur(?:o|ando)|interessad[oa])(?![\\p{L}])',
  'iu'
);

// Partículas que ficam minúsculas no meio do nome.
const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'van', 'von']);

function stripEmoji(text) {
  return text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, ' ');
}

function titleCase(name) {
  return name.split(' ').map((word, i) => {
    const lower = word.toLocaleLowerCase('pt-BR');
    if (i > 0 && PARTICLES.has(lower)) return lower;
    // Respeita grafias mistas que a pessoa escreveu de propósito (ex: "McDonald").
    const mixed = word !== word.toLocaleLowerCase('pt-BR') && word !== word.toLocaleUpperCase('pt-BR');
    if (mixed) return word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1);
    return lower.split('-').map((part) => part.charAt(0).toLocaleUpperCase('pt-BR') + part.slice(1)).join('-');
  }).join(' ');
}

export function extractName(raw) {
  let text = stripEmoji(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Tira cumprimentos e a forma de apresentação, quantas vezes aparecerem
  // ("Oi, boa tarde! Tudo bem? Meu nome é ...").
  for (let i = 0; i < 6; i++) {
    const before = text;
    text = text.replace(GREETING, '').replace(INTRO, '').trim();
    if (text === before) break;
  }

  // O nome termina no primeiro sinal de pontuação ou quebra de linha
  // ("Cristiano, tudo bem?" / "Ana. Quero saber do curso").
  text = text.split(/[,.!?;:\n()]| - /)[0].trim();

  // Assunto depois do nome: "João e quero saber o valor", "Ana gostaria de...".
  text = text.replace(/(?:\s+e)?\s+(?:quero|queria|gostaria|preciso|precisava|tenho|vim|vi|estou|to|tô|ta|tá|vou|fiquei|achei|procuro|procurando)(?![\p{L}]).*$/iu, '').trim();
  // Pergunta de volta: "José e o seu?", "tudo bem e você?".
  text = text.replace(/(?:^|\s+)e\s+(?:o\s+|a\s+)?(?:seu|sua|voc[eê]|vc|tu)(?![\p{L}]).*$/iu, '').trim();
  // Sobras no fim: "Cristiano aqui", "Maria, prazer", "João mesmo".
  text = text.replace(/\s+(aqui|prazer|mesmo|mesma|tudo\s+bem|tudo\s+bom|blz|beleza)$/i, '').trim();
  // Artigo solto no começo: "a Maria".
  text = text.replace(/^(o|a)\s+(?=\S)/i, '').trim();

  if (!text) return null;
  if (!/^[\p{L}][\p{L}' -]*$/u.test(text)) return null; // só letras, espaço, hífen e apóstrofo
  if (NOT_A_NAME.test(text)) return null;
  const words = text.split(' ').filter(Boolean);
  if (words.length > 5) return null;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2 || text.length > 60) return null;

  return titleCase(words.join(' '));
}
