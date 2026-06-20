/* tools/lpf.js — In-loop Filters (LPF 스테이지)
   실측: ~/work/avm (AV2) · ~/work/aom (AV1). file:line 근거.
   ⭐ NPU 교집합: GDF(픽셀당 66 정수 MAC 학습 퍼셉트론)·PC-Wiener(분류기→학습필터)가 디코더 규범 경로 정수 연산. */
window.TOOL = {
  id: 'lpf',
  title: 'In-loop Filters',
  stage: 'LPF',
  coupling: ['PRD'],
  role: '복원 후 5-패스 필터: deblock→CDEF→CCSO→LR→GDF. AV2 신규 **CCSO·GDF**, LR은 PC-Wiener로 교체. ⭐**GDF=학습 정수 MAC 필터**(NPU 닮은 datapath).',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '7.17~7.20', title: 'In-loop filter chain',
        pseudo:
          '순서(코드 확인): **deblock(§7.17) → CDEF(§7.18) → CCSO(§7.19) → Loop Restoration(§7.20) → GDF**.\n\n' +
          '- 각 패스 = 프레임 전체 read-modify-write\n' +
          '- ⚠️ **GDF**: spec §7.20.5는 "Apply GDF"를 LR 하위로 묶지만, **레퍼런스 디코더는 LR 뒤 별도 패스로 실행**(`RESTORE_GDF` 타입 없음). spec↔코드 표현 차이.' },
      { num: '7.19', title: 'CCSO (Cross-Component Sample Offset)',
        pseudo: '동위치 **luma 에지 분류**(3 또는 2 레벨) + band → 작은 부호 오프셋 LUT 조회 → 출력 plane에 가산. luma가 chroma를 가이드.' },
      { num: '7.20.5', title: 'Apply GDF (Guided Detail Filter)',
        pseudo: '학습 weight/bias/alpha/error 테이블을 쓰는 **정수 퍼셉트론형 luma 필터**. 22 입력(18 복원샘플차+4 gradient)→클립→MAC→bias→정규화→3D error-LUT→복원에 가산. **bit-exact 정수**.' },
      { num: '7.20.1~4', title: 'Loop Restoration (PC-Wiener / Wiener-nonsep)',
        pseudo: 'AV2 LR = **PC-Wiener**(픽셀분류 4-feature→4096 LUT→256 클래스→64개 학습 13-tap 필터) + 비분리 Wiener. (AV1 분리Wiener+SGR 대체.)' },
    ],
    bitfields: [
      { name: 'In-loop 5-패스 체인 (순차 프레임 패스)',
        bits: [
          { f: 'deblock', w: null, d: '비대칭 가변폭 generic 필터(AV1 fixed 4/8/14 대체)', hl: true },
          { f: 'CDEF', w: null, d: '8방향 + 2-pass(pri/sec)' },
          { f: 'CCSO', w: null, d: 'luma-guided 오프셋 LUT(신규)', hl: true },
          { f: 'LR', w: null, d: 'PC-Wiener / 비분리 Wiener(신규 타입)', hl: true },
          { f: 'GDF', w: null, d: '학습 정수 MAC 필터(신규, 별도 패스)', hl: true },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  DB["av2_loop_filter_frame<br/>decodeframe.c:9923"] --> CD["av2_cdef_frame<br/>:9985"]\n' +
      '  CD --> CC["ccso_frame<br/>:9999"]\n' +
      '  CC --> LR["av2_loop_restoration_filter_frame<br/>:10026"]\n' +
      '  LR --> GD["av2_gdf_frame_dec → gdf_filter_frame<br/>:10037 / gdf.c:529"]\n' +
      '  GD --> INF["gdf_inference_unit (66 MAC/px)<br/>gdf_block.c:585"]\n' +
      '  GD --> CMP["gdf_compensation_unit<br/>gdf_block.c:553"]',
    funcs: [
      { file: 'av2/common/gdf_block.c', line: 668, name: 'gdf_inference_unit (MAC 코어)', lang: 'c',
        excerpt:
          '// k = 0..21 (22 입력: 18 복원샘플차 + 4 gradient)\n' +
          'inp_value = (s_pos_fwd[j] - rec_ptr[j]) << gdf_shift;      // 이웃차\n' +
          'gdf_inp = CLIP(inp_value, -alpha[cls_off], alpha[cls_off]); // 학습 클립\n' +
          'gdf_inp += CLIP((s_pos_bwd[j]-rec_ptr[j])<<gdf_shift, ...); // 대칭 bwd\n' +
          'for (idx = 0; idx < 3; idx++)                              // 3 누산기\n' +
          '  gdf_idx[j][idx] += gdf_inp * weight[cls_off + 22*4*idx]; // ⭐ 정수 MAC\n' +
          '// 마지막 입력 후: += bias → GDF_NORM_IDX → 3D error-LUT 조회\n' +
          'err_pnt[j] = (int16_t)*tb_ptr;   // 예측 잔차(activation LUT)',
        note: '⭐ **GDF = 픽셀당 22입력×3누산 = 66 정수 MAC** + per-입력 alpha 클립 + 3D error-LUT(int8). 학습 weight/bias ROM. **부동소수 없음, bit-exact.** = 디코더 속 NN-닮은 정수 퍼셉트론.' },
      { file: 'av2/common/gdf_block.h', line: 25, name: 'GDF 네트 config', lang: 'c',
        excerpt: '#define GDF_TRAIN_QP_NUM 6      // QP 6 버킷\n#define GDF_TRAIN_REFDST_NUM 5  // ref거리 5 버킷\n#define GDF_TRAIN_CLS_NUM 4     // 픽셀 클래스 4\n#define GDF_NET_INP_REC_NUM 18  // 복원샘플차 입력\n#define GDF_NET_INP_GRD_NUM 4   // gradient 입력\n#define GDF_NET_LUT_IDX_NUM 3   // 출력 누산기',
        note: '테이블 선택: intra/inter × QP(6) × ref거리(5) × 클래스(4). error-LUT = intra 16³·inter 10³ (int8). 작은 클래스화 퍼셉트론.' },
      { file: 'av2/common/ccso.c', line: 249, name: 'CCSO 오프셋 적용', lang: 'c',
        excerpt:
          'const int lut_idx_ext = (band_num << 4) + (src_cls[0] << 2) + src_cls[1];\n' +
          'const int offset_val = offset_buf[lut_idx_ext];\n' +
          'dst_yuv[...] = clamp(offset_val + dst_yuv[...], 0, max_val);',
        note: '동위치 luma 2-탭 에지분류(src_cls 3/2레벨) + band → `offset_buf` 조회 → dst 가산. LUT `int8 filter_offset[3][64*16]`. cross-component(chroma는 필터된 luma 의존).' },
      { file: 'av2/common/restoration.c', line: 940, name: 'PC-Wiener 분류→필터', lang: 'c',
        note: '픽셀분류: 4-feature 양자화 → `lut_input=Σ thr*feat` → 4096 LUT → 256 클래스 → 클래스별 **학습 int16 13-tap** 필터(`pcwiener_filters_luma`). 또 하나의 분류기→MAC(NPU 인접).' },
      { file: 'avm_dsp/loopfilter.c', line: 181, name: 'deblock generic', lang: 'c',
        note: 'AV2 deblock = `avm_highbd_lpf_*_generic`(가변 비대칭 탭폭 `filt_width_neg/pos`). AV1 fixed filter4/6/8/14 대체.' },
    ],
    structs: [
      { name: 'GDF 학습 테이블', file: 'av2/common/gdf_block.c', line: 68,
        fields: [
          { f: 'gdf_intra/inter_alpha_table (int16)', d: '입력/클래스별 클립 경계' },
          { f: 'gdf_intra/inter_weight_table (int16)', d: 'MAC 가중치 [QP][4*22*3]' },
          { f: 'gdf_intra/inter_bias_table (int32)', d: '누산 bias' },
          { f: 'gdf_intra/inter_error_table (int8)', d: '3D activation LUT(잔차)' },
        ],
        note: '전부 정수 ROM. 디코더에 학습 가중치 행렬이 들어옴 = NPU ROM 동형.' },
      { name: 'RestorationType', file: 'av2/common/enums.h', line: 1132,
        fields: [
          { f: 'RESTORE_NONE / SWITCHABLE', d: '' },
          { f: 'RESTORE_PC_WIENER', d: '픽셀분류 Wiener(신규)' },
          { f: 'RESTORE_WIENER_NONSEP', d: '비분리 Wiener(신규)' },
        ],
        note: '⚠️ `RESTORE_GDF` 없음 — GDF는 LR 타입이 아니라 별도 패스. AV1 분리Wiener+SGR 대체.' },
      { name: 'CCSO LUT / config', file: 'av2/common/av2_common_int.h', line: 247,
        fields: [
          { f: 'filter_offset[3][64*16] (int8)', d: '64 band × 16 edge-class × 3 plane' },
          { f: 'edge_clf[3] / max_band_log2[3]', d: 'plane별 분류 모드' },
        ] },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '체인 순서', cLine: 'decodeframe.c:9923→9985→9999→10026→10037',
      kind: 'changed', delta: 'AV1 deblock→CDEF→LR. AV2는 **CCSO·GDF 삽입** → deblock→CDEF→CCSO→LR→GDF.' },
    { specLine: '§7.17 deblock', cLine: 'avm_highbd_lpf_*_generic (loopfilter.c:181)',
      kind: 'changed', delta: 'AV1 fixed filter4/6/8/14 → AV2 **가변 비대칭 generic** + TIP deblock.' },
    { specLine: '§7.19 CCSO', cLine: 'ccso.c (apply_ccso_filter)',
      kind: 'new', delta: 'AV1 **CCSO 없음**(grep=0). luma-guided 오프셋 LUT.' },
    { specLine: '§7.20.5 GDF', cLine: 'gdf_block.c:585 (gdf_inference_unit)',
      kind: 'new', delta: 'AV1 **GDF 없음**(grep=0). 픽셀당 66 정수 MAC 학습 필터.' },
    { specLine: '§7.20 LR 타입', cLine: 'RESTORE_PC_WIENER/WIENER_NONSEP (enums.h:1132)',
      kind: 'changed', delta: 'AV1 분리Wiener+SGR → AV2 **PC-Wiener(분류기+학습필터)·비분리 Wiener**.' },
    { specLine: '§7.18 CDEF', cLine: 'av2_cdef_frame (cdef.c:479)',
      kind: 'same', delta: '8방향 구조 AV1과 동일. skip-txfm 시그널만 추가.' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  REC["recon luma"] --> G["22 inputs<br/>(fwd/bwd gather)"]\n' +
      '  G --> CLIP["learned alpha clip"]\n' +
      '  W["weight ROM"] --> MAC["66 int MAC<br/>(22×3 accum)"]\n' +
      '  CLIP --> MAC\n' +
      '  MAC --> NRM["+bias → normalize idx"]\n' +
      '  NRM --> LUT["3D error-LUT<br/>(int8)"]\n' +
      '  LUT --> ADD["residual comp → rec add"]\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
      '  class REC mem;\n  class W rom;\n  class LUT rom;\n' +
      '  class G op;\n  class CLIP op;\n  class NRM op;\n  class ADD op;\n  class MAC hot;',
    throughput:
      '체인 = **5 순차 프레임 패스**, 각 full-frame R-M-W. 비용 큰 둘: ⭐**GDF = 픽셀당 ~66 int MAC**(+클립+LUT) — luma 전 픽셀, ' +
      'PC-Wiener = 픽셀당 분류(4-feature→LUT) + 13-tap conv. CCSO/CDEF/deblock은 상대적으로 가벼움. ' +
      'GDF/PC-Wiener가 LPF throughput을 좌우(둘 다 SIMD-critical).',
    memory:
      '각 패스가 **라인버퍼** 대량 소비(경계 저장). GDF/PC-Wiener **학습 ROM**: GDF weight int16 [QP6×refdst5×(4×22×3)], error-LUT int8(intra 16³·inter 10³); PC-Wiener 64×13 int16 필터 + 4096 LUT. ' +
      'CCSO는 **패딩된 full-luma 평면**(`ext_rec_y`)을 SRAM에 둬야 함. CCSO·GDF는 필터된 luma를 읽음 → 단계 순서 강제.',
    hazard:
      '5 패스 **직렬**(앞 패스 출력이 뒷 패스 입력). cross-component: **CCSO·GDF가 luma 결과에 의존** → chroma/후단 직렬화. ' +
      'GDF는 LR 뒤 별도 패스라 LR 완료 후 시작. 각 패스 내부는 픽셀/타일 병렬이나 패스 간은 순차.',
    parallel:
      '타일·stripe 단위 병렬(패스 내부). 패스 간은 순차 사슬. GDF/PC-Wiener의 MAC는 내부 데이터 병렬(systolic/SIMD) 적합. ' +
      'GDF는 2×2 단위 클래스화 + per-pixel MAC → 클래스 공유로 MAC 재사용 가능.',
    av1delta:
      '- deblock: fixed → **가변 비대칭 generic**.\n' +
      '- **추가:** CCSO(luma-guided LUT), ⭐**GDF**(66 MAC/px 학습 정수필터 + error-LUT).\n' +
      '- LR: 분리Wiener+SGR → **PC-Wiener(분류기+학습필터)·비분리 Wiener**.\n' +
      '- 패스 수 3→5 → 라인버퍼·대역폭·직렬 깊이 증가.',
    openQ: [
      '⭐ GDF(66 MAC/px)·PC-Wiener(분류+13tap)는 **각자 전용 LPF 모듈**(IQT·intra의 MAC와 동시가동→스테이지 간 공유 불가). 핵심 = GDF가 전 luma 픽셀이라 **worst-case throughput을 정의** → 전용 MAC 어레이 사이징(MAC/clk, systolic vs time-mux). Nick 해자 영역.',
      'GDF는 LR 뒤 별도 full-frame 패스 → LR과 융합(fuse)해 라인버퍼/대역폭 절감 가능? spec은 LR 하위로 묶음.',
      '5 순차 패스의 라인버퍼 총량 예산 — 패스 융합/타일 파이프라이닝으로 어디까지 줄일까?',
      'GDF error-LUT(3D, int8)는 ROM 조회 = activation 대체. LUT vs 산술 activation의 면적/지연 트레이드.',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'GDF가 왜 Nick의 NPU 목표에 직접 닿는가?',
      a: '디코더 **규범 경로**에 학습 weight/bias/alpha ROM + **픽셀당 66 정수 MAC** + 3D error-LUT(activation 대체)로 동작하는 퍼셉트론형 필터가 실재. 부동소수 NN은 아니지만 MAC 어레이+가중치 ROM+LUT = NPU datapath 동형. DIP·MHCCP·PC-Wiener까지 더하면 디코더에 정수 NN-블록이 다수.',
      hint: 'gdf_inference_unit의 weight MAC + error-LUT.' },
    { q: 'CCSO의 "cross-component" 의존이 HW 순서에 주는 제약은?',
      a: 'CCSO는 동위치 **luma**를 분류해 chroma(및 luma) 출력에 오프셋 가산 → 필터된 luma가 준비돼야 진행. GDF도 luma 의존. 따라서 LPF 내 단계 순서가 강제되고 패딩된 full-luma 평면을 SRAM에 둬야 함.',
      hint: 'lut_idx가 luma edge class에서 나온다.' },
    { q: 'AV2 in-loop 체인이 AV1 대비 어떻게 무거워졌나?',
      a: '3패스(deblock→CDEF→LR)에서 **5패스**(+CCSO +GDF)로. LR도 분류기+학습필터(PC-Wiener)로 교체. 라인버퍼·대역폭·직렬 깊이 증가, GDF/PC-Wiener의 MAC 연산 추가.',
      hint: '체인 순서 표.' },
  ],
  quiz: [
    { q: 'GDF의 연산 성격은?',
      options: ['부동소수 CNN 추론', '학습 가중치 정수 MAC + error-LUT(bit-exact)', '단순 3x3 평균', 'FFT 기반'],
      answer: 1, why: 'gdf_inference_unit: int16 weight MAC(66/px) + int8 3D error-LUT. 부동소수 없음.' },
    { q: 'AV2 in-loop 필터 적용 순서는?',
      options: ['CDEF→deblock→LR', 'deblock→CDEF→CCSO→LR→GDF', 'GDF→deblock→CDEF', 'LR→CDEF→deblock'],
      answer: 1, why: 'decodeframe.c:9923→9985→9999→10026→10037.' },
    { q: 'AV2에서 AV1 대비 새로 추가된 in-loop 필터는?',
      options: ['deblock, CDEF', 'CCSO, GDF', 'SGR, 분리 Wiener', 'CDEF만'],
      answer: 1, why: 'CCSO(ccso.c)·GDF(gdf.c)는 AV1에 0. LR은 PC-Wiener로 교체.' },
    { q: 'AV2 Loop Restoration 타입은?',
      options: ['분리 Wiener + SGR', 'PC-Wiener + 비분리 Wiener', 'GDF만', 'CDEF 재사용'],
      answer: 1, why: 'RESTORE_PC_WIENER/WIENER_NONSEP. GDF는 LR 타입 아님(별도 패스).' },
  ],

  chapters: [
    { id: 'l1', n: 1, title: 'Filter chain order', stage: 'skeleton',
      fn: { name: 'in-loop filter sequence', file: 'av2/decoder/decodeframe.c', line: 9923,
        role: 'Apply order: deblock → CDEF → CCSO → Loop Restoration → GDF, each a full-frame read-modify-write pass.' },
      spec: { num: '7.17-7.20', title: 'In-loop filter chain' },
      hw: { questions: [
        '5 sequential passes — line-buffer + bandwidth per pass. Can any be fused?',
        'CCSO and GDF read luma after prior passes → cross-component ordering.',
      ], derived: null } },
    { id: 'l2', n: 2, title: 'Deblock (generic filter)', stage: 'skeleton',
      fn: { name: 'avm_highbd_lpf_*_generic', file: 'avm_dsp/loopfilter.c', line: 181,
        role: 'Parameterized asymmetric filter (runtime tap widths) replacing AV1 fixed filter4/6/8/14; plus TIP deblock.' },
      spec: { num: '7.17', title: 'Deblocking filter process' },
      hw: { questions: [
        'Runtime asymmetric tap width → pipeline must size for max width. Data-dependent control?',
        'Edge line buffers (vertical then horizontal passes) — sizing.',
      ], derived: null } },
    { id: 'l3', n: 3, title: 'CDEF (8-direction)', stage: 'skeleton',
      fn: { name: 'av2_cdef_frame', file: 'av2/common/cdef.c', line: 479,
        role: '64×64 FB: 8-direction variance search + 2-pass (primary + secondary) filtering.' },
      spec: { num: '7.18', title: 'CDEF process' },
      hw: { questions: [
        'Per-64×64 8-direction search + 2-pass filter — halo line/col buffers?',
        'Mostly unchanged from AV1 — reuse the AV1 CDEF block?',
      ], derived: null } },
    { id: 'l4', n: 4, title: '⭐ CCSO (cross-component offset)', stage: 'skeleton',
      fn: { name: 'apply_ccso_filter', file: 'av2/common/ccso.c', line: 249,
        role: 'Classify co-located luma edge (3/2 levels) + band → index a small int8 offset LUT → add to the output plane.' },
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
      hw: { questions: [
        'Needs a padded full-luma plane (ext_rec_y) in SRAM. Sizing and reuse?',
        'Per-pixel: 2 luma taps + classify + LUT add — cheap, but cross-component ordering forces chroma after luma.',
        'LUT filter_offset[3][64×16] int8 — small ROM/SRAM addressing.',
      ], derived: null } },
    { id: 'l5', n: 5, title: 'GDF table selection', stage: 'skeleton',
      fn: { name: 'gdf_get_qp_idx_base / ref_dst_idx', file: 'av2/common/gdf.c', line: 505,
        role: 'Select GDF weight/bias/error tables by intra/inter, QP bucket (6), ref-distance bucket (5).' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      hw: { questions: [
        'Table selection → ROM bank addressing (6 QP × 5 refdist × intra/inter). Bank-switch cost?',
        'Per-2×2 class id (4 classes) precompute — gradient/Laplacian classifier.',
      ], derived: null } },
    { id: 'l6', n: 6, title: '⭐⭐ GDF inference (66 MAC/px)', stage: 'skeleton',
      fn: { name: 'gdf_inference_unit', file: 'av2/common/gdf_block.c', line: 585,
        role: '22 inputs (18 sample-diffs + 4 gradients) → alpha-clip → 22×3 integer MACs → bias → normalize → 3D error-LUT.' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      io: {
        diagCaption: 'gather → clip → 66 MAC → LUT activation',
        diagram: 'graph TD\n' +
          '  REC["recon luma<br/>+ line buffer (fwd/bwd nbr)"] --> GTH["gather 22 inputs<br/>18 diff + 4 grad"]\n' +
          '  ALP["alpha ROM<br/>int16"] --> CLP["per-input clip"]\n' +
          '  GTH --> CLP\n' +
          '  WT["weight ROM<br/>int16 [QP6][refdst5][4·22·3]"] --> MAC["MAC array<br/>22×3 = 66 int MAC/px"]\n' +
          '  CLP --> MAC\n' +
          '  BIA["bias ROM int32"] --> NRM["+bias → GDF_NORM_IDX"]\n' +
          '  MAC --> NRM\n' +
          '  ELU["error-LUT int8<br/>3D (intra 16³ / inter 10³)"] --> ACT["LUT activation"]\n' +
          '  NRM --> ACT\n' +
          '  ACT --> OUT["err residual<br/>→ compensation (l7)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class REC mem;\n  class OUT mem;\n  class ALP rom;\n  class WT rom;\n  class BIA rom;\n  class ELU rom;\n' +
          '  class GTH op;\n  class CLP op;\n  class NRM op;\n  class ACT op;\n  class MAC hot;',
        in: [
          { sig: 'rec nbr (fwd/bwd)', type: 'uint16', peer: 'recon luma + line buffer', vol: '22 inputs/px', note: '18 sample-diff + 4 gradient' },
          { sig: 'weight', type: 'int16 [QP6][refdst5][4·22·3]', peer: 'weight ROM', vol: 'per (intra/inter,QP,refdst,class)', note: 'learned MAC weights' },
          { sig: 'alpha / bias', type: 'int16 / int32', peer: 'ROM', vol: 'per class/input', note: 'clip bounds + accum bias' },
          { sig: 'error_table', type: 'int8 3D (intra 16³ / inter 10³)', peer: 'ROM', vol: 'activation LUT', note: 'replaces arithmetic activation' },
        ],
        out: [
          { sig: 'err residual', type: 'int16', peer: '→ compensation (l7) → rec add', vol: '1 / luma px', note: '66 int MAC/px — the decoder-NPU datapath' },
        ],
        note: 'The flagship decoder-NPU block: **weight ROM → integer MAC array → LUT activation**, bit-exact, every luma pixel. Identical shape to DIP / MHCCP / IST — the strongest case for one shared MAC array.',
      },
      hw: { questions: [
        '66 int MACs/pixel (22×3) — systolic MAC array sizing for luma throughput?',
        'Weight ROM (int16) + 3D error-LUT (int8, intra 16³ / inter 10³) — total storage and read ports?',
        'Per-input alpha clip + fwd/bwd gather — the gather/clip front-end before the MAC.',
        'This is the closest thing to an NPU in the decoder — would a shared MAC array (with DIP/MHCCP/IST) serve all?',
      ], derived: null } },
    { id: 'l7', n: 7, title: 'GDF compensation', stage: 'skeleton',
      fn: { name: 'gdf_compensation_unit', file: 'av2/common/gdf_block.c', line: 553,
        role: 'Scale the error-LUT residual and add to the reconstructed sample with clip.' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      hw: { questions: [
        'Residual scale + clipped add — simple per-pixel back-end after inference.',
        'Reference-line setup (stripe-based) — line buffers for GDF?',
      ], derived: null } },
    { id: 'l8', n: 8, title: 'PC-Wiener (classify + learned filter)', stage: 'skeleton',
      fn: { name: 'pc_wiener classify + apply', file: 'av2/common/restoration.c', line: 940,
        role: 'Per-pixel 4-feature classify → 4096 LUT → 256 classes → one of 64 learned int16 13-tap filters.' },
      spec: { num: '7.20', title: 'Loop restoration process' },
      io: {
        diagCaption: 'classify → select filter → 13-tap conv',
        diagram: 'graph TD\n' +
          '  REC["rec pixels<br/>+ line buffer"] --> FEAT["4-feature quantize<br/>Σ thr·feat"]\n' +
          '  CLUT["class LUT<br/>4096 entries"] --> CLS["256 classes"]\n' +
          '  FEAT --> CLS\n' +
          '  BANK["filter bank<br/>int16 64 × 13-tap"] --> SEL["select 13-tap"]\n' +
          '  CLS --> SEL\n' +
          '  REC --> CONV["13-tap conv (MAC)"]\n' +
          '  SEL --> CONV\n' +
          '  CONV --> OUT["restored → GDF"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class REC mem;\n  class OUT mem;\n  class CLUT rom;\n  class BANK rom;\n  class FEAT op;\n  class CLS op;\n  class SEL op;\n  class CONV op;',
        in: [
          { sig: 'rec pixels', type: 'uint16', peer: '← CCSO out + line buffer', vol: '13-tap window/px', note: '4-feature classify input' },
          { sig: 'class_lut', type: '4096-entry', peer: 'ROM', vol: 'feature → class', note: '4-feature → 256 classes' },
          { sig: 'filter_bank', type: 'int16 64 × 13-tap', peer: 'ROM', vol: '64 filters', note: 'selected by class' },
        ],
        out: [
          { sig: 'restored', type: 'uint16', peer: '→ GDF', vol: '1 / px', note: '13-tap learned conv' },
        ],
        note: 'A second classifier→learned-filter (NPU-adjacent): a 4096-entry class LUT front-end feeding a 64×13-tap filter bank. Pairs with GDF as the two LPF MAC blocks.',
      },
      hw: { questions: [
        'Another classifier→learned-filter (NPU-adjacent). Feature line buffers + 13-tap conv MACs?',
        '64 filters × 13 taps int16 ROM + 4096-entry class LUT — storage.',
      ], derived: null } },
    { id: 'l9', n: 9, title: 'HW synthesis (LPF, line buffers)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Put it together: 5 sequential passes, heavy line buffers, two learned-filter MAC blocks (GDF, PC-Wiener).' },
      hw: { questions: [
        'Total line-buffer budget across 5 passes — fuse passes / tile-pipeline to reduce?',
        'GDF + PC-Wiener MACs — share with IQT/intra MAC array (decoder-NPU)?',
        'GDF runs as a separate pass after LR — fuse with LR to save a frame R-M-W?',
      ], derived: null } },
  ],
};
