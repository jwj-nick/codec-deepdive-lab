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
      header(T) + secSpec(T) + secCode(T) + secBridge(T) + secHW(T) + secChecks(T) + tocNav(T);

    // 포스트 렌더: 코드 하이라이트 + mermaid + 체크포인트 토글 + bitfield 호버
    if (window.hljs) document.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch (e) {} });
    renderMermaid();
    wireChecks();
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
    return sectionWrap('spec', 'L1 · Spec (규범)', secs + bf);
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
    const body = cg + (funcs ? '<h3>핵심 함수</h3>' + funcs : '') +
                 (structs ? '<h3>자료구조</h3>' + structs : '') + gdb;
    if (!body.trim()) return '';
    return sectionWrap('code', 'L2 · C-Model (AVM 실측)', body);
  }

  // ── L3 Bridge ──────────────────────────────────────────────
  function secBridge(T) {
    if (!T.bridge || !T.bridge.length) return '';
    return sectionWrap('bridge', 'L3 · Spec ↔ Code + AV1→AV2 델타', SideBySide.render(T.bridge));
  }

  // ── L4 HW ──────────────────────────────────────────────────
  function secHW(T) {
    const h = T.hw; if (!h) return '';
    const guard = h.guardrail === false ? '' :
      '<div class="hw-guard">⚠️ <b>일반 HW 사고법</b> — 공개 spec·오픈소스 코드에서 도출 가능한 수준. ' +
      '특정 IP의 SRAM bit·대역폭 정량은 범위 밖.</div>';
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
    const items = [['spec','L1 Spec'],['code','L2 Code'],['bridge','L3 델타'],['hw','L4 HW'],['checks','확인']];
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

  return { page: page };
})();
