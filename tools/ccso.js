/* tools/ccso.js — In-loop filter 3/5: CCSO (Cross-Component Sample Offset). AV2 신규.
   실측: ~/work/avm. luma 에지 분류 → int8 offset LUT → chroma/luma 가산. */
window.TOOL = {
  id: 'ccso',
  title: 'CCSO — cross-component offset (LPF 3/5)',
  stage: 'LPF',
  coupling: ['lpf', 'PRD'],
  role: '⭐ AV2 신규 — 동위치 **luma 에지를 분류**해 작은 부호 오프셋을 출력 plane(주로 chroma)에 가산. luma가 chroma를 가이드하는 cross-component 필터. ' +
    '▶ 전체 체인은 <a href="app.html?tool=lpf">LPF 허브</a>.',
  spec: {
    sections: [
      { num: '7.19', title: 'CCSO process',
        pseudo: '동위치 luma 2-탭 에지 분류(`src_cls`, 3/2레벨) + band offset(BO) → `(band<<4)+(cls0<<2)+cls1` LUT 조회 → 출력 plane에 오프셋 가산, clamp.' },
    ],
  },
  chapters: [
    { id: 'c1', n: 1, title: 'CCSO offset apply', stage: 'skeleton',
      fn: { name: 'apply_ccso_filter / ccso_filter_block', file: 'av2/common/ccso.c', line: 249,
        role: 'lut_idx = (band<<4)+(src_cls0<<2)+src_cls1 → offset_buf[idx] → clamp(offset + dst).' },
      spec: { num: '7.19', title: 'CCSO process' },
      io: {
        diagCaption: 'luma classify → LUT → add to chroma',
        diagram: 'graph TD\n' +
          '  LUMA["ext_rec_y<br/>padded luma plane (SRAM)"] --> CLS["edge classify<br/>2 taps → src_cls, band"]\n' +
          '  CLS --> IDX["lut_idx = band·16 + cls"]\n' +
          '  ROM["offset_buf int8<br/>[3][64×16]"] --> SEL["offset_val"]\n' +
          '  IDX --> SEL\n' +
          '  DST["dst plane (cdef out)"] --> ADD["+ offset, clamp"]\n' +
          '  SEL --> ADD\n' +
          '  ADD --> OUT["dst&#39; → LR"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class LUMA mem;\n  class DST mem;\n  class OUT mem;\n  class ROM rom;\n  class CLS op;\n  class IDX op;\n  class SEL op;\n  class ADD op;',
        in: [
          { sig: 'dst (cdef out)', type: 'uint16', peer: '← CDEF', vol: 'block', note: 'in-place RMW' },
          { sig: 'ext_rec_y', type: 'uint16 (padded luma)', peer: 'recon luma SRAM', vol: 'co-located, chroma-aligned', note: '2-tap edge classify — forces luma-before-chroma' },
          { sig: 'offset_buf', type: 'int8 filter_offset[3][64×16]', peer: 'ROM', vol: '64 band × 16 class × 3 plane', note: 'small LUT' },
        ],
        out: [
          { sig: "dst'", type: 'uint16 (offset added)', peer: '→ LR', vol: 'block', note: 'clamp to bitdepth' },
        ],
        note: 'Cheap arithmetic, but the **cross-component read of a padded full-luma plane** is the real HW cost: that plane must be resident in SRAM and luma must be filtered first.',
      },
      qna: [
        { tag: 'delta', ref: 'ccso.c:249',
          q: 'CCSO란 무엇인가? (AV2 신규)',
          a: '**Cross-Component Sample Offset** — 동위치 **luma의 국소 에지 패턴**을 분류해 작은 부호 오프셋을 골라 **출력 plane(주로 chroma)에 가산**. luma가 chroma를 가이드. **AV1엔 전무**(aom grep `ccso`=0건). CDEF/deblock과 달리 plane 간 결합.' },
        { tag: 'verified', ref: 'ccso.c:249',
          q: 'LUT 인덱싱의 실제 식은? (실측)',
          a: '`lut_idx_ext = (band_num<<4) + (src_cls[0]<<2) + src_cls[1]` → `offset_val = offset_buf[lut_idx_ext]` → `dst = clamp(offset_val + dst, 0, max)`. **band(BO) + 2개 edge class**로 64×16 LUT 한 칸 조회. 곱셈 없이 분류+조회+가산.' },
        { tag: 'verified', ref: 'ccso.c:296',
          q: 'edge class(src_cls)는 어떻게 만드나? (실측)',
          a: '`cal_filter_support(src_cls, &src_y[...], thr, neg_thr, src_loc, edge_clf)` — 중심 luma를 주변 위치(`src_loc`)와 `thr`/`neg_thr`로 비교해 **3-레벨(또는 2) 분류** 2개. lossless 세그먼트는 4×4 단위 처리(`*_4x4`). 즉 luma 기울기 부호 분류.' },
        { tag: 'hw', ref: 'ccso.c:262',
          q: 'CCSO의 진짜 HW 비용은?',
          a: '산술은 싸지만(분류+LUT+가산), **패딩된 full-luma 평면(`ext_rec_y`)을 SRAM에 상주**시켜야 하고 **luma가 먼저 필터돼야** chroma 진행 = cross-component 순서 강제. 이게 CCSO의 핵심 HW 부담 — 연산이 아니라 메모리·순서.' },
        { tag: 'hw', ref: 'ccso.c:249',
          q: 'CCSO offset LUT의 구성은?',
          a: '`offset_buf int8 [3][64×16]` = plane 3개 × band 64 × edge-class 16. 작은 ROM/SRAM. per-pixel 1 read + 1 add. **전용 CCSO 모듈**(다른 LPF 패스와 동시가동 → 공유 불가). worst-case는 luma 평면 대역폭.' },
      ] },
  ],
};
