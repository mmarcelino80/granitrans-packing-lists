import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { organizeGuides } from './logistics.mjs';

const material = {
  quantity: '1', unit: 'cavalete', description: 'de ferro', commercialName: null,
  thickness: null, finish: null, reference: null, destination: null, client: null, notes: null, issues: [],
};

function document(unloadingWarehouse, lines) {
  return {
    id: unloadingWarehouse, name: unloadingWarehouse + '.pdf', loadingWarehouse: 'Braga',
    unloadingWarehouse, loadingDate: '2026-11-26',
    pages: [{ page: 1, lines, issues: [], totals: [] }], issues: [], totals: [],
  };
}

function result(unloading, lines, options) {
  return organizeGuides([document(unloading, lines)], options).results[0].text;
}

test('translates the Spanish equipment designation with singular and plural forms', () => {
  const singular = result('Santiago', [{ ...material, notes: 'ENCOMENDA; ESCOVAR' }]);
  const plural = result('Santiago', [
    { ...material, quantity: '8', unit: 'cavaletes', notes: 'ENCOMENDA; ESCOVAR' },
  ]);
  assert.match(singular, /1 caballete de hierro \(PEDIDO; CEPILLAR\)/);
  assert.match(plural, /8 caballetes de hierro \(PEDIDO; CEPILLAR\)/);
  assert.doesNotMatch(singular + plural, /de ferro|ESCOVAR|ENCOMENDA/);
});

test('translates French material lines without affecting the bilingual greeting', () => {
  const text = result('Paris', [
    { ...material, notes: 'ENCOMENDA; ESCOVAR' },
    { ...material, quantity: '2', unit: 'cavaletes', description: 'de madeira', notes: 'NÃO EMPILHAR' },
    { ...material, unit: 'Palete', description: 'Cerâmica Duna Teste 8 mm Acetinado',
      commercialName: 'Cerâmica Duna Teste', notes: 'ENCOSTO' },
    { ...material, quantity: '3', unit: 'Paletes', description: 'amostras de madeira' },
  ], { mobile: true, route: ['Paris'] });
  assert.match(text, /Bom dia,[\s\S]*Bonjour,/);
  assert.match(text, /-1 chevalet en fer \(COMMANDE; BROSSER\)/);
  assert.match(text, /-2 chevalets en bois \(NE PAS EMPILER\)/);
  assert.match(text, /-1 palette Cerâmica Duna Teste 8 mm Satiné \(CRÉDENCE\)/);
  assert.match(text, /-3 palettes échantillons en bois/);
});

test('keeps brands, references and client codes while translating finishes and handling terms', () => {
  const row = {
    ...material,
    quantity: '2', unit: 'chapas', description: 'Quartzo Polido™ 12 mm Escovado REF-FERRO-12 FERRO',
    commercialName: 'Quartzo Polido™', reference: 'REF-FERRO-12', client: 'FERRO', finish: 'Escovado',
    notes: 'ENTREGA; manter na vertical; referência REF-FERRO-12; cliente FERRO; "PEDRA DE FERRO"',
  };
  assert.match(result('Santiago', [row]),
    /2 tablas Quartzo Polido™ 12 mm Cepillado REF-FERRO-12 FERRO \(cliente FERRO; ENTREGA; mantener en posición vertical; referencia REF-FERRO-12; cliente FERRO; "PEDRA DE FERRO"\)/);
  assert.match(result('Paris', [row]),
    /-2 tranches Quartzo Polido™ 12 mm Brossé REF-FERRO-12 FERRO \(client FERRO; LIVRAISON; maintenir à la verticale; référence REF-FERRO-12; client FERRO; "PEDRA DE FERRO"\)/);
});

test('translates generic equipment and logistics in the provided guide examples', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./tests/fixtures/gpt-6-luna/expected.json', import.meta.url)));
  const documents = fixtures.cases.map(({ file, expected }) => ({ id: file, name: file, ...expected }));
  const { results } = organizeGuides(documents);
  const santiago = results.find(({ unloading }) => unloading === 'Santiago').text;
  const paris = results.find(({ unloading }) => unloading === 'Paris').text;
  assert.match(santiago, /8 caballetes de hierro \(PEDIDO; CEPILLAR\)/);
  assert.match(santiago, /Quartzito Aurora Teste 20 mm Satinado/);
  assert.match(santiago, /Ladrilho Íris Teste 12 mm Pulido/);
  assert.match(paris, /-1 palette Cerâmica Duna Teste 8 mm Satiné/);
  assert.match(paris, /\? palettes Amostras Bruma Teste/);
});

test('retains Portuguese terms in Portuguese discharge documents', () => {
  const text = result('Negrais', [{ ...material, quantity: '8', unit: 'cavaletes', notes: 'ENCOMENDA; ESCOVAR' }]);
  assert.match(text, /8 cavaletes de ferro \(ENCOMENDA; ESCOVAR\)/);
});

test('uses longest handling terms and does not split equivalent classified stock', () => {
  const text = result('Paris', [
    { ...material, description: 'de aço galvanizado', notes: 'stock; fixar a carga' },
    { ...material, description: 'de aço galvanizado', notes: 'STOCK; fixar a carga' },
  ]);
  assert.match(text, /-2 chevalets en acier galvanisé \(STOCK; arrimer le chargement\)/);
  assert.doesNotMatch(text, /-1 chevalet/);
});

test('preserves plus signs inside reference codes in observations', () => {
  const text = result('Santiago', [
    { ...material, reference: 'FERRO+3', notes: 'REFERÊNCIA FERRO+3 + NÃO EMPILHAR' },
  ]);
  assert.match(text, /REFERENCIA FERRO\+3; NO APILAR/);
});
