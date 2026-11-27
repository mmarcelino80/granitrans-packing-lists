import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeGuides, documentLanguage, WAREHOUSES } from './logistics.mjs';

const material = {
  quantity: '2', unit: 'Chapas', description: 'Quartzo Éclat 12 mm', commercialName: 'Quartzo Éclat',
  thickness: '12 mm', finish: 'Polido', reference: 'QA', destination: null, client: null, notes: 'STOCK', issues: [],
};
function guide(unloadingWarehouse, lines = [material]) {
  return {
    id: unloadingWarehouse, name: unloadingWarehouse + '.pdf',
    loadingWarehouse: 'Braga', unloadingWarehouse, loadingDate: '2026-11-26',
    pages: [{ page: 1, lines, issues: [], totals: [] }], issues: [], totals: [],
  };
}
test('recognizes official warehouses and derives document language from physical unloading', () => {
  assert.equal(WAREHOUSES.length, 11);
  for (const stop of WAREHOUSES) {
    assert.equal(documentLanguage(stop), ['Paris', 'Thionville', 'Valence'].includes(stop) ? 'pt-fr' : stop === 'Santiago' ? 'es' : 'pt');
  }
  const { results } = organizeGuides([
    guide('Negrais', [material, { ...material, destination: 'Paris', notes: 'ENCOMENDA + ESCOVAR' }]),
    guide('Santiago'), guide('Paris'),
  ]);
  assert.equal(results.length, 3);
  assert.match(results[0].text, /Para Negrais:[\s\S]*Para Paris:[\s\S]*ENCOMENDA; ESCOVAR/);
  assert.match(results[1].title, /Descarga en Santiago/);
  assert.match(results[1].text, /2 tablas Quartzo Éclat/);
  assert.match(results[2].title, /Descarga em Paris \/ Déchargement à Paris/);
});
test('uses discharge fallback only when destination was not explicitly uncertain', () => {
  const { results, warnings, blocked } = organizeGuides([
    guide('Negrais', [{ ...material, destination: 'Loulé' }, material, { ...material, destination: 'Logística' }]),
    guide(''),
  ]);
  assert.deepEqual(results[0].rows.map((row) => row.destination), ['Loulé', 'Negrais', 'Destino por confirmar']);
  assert.equal(blocked.length, 1);
  assert.ok(warnings.some((message) => message.includes('Destino final')));
});
test('groups identical editions across lot identifiers and keeps finishes and customers separate', () => {
  const { results: [result] } = organizeGuides([guide('Braga', [
    { ...material, lot: 1 }, { ...material, lot: 2 },
    { ...material, quantity: '8', unit: 'cavaletes', description: 'de ferro', client: '2230', notes: 'ENCOSTO' },
    { ...material, finish: 'Mate' },
  ])]);
  assert.match(result.text, /4 ch Quartzo/);
  assert.match(result.text, /8 cavaletes de ferro \(cliente 2230; ENCOSTO\)/);
  assert.match(result.text, /2 ch Quartzo/);
});
