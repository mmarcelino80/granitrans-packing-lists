import { buildPackingList, materialTotals } from './packing-list.mjs';
import { prepareReview, reviewTotals } from './review.mjs';
import { canonicalLogisticsUnit, translateLogisticsText, translateLogisticsUnit } from './logistics-terms.mjs';

export const WAREHOUSES = Object.freeze([
  'Negrais', 'Braga', 'Penafiel', 'Coimbra', 'Batalha', 'Loulé', 'Logística',
  'Santiago', 'Paris', 'Thionville', 'Valence',
]);
const french = new Set(['Paris', 'Thionville', 'Valence']);
const clean = (value) => value?.trim().replace(/\s+/gu, ' ') ?? '';
const normalized = (value) => clean(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const warehouse = (value) => WAREHOUSES.find((place) => normalized(place) === normalized(value));
const quantity = (value) => /^\d+(?:[,.]\d+)?$/u.test(clean(value)) && Number(clean(value).replace(',', '.')) > 0;
const formatDate = (date) => date?.split('-').reverse().join('/');

export function documentLanguage(unloading) {
  return french.has(unloading) ? 'pt-fr' : unloading === 'Santiago' ? 'es' : 'pt';
}

const destinations = {
  pt: (name) => `Para ${name}:`,
  es: (name) => `Para ${name}:`,
  'pt-fr': (name) => `Para ${name} / Pour ${name}:`,
};

export function documentTitle(unloading) {
  return 'PACKING LIST - ' + ({
    pt: `Descarga em ${unloading}`,
    es: `Descarga en ${unloading}`,
    'pt-fr': `Descarga em ${unloading} / Déchargement à ${unloading}`,
  })[documentLanguage(unloading)];
}

const standaloneNotes = new Set(['stock', 'encomenda', 'escovar', 'encosto']);

function notesFor(row, language) {
  const notes = clean(row.notes).split(/\s*;\s*|\s+\+\s+/u).filter(Boolean);
  const classification = notes.find((note) => ['stock', 'encomenda'].includes(normalized(note)));
  const client = row.client ? (language === 'pt-fr' ? 'client ' : 'cliente ') + row.client : null;
  return [
    client ?? translateLogisticsText(classification?.toUpperCase(), language, row),
    ...notes.filter((note) => note !== classification).map((note) =>
      translateLogisticsText(standaloneNotes.has(normalized(note)) ? note.toUpperCase() : note, language, row)),
  ].filter(Boolean).join('; ');
}

function localizedRow(row, language) {
  return {
    ...row,
    unit: translateLogisticsUnit(row.unit, row.quantity, language),
    description: translateLogisticsText(row.description, language, row),
    notes: notesFor(row, language),
  };
}

function groupRows(rows, language) {
  const groups = new Map();
  for (const row of rows) {
    const unit = canonicalLogisticsUnit(row.unit);
    const key = JSON.stringify([row.destination, row.description, row.commercialName, row.thickness, row.finish, row.client, unit, notesFor(row, language), row.reference]);
    if (!groups.has(key)) groups.set(key, { ...row, unit, amounts: [] });
    groups.get(key).amounts.push({ quantity: row.quantity, unit });
  }
  return [...groups.values()].map(({ amounts, ...row }) => {
    const [{ quantity: count }] = materialTotals(amounts);
    return localizedRow({ ...row, quantity: count }, language);
  });
}

export function organizeGuides(documents, { mobile = false, route = [], date = '' } = {}) {
  const groups = new Map();
  const warnings = [];
  const blocked = [];
  for (const guide of documents) {
    const unload = warehouse(guide.unloadingWarehouse);
    const tag = (message) => `${guide.name}: ${message}`;
    if (!unload || (mobile && (!french.has(unload) || !route.includes(unload)))) {
      blocked.push(tag(!unload ? 'Local de descarga por confirmar.' : 'A descarga não faz parte da rota francesa selecionada.'));
      continue;
    }
    if (!groups.has(unload)) groups.set(unload, { unloading: unload, rows: [], dates: new Set() });
    const group = groups.get(unload);
    if (/^\d{4}-\d\d-\d\d$/u.test(guide.loadingDate ?? '')) group.dates.add(guide.loadingDate);
    if (!warehouse(guide.loadingWarehouse)) warnings.push(tag('Local de carga por confirmar.'));
    const report = (issues, prefix = '') => warnings.push(...issues.map(({ detail, field }) => tag(prefix + (detail || field))));
    report(guide.issues);
    const totalsGuide = { ...guide, pages: guide.pages.map((page) => ({
      ...page, lines: page.lines.map((row) => ({ ...row, destination: warehouse(row.destination) ?? unload })),
    })) };
    for (const total of reviewTotals(prepareReview({ documents: [totalsGuide] }, WAREHOUSES)).declared) {
      if (total.status !== 'match') warnings.push(tag('Um total impresso diverge das quantidades lidas.'));
    }
    let count = 0;
    for (const page of guide.pages) {
      const prefix = `p. ${page.page} — `;
      report(page.issues, prefix);
      for (const row of page.lines) {
        count++;
        report(row.issues, prefix);
        const uncertain = row.issues.some(({ field }) => field === 'destination');
        const destination = uncertain ? undefined : row.destination ? warehouse(row.destination) : unload;
        if (!destination || destination === 'Logística') warnings.push(tag(prefix + 'Destino final por confirmar.'));
        if (!quantity(row.quantity) || !clean(row.unit) || !clean(row.description)) {
          warnings.push(tag(prefix + 'Quantidade, unidade ou descrição por confirmar.'));
        }
        group.rows.push({
          ...row, destination: destination && destination !== 'Logística' ? destination : 'Destino por confirmar',
          quantity: quantity(row.quantity) ? clean(row.quantity) : '?',
          unit: clean(row.unit), description: clean(row.description) || '[Descrição por confirmar]',
          guideId: guide.id, page: page.page,
        });
      }
    }
    if (!count) warnings.push(tag('Nenhum material identificado.'));
  }

  const results = [...groups.values()].map(({ unloading, rows, dates }) => {
    const language = documentLanguage(unloading);
    const title = documentTitle(unloading);
    if (dates.size > 1) warnings.push(`${unloading}: datas de carregamento divergentes.`);
    const loadingDate = dates.size === 1 ? [...dates][0] : date;
    const valid = rows.filter((row) => row.quantity !== '?' && row.unit);
    const materials = [...groupRows(valid, language), ...rows.filter((row) => !valid.includes(row)).map((row) => localizedRow(row, language))];
    const stops = [...new Set(materials.map((row) => row.destination))];
    const lines = stops.flatMap((destination) => [
      destinations[language](destination),
      ...materials.filter((row) => row.destination === destination).map((row) =>
        `${row.quantity} ${language === 'pt' && canonicalLogisticsUnit(row.unit) === 'Chapa' ? 'ch' : row.unit} ${row.description}${row.notes ? ' (' + row.notes + ')' : ''}`),
      '',
    ]);
    const headingDate = loadingDate ? (language === 'es' ? 'Fecha de carga: ' : 'Data de carga: ') + formatDate(loadingDate) : '';
    let text = [headingDate, ...lines].filter((line, index) => line || index > 0).join('\n');
    if (language === 'pt-fr') {
      const frenchRoute = mobile ? route : [unloading];
      text = buildPackingList({
        date: loadingDate, route: frenchRoute, sectionRoute: [...new Set([...frenchRoute, ...stops])], materials,
      });
      const unfinished = materials.filter(({ quantity, unit }) => quantity === '?' || !unit);
      if (!mobile && unfinished.length) {
        const review = unfinished.map((row) => `${row.quantity} ${row.unit} ${row.description} — ${row.destination}`).join('\n');
        text = text.replace('Obrigado / Merci', `${review}\n\nObrigado / Merci`);
      }
    }
    if (mobile && !loadingDate) warnings.push(`${unloading}: data de carregamento por confirmar.`);
    return { unloading, title, text, rows, loadingDate };
  });
  if (mobile && results.length > 1) {
    const rows = results.flatMap((result) => result.rows);
    const stops = [...new Set([...route, ...rows.map(({ destination }) => destination)])];
    results.splice(0, results.length, {
      unloading: route.join(' – '), title: 'Packing List', rows,
      text: buildPackingList({ date: date || results[0].loadingDate, route, sectionRoute: stops, materials: groupRows(rows.filter((row) => row.quantity !== '?' && row.unit), 'pt-fr') }),
    });
  }
  return { results, warnings: [...new Set(warnings)], blocked };
}
