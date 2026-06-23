/* tools/lr.js — In-loop filter 4/5: Loop Restoration (PC-Wiener + non-sep Wiener). AV2 신규 타입.
   실측: ~/work/avm. AV1 분리 Wiener+SGR → AV2 PC-Wiener(분류기+학습필터)·비분리 Wiener. */
window.TOOL = {
  id: 'lr',
  title: 'Loop Restoration — PC-Wiener (LPF 4/5)',
  stage: 'LPF',
  coupling: ['lpf', 'PRD'],
  role: '복원 손실 보정 필터. AV2는 AV1의 분리 Wiener+SGR를 **PC-Wiener**(픽셀 분류기 → 학습 필터뱅크)와 **비분리 Wiener**로 교체. ' +
    'GDF와 함께 LPF의 두 "분류→학습필터" 정수 블록. ▶ 전체 체인은 <a href="app.html?tool=lpf">LPF 허브</a>.',
  spec: {
    sections: [
      { num: '7.20', title: 'Loop restoration process',
        pseudo: 'stripe(64행) 단위. PC-Wiener: 픽셀 feature 양자화 → LUT → class → class별 학습 non-sep 필터. RESTORE_PC_WIENER / RESTORE_WIENER_NONSEP / RESTORE_SWITCHABLE.' },
    ],
  },
  chapters: [
    { id: 'lr1', n: 1, title: 'LR types & PC-Wiener', stage: 'skeleton',
      fn: { name: 'apply_pc_wiener_highbd', file: 'av2/common/restoration.c', line: 963,
        role: 'Per-pixel classify (feature→LUT→class) then apply a class-specific learned non-separable filter.' },
      spec: { num: '7.20', title: 'Loop restoration process' },
      io: {
        diagCaption: 'classify → select filter → conv',
        diagram: 'graph TD\n' +
          '  REC["rec pixels<br/>+ line buffer"] --> FEAT["feature quantize<br/>Σ thr·feat"]\n' +
          '  CLUT["class LUT"] --> CLS["class index"]\n' +
          '  FEAT --> CLS\n' +
          '  BANK["filter bank<br/>int16 learned non-sep"] --> SEL["select filter"]\n' +
          '  CLS --> SEL\n' +
          '  REC --> CONV["non-sep conv (MAC)"]\n' +
          '  SEL --> CONV\n' +
          '  CONV --> OUT["restored → GDF"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class REC mem;\n  class OUT mem;\n  class CLUT rom;\n  class BANK rom;\n  class FEAT op;\n  class CLS op;\n  class SEL op;\n  class CONV op;',
        in: [
          { sig: 'rec pixels', type: 'uint16', peer: '← CCSO out + line buffer', vol: 'tap window/px', note: 'feature classify input' },
          { sig: 'class_lut', type: 'PC_WIENER_LUT', peer: 'ROM', vol: 'feature → class', note: 'pc_wiener_lut_to_class_index' },
          { sig: 'filter_bank', type: 'int16 (non-sep taps)', peer: 'ROM', vol: 'per class', note: 'pcwiener_filters_luma' },
        ],
        out: [
          { sig: 'restored', type: 'uint16', peer: '→ GDF', vol: '1 / px', note: 'learned non-sep conv' },
        ],
        note: 'A classifier→learned-filter — NPU-adjacent. A feature-LUT front-end selects one of many learned filters per pixel. Pairs with GDF as the two LPF MAC blocks (each a **dedicated** module).',
      },
      qna: [
        { tag: 'delta', ref: 'restoration.h:665',
          q: 'AV2 LR 타입이 AV1과 어떻게 다른가? (AV2 델타)',
          a: 'AV1 = **분리 Wiener + SGR(self-guided)**. AV2 = `RESTORE_PC_WIENER`(픽셀분류 Wiener) + `RESTORE_WIENER_NONSEP`(비분리 Wiener) + `RESTORE_SWITCHABLE`. **AV1엔 PC-Wiener 전무**(grep 0건). 분리필터 → 분류기+학습 비분리필터로 진화.' },
        { tag: 'verified', ref: 'restoration.c:958',
          q: 'PC-Wiener 픽셀 분류는 어떻게? (실측)',
          a: 'feature 벡터 양자화(`qval = ROUND(feature + qval_lut[tskip][i], PC_WIENER_PREC_FEATURE)`) → `clip_pixel(qval) >> shift` → `lut_input = Σ pc_wiener_thresholds[i]·feature[i]` → `pc_wiener_lut_to_class_index[lut_input]` = **class index**. 즉 feature→가중합→LUT→클래스.' },
        { tag: 'verified', ref: 'restoration.c:990',
          q: '분류 후 필터 적용은? (실측)',
          a: '`apply_pc_wiener_highbd`이 class로 `pcwiener_filters_luma`(학습 int16 **비분리** 필터)를 골라 `NonsepFilterConfig`(대칭 탭, `num_sym_taps ≤ 24`)로 컨볼브. `classify_only`면 분류만(chroma는 luma class 재사용).' },
        { tag: 'hw', ref: 'restoration.c:963',
          q: 'PC-Wiener의 HW 형태는?',
          a: '**분류기 → 학습 필터뱅크** = 두 단: ① feature 추출+LUT(class 결정) ② class별 비대칭 탭 MAC 컨볼루션. stripe(64행) line buffer + class LUT ROM + 필터뱅크 ROM. GDF와 더불어 LPF의 정수 MAC 블록 — 단 **전용 LR 모듈**(스테이지 간 공유 불가).' },
        { tag: 'hw', ref: 'restoration.c:990',
          q: 'PC-Wiener와 GDF의 관계는?',
          a: '둘 다 "**분류 → 학습 정수필터**" 구조라 NPU 닮은 datapath. 차이: PC-Wiener는 **non-sep 탭 conv**(class별 계수), GDF는 **22입력×3 MAC + error-LUT activation**(퍼셉트론형). LPF 안에 정수 NN-블록 2개가 직렬로 존재. 각자 전용 모듈.' },
      ] },
  ],
};
