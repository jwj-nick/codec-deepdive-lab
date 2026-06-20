/* render.js — TOOL 데이터 → 5섹션 페이지
   섹션: 0 Stage Map · 1 Spec(L1) · 2 C-Model(L2) · 3 Bridge(L3) · 4 HW(L4) · 5 Checkpoints
   의존: StageMap, BitField, CodeBlock, SideBySide, marked, hljs, mermaid */
window.Render = (function () {
  function md(s) { return window.marked ? marked.parse(String(s || '')) : esc(s); }
  function inl(s) { return window.marked ? marked.parseInline(String(s || '')) : esc(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function page(T) {
    if (!T) return;
    document.title = T.title + ' — Deep-Dive Lab';
    // 앱바 미니맵
    const mini = document.getElementById('stagemap-mini');
    if (mini) mini.innerHTML = StageMap.renderMini(T.id, T.coupling || []);

    const root = document.getElementById('root');
    root.innerHTML =
      header(T) + secSpec(T) + secCode(T) + secBridge(T) + secHW(T) + secChapters(T) + secChecks(T) + tocNav(T);
    postRender();
  }

  // ── Chapter view (mega-deep, function-level → HW) ──────────
  function chapter(T, chId) {
    if (!T) return;
    const mini = document.getElementById('stagemap-mini');
    if (mini) mini.innerHTML = StageMap.renderMini(T.id, T.coupling || []);
    const ch = (T.chapters || []).find(c => c.id === chId);
    const root = document.getElementById('root');
    if (!ch) {
      root.innerHTML = '<div class="card"><p class="bc"><a href="app.html?tool=' + T.id + '">◂ ' + esc(T.title) + ' overview</a></p><h2>Unknown chapter</h2></div>';
      return;
    }
    document.title = ch.title + ' — ' + T.title;
    const skel = ch.stage !== 'full'
      ? '<div class="skel-banner">🚧 <b>Skeleton</b> — line-by-line walkthrough pending. Fill while studying via <code>codec-study ' + esc(ch.id) + '</code>.</div>' : '';
    root.innerHTML = chHeader(T, ch) + skel + chSpec(ch) + chFigures(ch) + chWalk(ch) + chStructs(ch) + chIO(ch) + chHW(ch) + chChecks(ch) + chNav(T, ch);
    postRender();
  }

  // ── Dataflow view (top-level: one superblock through the pipeline) ──
  function dataflow(T) {
    if (!T) return;
    const mini = document.getElementById('stagemap-mini');
    if (mini) mini.innerHTML = StageMap.renderMini('dataflow', []);
    document.title = T.title + ' — Deep-Dive Lab';
    const root = document.getElementById('root');
    const hero = '<section class="tool-hero">' +
      '<div class="th-tag">DATAFLOW</div>' +
      '<h1>' + esc(T.title) + '</h1>' +
      (T.intro ? '<p class="th-role">' + inl(T.intro) + '</p>' : '') + '</section>';
    const loops = (T.loops || []).map(dfLoop).join('');
    const foot = '<div class="ch-foot"><p class="muted">Each stage box links to its deep-dive tool. ' +
      'I/O formats here are the public draft; only actual RTL stays private.</p>' +
      '<p><a href="index.html">↑ Lab</a></p></div>';
    root.innerHTML = hero + loops + foot;
    postRender();
  }
  function dfLoop(lp) {
    const diag = lp.diagram ? mermaidBox(lp.diagram, lp.diagCaption || 'dataflow') : '';
    const stages = (lp.stages || []).map(dfStage).join('');
    return sectionWrap('df-' + esc(lp.id || ''), lp.title || '',
      (lp.caption ? '<p class="muted">' + inl(lp.caption) + '</p>' : '') + diag +
      '<div class="df-stages">' + stages + '</div>');
  }
  function dfStage(s) {
    const head = '<div class="df-st-head">' +
      '<span class="df-hw">' + esc(s.hw || '') + '</span>' +
      (s.tool ? '<a class="df-fn" href="app.html?tool=' + esc(s.tool) + '">' + esc(s.fn || s.tool) + ' →</a>'
              : '<span class="df-fn">' + esc(s.fn || '') + '</span>') + '</div>';
    const ports = (s.in || []).map(p => portRow(p, 'in')).concat((s.out || []).map(p => portRow(p, 'out'))).join('');
    const tbl = ports ? '<table class="io-table">' + ioHead + '<tbody>' + ports + '</tbody></table>' : '';
    return '<div class="df-stage">' + head + (s.role ? '<p class="muted">' + inl(s.role) + '</p>' : '') + tbl + '</div>';
  }

  function postRender() {
    if (window.hljs) document.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch (e) {} });
    renderMermaid();
    wireChecks();
  }

  // Overview footer: deep-dive chapter list
  function secChapters(T) {
    if (!T.chapters || !T.chapters.length) return '';
    const items = T.chapters.map(c => {
      const st = c.stage === 'full' ? 'walkthrough →' : 'skeleton →';
      const inner = '<span class="ch-n">' + esc(c.n) + '</span>' +
        '<span class="ch-t">' + esc(c.title) + (c.fn ? ' <span class="ch-fn">' + esc(c.fn.name) + '()</span>' : '') + '</span>' +
        '<span class="ch-st' + (c.stage === 'full' ? ' full' : '') + '">' + st + '</span>';
      return '<a class="ch-item" href="app.html?tool=' + T.id + '&ch=' + c.id + '">' + inner + '</a>';
    }).join('');
    return sectionWrap('chapters', 'Deep-dive chapters (function-level → HW)',
      '<p class="muted">Each chapter dissects one function line-by-line, then reasons to HW. The HW section is yours to derive via <code>codec-study</code>.</p>' +
      '<div class="ch-list">' + items + '</div>');
  }

  // Chapter quick-nav strip  [1][2]…[N]
  function chStrip(T, ch) {
    return '<nav class="ch-strip">' + (T.chapters || []).map(c =>
      '<a class="cs' + (c.id === ch.id ? ' on' : '') + (c.stage === 'full' ? ' full' : '') +
      '" href="app.html?tool=' + T.id + '&ch=' + c.id + '" title="' + esc(c.n + '. ' + c.title) + '">' + esc(c.n) + '</a>').join('') + '</nav>';
  }

  function chHeader(T, ch) {
    const f = ch.fn || {};
    return '<section class="ch-hero">' +
      '<p class="bc"><a href="app.html?tool=' + T.id + '">◂ ' + esc(T.title) + ' overview</a></p>' +
      chStrip(T, ch) +
      '<h1>' + esc(ch.n + '. ' + ch.title) + '</h1>' +
      (f.name ? '<div class="ch-fnbar"><code>' + esc(f.name) + '()</code>' + (f.file ? '<span class="cb-loc">' + esc(f.file + (f.line ? ':' + f.line : '')) + '</span>' : '') + '</div>' : '') +
      (f.role ? '<p class="th-role">' + inl(f.role) + '</p>' : '') +
      ((f.callers || f.callees) ? '<p class="muted">' + (f.callers ? 'callers: ' + esc(f.callers) + ' · ' : '') + (f.callees ? 'calls: ' + esc(f.callees) : '') + '</p>' : '') +
      chNavBtns(T, ch) + '</section>';
  }
  function chSpec(ch) {
    if (!ch.spec) return '';
    return sectionWrap('ch-spec', 'L1 · Spec',
      '<div class="spec-block"><h3>§' + esc(ch.spec.num) + ' · ' + esc(ch.spec.title || '') + '</h3>' +
      (ch.spec.pseudo ? md(ch.spec.pseudo) : '') + '</div>');
  }
  function chFigures(ch) {
    if (!ch.figures || !ch.figures.length) return '';
    const body = ch.figures.map(fg => {
      if (fg.mermaid) return mermaidBox(fg.mermaid, fg.title || '');
      if (fg.ascii) return '<figure class="ascii-fig">' + (fg.title ? '<figcaption>' + esc(fg.title) + '</figcaption>' : '') +
        '<pre class="ascii">' + esc(fg.ascii) + '</pre>' + (fg.caption ? '<p class="muted">' + inl(fg.caption) + '</p>' : '') + '</figure>';
      return '';
    }).join('');
    return sectionWrap('ch-fig', 'Figures · intuition', body);
  }
  function chWalk(ch) {
    if (!ch.walkthrough || !ch.walkthrough.length) return '';
    const steps = ch.walkthrough.map(w =>
      '<div class="wt-step">' +
        '<div class="wt-code">' + (w.line ? '<span class="wt-ln">L' + esc(w.line) + '</span>' : '') +
          '<pre><code class="language-c">' + esc(w.code) + '</code></pre></div>' +
        (w.note ? '<div class="wt-note">' + inl(w.note) + '</div>' : '') +
      '</div>').join('');
    const src = ch.fn ? '<p class="muted">source: <code>' + esc(ch.fn.file + (ch.fn.line ? ':' + ch.fn.line : '')) + '</code> · AVM (BSD)</p>' : '';
    return sectionWrap('ch-walk', 'L2 · Code walkthrough (line-by-line)', src + '<div class="walkthrough">' + steps + '</div>');
  }
  function chStructs(ch) {
    if (!ch.structs || !ch.structs.length) return '';
    return sectionWrap('ch-structs', 'L3 · Data structures & constants', ch.structs.map(structBlock).join(''));
  }
  // ── I/O ports (RTL port draft) ──────────────────────────────
  const ioHead = '<thead><tr><th>dir</th><th>signal</th><th>type · width</th><th>src · dst</th><th>per-SB volume</th><th>notes</th></tr></thead>';
  function portRow(p, dir) {
    dir = p.dir || dir || 'in';
    return '<tr class="io-' + esc(dir) + '"><td class="io-dir">' + esc(dir) + '</td>' +
      '<td><code>' + esc(p.sig || '') + '</code></td>' +
      '<td>' + inl(p.type || '') + '</td>' +
      '<td>' + inl(p.peer || '') + '</td>' +
      '<td>' + inl(p.vol || '') + '</td>' +
      '<td>' + inl(p.note || '') + '</td></tr>';
  }
  function chIO(ch) {
    const io = ch.io; if (!io) return '';
    const diag = io.diagram ? mermaidBox(io.diagram, io.diagCaption || 'I/O block diagram') : '';
    const rows = (io.in || []).map(p => portRow(p, 'in'))
      .concat((io.out || []).map(p => portRow(p, 'out')))
      .concat((io.ports || []).map(p => portRow(p))).join('');
    const tbl = rows ? '<table class="io-table">' + ioHead + '<tbody>' + rows + '</tbody></table>' : '';
    const note = io.note ? '<p class="muted">' + inl(io.note) + '</p>' : '';
    return sectionWrap('ch-io', 'I/O ports (RTL draft)',
      '<p class="muted">The function as a small RTL block: what crosses its boundary, in what format. Feeds the stage-level I/O synthesis.</p>' +
      diag + tbl + note);
  }
  function chHW(ch) {
    const h = ch.hw; if (!h) return '';
    const guard = '<div class="hw-guard">💡 <b>HW architecture reasoning</b> — datapath, ports, bandwidth, MAC/SRAM estimates, all derived from public AVM source + AV2 spec. This section is <b>yours to derive</b> (Socratic). Only actual RTL/Verilog code stays in the private repo.</div>';
    const dp = h.datapath ? mermaidBox(h.datapath, 'datapath skeleton') : '';
    const qs = (h.questions && h.questions.length)
      ? '<div class="hw-openq"><h3>Guiding questions (derive)</h3><ol>' + h.questions.map(q => '<li>' + inl(q) + '</li>').join('') + '</ol></div>' : '';
    const derived = h.derived
      ? '<div class="hw-derived"><h3>Derived</h3>' + md(h.derived) + '</div>'
      : '<p class="muted">↑ Derive these in a <code>codec-study ' + esc(ch.id) + '</code> session; answers get formalized here.</p>';
    return sectionWrap('ch-hw', 'L4 · HW architecture', guard + dp + qs + derived);
  }
  function chChecks(ch) {
    if (!ch.checks || !ch.checks.length) return '';
    const items = ch.checks.map((c, i) =>
      '<div class="check" data-i="' + i + '"><button class="check-q">Q' + (i + 1) + '. ' + inl(c.q) + '</button>' +
      '<div class="check-a">' + (c.hint ? '<p class="check-hint">💡 ' + inl(c.hint) + '</p>' : '') +
      '<p class="check-ans">' + inl(c.a) + '</p></div></div>').join('');
    return sectionWrap('ch-checks', 'Checkpoints', '<div class="checks">' + items + '</div>');
  }
  function chNavBtns(T, ch) {
    const list = T.chapters || [];
    const i = list.findIndex(c => c.id === ch.id);
    const prev = i > 0 ? list[i - 1] : null, next = i < list.length - 1 ? list[i + 1] : null;
    const btn = (c, lbl) => !c ? '<span class="chnav-b dis"></span>'
      : '<a class="chnav-b" href="app.html?tool=' + T.id + '&ch=' + c.id + '">' + lbl + ' ' + esc(c.n + '. ' + c.title) + '</a>';
    return '<div class="chnav">' + btn(prev, '◂') + btn(next, '▸') + '</div>';
  }
  function chNav(T, ch) {
    return '<div class="ch-foot">' + chNavBtns(T, ch) +
      '<p><a href="app.html?tool=' + T.id + '">↑ ' + esc(T.title) + ' overview</a></p></div>';
  }
  function structBlock(s) {
    return '<div class="struct"><div class="struct-head"><code>' + esc(s.name) + '</code>' +
      (s.file ? '<span class="cb-loc">' + esc(s.file + (s.line ? ':' + s.line : '')) + '</span>' : '') + '</div>' +
      (s.fields && s.fields.length ? '<ul class="struct-fields">' + s.fields.map(fl => '<li><code>' + esc(fl.f) + '</code> — ' + inl(fl.d || '') + '</li>').join('') + '</ul>' : '') +
      (s.note ? '<p class="cb-note">' + inl(s.note) + '</p>' : '') + '</div>';
  }

  function header(T) {
    const cpl = (T.coupling && T.coupling.length)
      ? '<p class="coupling">강결합: ' + T.coupling.map(c => '<code>' + esc(c) + '</code>').join(' · ') + '</p>' : '';
    return '<section class="tool-hero">' +
      '<div class="th-tag">' + esc(T.stage) + ' 스테이지</div>' +
      '<h1>' + esc(T.title) + '</h1>' +
      '<p class="th-role">' + inl(T.role || '') + '</p>' + cpl +
      '</section>';
  }

  // ── L1 Spec ────────────────────────────────────────────────
  function secSpec(T) {
    const sp = T.spec || {};
    const secs = (sp.sections || []).map(s =>
      '<div class="spec-block">' +
        '<h3>§' + esc(s.num) + ' · ' + esc(s.title) + '</h3>' +
        (s.pseudo ? '<div class="pseudo"><div class="pseudo-lbl">decode process (요약/패러프레이즈)</div>' + md(s.pseudo) + '</div>' : '') +
        (s.elements && s.elements.length
          ? '<table class="synel"><thead><tr><th>syntax element</th><th>descriptor</th><th>의미</th></tr></thead><tbody>' +
            s.elements.map(e => '<tr><td><code>' + esc(e.name) + '</code></td><td>' + esc(e.desc || '') + '</td><td>' + inl(e.meaning || '') + '</td></tr>').join('') +
            '</tbody></table>' : '') +
      '</div>').join('');
    const bf = (sp.bitfields || []).map(b => BitField.render(b)).join('');
    if (!secs && !bf) return '';
    return sectionWrap('spec', 'L1 · Spec', secs + bf);
  }

  // ── L2 C-Model ─────────────────────────────────────────────
  function secCode(T) {
    const c = T.code || {};
    const cg = c.callgraph ? mermaidBox(c.callgraph, '호출그래프') : '';
    const funcs = (c.funcs || []).map(f => CodeBlock.render(f)).join('');
    const structs = (c.structs || []).map(s =>
      '<div class="struct"><div class="struct-head"><code>' + esc(s.name) + '</code>' +
      (s.file ? '<span class="cb-loc">' + esc(s.file + (s.line ? ':' + s.line : '')) + '</span>' : '') + '</div>' +
      (s.fields && s.fields.length
        ? '<ul class="struct-fields">' + s.fields.map(fl => '<li><code>' + esc(fl.f) + '</code> — ' + inl(fl.d || '') + '</li>').join('') + '</ul>' : '') +
      (s.note ? '<p class="cb-note">' + inl(s.note) + '</p>' : '') + '</div>').join('');
    const gdb = (c.gdb && c.gdb.length)
      ? '<div class="gdb"><div class="gdb-lbl">gdb 실측값</div><ul>' +
        c.gdb.map(g => '<li><code>' + esc(g.at) + '</code> → ' + inl(g.val) + '</li>').join('') + '</ul></div>' : '';
    const body = cg + (funcs ? '<h3>Key functions</h3>' + funcs : '') +
                 (structs ? '<h3>Data structures</h3>' + structs : '') + gdb;
    if (!body.trim()) return '';
    return sectionWrap('code', 'L2 · C-Model (source)', body);
  }

  // ── L3 Bridge ──────────────────────────────────────────────
  function secBridge(T) {
    if (!T.bridge || !T.bridge.length) return '';
    return sectionWrap('bridge', 'L3 · Spec ↔ Code · AV1→AV2 delta', SideBySide.render(T.bridge));
  }

  // ── L4 HW ──────────────────────────────────────────────────
  function secHW(T) {
    const h = T.hw; if (!h) return '';
    const guard = h.guardrail === false ? '' :
      '<div class="hw-guard">💡 <b>HW architecture reasoning</b> — derived from public AVM source + AV2 spec. ' +
      'Datapath, bandwidth, MAC/SRAM estimates all in scope. Only actual RTL/Verilog code stays private.</div>';
    const dp = h.datapath ? mermaidBox(h.datapath, 'datapath 개념도') : '';
    const rows = [
      ['throughput / 파이프라인', h.throughput],
      ['메모리 / 라인버퍼', h.memory],
      ['의존성 / hazard', h.hazard],
      ['병렬화 전략', h.parallel],
      ['AV1 → AV2 HW 델타', h.av1delta],
    ].filter(r => r[1]).map(r =>
      '<div class="hw-item"><div class="hw-k">' + r[0] + '</div><div class="hw-v">' + md(r[1]) + '</div></div>').join('');
    const oq = (h.openQ && h.openQ.length)
      ? '<div class="hw-openq"><h3>설계 사고 sandbox (open questions)</h3><ul>' +
        h.openQ.map(q => '<li>' + inl(q) + '</li>').join('') + '</ul></div>' : '';
    return sectionWrap('hw', 'L4 · HW Architecture', guard + dp + '<div class="hw-grid">' + rows + '</div>' + oq);
  }

  // ── 5 Checkpoints + Quiz ───────────────────────────────────
  function secChecks(T) {
    const ch = (T.checks || []).map((c, i) =>
      '<div class="check" data-i="' + i + '">' +
        '<button class="check-q">Q' + (i + 1) + '. ' + inl(c.q) + '</button>' +
        '<div class="check-a">' +
          (c.hint ? '<p class="check-hint">💡 ' + inl(c.hint) + '</p>' : '') +
          '<p class="check-ans">' + inl(c.a) + '</p></div></div>').join('');
    const qz = (T.quiz || []).map((q, i) => quizItem(q, i)).join('');
    if (!ch && !qz) return '';
    return sectionWrap('checks', 'Checkpoints',
      (ch ? '<div class="checks">' + ch + '</div>' : '') +
      (qz ? '<h3>퀴즈</h3><div class="quiz">' + qz + '</div>' : ''));
  }
  function quizItem(q, i) {
    const opts = (q.options || []).map((o, j) =>
      '<li><button class="qopt" data-correct="' + (j === q.answer ? '1' : '0') + '">' + inl(o) + '</button></li>').join('');
    return '<div class="qitem"><p class="q-stem">' + (i + 1) + '. ' + inl(q.q) + '</p><ul class="qopts">' + opts + '</ul>' +
      (q.why ? '<p class="q-why" hidden>해설: ' + inl(q.why) + '</p>' : '') + '</div>';
  }

  // ── 공통 ───────────────────────────────────────────────────
  function sectionWrap(id, title, body) {
    return '<section id="sec-' + id + '" class="layer-sec"><h2 class="layer-h">' + esc(title) + '</h2>' + body + '</section>';
  }
  function tocNav(T) {
    const items = [['spec','L1 Spec'],['code','L2 Code'],['bridge','L3 delta'],['hw','L4 HW'],['checks','Check']];
    return '<nav class="toc"><div class="toc-title">' + esc(T.title) + '</div>' +
      items.map(it => '<a href="#sec-' + it[0] + '">' + it[1] + '</a>').join('') + '</nav>';
  }

  let mermaidSeq = 0, mermaidInit = false;
  function mermaidBox(code, cap) {
    const id = 'mmd-' + (mermaidSeq++);
    return '<figure class="mermaid-box">' + (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') +
      '<div class="mermaid" id="' + id + '">' + esc(code) + '</div></figure>';
  }
  function renderMermaid() {
    if (!window.mermaid) return;
    try {
      if (!mermaidInit) { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); mermaidInit = true; }
      mermaid.run({ querySelector: '.mermaid' });
    } catch (e) { /* 다이어그램 실패는 무시 */ }
  }
  function wireChecks() {
    document.querySelectorAll('.check-q').forEach(b =>
      b.addEventListener('click', () => b.parentElement.classList.toggle('open')));
    document.querySelectorAll('.qopt').forEach(b =>
      b.addEventListener('click', () => {
        const item = b.closest('.qitem');
        item.querySelectorAll('.qopt').forEach(x => x.classList.add('done'));
        b.classList.add(b.dataset.correct === '1' ? 'right' : 'wrong');
        const why = item.querySelector('.q-why'); if (why) why.hidden = false;
      }));
  }

  return { page: page, chapter: chapter, dataflow: dataflow };
})();
