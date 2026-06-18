/* codeblock.js — file:line 캡션 + hljs 코드 발췌
   입력: { file, line?, name?, lang?, excerpt, note? } */
window.CodeBlock = (function () {
  function render(c) {
    if (!c) return '';
    const loc = c.file + (c.line ? ':' + c.line : '');
    const lang = c.lang || 'c';
    const head = '<div class="cb-head">' +
      (c.name ? '<span class="cb-fn">' + esc(c.name) + '()</span>' : '') +
      '<span class="cb-loc">' + esc(loc) + '</span></div>';
    const code = c.excerpt
      ? '<pre class="cb-pre"><code class="language-' + lang + '">' + esc(c.excerpt) + '</code></pre>'
      : '';
    const note = c.note ? '<p class="cb-note">' + (window.marked ? marked.parseInline(c.note) : esc(c.note)) + '</p>' : '';
    return '<div class="codeblock">' + head + code + note + '</div>';
  }
  // 호출그래프 등 단순 인라인 코드 위치 배지
  function loc(file, line) {
    return '<code class="loc">' + esc(file + (line ? ':' + line : '')) + '</code>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return { render: render, loc: loc };
})();
