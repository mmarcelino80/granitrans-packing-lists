import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DESTINATIONS,
  addCustomDestination,
  buildPackingList,
  localDateValue,
  materialTotals,
  packingListFilename,
  toggleDestination,
  validatePackingList,
} from './packing-list.mjs';

const material = {
  destination: 'Paris',
  quantity: '2',
  unit: 'un',
  description: 'Bancada Cinza Évora 2 cm, polido, ref. FR-218',
  notes: 'stock',
};

const shipment = { date: '2026-11-19', route: ['Paris'], materials: [material] };

test('destinations follow touch order and a reselected destination goes last', () => {
  const route = ['Valence', 'Paris', 'Thionville'].reduce(toggleDestination, []);
  assert.deepEqual(route, ['Valence', 'Paris', 'Thionville']);
  assert.deepEqual(toggleDestination(toggleDestination(route, 'Paris'), 'Paris'), [
    'Valence', 'Thionville', 'Paris',
  ]);
  assert.deepEqual(route, ['Valence', 'Paris', 'Thionville']);
});

test('multiple named warehouses can be added and reordered with preset destinations', () => {
  const lyon = addCustomDestination(DEFAULT_DESTINATIONS, '  Lyon  /  Armazém A  ');
  const lille = addCustomDestination([...DEFAULT_DESTINATIONS, lyon], 'Lille');
  const route = [lyon, 'Paris', lille].reduce(toggleDestination, []);
  assert.deepEqual(route, ['Lyon / Armazém A', 'Paris', 'Lille']);
  assert.deepEqual(toggleDestination(route, lyon), ['Paris', 'Lille']);
  assert.throws(() => addCustomDestination([...DEFAULT_DESTINATIONS, lyon], 'LYON / ARMAZÉM A'), /Já existe/);
  assert.throws(() => addCustomDestination(DEFAULT_DESTINATIONS, '  paris '), /Já existe/);
  assert.throws(() => addCustomDestination(DEFAULT_DESTINATIONS, '   '), /Introduza/);
});

test('date defaults use the local calendar and filenames use the selected ISO date', () => {
  const date = new Date(2026, 0, 2, 0, 1);
  assert.equal(localDateValue(date), '2026-01-02');
  assert.equal(packingListFilename(shipment.date), 'packing-list-2026-11-19.txt');
  assert.equal(packingListFilename('2026-02-30'), 'packing-list.txt');
});

test('approval rejects missing info, calendar overflow and incomplete material lines', () => {
  assert.deepEqual(validatePackingList(shipment), []);
  assert.deepEqual(validatePackingList({ ...shipment, date: '2024-02-29' }), []);
  assert.equal(validatePackingList({ date: '', route: [], materials: [], introduction: ' ' }).length, 4);

  const errors = validatePackingList({
    date: '2026-02-29',
    route: ['Thionville'],
    materials: [{ ...material, quantity: '0', unit: '', description: '' }],
  });
  assert.equal(errors.length, 5);
  assert.match(errors.join('\n'), /data[\s\S]*destino[\s\S]*quantidade[\s\S]*unidade[\s\S]*descrição/);
  for (const quantity of ['-1', '1e2', 'Infinity', 'NaN', '3,4,5']) {
    const errors = validatePackingList({ ...shipment, materials: [{ ...material, quantity }] });
    assert.match(errors[0], /quantidade/);
  }
});

test('totals keep different units separate and add decimal quantities exactly', () => {
  const materials = [
    material,
    { ...material, quantity: '0,10', unit: 'm²' },
    { ...material, quantity: '0.2', unit: 'm²' },
    { ...material, quantity: '3', unit: ' ' },
    { ...material, quantity: '-1' },
  ];
  assert.deepEqual(materialTotals(materials), [
    { unit: 'un', quantity: '2' },
    { unit: 'm²', quantity: '0,3' },
  ]);
});

test('TXT renders bilingual greetings, ordered sections and complete material details', () => {
  const text = buildPackingList({
    ...shipment,
    route: ['Lyon', 'Paris'],
    materials: [material, { ...material, destination: 'Lyon', client: 'Atelier Émile', notes: '(encosto)' }],
  });
  assert.match(text, /^Bom dia\. Segue abaixo .+ camião\.\nBonjour, veuillez trouver .+ camion\./);
  assert.match(text, /Rota: Lyon → Paris\nData de carga: 19\/11\/2026/);
  assert.ok(text.indexOf('\nLYON / Atelier Émile\n') < text.indexOf('\nPARIS\n'));
  assert.ok(text.includes(`- 2 un - ${material.description} (stock)`));
  assert.ok(text.includes(`- 2 un - ${material.description} (encosto)`));
  assert.ok(text.endsWith('\n\nObrigado / Merci\n'));
});

test('TXT sums only materials with matching destination, client, unit, description and notes', () => {
  const text = buildPackingList({
    ...shipment,
    route: ['Paris', 'Valence'],
    materials: [
      material,
      { ...material, quantity: '0.4' },
      { ...material, quantity: '0,6' },
      { ...material, notes: 'encosto' },
      { ...material, description: material.description.replace('2 cm', '3 cm') },
      { ...material, unit: 'm²' },
      { ...material, client: 'Cliente C22' },
      { ...material, destination: 'Valence' },
    ],
  });
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(lines, [
    `- 3 un - ${material.description} (stock)`,
    `- 2 un - ${material.description} (encosto)`,
    `- 2 un - ${material.description.replace('2 cm', '3 cm')} (stock)`,
    `- 2 m² - ${material.description} (stock)`,
    `- 2 un - ${material.description} (stock)`,
    `- 2 un - ${material.description} (stock)`,
  ]);
});

test('draft preview tolerates an unfinished form and marks fictitious examples', () => {
  const preview = buildPackingList({ date: '', route: [], materials: [material], demo: true });
  assert.match(preview, /^DEMONSTRAÇÃO — DADOS FICTÍCIOS\n\nBom dia\./);
  assert.match(preview, /Rota: Por selecionar\nData de carga: Por indicar/);
  assert.ok(!preview.includes(material.description));
});
