/* bitfield.js — syntax element 비트 레이아웃 뷰어
   입력: { name, total?, bits:[{f:'필드명', w:폭, d:'설명', hl?:true}] }
   - 폭(w)에 비례한 박스 + 필드명 + 비트수. 클릭/호버로 설명.
   - descriptor가 가변(uvlc/leb128 등)이면 w 생략 가능 → '~'로 표기. */
window.BitField = (function () {
  function render(bf) {
    if (!bf || !bf.bits) return '';
    const totalW = bf.bits.reduce((a, b) => a + (b.w || 1), 0);
    const cells = bf.bits.map((b, i) => {
      const w = b.w || 1;
      const pct = Math.max(8, Math.round((w / totalW) * 100));
      const wl = (b.w == null) ? '~' : (b.w + 'b');
      const hl = b.hl ? ' hl' : '';
      return '<div class="bf-cell' + hl + '" style="flex:' + pct + ' 1 0" ' +
             'data-desc="' + esc(b.d || '') + '">' +
             '<span class="bf-name">' + esc(b.f) + '</span>' +
             '<span class="bf-w">' + wl + '</span></div>';
    }).join('');
    const legend = bf.bits.map(b =>
      '<li><b>' + esc(b.f) + '</b> <span class="bf-lw">' + (b.w == null ? '가변' : b.w + ' bit') + '</span> — ' +
      esc(b.d || '') + '</li>').join('');
    return '<figure class="bitfield">' +
      (bf.name ? '<figcaption>' + esc(bf.name) + '</figcaption>' : '') +
      '<div class="bf-row">' + cells + '</div>' +
      '<ul class="bf-legend">' + legend + '</ul>' +
      '</figure>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  return { render: render };
})();
