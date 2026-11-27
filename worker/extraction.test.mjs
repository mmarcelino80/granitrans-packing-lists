import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  EXTRACTION_MODEL,
  ExtractionError,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_EDGE,
  MAX_OUTPUT_TOKENS,
  MAX_PDF_PAGES,
  extractDocument,
  readDocument,
} from './extraction.mjs';

// Synthetic 1 × 1 grayscale fixtures encoded with Pillow.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64'));
const jpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af3//2Q==', 'base64'));
const progressiveJpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wgALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/aAAgBAQAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oACAEBAAAAEP8A/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64'));
const image = { id: 'id-by-server', name: 'Expedição PNG.png', mimeType: 'image/png', bytes: png };
const testSecret = 'only-for-test';

const material = {
  quantity: '2,50',
  unit: 'm²',
  description: 'Céramique A-012 2 cm, polido',
  commercialName: 'Céramique A-012',
  thickness: '2 cm',
  finish: 'polido',
  reference: 'A-012',
  client: null,
  destination: 'Valence',
  unloadingLocation: 'Portes-lès-Valence',
  notes: 'stock + encosto',
  issues: [{ field: 'client', reason: 'illegible', detail: 'O código do cliente está tapado.' }],
};

function documentResult(pages = 1) {
  return {
    loadingWarehouse: 'Negrais', unloadingWarehouse: 'Valence', loadingDate: null,
    pages: Array.from({ length: pages }, (_, index) => ({
      page: index + 1,
      lines: [material],
      totals: [{ scope: 'page', destination: null, unit: 'm²', quantity: '2,50' }],
      issues: [],
    })),
    totals: [{ scope: 'document', destination: null, unit: 'm²', quantity: '2,50' }],
    issues: [],
  };
}

function send(body, type = 'image/png', headers = {}) {
  return new Request('https://worker.example/extract', {
    method: 'POST',
    headers: { 'Content-Type': type, ...headers },
    body,
    duplex: 'half',
  });
}

function completes(content) {
  return {
    model: 'gpt-6-luna',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      { type: 'reasoning', id: 'rs_test', summary: [] },
      { type: 'message', role: 'assistant', status: 'completed', content },
    ],
  };
}

function respond(data) {
  return Response.json(completes([{ type: 'output_text', text: JSON.stringify(data) }]));
}

function problem(code, status) {
  return (error) => error instanceof ExtractionError && error.code === code && error.status === status;
}

async function samplePdf(pageCount) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) pdf.addPage();
  return pdf.save({ addDefaultPage: false });
}

test('reads PNG, JPEG and progressive JPEG and normalizes the JPG MIME alias', async () => {
  assert.deepEqual(await readDocument(send(png)), { bytes: png, mimeType: 'image/png' });
  assert.deepEqual(await readDocument(send(jpeg, 'IMAGE/JPG')), { bytes: jpeg, mimeType: 'image/jpeg' });
  assert.deepEqual(await readDocument(send(progressiveJpeg, 'image/jpeg')), {
    bytes: progressiveJpeg,
    mimeType: 'image/jpeg',
  });
});

test('rejects missing bytes, unsupported type and a mismatched signature', async () => {
  await assert.rejects(readDocument(send('')), problem('empty_document', 400));
  await assert.rejects(readDocument(send(png, 'image/webp')), problem('unsupported_media_type', 415));
  await assert.rejects(readDocument(send(png, 'application/pdf')), problem('invalid_document_signature', 415));
  await assert.rejects(readDocument(send('<script>alert(1)</script>')), problem('invalid_document_signature', 415));
});

test('rejects image files with matching signatures and incomplete structures', async () => {
  const brokenChunk = png.slice();
  new DataView(brokenChunk.buffer).setUint32(33, 0xffff_ffff);
  const badChecksum = png.slice();
  badChecksum[29] ^= 0xff;
  for (const bytes of [png.slice(0, 8), png.slice(0, -1), brokenChunk, badChecksum]) {
    await assert.rejects(readDocument(send(bytes)), problem('invalid_image', 422));
  }
  for (const bytes of [jpeg.slice(0, 3), jpeg.slice(0, -2), jpeg.slice(0, 20)]) {
    await assert.rejects(readDocument(send(bytes, 'image/jpeg')), problem('invalid_image', 422));
  }
});

test('checks the requested dimensions before sending PNGs or JPEGs to extraction', async () => {
  const widePng = png.slice();
  new DataView(widePng.buffer).setUint32(16, MAX_IMAGE_EDGE + 1);
  await assert.rejects(readDocument(send(widePng)), problem('image_too_large', 413));
  const jpegFrame = Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xc0])) + 2;
  const largeJpeg = jpeg.slice();
  const frame = new DataView(largeJpeg.buffer);
  frame.setUint16(jpegFrame + 3, 6001);
  frame.setUint16(jpegFrame + 5, 6001);
  await assert.rejects(readDocument(send(largeJpeg, 'image/jpeg')), problem('image_too_large', 413));
  frame.setUint16(jpegFrame + 3, 0);
  await assert.rejects(readDocument(send(largeJpeg, 'image/jpeg')), problem('invalid_image', 422));
});

test('enforces the byte cap even without a trustworthy Content-Length', async () => {
  await assert.rejects(
    readDocument(send(png, 'image/png', { 'Content-Length': String(MAX_DOCUMENT_BYTES + 1) })),
    problem('document_too_large', 413),
  );
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(png);
      controller.enqueue(new Uint8Array(MAX_DOCUMENT_BYTES));
    },
    cancel() { canceled = true; },
  });
  await assert.rejects(readDocument(send(body)), problem('document_too_large', 413));
  assert.equal(canceled, true);
});

test('uses one strict Responses API request and returns server-owned provenance', async () => {
  let calls = 0;
  const data = documentResult();
  const result = await extractDocument(image, {
    apiKey: testSecret,
    fetcher: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Bearer ${testSecret}`);
      assert.equal(options.redirect, 'manual');
      assert(options.signal instanceof AbortSignal);
      const request = JSON.parse(options.body);
      assert.equal(request.model, EXTRACTION_MODEL);
      assert.equal(request.model, 'gpt-6-luna');
      assert.equal(request.store, false);
      assert.deepEqual(request.reasoning, { effort: 'medium' });
      assert.equal(request.max_output_tokens, MAX_OUTPUT_TOKENS);
      assert.equal(request.max_output_tokens, 12_000);
      assert.equal(request.tools, undefined);
      assert.match(request.instructions, /untrusted source data/i);
      assert.match(request.instructions, /Read thickness only from the article description.*Ignore the "Esp" column/);
      assert(!options.body.includes(image.name));
      assert.equal(request.input[0].content[1].type, 'input_image');
      assert.equal(request.input[0].content[1].detail, 'original');
      assert.equal(request.input[0].content[1].image_url, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
      const { format } = request.text;
      assert.equal(format.type, 'json_schema');
      assert.equal(format.strict, true);
      assert.equal(format.schema.additionalProperties, false);
      assert.deepEqual(format.schema.required, ['loadingWarehouse', 'unloadingWarehouse', 'loadingDate', 'pages', 'totals', 'issues']);
      return respond(data);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: image.id, name: image.name, ...data });
});

test('sends compressed-object multi-page PDFs as input_file and requires every page', async () => {
  const bytes = await samplePdf(2);
  const pdf = { ...image, name: 'Guia privada.pdf', mimeType: 'application/pdf', bytes };
  const data = documentResult(2);
  const result = await extractDocument(pdf, {
    apiKey: testSecret,
    fetcher: async (url, options) => {
      const content = JSON.parse(options.body).input[0].content;
      assert.match(content[0].text, /2 página/);
      assert.deepEqual(content[1], {
        type: 'input_file',
        filename: 'guia.pdf',
        file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
      });
      return respond(data);
    },
  });
  assert.deepEqual(result.pages.map(({ page }) => page), [1, 2]);
  await assert.rejects(extractDocument(pdf, { apiKey: testSecret, fetcher: async () => respond(documentResult(1)) }),
    problem('invalid_extraction', 502));
});

test('rejects empty, malformed and excessive PDFs before contacting OpenAI', async () => {
  let calls = 0;
  const options = { apiKey: testSecret, fetcher: async () => { calls += 1; } };
  const pdf = { ...image, mimeType: 'application/pdf' };
  await assert.rejects(extractDocument({ ...pdf, bytes: await samplePdf(0) }, options),
    problem('empty_pdf', 422));
  await assert.rejects(extractDocument({ ...pdf, bytes: new TextEncoder().encode('%PDF-report\ncorrupt') }, options),
    problem('unreadable_pdf', 422));
  await assert.rejects(extractDocument({ ...pdf, bytes: await samplePdf(MAX_PDF_PAGES + 1) }, options),
    problem('too_many_pages', 413));
  assert.equal(calls, 0);
});

test('never returns refused or incomplete model results', async () => {
  const refusal = completes([{ type: 'refusal', refusal: 'provider-only text' }]);
  const incomplete = { ...completes([{ type: 'output_text', text: '{}' }]), status: 'incomplete' };
  for (const [body, code, status] of [[refusal, 'extraction_refused', 422], [incomplete, 'invalid_extraction', 502]]) {
    await assert.rejects(
      extractDocument(image, { apiKey: testSecret, fetcher: async () => Response.json(body) }),
      (error) => problem(code, status)(error) && !error.message.includes('provider-only text'),
    );
  }
});

test('rejects the output token limit even when the partial JSON is valid', async () => {
  const partial = {
    ...completes([{ type: 'output_text', text: JSON.stringify(documentResult()) }]),
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { output_tokens: 12_000, output_tokens_details: { reasoning_tokens: 11_000 } },
  };
  await assert.rejects(extractDocument(image, { apiKey: testSecret, fetcher: async () => Response.json(partial) }),
    problem('extraction_token_limit', 502));
});

test('reasoning without one complete structured message is not an extraction', async () => {
  const complete = completes([{ type: 'output_text', text: JSON.stringify(documentResult()) }]);
  for (const output of [complete.output.slice(0, 1), [...complete.output, { type: 'function_call' }]]) {
    await assert.rejects(extractDocument(image, {
      apiKey: testSecret,
      fetcher: async () => Response.json({ ...complete, output }),
    }), problem('invalid_extraction', 502));
  }
});

test('validates the synthetic JPG, PNG and two-page PDF against their expected extractions', async () => {
  const fixtures = new URL('../tests/fixtures/gpt-6-luna/', import.meta.url);
  const dataset = JSON.parse(await readFile(new URL('expected.json', fixtures), 'utf8'));
  for (const { file, mediaType, expected } of dataset.cases) {
    const bytes = await readFile(new URL(file, fixtures));
    const input = await readDocument(send(bytes, mediaType));
    const document = await extractDocument({ ...input, id: 'synthetic-test', name: file }, {
      apiKey: testSecret,
      fetcher: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        const { model, input } = JSON.parse(options.body);
        assert.equal(model, 'gpt-6-luna');
        const payload = input[0].content[1];
        if (mediaType === 'application/pdf') {
          assert.equal(payload.type, 'input_file');
          assert.match(input[0].content[0].text, /2 página/);
        } else {
          assert.equal(payload.type, 'input_image');
          assert.equal(payload.detail, 'original');
          assert.ok(payload.image_url.startsWith(`data:${mediaType};base64,`));
        }
        return respond(expected);
      },
    });
    assert.deepEqual(document, { id: 'synthetic-test', name: file, ...expected });
  }
});

test('fails closed on extra keys, type mismatches, missing provenance and invalid total scope', async () => {
  const data = documentResult();
  const invalidPageNumber = { ...data.pages[0], page: 0 };
  const invalidLine = { ...material, quantity: 2.5 };
  const invalidPageScope = { ...data.pages[0], totals: data.totals };
  for (const invalid of [
    { ...data, name: 'spoofed name' },
    { ...data, pages: [invalidPageNumber] },
    { ...data, pages: [{ ...data.pages[0], lines: [invalidLine] }] },
    { ...data, pages: [invalidPageScope] },
    { ...data, totals: data.pages[0].totals },
    { ...data, issues: [{ field: 'name', reason: 'other', detail: 'unexpected' }] },
  ]) {
    await assert.rejects(extractDocument(image, { apiKey: testSecret, fetcher: async () => respond(invalid) }),
      problem('invalid_extraction', 502));
  }
});

test('rejects the entire redirect range without following Location or reading its body', async () => {
  const privateLocation = 'https://redirect.example/upstream-private-location';
  for (let status = 300; status <= 399; status += 1) {
    const calls = [];
    let reads = 0;
    let discarded = false;
    const body = status === 304 ? null : new ReadableStream({
      pull() { reads += 1; },
      cancel() { discarded = true; },
    }, { highWaterMark: 0 });

    await assert.rejects(extractDocument(image, {
      apiKey: testSecret,
      fetcher: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, 'manual');
        return new Response(body, { status, headers: { Location: privateLocation } });
      },
    }), (error) => problem('extraction_rejected', 502)(error)
      && /redirecionamento inesperado/u.test(error.message)
      && !error.message.includes(privateLocation));
    assert.deepEqual(calls, ['https://api.openai.com/v1/responses']);
    assert.equal(reads, 0);
    assert.equal(discarded, body !== null);
  }
});

test('keeps the adjacent 299 and 400 statuses outside the redirect guard', async () => {
  const data = documentResult();
  const completed = completes([{ type: 'output_text', text: JSON.stringify(data) }]);
  const result = await extractDocument(image, {
    apiKey: testSecret,
    fetcher: async () => Response.json(completed, { status: 299 }),
  });
  assert.deepEqual(result, { id: image.id, name: image.name, ...data });
  await assert.rejects(extractDocument(image, {
    apiKey: testSecret,
    fetcher: async () => new Response('upstream-only details', { status: 400 }),
  }), (error) => problem('extraction_rejected', 502)(error) && !/redirecionamento/u.test(error.message));
});

test('maps missing setup, busy service, upstream error and timeout to safe messages', async () => {
  await assert.rejects(extractDocument(image), problem('extraction_unavailable', 503));
  for (const [status, kind, expectedStatus] of [[429, 'extraction_busy', 503], [500, 'extraction_rejected', 502]]) {
    await assert.rejects(
      extractDocument(image, { apiKey: testSecret, fetcher: async () => new Response('private upstream details', { status }) }),
      (error) => problem(kind, expectedStatus)(error) && !error.message.includes('private upstream details'),
    );
  }
  await assert.rejects(extractDocument(image, {
    apiKey: testSecret,
    signal: AbortSignal.abort(),
    fetcher: async (url, options) => options.signal.throwIfAborted(),
  }), problem('extraction_timeout', 504));

  await assert.rejects(extractDocument(image, {
    apiKey: testSecret,
    fetcher: async () => { throw new Error('Transport error'); },
  }), problem('extraction_transport', 502));

  await assert.rejects(extractDocument(image, {
    apiKey: testSecret,
    fetcher: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('Response body lost')); },
    })),
  }), problem('extraction_transport', 502));
});

test('rejects malformed API JSON and non-JSON content without exposing them', async () => {
  for (const response of [
    new Response('private upstream error message'),
    Response.json(completes([{ type: 'output_text', text: 'private partial output' }])),
  ]) {
    await assert.rejects(
      extractDocument(image, { apiKey: testSecret, fetcher: async () => response }),
      (error) => problem('invalid_extraction', 502)(error) && !error.message.includes('private'),
    );
  }
});
