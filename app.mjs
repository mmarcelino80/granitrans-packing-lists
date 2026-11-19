import {
  DEFAULT_DESTINATIONS,
  DEFAULT_INTRODUCTION,
  addCustomDestination,
  buildPackingList,
  localDateValue,
  materialTotals,
  packingListFilename,
  toggleDestination,
  validatePackingList,
} from './packing-list.mjs';
import { collectGuides } from './guides.mjs';

const ui = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), (element) => [element.id, element]));
const state = {
  route: [],
  customDestinations: [],
  guides: [],
  materials: [],
  approved: null,
};
const recipient = 'mralo@granitrans.pt';
const demoMaterials = [
  { destination: 'Paris', quantity: '12', unit: 'un', description: 'Bancadas Série Alpha 2 cm, polido', notes: 'stock' },
  { destination: 'Paris', quantity: '4', unit: 'un', description: 'Tampos Série Alpha 3 cm, acetinado', notes: 'Cliente DEMO-01' },
  { destination: 'Paris', quantity: '2', unit: 'un', description: 'Encostos Série Alpha 2 cm', notes: 'encosto' },
  { destination: 'Thionville', quantity: '6', unit: 'un', description: 'Bancadas Série Beta 3 cm, polido', notes: 'stock' },
  { destination: 'Thionville', quantity: '1', unit: 'un', description: 'Tampo de ilha Série Beta 3 cm', notes: 'Referência DEMO-02' },
  { destination: 'Valence', quantity: '5', unit: 'un', description: 'Bancadas Série Gama 2 cm, polido', notes: 'stock' },
  { destination: 'Valence', quantity: '3', unit: 'un', description: 'Tampos Série Gama 3 cm, acetinado', notes: 'Cliente DEMO-03' },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', './assets/app-icons.svg#' + name);
  svg.append(use);
  return svg;
}

function action(className, label, iconName) {
  const button = element('button', className);
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  button.append(label);
  return button;
}

function setMessage(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function documentData() {
  return {
    date: ui.date.value,
    introduction: ui.introduction.value,
    route: state.route,
    materials: state.materials,
    demo: state.materials.some((material) => material.demo),
  };
}

function renderRoute() {
  for (const button of document.querySelectorAll('[data-destination]')) {
    button.setAttribute('aria-pressed', String(state.route.includes(button.dataset.destination)));
  }
  ui['route-text'].textContent = state.route.join(' → ');
  ui['route-summary'].hidden = !state.route.length;
}

function changeRoute(destination) {
  state.route = toggleDestination(state.route, destination);
  renderRoute();
  renderMaterials();
  refreshDocument();
}

function addDestination(event) {
  event.preventDefault();
  const input = ui['custom-name'];
  let name;
  try {
    name = addCustomDestination([...DEFAULT_DESTINATIONS, ...state.customDestinations], input.value);
  } catch (error) {
    setMessage(ui['custom-error'], error.message);
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  state.customDestinations.push(name);
  const button = action('destination-btn', name);
  button.dataset.destination = name;
  button.addEventListener('click', () => changeRoute(name));
  const item = element('li');
  item.append(button);
  ui['custom-list'].append(item);
  ui['custom-list'].hidden = false;
  input.value = '';
  changeRoute(name);
  input.focus();
}

function renderGuides() {
  const list = ui['file-list'];
  list.hidden = !state.guides.length;
  list.replaceChildren(...state.guides.map((file, index) => {
    const item = element('li');
    const name = element('span', 'file-name', file.name);
    const remove = action('remove-button', '', 'x-lg');
    remove.setAttribute('aria-label', 'Remover ' + file.name);
    remove.addEventListener('click', () => {
      state.guides.splice(index, 1);
      renderGuides();
      (list.children[Math.min(index, state.guides.length - 1)]?.querySelector('button') ?? ui.guides).focus();
    });
    item.append(icon('file-earmark-text'), name, remove);
    return item;
  }));
}

function attachGuides(files) {
  const { accepted, errors } = collectGuides(files);
  state.guides.push(...accepted);
  setMessage(ui['file-error'], errors.join('\n'));
  renderGuides();
}

const materialFields = [
  { name: 'quantity', label: 'Quantidade', inputMode: 'decimal', maxLength: 20 },
  { name: 'unit', label: 'Unidade', list: 'units', maxLength: 30 },
  { name: 'description', label: 'Descrição', placeholder: 'Designação, espessura, acabamento, referências' },
  { name: 'notes', label: 'Observações', placeholder: 'Stock, encosto, cliente…' },
];

function materialRow(material, destinationMaterials, totals) {
  const row = element('div', 'material-row');
  for (const field of materialFields) {
    const label = element('label', 'material-cell material-' + field.name);
    const name = element('span', 'label-text', field.label);
    const input = element('input');
    input.type = 'text';
    input.value = material[field.name];
    if (field.inputMode) input.inputMode = field.inputMode;
    if (field.list) input.setAttribute('list', field.list);
    if (field.maxLength) input.maxLength = field.maxLength;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.addEventListener('input', () => {
      material[field.name] = input.value;
      renderTotals(totals, destinationMaterials);
      refreshDocument();
    });
    label.append(name, input);
    row.append(label);
  }
  const index = state.materials.indexOf(material);
  const remove = action('remove-button', '', 'trash3');
  remove.setAttribute('aria-label', `Remover material ${index + 1} de ${material.destination}`);
  remove.addEventListener('click', () => {
    state.materials.splice(index, 1);
    renderMaterials();
    refreshDocument();
    const group = Array.from(ui['material-groups'].children).find((node) => node.dataset.group === material.destination);
    (group?.querySelector('.add-button') ?? group?.querySelector('.remove-button') ?? ui.materials).focus();
  });
  row.append(remove);
  return row;
}

function renderTotals(node, materials) {
  const totals = materialTotals(materials);
  node.textContent = totals.length ? 'Total: ' + totals.map(({ quantity, unit }) => `${quantity} ${unit}`).join(' · ') : '';
}

function renderMaterials(materialToFocus = null) {
  let focusedInput;
  const destinations = new Set([...state.route, ...state.materials.map(({ destination }) => destination)]);
  const list = ui['material-groups'];
  ui['materials-empty'].hidden = destinations.size > 0;
  list.replaceChildren();
  for (const destination of destinations) {
    const materials = state.materials.filter((material) => material.destination === destination);
    const group = element('section', 'material-group');
    group.dataset.group = destination;
    const heading = element('h3', 'group-heading');
    const count = materials.length;
    heading.append(element('span', 'group-name', destination), element('span', 'item-count', count === 1 ? '1 linha' : `${count} linhas`));
    group.append(heading);
    const active = state.route.includes(destination);
    if (!active) {
      group.append(element('p', 'field-error', 'Destino fora da rota. Selecione-o novamente ou remova os seus materiais.'));
    }

    const totals = element('span', 'group-totals');
    renderTotals(totals, materials);
    for (const material of materials) {
      const row = materialRow(material, materials, totals);
      group.append(row);
      if (material === materialToFocus) focusedInput = row.querySelector('input');
    }
    const footer = element('div', 'group-footer');
    if (active) {
      const add = action('add-button outline', 'Adicionar material', 'plus-lg');
      add.setAttribute('aria-label', 'Adicionar material: ' + destination);
      add.addEventListener('click', () => {
        const material = { destination, quantity: '', unit: 'un', description: '', notes: '' };
        state.materials.push(material);
        renderMaterials(material);
        refreshDocument();
      });
      footer.append(add);
    }
    footer.append(totals);
    group.append(footer);
    list.append(group);
  }
  const hasDemo = documentData().demo;
  ui['demo-warning'].hidden = !hasDemo;
  ui['clear-demo'].hidden = !hasDemo;
  ui['load-demo'].hidden = state.materials.length > 0;
  focusedInput?.focus();
}

function approvalControls() {
  const { approved } = state;
  const canShare = approved && supportsFileShare(approved.file);
  ui['preview-status'].textContent = approved ? 'Aprovado' : 'Em tempo real';
  ui['preview-status'].classList.toggle('is-approved', Boolean(approved));
  ui.approve.disabled = Boolean(approved);
  ui.download.disabled = !approved;
  ui.share.disabled = !approved;
  ui['share-label'].textContent = canShare ? 'Partilhar TXT' : 'Partilhar por email';
  ui['email-link'].hidden = !approved || !canShare;
  if (approved) ui['email-link'].href = approved.email;
  else ui['email-link'].removeAttribute('href');
}

function refreshDocument() {
  state.approved = null;
  ui['txt-preview'].textContent = buildPackingList(documentData());
  ui['validation-errors'].replaceChildren();
  ui['validation-errors'].hidden = true;
  setMessage(ui['share-feedback'], '');
  approvalControls();
}

function createEmail(date, demo) {
  const dateLabel = date.split('-').reverse().join('/');
  const subject = `${demo ? '[Demonstração] ' : ''}Packing List — ${dateLabel}`;
  const body = [
    'Bom dia,',
    '',
    demo ? 'Segue em anexo a Packing List de demonstração, com dados fictícios.' : 'Segue em anexo a Packing List do carregamento de ' + dateLabel + '.',
    '',
    'Obrigado / Merci',
  ].join('\r\n');
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function approveDocument() {
  const data = documentData();
  const errors = validatePackingList(data);
  const list = ui['validation-errors'];
  list.hidden = !errors.length;
  list.replaceChildren(...errors.map((message) => element('li', '', message)));
  if (errors.length) {
    list.focus();
    return;
  }

  const text = buildPackingList(data);
  const file = new File([text], packingListFilename(data.date), { type: 'text/plain' });
  state.approved = { file, email: createEmail(data.date, data.demo) };
  approvalControls();
  const feedback = supportsFileShare(file)
    ? 'TXT aprovado. No menu de partilha, se escolher email, indique mralo@granitrans.pt.'
    : 'Antes de preparar o email, descarregue o TXT. Poderá ter de o anexar manualmente.';
  setMessage(ui['share-feedback'], feedback);
  ui.download.focus();
}

function downloadDocument() {
  if (!state.approved) return;
  const file = state.approved.file;
  const url = URL.createObjectURL(file);
  const link = element('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function supportsFileShare(file) {
  try {
    return Boolean(navigator.share && navigator.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
}

async function shareDocument() {
  const approval = state.approved;
  if (!approval) return;
  if (supportsFileShare(approval.file)) {
    try {
      await navigator.share({ files: [approval.file], title: 'Packing List' });
      return;
    } catch (error) {
      if (error.name === 'AbortError' || state.approved !== approval) return;
      setMessage(ui['share-feedback'], 'Não foi possível abrir a partilha. Descarregue o TXT e anexe-o manualmente ao email.');
      ui['email-link'].hidden = false;
      ui['email-link'].focus();
      return;
    }
  }
  setMessage(ui['share-feedback'], 'Se necessário, descarregue o TXT e anexe-o manualmente ao email.');
  ui['email-link'].hidden = false;
  ui['email-link'].click();
}

ui.date.value = localDateValue();
ui.introduction.value = DEFAULT_INTRODUCTION;
ui.date.addEventListener('input', refreshDocument);
ui.introduction.addEventListener('input', refreshDocument);

for (const button of document.querySelectorAll('[data-destination]')) {
  button.addEventListener('click', () => changeRoute(button.dataset.destination));
}
ui['custom-toggle'].addEventListener('click', () => {
  const form = ui['custom-destination'];
  form.hidden = !form.hidden;
  ui['custom-toggle'].setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) ui['custom-name'].focus();
});
ui['custom-destination'].addEventListener('submit', addDestination);
ui['custom-name'].addEventListener('input', () => {
  setMessage(ui['custom-error'], '');
  ui['custom-name'].removeAttribute('aria-invalid');
});

for (const input of [ui.guides, ui.camera]) {
  input.addEventListener('change', () => {
    attachGuides(input.files);
    input.value = '';
  });
}
for (const type of ['dragover', 'drop']) {
  ui['upload-target'].addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'drop') attachGuides(event.dataTransfer.files);
  });
}

ui['load-demo'].addEventListener('click', () => {
  for (const destination of DEFAULT_DESTINATIONS) {
    if (!state.route.includes(destination)) state.route.push(destination);
  }
  state.materials.push(...demoMaterials.map((material) => ({ ...material, demo: true })));
  renderRoute();
  renderMaterials();
  refreshDocument();
  ui['clear-demo'].focus();
});
ui['clear-demo'].addEventListener('click', () => {
  state.materials = state.materials.filter((material) => !material.demo);
  renderMaterials();
  refreshDocument();
  (ui['load-demo'].hidden ? ui.materials : ui['load-demo']).focus();
});

ui.approve.addEventListener('click', approveDocument);
ui.download.addEventListener('click', downloadDocument);
ui.share.addEventListener('click', shareDocument);

renderMaterials();
refreshDocument();
