import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeReviewRows, excludeReviewDocument, excludeReviewRow, prepareReview, resolveReviewIssue,
  reviewIssues, reviewMaterials, reviewTotals,
} from './review.mjs';

const route = ['Paris', 'Valence'];
const material = {
  quantity: '1,00', unit: 'Chapa', description: 'Granito Série Alfa 2 cm',
  commercialName: 'Granito Série Alfa', thickness: '2 cm', finish: 'Polido',
  reference: 'REF-FICTÍCIA+3', client: 'Cliente DEMO-C1', notes: 'encosto',
  destination: 'PARIS', unloadingLocation: 'Armazém Fictício B',
};

function guide({ id = 'guide-1', name = 'guia-ficticia.pdf', pages, totals = [], issues = [] } = {}) {
  return { id, name, pages: pages ?? [{ page: 1, lines: [material] }], totals, issues };
}

test('review preserves source and commercial fields while keeping unloading separate from the final stop', () => {
  const data = {
    documents: [guide({ pages: [{ page: 12, lines: [material, { ...material, destination: null, unloadingLocation: 'Valence' }] }] })],
  };
  const review = prepareReview(data, route);
  const [assigned, unassigned] = review.rows;
  assert.equal(assigned.documentId, 'guide-1');
  assert.equal(assigned.documentName, 'guia-ficticia.pdf');
  assert.equal(assigned.page, 12);
  assert.equal(assigned.destination, 'Paris');
  assert.equal(assigned.destinationHint, 'PARIS');
  assert.equal(assigned.unloadingLocation, 'Armazém Fictício B');
  assert.equal(unassigned.destination, '');
  assert.equal(unassigned.unloadingLocation, 'Valence');
  assert.throws(() => reviewMaterials(review, route), /avisos/);

  unassigned.destination = 'Valence';
  const [first, second] = reviewMaterials(review, route);
  assert.equal(first.description, 'Granito Série Alfa 2 cm, Polido, REF-FICTÍCIA+3');
  assert.equal(first.notes, 'encosto; descarga em Armazém Fictício B');
  assert.equal(first.reference, 'REF-FICTÍCIA+3');
  assert.equal(first.client, 'Cliente DEMO-C1');
  assert.equal(second.destination, 'Valence');
  assert.equal(second.notes, 'encosto; descarga em Valence');
  assert.equal(material.description, 'Granito Série Alfa 2 cm');
});

test('destination assignment requires an exact route match or an explicit user choice', () => {
  const response = { documents: [guide({ pages: [{ page: 1, lines: [{ ...material, destination: 'Paris (armazém)' }] }] })] };
  const review = prepareReview(response, route);
  const [issue] = reviewIssues(review, route);
  assert.equal(review.rows[0].destination, '');
  assert.equal(issue.field, 'destination');
  assert.equal(resolveReviewIssue(review, issue), false);
  review.rows[0].destination = 'Paris';
  assert.deepEqual(reviewIssues(review, route), []);
  assert.equal(reviewIssues(review, ['Valence'])[0].field, 'destination');
});

test('missing required fields require corrections while unreadable source flags require an explicit confirmation', () => {
  const bad = {
    ...material, quantity: null, unit: null, description: null, reference: null,
    issues: [{ field: 'reference', reason: 'illegible', detail: 'Referência parcialmente tapada.' }],
  };
  const review = prepareReview({ documents: [guide({ pages: [{ page: 1, lines: [bad] }] })] }, route);
  assert.deepEqual(reviewIssues(review, route).map(({ field }) => field), ['reference', 'quantity', 'unit', 'description']);

  Object.assign(review.rows[0], { quantity: '2', unit: 'Chapas', description: 'Pedra Fictícia A' });
  const [sourceIssue] = reviewIssues(review, route);
  assert.equal(sourceIssue.message, 'Referência — ilegível.');
  assert.equal(sourceIssue.detail, 'Referência parcialmente tapada.');
  assert.ok(resolveReviewIssue(review, sourceIssue));
  assert.deepEqual(reviewIssues(review, route), []);
  review.rows[0].reference = 'REF-FICTÍCIA-3';
  assert.equal(reviewIssues(review, route)[0].id, sourceIssue.id);
});

test('document, page and destination totals reconcile independently with exact decimals and unit aliases', () => {
  const pages = [
    { page: 1, lines: [{ ...material, quantity: '0,1' }, { ...material, quantity: '0.2', unit: 'chapas' }],
      totals: [{ scope: 'page', unit: 'Chapa', quantity: '0,30' }] },
    { page: 2, lines: [{ ...material, quantity: '1', destination: 'Valence' }] },
  ];
  const totals = [
    { scope: 'document', unit: 'Chapas', quantity: '1,30' },
    { scope: 'destination', destination: 'Paris', unit: 'Chapa', quantity: '0,3' },
    { scope: 'destination', destination: 'Valence', unit: 'Chapas', quantity: '2' },
    { scope: 'document', unit: null, quantity: '7' },
  ];
  const review = prepareReview({ documents: [guide({ pages, totals })] }, route);
  const { byDestination, declared } = reviewTotals(review);
  assert.deepEqual(byDestination, [
    { destination: 'Paris', totals: [{ unit: 'Chapas', quantity: '0,3' }] },
    { destination: 'Valence', totals: [{ unit: 'Chapa', quantity: '1' }] },
  ]);
  assert.deepEqual(declared.map(({ scope, page, status, calculated }) => [scope, page, status, calculated]), [
    ['document', null, 'match', '1,3'],
    ['destination', null, 'match', '0,3'],
    ['destination', null, 'mismatch', '1'],
    ['document', null, 'incomplete', null],
    ['page', 1, 'match', '0,3'],
  ]);

  const blockers = reviewIssues(review, route);
  assert.deepEqual(blockers.map(({ reason }) => reason), ['total_mismatch', 'total_incomplete']);
  blockers.forEach((issue) => resolveReviewIssue(review, issue));
  assert.deepEqual(reviewIssues(review, route), []);

  review.rows[2].quantity = '2';
  assert.deepEqual(reviewTotals(review).declared.map(({ status }) => status), ['mismatch', 'match', 'match', 'incomplete', 'match']);
  assert.deepEqual(reviewIssues(review, route).map(({ reason }) => reason), ['total_mismatch', 'total_incomplete']);
});

test('duplicate rows retain their origins and can be excluded or confirmed as independent items', () => {
  const documents = [guide(), guide({ id: 'guide-2', name: 'foto-ficticia.jpg' })];
  const review = prepareReview({ documents }, route);
  const [duplicate] = reviewIssues(review, route);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.documentName, 'foto-ficticia.jpg');
  assert.match(duplicate.detail, /guia-ficticia\.pdf, página 1/);
  assert.throws(() => reviewMaterials(review, route), /avisos/);

  excludeReviewRow(review, duplicate.rowId);
  assert.equal(activeReviewRows(review).length, 1);
  assert.equal(reviewMaterials(review, route).length, 1);
  excludeReviewRow(review, duplicate.rowId, false);
  assert.ok(resolveReviewIssue(review, reviewIssues(review, route)[0]));
  assert.equal(reviewMaterials(review, route).length, 2);
});

test('withdrawing a whole guide removes its source issues and totals from the active review', () => {
  const documents = [guide(), guide({ id: 'guide-2', pages: [{ page: 1, lines: [] }],
    totals: [{ scope: 'document', unit: 'Chapas', quantity: '2' }] })];
  const review = prepareReview({ documents }, route);
  assert.deepEqual(reviewIssues(review, route).map(({ reason }) => reason), ['empty_page', 'total_mismatch']);
  excludeReviewDocument(review, 'guide-2');
  assert.deepEqual(reviewIssues(review, route), []);
  assert.deepEqual(reviewTotals(review).declared, []);
  assert.equal(reviewMaterials(review, route).length, 1);
  excludeReviewDocument(review, 'guide-1');
  assert.equal(reviewIssues(review, route)[0].reason, 'missing_rows');
});
