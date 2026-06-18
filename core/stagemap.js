/* stagemap.js — 6-스테이지 파이프라인 위젯 (랜딩 런처 + 앱바 미니맵)
   디코더 dataflow 순서: ENT → MIP → IQT → (Intra | Inter) → REC → LPF
   6 tool 앱: ent, mip, iqt, intra, inter, lpf  (REC는 intra/inter recon에 흡수) */
window.StageMap = (function () {
  const STAGES = [
    { id: 'ent',   hw: 'ENT',     label: 'Entropy Decoder',   short: 'Entropy',   ready: true,
      role: '비트스트림 심볼 복호 — 유일한 순차 병목' },
    { id: 'mip',   hw: 'MIP',     label: 'Partition & Mode',  short: 'Partition', ready: false,
      role: '분할 트리(SDP)·모드/MV 재구성 — 이웃 의존' },
    { id: 'iqt',   hw: 'IQT',     label: 'Transform & Quant', short: 'Tx/Quant',  ready: true,
      role: '역양자화 + 역변환 — 규칙적 datapath' },
    { id: 'intra', hw: 'PRD',     label: 'Intra Prediction',  short: 'Intra',     ready: false,
      role: '인트라 예측 — recon 피드백 의존' },
    { id: 'inter', hw: 'PRD·MEM', label: 'Inter Prediction',  short: 'Inter',     ready: false,
      role: '모션보상 — DRAM 대역폭 지배' },
    { id: 'lpf',   hw: 'LPF',     label: 'In-loop Filters',   short: 'In-loop',   ready: false,
      role: 'deblock→CDEF→CCSO→LR→GDF — 멀티패스 라인버퍼' },
  ];
  const byId = Object.fromEntries(STAGES.map(s => [s.id, s]));

  function has(id) { return !!byId[id]; }
  function label(id) { return byId[id] ? byId[id].label : id; }
  function get(id) { return byId[id]; }

  // 랜딩 페이지: 큰 런처 카드 (REC 패스스루 박스 포함, 화살표로 dataflow)
  function renderLauncher() {
    const cards = STAGES.map((s, i) => {
      const arrow = i > 0 ? '<span class="flow">▸</span>' : '';
      const cls = 'launch-card' + (s.ready ? '' : ' soon');
      const inner =
        '<div class="lc-hw">' + s.hw + '</div>' +
        '<div class="lc-label">' + s.label + '</div>' +
        '<div class="lc-role">' + s.role + '</div>' +
        '<div class="lc-status">' + (s.ready ? '심화 →' : '준비 중') + '</div>';
      const card = s.ready
        ? '<a class="' + cls + '" href="app.html?tool=' + s.id + '">' + inner + '</a>'
        : '<div class="' + cls + '">' + inner + '</div>';
      return arrow + card;
    }).join('');
    return '<div class="launcher-flow">' + cards + '</div>';
  }

  // 앱바 미니맵: 현재 tool 하이라이트 + 강결합(coupling) 표시
  function renderMini(currentId, coupling) {
    coupling = coupling || [];
    const couplingHw = new Set(coupling);
    const dots = STAGES.map(s => {
      let cls = 'sm-dot';
      if (s.id === currentId) cls += ' cur';
      else if (couplingHw.has(s.hw) || coupling.includes(s.id)) cls += ' coupled';
      const link = s.ready
        ? '<a class="' + cls + '" href="app.html?tool=' + s.id + '" title="' + s.label + '">' + s.short + '</a>'
        : '<span class="' + cls + ' soon" title="' + s.label + ' (준비 중)">' + s.short + '</span>';
      return link;
    }).join('<span class="sm-sep">›</span>');
    return '<nav class="stagemap-mini">' + dots + '</nav>';
  }

  return { STAGES: STAGES, has: has, label: label, get: get,
           renderLauncher: renderLauncher, renderMini: renderMini };
})();
