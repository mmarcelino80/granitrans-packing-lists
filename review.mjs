import { materialTotals } from './packing-list.mjs';

const materialFields = [
  'quantity', 'unit', 'description', 'commercialName', 'thickness', 'finish',
  'reference', 'client', 'unloadingLocation', 'notes',
];

const fieldLabels = {
  quantity: 'Quantidade', unit: 'Unidade', description: 'Descrição',
  commercialName: 'Designação comercial', thickness: 'Espessura', finish: 'Acabamento',
  reference: 'Referência', client: 'Cliente', destination: 'Destino',
  unloadingLocation: 'Local de descarga', notes: 'Observações', total: 'Total',
};

const issueLabels = {
  illegible: 'ilegível', ambiguous: 'ambíguo', missing: 'em falta', conflicting: 'em conflito',
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sameDestination(left, right) {
  return text(left).localeCompare(text(right), 'pt-PT', { sensitivity: 'accent' }) === 0;
}

function quantityText(quantity) {
  if (/^0+(?:[.,]0+)?$/.test(text(quantity))) return '0';
  return materialTotals([{ quantity, unit: 'un' }])[0]?.quantity ?? null;
}

function unitKey(unit) {
  return materialTotals([{ quantity: '1', unit }])[0]?.unit ?? '';
}

function sourceIssues(issues, location, prefix) {
  return (issues ?? []).map(({ field, reason, detail }, index) => ({
    id: `${prefix}-source-${index}`,
    ...location,
    field: text(field),
    reason: text(reason),
    detail: text(detail),
    message: `${fieldLabels[field] ?? 'Leitura'} — ${issueLabels[reason] ?? 'por verificar'}.`,
    resolvable: true,
  }));
}

function sourceTotals(totals, location, prefix) {
  return (totals ?? []).map(({ scope, destination, unit, quantity }, index) => ({
    id: `${prefix}-total-${index}`,
    ...location,
    scope: text(scope),
    destination: text(destination),
    unit: text(unit),
    quantity: text(quantity),
  }));
}

export function prepareReview(response, route) {
  const rows = [];
  const issues = [];
  const documents = (response.documents ?? []).map((document, documentIndex) => {
    const key = `document-${documentIndex}`;
    // The internal key identifies the review instance, even if two sources share an identifier.
    const documentId = text(document.id) || key;
    const documentName = text(document.name) || `Guia ${documentIndex + 1}`;
    const location = { documentId, documentName, documentKey: key, page: null, pageKey: null, rowId: null };
    issues.push(...sourceIssues(document.issues, location, key));

    const pages = (document.pages ?? []).map((source, pageIndex) => {
      const pageKey = `${key}-page-${pageIndex}`;
      const page = Number.isSafeInteger(source.page) && source.page > 0 ? source.page : null;
      const pageLocation = { ...location, page, pageKey };
      issues.push(...sourceIssues(source.issues, pageLocation, pageKey));

      for (const [lineIndex, line] of (source.lines ?? []).entries()) {
        const id = `${pageKey}-row-${lineIndex}`;
        const destinationHint = text(line.destination);
        const destination = destinationHint ? route.find((stop) => sameDestination(stop, destinationHint)) ?? '' : '';
        rows.push({
          ...pageLocation,
          id,
          rowId: id,
          destination,
          destinationHint,
          excluded: false,
          ...Object.fromEntries(materialFields.map((field) => [field, text(line[field])])),
        });
        issues.push(...sourceIssues(line.issues, { ...pageLocation, rowId: id }, id));
      }

      if (!source.lines?.length) {
        issues.push({
          id: `${pageKey}-empty`, ...pageLocation, field: '', reason: 'empty_page', detail: '',
          message: 'A leitura não encontrou linhas de material nesta página. Verifique a guia.',
          resolvable: true,
        });
      }
      return { page, pageKey, totals: sourceTotals(source.totals, pageLocation, pageKey) };
    });

    if (!pages.length) {
      issues.push({
        id: `${key}-empty`, ...location, field: '', reason: 'empty_document', detail: '',
        message: 'A leitura não encontrou páginas nesta guia. Verifique o ficheiro.',
        resolvable: true,
      });
    }
    return { id: documentId, key, name: documentName, pages, totals: sourceTotals(document.totals, location, key), excluded: false };
  });

  return { documents, rows, issues, resolved: new Map() };
}

export function excludeReviewRow(review, rowId, excluded = true) {
  const row = review.rows.find(({ id }) => id === rowId);
  if (!row) return;
  row.excluded = excluded;
}

export function excludeReviewDocument(review, documentId, excluded = true) {
  const document = review.documents.find(({ id, key }) => key === documentId || id === documentId);
  if (!document) return;
  document.excluded = excluded;
}

export function activeReviewRows(review) {
  const excludedDocuments = new Set(review.documents.filter(({ excluded }) => excluded).map(({ key }) => key));
  return review.rows.filter((row) => !row.excluded && !excludedDocuments.has(row.documentKey));
}

function reconcileTotal(total, rows) {
  const belongsToPage = total.pageKey !== null;
  let group = rows.filter((row) => row.documentKey === total.documentKey);
  if (belongsToPage) group = group.filter((row) => row.pageKey === total.pageKey);
  if (total.scope === 'destination' && total.destination) {
    group = group.filter((row) => sameDestination(row.destination, total.destination));
  }

  const unit = unitKey(total.unit);
  const quantity = quantityText(total.quantity);
  const matchingRows = group.filter((row) => unitKey(row.unit) === unit);
  const calculated = unit ? materialTotals(matchingRows)[0]?.quantity ?? '0' : null;
  const validScope = total.scope === 'destination' ? Boolean(total.destination)
    : total.scope === (belongsToPage ? 'page' : 'document');
  const missingRowData = group.some((row) => !text(row.unit))
    || matchingRows.some((row) => !materialTotals([row]).length);
  const incomplete = quantity === null || !unit || !validScope || missingRowData;
  const status = incomplete ? 'incomplete' : calculated === quantity ? 'match' : 'mismatch';
  const relevantRows = group.map((row) => [row.id, row.quantity, row.unit, row.destination]);
  const signature = JSON.stringify([status, total.quantity, calculated, total.unit, total.destination, relevantRows]);
  return { ...total, calculated, status, signature };
}

export function reviewTotals(review) {
  const rows = activeReviewRows(review);
  const groups = new Map();
  for (const row of rows) {
    const destination = text(row.destination);
    if (!groups.has(destination)) groups.set(destination, []);
    groups.get(destination).push(row);
  }

  const declared = [];
  for (const document of review.documents) {
    if (document.excluded) continue;
    const totals = [...document.totals, ...document.pages.flatMap((page) => page.totals)];
    declared.push(...totals.map((total) => reconcileTotal(total, rows)));
  }
  const byDestination = Array.from(groups, ([destination, materials]) => ({
    destination, totals: materialTotals(materials),
  }));
  return { byDestination, declared };
}

function validationIssues(row, route) {
  const { id, documentId, documentName, page } = row;
  const requiredFields = [
    ['quantity', Boolean(materialTotals([{ quantity: row.quantity, unit: 'un' }]).length), 'Indique uma quantidade positiva.'],
    ['unit', Boolean(text(row.unit)), 'Indique a unidade.'],
    ['description', Boolean(text(row.description)), 'Preencha a descrição completa.'],
    ['destination', route.includes(row.destination), 'Atribua um destino da rota a esta linha.'],
  ];

  return requiredFields.filter(([, valid]) => !valid).map(([field, , message]) => ({
    id: `${id}-required-${field}`, rowId: id, documentId, documentName, page,
    field, reason: `invalid_${field}`, detail: '', message, resolvable: false,
  }));
}

function duplicateIssues(rows) {
  const byContent = new Map();
  for (const row of rows) {
    const quantity = quantityText(row.quantity);
    if (!quantity || quantity === '0' || !text(row.unit) || !text(row.description)) continue;

    const fields = [row.destination || row.destinationHint, quantity, unitKey(row.unit)];
    for (const field of materialFields.slice(2)) fields.push(text(row[field]));
    const signature = JSON.stringify(fields);
    if (!byContent.has(signature)) byContent.set(signature, []);
    byContent.get(signature).push(row);
  }

  const duplicates = [];
  for (const [signature, group] of byContent) {
    if (group.length < 2) continue;
    const [first, ...remaining] = group;
    const source = first.page ? `${first.documentName}, página ${first.page}` : first.documentName;
    for (const row of remaining) {
      duplicates.push({
        id: `${row.id}-duplicate`, rowId: row.id, documentId: row.documentId,
        documentName: row.documentName, page: row.page, field: '', reason: 'duplicate',
        detail: `A mesma linha aparece em ${source}.`,
        message: 'Possível duplicado. Exclua a repetição ou confirme que se trata de um material distinto.',
        resolvable: true, signature: JSON.stringify([first.id, signature]),
      });
    }
  }
  return duplicates;
}

export function reviewIssues(review, route) {
  const rows = activeReviewRows(review);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const includedDocuments = new Set(review.documents.filter(({ excluded }) => !excluded).map(({ key }) => key));
  const issues = [];
  if (!rows.length) {
    issues.push({
      id: 'no-review-materials', rowId: null, documentId: null, page: null, field: '',
      reason: 'missing_rows', detail: '', message: 'A revisão não contém linhas de material para importar.', resolvable: false,
    });
  }

  for (const issue of review.issues) {
    if (!includedDocuments.has(issue.documentKey)) continue;
    const row = rowById.get(issue.rowId);
    if (issue.rowId && !row) continue;
    const signature = row
      ? JSON.stringify([row.destination, ...materialFields.map((field) => row[field])])
      : issue.detail;
    issues.push({ ...issue, signature });
  }
  issues.push(...rows.flatMap((row) => validationIssues(row, route)), ...duplicateIssues(rows));

  for (const total of reviewTotals(review).declared) {
    if (total.status === 'match') continue;
    issues.push({
      id: total.id, rowId: null, documentId: total.documentId, documentName: total.documentName,
      page: total.page, field: 'total', reason: `total_${total.status}`, detail: '',
      message: total.status === 'mismatch'
        ? 'O total lido na guia difere do total calculado. Verifique as linhas.'
        : 'O total lido na guia não pôde ser conferido. Verifique a unidade, o valor e as linhas.',
      resolvable: true,
      signature: total.signature,
    });
  }

  return issues.filter((issue) => !issue.resolvable || review.resolved.get(issue.id) !== issue.signature);
}

export function resolveReviewIssue(review, issue) {
  if (!issue?.resolvable) return false;
  review.resolved.set(issue.id, issue.signature);
  return true;
}

function withDetails(base, details, separator) {
  const parts = [text(base)].filter(Boolean);
  for (const detail of details.map(text).filter(Boolean)) {
    const escaped = detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (!pattern.test(parts.join(separator))) parts.push(detail);
  }
  return parts.join(separator);
}

export function reviewMaterials(review, route) {
  if (reviewIssues(review, route).length) throw new Error('Resolva os avisos da revisão antes de importar os materiais.');

  return activeReviewRows(review).map((row) => {
    const description = withDetails(row.description, [row.commercialName, row.thickness, row.finish, row.reference], ', ');
    const unloading = text(row.unloadingLocation);
    const notes = withDetails(row.notes, [unloading ? `descarga em ${unloading}` : ''], '; ');
    return { ...row, description, notes };
  });
}
