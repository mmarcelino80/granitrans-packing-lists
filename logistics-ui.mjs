import { organizeGuides } from './logistics.mjs';

const small = matchMedia('(max-width: 860px)');
const make = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });
const fileName = (value) => 'packing-list-' + value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createLogisticsUI(container, context) {
  const drafts = new Map();
  const files = new Map();
  let confirmed = false;
  let dataSignature;
  const heading = make('h2', 'Resultado');
  const status = make('p', '');
  status.setAttribute('role', 'status');
  const notices = make('ul', '');
  const confirm = make('button', 'Confirmar conferência dos avisos');
  const cards = make('div', '');
  container.replaceChildren(heading, status, notices, confirm, cards);
  confirm.addEventListener('click', () => {
    if (window.confirm('Confirma que verificou os avisos nas guias e corrigiu o texto?')) {
      confirmed = true;
      render();
    }
  });

  function render() {
    const { route, date, guides, busy } = context();
    const documents = [...new Map(guides.filter((file) => files.has(file)).map((file) => {
      const doc = files.get(file);
      return [doc.id, doc];
    })).values()];
    const mobile = small.matches;
    const { results, warnings, blocked } = organizeGuides(documents, { mobile, route, date });
    const pending = guides.filter((file) => !files.has(file));
    const signature = JSON.stringify([mobile, route, date, documents.map(({ id }) => id), guides.length]);
    if (dataSignature !== signature) {
      confirmed = false;
      for (const draft of drafts.values()) draft.approved = false;
      dataSignature = signature;
    }
    status.textContent = results.length ? '' : 'Anexe e analise as guias para preparar a Packing List.';
    notices.replaceChildren(...[
      ...blocked, ...warnings, ...(documents.length && pending.length ? ['Existem guias por analisar.'] : []),
    ].map((message) => make('li', message)));
    notices.hidden = !notices.childNodes.length;
    confirm.hidden = mobile || !warnings.length || confirmed || Boolean(blocked.length || pending.length || busy);
    cards.replaceChildren();
    for (const result of results) {
      const { title, text, unloading } = result;
      let draft = drafts.get(unloading);
      if (!draft || !draft.edited) {
        draft = { text, approved: draft?.text === text && draft.approved, edited: false };
        drafts.set(unloading, draft);
      } else if (draft.generated !== undefined && draft.generated !== text) {
        draft.stale = true;
        draft.approved = false;
      }
      draft.generated = text;
      const card = make('article', '');
      card.className = 'logistics-document';
      card.append(make('h3', title));
      const output = make(mobile ? 'pre' : 'textarea', draft.text);
      const approve = make('button', draft.approved ? 'Aprovado' : 'Aprovar');
      const save = make('button', mobile ? 'Descarregar TXT' : 'Descarregar PDF');
      const share = make('a', 'Preparar email');
      const attachment = make('p', 'Descarregue o TXT e anexe-o ao email.');
      const reconcile = make('button', 'Conferi o texto com as guias atualizadas');
      reconcile.hidden = !draft.stale || mobile;
      reconcile.addEventListener('click', () => {
        if (window.confirm('Confirma que o texto editado contempla todas as guias desta descarga?')) {
          draft.stale = false;
          reconcile.hidden = true;
          controls();
        }
      });
      if (!mobile) {
        output.value = draft.text;
        output.setAttribute('aria-label', 'Texto · ' + title);
        output.addEventListener('input', () => {
          draft.text = output.value;
          draft.edited = true;
          draft.approved = false;
          confirmed = false;
          confirm.hidden = !warnings.length || Boolean(blocked.length || pending.length || busy);
          controls();
        });
      }
      function controls() {
        approve.textContent = draft.approved ? 'Aprovado' : 'Aprovar';
        const unresolved = /(?:^\? |Destino por confirmar|\[Descrição por confirmar\])/mu.test(draft.text);
        approve.disabled = draft.approved || draft.stale || unresolved || !draft.text.trim() || !result.rows.length
          || Boolean(pending.length || blocked.length || busy || (warnings.length && (mobile || !confirmed)));
        save.disabled = !draft.approved;
        share.hidden = !draft.approved || !mobile;
        attachment.hidden = share.hidden;
      }
      approve.addEventListener('click', () => {
        draft.approved = true;
        controls();
      });
      save.addEventListener('click', async () => {
        if (!draft.approved) return;
        const approved = draft.text;
        if (mobile) return download(approved, fileName(unloading) + '.txt', 'text/plain;charset=utf-8');
        try {
          const { packingPDF } = await import('./packing-pdf.mjs');
          const bytes = await packingPDF(title, approved);
          if (draft.approved && draft.text === approved && cards.contains(card)) {
            download(bytes, fileName(unloading) + '.pdf', 'application/pdf');
          }
        } catch {
          status.textContent = 'Não foi possível gerar o PDF. Verifique os caracteres do texto.';
        }
      });
      share.href = 'mailto:mralo@granitrans.pt?subject=' + encodeURIComponent('Packing List — ' + unloading)
        + '&body=' + encodeURIComponent('Bom dia,\r\n\r\nSegue a Packing List em anexo.\r\n\r\nObrigado / Merci');
      card.append(output, reconcile, approve, save);
      if (mobile) card.append(share, attachment);
      controls();
      cards.append(card);
    }
  }
  small.addEventListener('change', render);
  return { render, receive: (entries) => {
    for (const file of files.keys()) if (!context().guides.includes(file)) files.delete(file);
    for (const { document, files: received } of entries) {
      for (const file of received) files.set(file, document);
    }
    render();
  } };
}
