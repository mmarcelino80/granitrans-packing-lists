export const DEFAULT_DESTINATIONS = Object.freeze(['Paris', 'Thionville', 'Valence']);

const PORTUGUESE_INTRODUCTION = 'Bom dia,\n\nEnvio o Packing List do camião do dia {{data}}, {{rota}}';
const FRENCH_INTRODUCTION = 'Bonjour,\n\nJe vous transmets la liste de colisage du camion du {{data}}, {{rota}}';

const BLOCK_SEPARATOR = '\n\n\n';

export const DEFAULT_INTRODUCTION = `${PORTUGUESE_INTRODUCTION}${BLOCK_SEPARATOR}${FRENCH_INTRODUCTION}`;

const DESTINATION_HEADINGS = new Map([
  ['Paris', 'PARIS / BOISSY-SAINT-LEGER'],
  ['Thionville', 'THIONVILLE'],
  ['Valence', 'VALENCE / PORTES-LES-VALENCE'],
]);

const UNIT_FORMS = [
  ['Chapa', 'Chapas'],
  ['Palete', 'Paletes'],
  ['Ladrilho', 'Ladrilhos'],
];

export function localDateValue(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addCustomDestination(destinations, rawName) {
  const name = rawName.trim().replace(/\s+/g, ' ').normalize('NFC');
  if (!name) throw new Error('Introduza o nome do destino ou armazém.');

  const duplicate = destinations.some((destination) => (
    destination.localeCompare(name, 'pt-PT', { sensitivity: 'accent' }) === 0
  ));
  if (duplicate) throw new Error('Já existe um destino com este nome.');

  return name;
}

export function toggleDestination(route, destination) {
  if (route.includes(destination)) return route.filter((stop) => stop !== destination);
  return [...route, destination];
}

function hasValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;

  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function parseQuantity(value) {
  const text = cleanText(value);
  const match = /^(\d+)(?:[,.](\d+))?$/.exec(text);
  if (!match) return null;

  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const amount = BigInt(match[1] + fraction);
  if (amount === 0n) return null;

  return { amount, precision: fraction.length };
}

// Align decimal places before adding so decimal quantities remain exact.
function addQuantities(left, right) {
  const precision = Math.max(left.precision, right.precision);
  return {
    precision,
    amount: left.amount * 10n ** BigInt(precision - left.precision)
      + right.amount * 10n ** BigInt(precision - right.precision),
  };
}

function formatQuantity({ amount, precision }) {
  const digits = String(amount);
  if (!precision) return digits;

  const decimal = digits.padStart(precision + 1, '0');
  const fraction = decimal.slice(-precision).replace(/0+$/, '');
  const integer = decimal.slice(0, -precision);
  return fraction ? `${integer},${fraction}` : integer;
}

function normalizedUnit(value) {
  const unit = cleanText(value);
  const lower = unit.toLocaleLowerCase('pt-PT');
  const forms = UNIT_FORMS.find((pair) => pair.some((form) => form.toLowerCase() === lower));
  return forms?.[0] ?? unit;
}

function formatUnit(unit, quantity) {
  const forms = UNIT_FORMS.find(([singular]) => singular === unit);
  return forms && quantity !== '1' ? forms[1] : unit;
}

export function validatePackingList({ date, route, materials, introduction = DEFAULT_INTRODUCTION }) {
  const errors = [];

  if (!hasValidDate(date)) errors.push('Indique uma data de carregamento válida.');
  if (!route.length) errors.push('Selecione pelo menos um destino.');
  if (!cleanText(introduction)) errors.push('Preencha a introdução em português e francês.');
  if (!materials.length) errors.push('Adicione pelo menos um material.');

  const lineByDestination = new Map();
  for (const material of materials) {
    const line = (lineByDestination.get(material.destination) ?? 0) + 1;
    lineByDestination.set(material.destination, line);
    const location = `${material.destination}, linha ${line}`;
    if (!route.includes(material.destination)) {
      errors.push(`${location}: selecione o destino na rota.`);
    }
    if (!parseQuantity(material.quantity)) {
      errors.push(`${location}: indique uma quantidade positiva.`);
    }
    if (!cleanText(material.unit)) errors.push(`${location}: indique a unidade.`);
    if (!cleanText(material.description)) errors.push(`${location}: preencha a descrição.`);
  }

  return errors;
}

export function materialTotals(materials) {
  const totals = new Map();
  for (const material of materials) {
    const unit = normalizedUnit(material.unit);
    const quantity = parseQuantity(material.quantity);
    if (!quantity || !unit) continue;

    const current = totals.get(unit);
    totals.set(unit, current ? addQuantities(current, quantity) : quantity);
  }

  return Array.from(totals, ([unit, amount]) => {
    const quantity = formatQuantity(amount);
    return { unit: formatUnit(unit, quantity), quantity };
  });
}

function materialSections(route, materials) {
  const sections = [];
  for (const destination of route) {
    const clientGroups = new Map();
    for (const material of materials) {
      if (material.destination !== destination) continue;

      const quantity = parseQuantity(material.quantity);
      const unit = normalizedUnit(material.unit);
      const description = cleanText(material.description);
      if (!quantity || !unit || !description) continue;

      const client = cleanText(material.client);
      const notes = cleanText(material.notes);
      if (!clientGroups.has(client)) clientGroups.set(client, new Map());
      const group = clientGroups.get(client);
      const key = JSON.stringify([unit, description, notes]);
      const existing = group.get(key);
      if (existing) {
        existing.quantity = addQuantities(existing.quantity, quantity);
      } else {
        group.set(key, { quantity, unit, description, notes });
      }
    }

    for (const [client, group] of clientGroups) {
      const name = DESTINATION_HEADINGS.get(destination) ?? destination;
      const heading = client ? `${name} / ${client}` : name;
      const lines = Array.from(group.values(), formatMaterialLine);
      sections.push([`-${heading}:`, ...lines].join('\n\n'));
    }
  }
  return sections;
}

function formatMaterialLine({ quantity, unit, description, notes }) {
  const amount = formatQuantity(quantity);
  const line = `-${amount} ${formatUnit(unit, amount)} ${description}`;
  if (!notes) return line;
  if (notes.startsWith('(') && notes.endsWith(')')) return `${line} ${notes}`;
  return `${line} (${notes})`;
}

function routePhrases(route) {
  const first = route[0];
  if (route.length < 2) {
    return {
      pt: `com descarga em ${first ?? '[rota]'}.`,
      fr: `avec un déchargement à ${first ?? '[itinéraire]'}.`,
    };
  }

  const last = route.at(-1);
  const intermediate = route.slice(1, -1);
  const portugueseContinuation = intermediate.length
    ? `De seguida segue para ${new Intl.ListFormat('pt-PT').format(intermediate)} e, por fim, para ${last}.`
    : `De seguida segue para ${last}.`;
  const frenchContinuation = intermediate.length
    ? `Il se dirigera ensuite vers ${new Intl.ListFormat('fr-FR').format(intermediate)}, pour finir à ${last}.`
    : `Il se dirigera ensuite vers ${last}.`;
  return {
    pt: `com primeira descarga em ${first}.\n\n${portugueseContinuation}`,
    fr: `avec un premier déchargement à ${first}.\n\n${frenchContinuation}`,
  };
}

function formatIntroduction(introduction, date, route) {
  const text = cleanText(introduction).replace(/\r\n?/g, '\n');
  if (!text) return '';

  // Preserve paragraph breaks within each language and accept the earlier one-newline template.
  const divider = /\n[\n\t ]*(?=Bonjour\b)/i.exec(text)
    ?? /\n(?:[ \t]*\n){2,}/.exec(text)
    ?? /\n[ \t]*\n/.exec(text);
  const portuguese = (divider ? text.slice(0, divider.index).trim() : text) || PORTUGUESE_INTRODUCTION;
  const french = (divider ? text.slice(divider.index + divider[0].length).trim() : '') || FRENCH_INTRODUCTION;

  const render = (paragraph, values, missingDate, missingRoute) => {
    const rendered = paragraph.replace(/\{\{(data|rota)\}\}/g, (_, key) => values[key]);
    return [
      rendered,
      paragraph.includes('{{data}}') ? '' : missingDate,
      paragraph.includes('{{rota}}') ? '' : missingRoute,
    ].filter(Boolean).join('\n\n');
  };

  const dateParts = hasValidDate(date) ? date.split('-').reverse() : null;
  const phrases = routePhrases(route);
  const pt = { data: dateParts?.join('-') ?? '[data]', rota: phrases.pt };
  const fr = { data: dateParts?.join('/') ?? '[date]', rota: phrases.fr };
  return [
    render(portuguese, pt, `O carregamento está previsto para ${pt.data}.`, `O camião segue ${pt.rota}`),
    render(french, fr, `Le chargement est prévu le ${fr.data}.`, `Le camion part ${fr.rota}`),
  ].join(BLOCK_SEPARATOR);
}

export function buildPackingList({ date, route, materials, introduction = DEFAULT_INTRODUCTION, demo = false }) {
  const sections = [
    demo ? 'DEMONSTRAÇÃO — DADOS FICTÍCIOS' : '',
    formatIntroduction(introduction, date, route),
    ...materialSections(route, materials),
    'Obrigado / Merci',
  ];

  return `${sections.filter(Boolean).join(BLOCK_SEPARATOR)}\n`;
}

export function packingListFilename(date) {
  return hasValidDate(date) ? `packing-list-${date}.txt` : 'packing-list.txt';
}
