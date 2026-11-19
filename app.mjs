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
import { extractionWorkerUrl } from './extraction-config.mjs';
import { createExtractionClient } from './extraction-client.mjs';
import {
  activeReviewRows, appendReviewDocuments, prepareReview, reviewIssues, reviewMaterials, reviewTotals,
  resolveReviewIssue, excludeReviewRow, excludeReviewDocument,
} from './review.mjs';

const ui = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), (element) => [element.id, element]));
const state = {
  route: [],
  customDestinations: [],
  guides: [],
  materials: [],
  approved: null,
  demo: false,
  review: null,
  analyzing: false,
  failedAnalysis: false,
  extractedEditsPending: false,
  importedGuides: new Set(),
  completedGuides: new Map(),
  guideAttempts: new Map(),
};
let emptyDate = localDateValue();
// The Worker checks the current and previous UTC day. Use the minimum guaranteed window.
const safeRetryWindow = 24 * 60 * 60 * 1000;
let extractionClient;
if (extractionWorkerUrl) {
  ui['analysis-actions'].hidden = false;
  try {
    extractionClient = createExtractionClient(extractionWorkerUrl);
    ui['guides-processing-note'].textContent =
      'Ao selecionar Analisar guias, os ficheiros são enviados para tratamento. Também pode introduzir os materiais manualmente.';
  } catch (error) {
    setMessage(ui['analysis-status'], error.message);
  }
}
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
    demo: state.demo,
  };
}

function canLoadDemo() {
  return !state.demo && !state.analyzing && !state.review && !state.failedAnalysis
    && !state.extractedEditsPending
    && !state.route.length && !state.customDestinations.length
    && !state.guides.length && !state.materials.length && !ui['custom-name'].value
    && ui.date.value === emptyDate && ui.introduction.value === DEFAULT_INTRODUCTION;
}

function renderDemoControls() {
  ui['demo-warning'].hidden = !state.demo;
  ui['clear-demo'].hidden = !state.demo;
  ui['load-demo'].hidden = !canLoadDemo();
}

function renderRoute() {
  for (const button of document.querySelectorAll('[data-destination]')) {
    button.setAttribute('aria-pressed', String(state.route.includes(button.dataset.destination)));
  }
  ui['route-text'].textContent = state.route.join(' → ');
  ui['route-summary'].hidden = !state.route.length;
  ui['review-destinations'].replaceChildren(...state.route.map((destination) => {
    const option = element('option');
    option.value = destination;
    return option;
  }));
}

function changeRoute(destination) {
  state.route = toggleDestination(state.route, destination);
  renderRoute();
  renderMaterials();
  renderReviewSummary();
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
  renderDemoControls();
  analysisControls();
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
      if (material.documentId) state.extractedEditsPending = true;
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
    if (material.documentId) state.extractedEditsPending = true;
    state.materials.splice(index, 1);
    renderMaterials();
    refreshDocument();
    const group = Array.from(ui['material-groups'].children).find((node) => node.dataset.group === material.destination);
    (group?.querySelector('.add-button') ?? group?.querySelector('.remove-button') ?? ui.materials).focus();
  });
  row.append(remove);
  if (material.documentName && material.page) {
    row.append(element('small', 'material-source', `${material.documentName} · pág. ${material.page}`));
  }
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
  focusedInput?.focus();
}

function approvalControls() {
  const reviewPending = state.analyzing || state.review || state.failedAnalysis || state.extractedEditsPending;
  const approved = state.demo || reviewPending ? null : state.approved;
  const canShare = approved && supportsFileShare(approved.file);
  ui['preview-status'].textContent = state.demo ? 'Demonstração' : approved ? 'Aprovado' : 'Em tempo real';
  ui['preview-status'].classList.toggle('is-approved', Boolean(approved));
  ui.approve.disabled = state.demo || Boolean(reviewPending || approved);
  ui.download.disabled = !approved;
  ui.share.disabled = !approved;
  ui['share-label'].textContent = canShare ? 'Partilhar TXT' : 'Partilhar por email';
  ui['email-link'].hidden = !approved || !canShare;
  if (approved) ui['email-link'].href = approved.email;
  else ui['email-link'].removeAttribute('href');
  ui['confirm-extracted-edits'].hidden = !state.extractedEditsPending;
}

function refreshDocument() {
  state.approved = null;
  ui['txt-preview'].textContent = buildPackingList(documentData());
  ui['validation-errors'].replaceChildren();
  ui['validation-errors'].hidden = true;
  setMessage(ui['share-feedback'], state.demo ? 'A exportação e a partilha estão indisponíveis na demonstração.' : '');
  renderDemoControls();
  approvalControls();
}

function createEmail(date) {
  const dateLabel = date.split('-').reverse().join('/');
  const subject = `Packing List — ${dateLabel}`;
  const body = [
    'Bom dia,',
    '',
    'Segue em anexo a Packing List do carregamento de ' + dateLabel + '.',
    '',
    'Obrigado / Merci',
  ].join('\r\n');
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function approveDocument() {
  if (state.analyzing || state.review || state.failedAnalysis || state.extractedEditsPending) return;
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
  state.approved = { file, email: createEmail(data.date) };
  approvalControls();
  const feedback = supportsFileShare(file)
    ? 'TXT aprovado. No menu de partilha, se escolher email, indique mralo@granitrans.pt.'
    : 'Antes de preparar o email, descarregue o TXT. Poderá ter de o anexar manualmente.';
  setMessage(ui['share-feedback'], feedback);
  ui.download.focus();
}

function downloadDocument() {
  if (state.demo || !state.approved) return;
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
  if (state.demo || !approval) return;
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

ui.date.value = emptyDate;
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
  renderDemoControls();
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
  if (!canLoadDemo()) return;
  state.demo = true;
  state.route = [...DEFAULT_DESTINATIONS];
  state.materials = demoMaterials.map((material) => ({ ...material }));
  renderRoute();
  renderMaterials();
  analysisControls();
  refreshDocument();
  ui['clear-demo'].focus();
});
ui['clear-demo'].addEventListener('click', () => {
  if (!state.demo || !window.confirm(
    'Limpar a demonstração e começar uma expedição vazia? As alterações e os ficheiros desta demonstração serão eliminados.',
  )) return;

  state.demo = false;
  state.route = [];
  state.customDestinations = [];
  state.guides = [];
  state.materials = [];
  emptyDate = localDateValue();
  ui.date.value = emptyDate;
  ui.introduction.value = DEFAULT_INTRODUCTION;
  ui['custom-name'].value = '';
  ui['custom-name'].removeAttribute('aria-invalid');
  ui['custom-destination'].hidden = true;
  ui['custom-toggle'].setAttribute('aria-expanded', 'false');
  ui['custom-list'].replaceChildren();
  ui['custom-list'].hidden = true;
  setMessage(ui['custom-error'], '');
  setMessage(ui['file-error'], '');
  renderRoute();
  renderGuides();
  renderMaterials();
  refreshDocument();
  ui['load-demo'].focus();
});

const reviewFields = [
  ['quantity', 'Quantidade'], ['unit', 'Unidade'], ['description', 'Descrição'],
  ['commercialName', 'Designação comercial'], ['thickness', 'Espessura'],
  ['finish', 'Acabamento'], ['reference', 'Referência'], ['client', 'Cliente'],
  ['destination', 'Destino final'], ['unloadingLocation', 'Local de descarga'], ['notes', 'Observações'],
];

function analysisControls() {
  ui['analyze-guides'].disabled = !extractionClient || state.demo
    || !state.guides.length || state.analyzing || Boolean(state.review && !state.failedAnalysis);
  ui['continue-manual'].hidden = !state.failedAnalysis || state.analyzing;
  ui['discard-review'].disabled = state.analyzing;
  renderReviewSummary();
}

function renderReviewSummary() {
  if (!state.review) return;
  const blockers = reviewIssues(state.review, state.route);
  const list = ui['review-issues'];
  list.replaceChildren(...blockers.map((issue) => {
    const item = element('li');
    const source = [issue.documentName, issue.page ? `pág. ${issue.page}` : ''].filter(Boolean).join(' · ');
    item.append(element('span', 'file-name', [source, issue.message, issue.detail].filter(Boolean).join(' — ')));
    if (issue.resolvable) {
      const accept = action('outline', 'Conferido na guia');
      accept.addEventListener('click', () => {
        resolveReviewIssue(state.review, issue);
        renderReviewSummary();
      });
      item.append(accept);
    }
    return item;
  }));
  const totals = reviewTotals(state.review);
  const quantities = (items) => items.map(({ quantity, unit }) => `${quantity} ${unit}`).join(' · ');
  const lines = [];
  const byDocument = new Map();
  for (const row of activeReviewRows(state.review)) {
    if (!byDocument.has(row.documentId)) byDocument.set(row.documentId, new Map());
    const pages = byDocument.get(row.documentId);
    if (!pages.has(row.page)) pages.set(row.page, []);
    pages.get(row.page).push(row);
  }
  for (const [id, pages] of byDocument) {
    const rows = [...pages.values()].flat();
    const label = rows[0].documentName ?? id;
    lines.push(element('p', '', `${label} · total calculado: ${quantities(materialTotals(rows)) || 'por conferir'}`));
    for (const [page, pageRows] of pages) {
      lines.push(element('p', '', `${label} · pág. ${page}: ${quantities(materialTotals(pageRows)) || 'por conferir'}`));
    }
  }
  for (const { destination, totals: units } of totals.byDestination) {
    lines.push(element('p', '', `${destination}: ${quantities(units)}`));
  }
  for (const total of totals.declared) {
    const where = [total.documentName, total.page ? `pág. ${total.page}` : '', total.destination].filter(Boolean).join(' · ');
    lines.push(element('p', '', `${where} · guia: ${total.quantity ?? '?'} ${total.unit ?? ''} · calculado: ${total.calculated ?? '?'}`));
  }
  ui['review-totals'].replaceChildren(...lines);
  ui['apply-review'].disabled = state.analyzing || state.failedAnalysis
    || blockers.length > 0 || !activeReviewRows(state.review).length;
}

function renderReview() {
  ui['extraction-review'].hidden = !state.review;
  const list = ui['review-rows'];
  const openRows = new Set(Array.from(list.querySelectorAll('details[open]'), (row) => row.dataset.reviewRow));
  list.replaceChildren();
  if (!state.review) return;

  for (const document of state.review.documents) {
    const group = element('section', 'material-group');
    group.append(element('h4', 'group-heading', document.name));
    const exclude = action('outline', document.excluded ? 'Repor guia na revisão' : 'Excluir guia da revisão');
    exclude.addEventListener('click', () => {
      excludeReviewDocument(state.review, document.key, !document.excluded);
      renderReview();
    });
    group.append(exclude);
    if (!document.excluded) {
      const rows = state.review.rows.filter((row) => row.documentKey === document.key);
      for (const row of rows) {
        const details = element('details', 'review-detail');
        details.dataset.reviewRow = row.id;
        details.open = openRows.has(row.id);
        const summary = element('summary', '', `Pág. ${row.page} · ${row.description || row.commercialName || 'Material por rever'}`);
        details.append(summary);
        const toggle = action('outline', row.excluded ? 'Repor linha' : 'Excluir linha');
        toggle.addEventListener('click', () => {
          excludeReviewRow(state.review, row.id, !row.excluded);
          renderReview();
        });
        details.append(toggle);
        if (!row.excluded) {
          if (row.destinationHint && row.destinationHint !== row.destination) {
            details.append(element('p', 'helper-text', `Destino lido na guia: ${row.destinationHint}`));
          }
          const grid = element('div', 'review-fields');
          for (const [key, labelText] of reviewFields) {
            const label = element('label', 'material-cell', labelText);
            const input = element('input');
            input.value = row[key] ?? '';
            if (key === 'quantity') input.inputMode = 'decimal';
            if (key === 'unit') input.setAttribute('list', 'units');
            if (key === 'destination') input.setAttribute('list', 'review-destinations');
            input.addEventListener('input', () => {
              row[key] = input.value;
              summary.textContent = `Pág. ${row.page} · ${row.description || row.commercialName || 'Material por rever'}`;
              renderReviewSummary();
            });
            label.append(input);
            grid.append(label);
          }
          details.append(grid);
        }
        group.append(details);
      }
    }
    list.append(group);
  }
  renderReviewSummary();
}

function finishAnalysis(message) {
  state.review = null;
  state.failedAnalysis = false;
  renderReview();
  renderMaterials();
  refreshDocument();
  analysisControls();
  setMessage(ui['analysis-status'], message);
}

ui['analyze-guides'].addEventListener('click', async () => {
  if (!extractionClient || state.demo || state.analyzing
    || (state.review && !state.failedAnalysis) || !state.guides.length) return;
  const files = [...state.guides];
  if (files.length > 5) {
    setMessage(ui['analysis-status'], 'Selecione até cinco guias por análise.');
    return;
  }
  state.analyzing = true;
  state.failedAnalysis = false;
  refreshDocument();
  analysisControls();
  setMessage(ui['analysis-status'], 'A analisar as guias selecionadas…');
  try {
    const token = await extractionClient.login();
    const selected = (file) => state.guides.includes(file);
    const ready = new Map();
    const failures = new Map();
    const existing = new Set(state.review?.documents.map(({ id }) => id));
    let skipped = false;
    for (const file of files) {
      if (!selected(file)) continue;
      let id;
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Cada guia pode ter até 10 MiB.');
        const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
        // No attachment captured before authentication is sent once it has been removed.
        if (!selected(file)) continue;
        if (state.importedGuides.has(id) || existing.has(id)) {
          skipped = true;
          continue;
        }
        if (failures.has(id)) {
          failures.get(id).files.push(file);
          skipped = true;
          continue;
        }
        let document = state.completedGuides.get(id);
        if (!document) {
          const attempt = state.guideAttempts.get(id) ?? { id: crypto.randomUUID(), startedAt: Date.now() };
          if (attempt.unavailable) throw new Error(attempt.unavailable);
          if (Date.now() - attempt.startedAt >= safeRetryWindow) {
            throw new Error('Não foi possível confirmar a tentativa anterior. Confira esta guia manualmente.');
          }
          state.guideAttempts.set(id, attempt);
          document = await extractionClient.extract(file, token, attempt.id);
          if (document?.id !== id) throw new Error('A resposta não corresponde à guia selecionada.');
          state.completedGuides.set(id, document);
          state.guideAttempts.delete(id);
        }
        if (ready.has(id)) skipped = true;
        else ready.set(id, { document, files: [] });
        ready.get(id).files.push(file);
      } catch (error) {
        const attempt = state.guideAttempts.get(id);
        if (attempt && error?.alreadyAccepted) attempt.unavailable = error.message;
        if (attempt && error?.canStartNewAttempt) state.guideAttempts.delete(id);
        failures.set(id ?? file, {
          files: [file],
          message: error instanceof Error ? error.message : 'Não foi possível analisar a guia.',
        });
      }
    }
    const documents = [...ready.values()].filter(({ files }) => files.some(selected)).map(({ document }) => document);
    const pending = [...failures.values()].filter(({ files }) => files.some(selected));
    state.failedAnalysis = pending.length > 0;
    if (documents.length) {
      const firstReview = !state.review;
      if (firstReview) state.review = prepareReview({ documents }, state.route);
      else appendReviewDocuments(state.review, documents, state.route);
      renderReview();
      if (firstReview) ui.materials.focus();
    }
    let status = state.review ? 'Guias analisadas. Confira os materiais antes da aprovação.' : 'Nenhuma guia nova para analisar.';
    if (pending.length === 1 && !state.review) {
      status = pending[0].message;
    } else if (pending.length) {
      const detail = pending.map(({ files, message }) => `${files.find(selected).name}: ${message}`).join(' ');
      status = `Guias por concluir: ${pending.length}. ${detail}`;
    }
    setMessage(ui['analysis-status'], skipped ? `${status} As cópias idênticas e as guias já importadas foram ignoradas.` : status);
  } catch (error) {
    state.failedAnalysis = files.some((file) => state.guides.includes(file));
    setMessage(ui['analysis-status'], error instanceof Error ? error.message : 'Não foi possível analisar as guias.');
  } finally {
    state.analyzing = false;
    refreshDocument();
    analysisControls();
  }
});

ui['apply-review'].addEventListener('click', () => {
  if (state.analyzing || state.failedAnalysis || !state.review || reviewIssues(state.review, state.route).length) return;
  const materials = reviewMaterials(state.review, state.route);
  if (!materials.length) return;
  const fingerprint = (material) => JSON.stringify([
    material.destination, materialTotals([material])[0], material.description.trim(), material.notes?.trim() ?? '',
  ]);
  const existing = new Set(state.materials.map(fingerprint));
  if (materials.some((material) => existing.has(fingerprint(material))) && !window.confirm(
    'Já existem linhas iguais na expedição. Confirma que estas linhas correspondem a materiais distintos?',
  )) return;
  for (const row of activeReviewRows(state.review)) {
    state.importedGuides.add(row.documentId);
    state.completedGuides.delete(row.documentId);
  }
  state.materials.push(...materials);
  finishAnalysis('Os materiais revistos foram acrescentados à expedição.');
  ui.materials.focus();
});

ui['discard-review'].addEventListener('click', () => {
  if (state.analyzing || !state.review || !window.confirm('Descartar a análise e as correções feitas nesta revisão?')) return;
  for (const { id } of state.review.documents) state.completedGuides.delete(id);
  finishAnalysis('Análise descartada. Confira as guias manualmente antes de aprovar.');
  ui['analyze-guides'].focus();
});

ui['continue-manual'].addEventListener('click', () => {
  if (state.analyzing || !state.failedAnalysis || !window.confirm('Confirmar que vai conferir manualmente as guias sem análise?')) return;
  state.failedAnalysis = false;
  refreshDocument();
  analysisControls();
  setMessage(ui['analysis-status'], 'Conferência manual selecionada para as guias por concluir.');
});

ui['confirm-extracted-edits'].addEventListener('click', () => {
  if (!state.extractedEditsPending || !window.confirm('Confirma que voltou a conferir nas guias os materiais e totais alterados?')) return;
  state.extractedEditsPending = false;
  refreshDocument();
});

ui.approve.addEventListener('click', approveDocument);
ui.download.addEventListener('click', downloadDocument);
ui.share.addEventListener('click', shareDocument);

renderMaterials();
refreshDocument();
analysisControls();
