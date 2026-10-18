import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractName } from '../src/automation/nameExtract.js';
import { parseAnswer } from '../src/automation/formQuestion.js';

// Pergunta "Qual é o seu nome?": grava só o nome, não a frase inteira.

const CASES = [
  ['me chamo Cristiano', 'Cristiano'],
  ['Meu nome é Cristiano Santana', 'Cristiano Santana'],
  ['meu nome e cristiano', 'Cristiano'],
  ['Oi, boa tarde! Meu nome é ana paula', 'Ana Paula'],
  ['Sou a Maria, tudo bem?', 'Maria'],
  ['sou Ana', 'Ana'],
  ['CRISTIANO SANTANA aqui 😊', 'Cristiano Santana'],
  ['joao DOS santos', 'Joao dos Santos'],
  ['Pode me chamar de Bia', 'Bia'],
  ['É o Pedro', 'Pedro'],
  ['Aqui é a Fernanda', 'Fernanda'],
  ['Bom dia, sou o Carlos. Quero saber do curso', 'Carlos'],
  ['Cristiano, prazer', 'Cristiano'],
  ["Ana D'Ávila", "Ana D'Ávila"],
  ['Ana-Clara', 'Ana-Clara'],
  ['oi tudo bem? me chamo Lucas', 'Lucas'],
  ['Me chamo João e quero saber o valor do curso', 'João'],
  ['meu nome é José e o seu?', 'José'],
  ['Sou o Marcos e vi o anúncio', 'Marcos'],
  ['Okay, Paulo', 'Paulo'],
  // Nomes que começam parecido com as palavras removidas continuam inteiros.
  ['Eduardo', 'Eduardo'], ['Elisa', 'Elisa'], ['Maria Eduarda', 'Maria Eduarda'], ['Bento', 'Bento'], ['Antônio', 'Antônio'],
];
const NOT_NAMES = ['quero saber o preço', 'não quero informar', 'pra que?', '123', 'ok', 'sim', 'Oi', '👍', 'Tudo bem e você?', 'Estou interessada', 'Tô procurando curso'];

test('extrai só o nome das formas comuns de se apresentar', () => {
  for (const [input, expected] of CASES) assert.equal(extractName(input), expected, input);
});

test('respostas que não são nome voltam null (a pergunta é refeita)', () => {
  for (const input of NOT_NAMES) assert.equal(extractName(input), null, input);
});

test('a pergunta com "salvar em Nome do lead" usa a extração', () => {
  assert.equal(parseAnswer({ save_to: 'name' }, 'me chamo Cristiano'), 'Cristiano');
  assert.equal(parseAnswer({ save_to: 'name' }, 'quero saber o preço'), null);
  // Sem salvar em Nome, a resposta continua livre.
  assert.equal(parseAnswer({ save_to: 'custom', custom_field: 'Obs' }, 'me chamo Cristiano'), 'me chamo Cristiano');
});
