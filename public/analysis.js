// The staff library loads only after sign-in. No publication data ships in browser assets.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const topics = ['Scouting & recruitment', 'Team performance', 'Player development'];
const state = { q: '', topic: '', sort: 'curated' };
const fmt = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const due = report => report.review_after < new Date().toLocaleDateString('en-CA');
const path = report => `#/analysis/${report.slug}`;
const filePath = (report, file) => `/api/analysis/${encodeURIComponent(report.slug)}/files/${encodeURIComponent(file.id)}`;

export function filterReports(reports, { q = '', topic = '', sort = 'curated' } = {}) {
  const terms = normalize(q).trim().split(/\s+/).filter(Boolean);
  const selected = reports.filter(r => (!topic || r.topic === topic) && terms.every(term =>
    normalize([r.title, r.summary, r.topic, r.coverage, ...r.tags, ...r.takeaways,
      ...r.sections.flatMap(s => [s.title, ...(s.paragraphs || []), ...(s.bullets || []), ...(s.table?.rows.flat() || [])])].join(' ')).includes(term)));
  if (sort === 'newest') selected.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
  if (sort === 'title') selected.sort((a, b) => a.title.localeCompare(b.title));
  return selected;
}

const statusHTML = r => `${r.status !== 'Analysis' ? `<span class="al-status ${r.status === 'Preliminary' ? 'preliminary' : ''}">${esc(r.status)}</span>` : ''}${due(r) ? '<span class="al-status preliminary">Review due</span>' : ''}`;

export async function renderAnalysis(main, arg, { api, setTitle }) {
  main.innerHTML = '<div class="page al-page"><p class="loading">Loading analysis…</p></div>';
  const host = main.firstElementChild;
  try {
    if (arg) {
      const { report } = await api('GET', `/api/analysis/${encodeURIComponent(arg)}`);
      if (!host.isConnected) return;
      setTitle(report.title);
      renderReport(host, report);
      return;
    }
    const { reports } = await api('GET', '/api/analysis');
    if (!host.isConnected) return;
    host.innerHTML = `<header class="al-heading"><div><div class="al-eyebrow">THE STAFF LIBRARY</div><h1>Analysis</h1>
      <p>Research for the next decision.</p><p class="al-intro">Selected studies, practical takeaways, and the evidence behind them.</p></div>
      <div class="al-library-count"><strong>${reports.length.toString().padStart(2, '0')}</strong><span>curated reports</span></div></header>
      <div class="al-layout"><aside class="al-sidebar"><h2>Browse by topic</h2><nav aria-label="Analysis topics">
        ${['', ...topics].map((topic, i) => `<button type="button" data-topic="${esc(topic)}"><span>${esc(topic || 'All analysis')}</span><span>${topic ? reports.filter(r => r.topic === topic).length : reports.length}</span></button>${i === 0 ? '<div class="al-topic-divider"></div>' : ''}`).join('')}
      </nav><div class="al-sidebar-note"><b>About this library</b><p>Start with the brief. Open the full report for the detail. Coverage dates and limitations travel with every study.</p></div></aside>
      <div class="al-content"><div class="al-toolbar"><label class="al-search"><span class="sr-only">Search analysis</span><input type="search" id="al-search" placeholder="Search reports, topics, or findings…" value="${esc(state.q)}"></label>
        <label class="al-sort"><span class="sr-only">Sort analysis</span><select id="al-sort"><option value="curated">By topic</option><option value="newest">Recently updated</option><option value="title">Title A–Z</option></select></label></div>
        <p class="al-results" id="al-count" role="status" aria-live="polite"></p><div id="al-reports"></div></div></div>`;
    const draw = () => {
      const selected = filterReports(reports, state);
      host.querySelectorAll('[data-topic]').forEach(button => {
        const active = button.dataset.topic === state.topic;
        button.classList.toggle('on', active); button.setAttribute('aria-pressed', String(active));
      });
      host.querySelector('#al-count').textContent = `${selected.length} report${selected.length === 1 ? '' : 's'}${state.topic ? ` in ${state.topic}` : ''}${state.q.trim() ? ` matching “${state.q.trim()}”` : ''}`;
      const card = r => `<article class="al-card"><div class="al-card-top"><span class="al-topic-label">${esc(r.topic)}</span><div class="al-statuses">${statusHTML(r)}</div></div>
        <h3><a href="${path(r)}">${esc(r.title)}</a></h3><p>${esc(r.summary)}</p><div class="al-tags">${r.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}</div>
        <footer><span>Updated ${fmt(r.updated)}</span><a href="${path(r)}" aria-label="Read brief: ${esc(r.title)}">${r.read_minutes} min brief <span aria-hidden="true">→</span></a></footer></article>`;
      const grouped = state.sort === 'curated' && !state.topic;
      host.querySelector('#al-reports').innerHTML = !selected.length ? `<div class="al-empty"><h2>${reports.length ? 'No matching reports' : 'The library is being prepared'}</h2>
        <p>${reports.length ? 'Try a different phrase or browse all topics.' : 'Curated reports will appear here once the first publication is uploaded.'}</p>${reports.length ? '<button class="btn" id="al-clear" type="button">Clear filters</button>' : ''}</div>`
        : grouped ? topics.map((topic, i) => {
          const group = selected.filter(r => r.topic === topic);
          return group.length ? `<section class="al-group"><h2><span>${String(i + 1).padStart(2, '0')}</span>${esc(topic)}<small>${group.length}</small></h2><div class="al-grid">${group.map(card).join('')}</div></section>` : '';
        }).join('') : `<div class="al-grid">${selected.map(card).join('')}</div>`;
      host.querySelector('#al-clear')?.addEventListener('click', () => {
        state.q = ''; state.topic = ''; host.querySelector('#al-search').value = ''; draw();
      });
    };
    host.querySelector('#al-sort').value = state.sort;
    host.querySelector('#al-search').addEventListener('input', event => { state.q = event.target.value; draw(); });
    host.querySelector('#al-sort').addEventListener('change', event => { state.sort = event.target.value; draw(); });
    host.querySelectorAll('[data-topic]').forEach(button => button.addEventListener('click', () => { state.topic = button.dataset.topic; draw(); }));
    draw();
  } catch (error) {
    if (!host.isConnected) return;
    host.innerHTML = `<a href="#/analysis" class="al-back">← All analysis</a><div class="al-empty"><h1>${error.status === 404 ? 'Report not found' : 'Could not load analysis'}</h1><p>${esc(error.status === 404 ? 'This report may have been withdrawn or replaced.' : error.message)}</p><button class="btn" id="al-retry" type="button">Try again</button></div>`;
    host.querySelector('#al-retry').addEventListener('click', () => renderAnalysis(main, arg, { api, setTitle }));
  }
}

function renderReport(host, r) {
  const pdfs = r.documents.filter(d => d.format === 'pdf');
  host.classList.add('al-report-page');
  host.innerHTML = `<a href="#/analysis" class="al-back">← All analysis</a>
    <header class="al-report-heading"><div class="al-card-top"><span class="al-topic-label">${esc(r.topic)}</span><div class="al-statuses">${statusHTML(r)}</div></div>
      <h1>${esc(r.title)}</h1><p class="al-deck">${esc(r.summary)}</p><div class="al-meta"><span>Updated ${fmt(r.updated)}</span><span>Reviewed ${fmt(r.reviewed)}</span><span>${r.read_minutes} min brief</span></div>
      <div class="al-report-actions">${pdfs.map((d, i) => `<a class="btn ${i === 0 ? 'primary' : ''}" href="${filePath(r, d)}" target="_blank" rel="noopener">${esc(d.label)} ↗</a>`).join('')}<button class="btn ghost" id="al-copy" type="button">Copy link</button></div></header>
    <div class="al-reading-layout"><aside class="al-contents"><h2>In this brief</h2><nav aria-label="Report contents"><a href="#al-takeaways" data-section="al-takeaways">Key takeaways</a>${r.sections.map((s, i) => `<a href="#al-section-${i}" data-section="al-section-${i}">${esc(s.title)}</a>`).join('')}<a href="#al-limits" data-section="al-limits">Coverage & limitations</a><a href="#al-source" data-section="al-source">Sources & downloads</a></nav></aside>
    <article class="al-reading"><section class="al-takeaways" id="al-takeaways"><div class="al-eyebrow">THE STAFF BRIEF</div><h2>Key takeaways</h2><ul>${r.takeaways.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>
      ${r.sections.map((s, i) => `<section class="al-section" id="al-section-${i}"><h2>${esc(s.title)}</h2>${(s.paragraphs || []).map(p => `<p>${esc(p)}</p>`).join('')}${s.bullets?.length ? `<ul>${s.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}${s.table ? `<div class="al-table-wrap" tabindex="0" role="region" aria-label="${esc(s.title)} table"><table><thead><tr>${s.table.columns.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map(row => `<tr>${row.map((c, j) => j === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}</section>`).join('')}
      ${r.documents.filter(d => d.format === 'png').map(d => `<figure class="al-figure"><img src="${filePath(r, d)}" alt="${esc(d.label)}" loading="lazy"><figcaption>${esc(d.label)}</figcaption></figure>`).join('')}
      <section class="al-section al-limits" id="al-limits"><h2>Coverage & limitations</h2><p><b>Data coverage:</b> ${esc(r.coverage)}</p><p>${esc(r.limitations)}</p>${due(r) ? '<p class="al-review-warning"><b>Review due.</b> Use as a dated reference until the next editorial review.</p>' : ''}<p class="al-review-date">Next review by ${fmt(r.review_after)}</p></section>
      <section class="al-section al-source" id="al-source"><h2>Sources & downloads</h2><p>The brief accompanies the original analysis. Use the full report for its evidence and method.</p>
        <ul>${pdfs.map(d => `<li><a href="${filePath(r, d)}?download=1">Download ${esc(d.label.replace(/^(Read|Open) /, ''))} (PDF)</a></li>`).join('')}<li><a href="/api/analysis/${r.slug}/files/source">Download original source (Markdown)</a></li><li><a href="https://github.com/${r.source.repository}/blob/${r.source.ref}/${r.source.path}" target="_blank" rel="noopener">View source in Hearts of PINE ↗</a> <span class="muted">Repository access required</span></li></ul>
        <details><summary>Publication provenance</summary><p>Source revision <code>${esc(r.source.ref.slice(0, 12))}</code><br><span class="al-source-path">${esc(r.source.path)}</span><br>Content SHA-256 <code class="al-source-path">${esc(r.source.sha256)}</code></p></details></section>
    </article></div>`;
  host.querySelectorAll('[data-section]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); document.getElementById(link.dataset.section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  host.querySelector('#al-copy').addEventListener('click', async event => {
    try { await navigator.clipboard.writeText(`${location.origin}/#/analysis/${r.slug}`); event.target.textContent = 'Link copied'; }
    catch { event.target.textContent = 'Copy the address above'; }
  });
}
