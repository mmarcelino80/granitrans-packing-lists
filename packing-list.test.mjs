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

test('approval remains blocked in demonstration mode even after all materials have been replaced', () => {
  const demo = { ...shipment, demo: true, materials: [{ ...material, demo: true }] };
  const manual = { ...material, description: 'Peça de teste introduzida manualmente' };
  assert.deepEqual(validatePackingList(demo), ['Saia do modo de demonstração para aprovar o TXT.']);
  assert.deepEqual(validatePackingList({ ...demo, materials: [manual] }), [
    'Saia do modo de demonstração para aprovar o TXT.',
  ]);
  assert.deepEqual(validatePackingList({ ...demo, demo: false, materials: [manual] }), []);
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
    route: ['Valence', 'Lyon / Armazém A', 'Paris', 'Thionville'],
    materials: [
      material,
      { ...material, destination: 'Lyon / Armazém A', client: 'Atelier Émile', notes: '(encosto)' },
      { ...material, destination: 'Valence' },
      { ...material, destination: 'Thionville' },
    ],
  });
  assert.equal(text, [
    'Bom dia,\n\nEnvio o Packing List do camião do dia 19-11-2026, com primeira descarga em Valence.\n\nDe seguida segue para Lyon / Armazém A e Paris e, por fim, para Thionville.',
    'Bonjour,\n\nJe vous transmets la liste de colisage du camion du 19/11/2026, avec un premier déchargement à Valence.\n\nIl se dirigera ensuite vers Lyon / Armazém A et Paris, pour finir à Thionville.',
    ...[
      ['VALENCE / PORTES-LES-VALENCE', 'stock'],
      ['Lyon / Armazém A / Atelier Émile', 'encosto'],
      ['PARIS / BOISSY-SAINT-LEGER', 'stock'],
      ['THIONVILLE', 'stock'],
    ].map(([heading, notes]) => `-${heading}:\n\n-2 un ${material.description} (${notes})`),
    'Obrigado / Merci\n',
  ].join('\n\n\n'));
});

test('one-stop and two-stop routes have complete sentences in both languages', () => {
  const one = buildPackingList(shipment);
  assert.match(one, /do dia 19-11-2026, com descarga em Paris\./);
  assert.match(one, /du 19\/11\/2026, avec un déchargement à Paris\./);
  const two = buildPackingList({ ...shipment, route: ['Thionville', 'Paris'] });
  assert.match(two, /com primeira descarga em Thionville\.\n\nDe seguida segue para Paris\./);
  assert.match(two, /avec un premier déchargement à Thionville\.\n\nIl se dirigera ensuite vers Paris\./);
});

test('custom PT and FR introductions keep the edited wording and resolve or supply dates and routes', () => {
  const text = buildPackingList({
    ...shipment,
    introduction: 'Olá,\r\n\r\nConfirmamos a expedição de {{data}}.\r\n\r\n\r\nSalutations,\r\n\r\nNous confirmons le départ, {{rota}}',
  });
  assert.ok(text.startsWith([
    'Olá,\n\nConfirmamos a expedição de 19-11-2026.\n\nO camião segue com descarga em Paris.',
    'Salutations,\n\nNous confirmons le départ, avec un déchargement à Paris.\n\nLe chargement est prévu le 19/11/2026.',
    '-PARIS / BOISSY-SAINT-LEGER:',
  ].join('\n\n\n')));
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
  const lines = text.split('\n').filter((line) => /^-\d/.test(line));
  assert.deepEqual(lines, [
    `-3 un ${material.description} (stock)`,
    `-2 un ${material.description} (encosto)`,
    `-2 un ${material.description.replace('2 cm', '3 cm')} (stock)`,
    `-2 m² ${material.description} (stock)`,
    `-2 un ${material.description} (stock)`,
    `-2 un ${material.description} (stock)`,
  ]);
  assert.ok(text.includes(`${lines[0]}\n\n${lines[1]}`));
});

test('explicit material units agree with exact or aggregated quantities and custom units remain intact', () => {
  const materials = [
    { ...material, quantity: '1,00', unit: 'chapas', description: 'Branco Encosto 1,2 cm' },
    { ...material, quantity: '1', unit: 'Chapa' },
    { ...material, quantity: '2', unit: 'CHAPAS' },
    { ...material, quantity: '0,40', unit: 'Palete' },
    { ...material, quantity: '0,6', unit: 'paletes' },
    { ...material, quantity: '1', unit: 'Ladrilhos' },
    { ...material, quantity: '2', unit: 'ladrilho', notes: 'Cliente 6723' },
    { ...material, quantity: '2', unit: 'cx.', description: 'Chapas Comerciais A-17' },
  ];
  const text = buildPackingList({ ...shipment, materials });
  const lines = text.split('\n').filter((line) => /^-\d/.test(line));
  assert.deepEqual(lines, [
    '-1 Chapa Branco Encosto 1,2 cm (stock)',
    `-3 Chapas ${material.description} (stock)`,
    `-1 Palete ${material.description} (stock)`,
    `-1 Ladrilho ${material.description} (stock)`,
    `-2 Ladrilhos ${material.description} (Cliente 6723)`,
    '-2 cx. Chapas Comerciais A-17 (stock)',
  ]);
  assert.deepEqual(materialTotals(materials), [
    { unit: 'Chapas', quantity: '4' },
    { unit: 'Palete', quantity: '1' },
    { unit: 'Ladrilhos', quantity: '3' },
    { unit: 'cx.', quantity: '2' },
  ]);
});

test('draft preview tolerates an unfinished form and marks fictitious examples', () => {
  const preview = buildPackingList({ date: '', route: [], materials: [material], demo: true });
  assert.match(preview, /^DEMONSTRAÇÃO — DADOS FICTÍCIOS\n\n\nBom dia,/);
  assert.ok(preview.includes('do dia [data], com descarga em [rota].'));
  assert.ok(preview.includes('du [date], avec un déchargement à [itinéraire].'));
  assert.ok(!preview.includes(material.description));
});
