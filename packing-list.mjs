export const DEFAULT_DESTINATIONS = Object.freeze(['Paris', 'Thionville', 'Valence']);

export const DEFAULT_INTRODUCTION = [
  'Bom dia. Segue abaixo a lista de carga do camião.',
  'Bonjour, veuillez trouver ci-dessous la liste de chargement du camion.',
].join('\n');

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
    const unit = cleanText(material.unit);
    const quantity = parseQuantity(material.quantity);
    if (!quantity || !unit) continue;

    const current = totals.get(unit);
    totals.set(unit, current ? addQuantities(current, quantity) : quantity);
  }

  return Array.from(totals, ([unit, quantity]) => ({ unit, quantity: formatQuantity(quantity) }));
}

function materialSections(route, materials) {
  const sections = [];
  for (const destination of route) {
    const clientGroups = new Map();
    for (const material of materials) {
      if (material.destination !== destination) continue;

      const quantity = parseQuantity(material.quantity);
      const unit = cleanText(material.unit);
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
      const name = destination.toLocaleUpperCase('pt-PT');
      const heading = client ? `${name} / ${client}` : name;
      const lines = Array.from(group.values(), formatMaterialLine);
      sections.push([heading, '-'.repeat(heading.length), ...lines].join('\n'));
    }
  }
  return sections;
}

function formatMaterialLine({ quantity, unit, description, notes }) {
  const line = `- ${formatQuantity(quantity)} ${unit} - ${description}`;
  if (!notes) return line;
  if (notes.startsWith('(') && notes.endsWith(')')) return `${line} ${notes}`;
  return `${line} (${notes})`;
}

export function buildPackingList({ date, route, materials, introduction = DEFAULT_INTRODUCTION, demo = false }) {
  const intro = cleanText(introduction).replace(/\r\n?/g, '\n');
  const loadingDate = hasValidDate(date) ? date.split('-').reverse().join('/') : 'Por indicar';
  const routeText = route.length ? route.join(' → ') : 'Por selecionar';
  const sections = [
    demo ? 'DEMONSTRAÇÃO — DADOS FICTÍCIOS' : '',
    intro,
    `Rota: ${routeText}\nData de carga: ${loadingDate}`,
    ...materialSections(route, materials),
    'Obrigado / Merci',
  ];

  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

export function packingListFilename(date) {
  return hasValidDate(date) ? `packing-list-${date}.txt` : 'packing-list.txt';
}
