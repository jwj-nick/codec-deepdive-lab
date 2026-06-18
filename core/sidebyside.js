/* sidebyside.js — Spec ↔ Code 2단 + AV1→AV2 델타
   입력: rows = [{ specLine, cLine, delta?, kind? }]
   kind: 'same' | 'changed' | 'new'  (델타 색상). 모바일에선 세로 스택. */
window.SideBySide = (function () {
  const KIND = { same: '동일', changed: '변경', new: '신규' };
  function render(rows) {
    if (!rows || !rows.length) return '';
    const body = rows.map(r => {
      const k = r.kind || (r.delta ? 'changed' : 'same');
      const badge = '<span class="sbs-badge ' + k + '">' + (KIND[k] || k) + '</span>';
      const delta = r.delta ? '<div class="sbs-delta">' + inl(r.delta) + '</div>' : '';
      return '<div class="sbs-row ' + k + '">' +
        '<div class="sbs-spec"><span class="sbs-lbl">spec</span>' + inl(r.specLine || '') + '</div>' +
        '<div class="sbs-code"><span class="sbs-lbl">code</span>' +
          '<code>' + esc(r.cLine || '') + '</code></div>' +
        '<div class="sbs-meta">' + badge + delta + '</div>' +
        '</div>';
    }).join('');
    return '<div class="sidebyside">' +
      '<div class="sbs-head"><span>규범(spec)</span><span>구현(AVM)</span><span>AV1→AV2</span></div>' +
      body + '</div>';
  }
  function inl(s) { return window.marked ? marked.parseInline(String(s)) : esc(s); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return { render: render };
})();
