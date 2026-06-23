/* tools/inter.js — Inter Prediction (PRD·MEM 스테이지)
   실측: ~/work/avm (AV2) · ~/work/aom (AV1). file:line 근거. */
window.TOOL = {
  id: 'inter',
  title: 'Inter Prediction',
  stage: 'PRD·MEM',
  coupling: ['MIP', 'IQT'],
  role: '모션보상 예측 — **DRAM 대역폭 지배** 스테이지. AV2는 **TIP·DMVR·광류 정제·7-레벨 MV정밀도·12-tap·refmvbank**로 fetch/연산 패스 대폭 증가.',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '7.13.3', title: 'Inter prediction process',
        pseudo:
          'MV로 참조프레임에서 보간 fetch. AV2 신규: **TIP**(보간 프레임), **DMVR/광류**(MV 디코더측 정제), ' +
          '7-레벨 적응 MV 정밀도, 12-tap sharp 필터, BAWP/CWP/JMVD 가중.' },
      { num: '7.9 / 7.10', title: 'Motion field estimation · Setup TIP',
        pseudo: '**TIP** = 저장된 motion field(tpl_mvs)를 투영 → 홀 채움 → 5-tap 평균 → 2참조 보간 프레임 생성. DMVR+광류 정제 포함.' },
      { num: '7.11 / 7.12', title: 'MV context · MV prediction',
        pseudo: 'MV 예측 후보 스택 + **ref-MV bank**(SB 넘는 링버퍼) + warp 후보(WRL). AV1 대비 후보 소스 확장.' },
      { num: '5.20.7', title: 'Motion vector and prediction structures (syntax)',
        pseudo: 'inter 모드/MV/정밀도/가중 신호. 7-레벨 정밀도는 MPP-flag + down-context로 신호.' },
    ],
    bitfields: [
      { name: 'inter 예측 파이프 (단계 시퀀스)',
        bits: [
          { f: 'MV predict', w: null, d: 'ref-MV bank + warp 후보(신규)', hl: true },
          { f: 'MC', w: null, d: '보간 fetch(8-tap, 신규 12-tap sharp)', hl: true },
          { f: 'DMVR', w: null, d: '24-이웃 SAD 대칭 정제(신규)', hl: true },
          { f: 'OptFlow', w: null, d: 'Lucas-Kanade LS 정제(신규)', hl: true },
          { f: 'compound', w: null, d: 'BAWP/CWP/JMVD 가중 결합' },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  B["av2_build_inter_predictors<br/>reconinter.c:3758"] --> M["av2_make_inter_predictor<br/>:130"]\n' +
      '  M -->|TRANSLATION| CV["convolve_2d_facade<br/>convolve.c:524"]\n' +
      '  M -->|WARP| W["av2_warp_plane"]\n' +
      '  B --> RV["apply_mv_refinement (DMVR)<br/>:2711"]\n' +
      '  B --> OF["av2_opfl_mv_refinement (광류)<br/>:1048"]\n' +
      '  TIP["av2_setup_tip_motion_field<br/>tip.c:243 (프레임당 1회)"] --> M',
    funcs: [
      { file: 'av2/common/reconinter.c', line: 1048, name: 'av2_opfl_mv_refinement', lang: 'c',
        excerpt:
          'void av2_opfl_mv_refinement(const int16_t *pdiff, ..., const int16_t *gx,\n' +
          '                            const int16_t *gy, ...) {\n' +
          '  int32_t su2=0, suv=0, sv2=0, suw=0, svw=0;\n' +
          '  for (i..bh) for (j..bw) {                // gradient 공분산 누적\n' +
          '    int u=gx[..], v=gy[..], w=pdiff[..];\n' +
          '    su2 += u*u; suv += u*v; sv2 += v*v;    // ∑gx², ∑gxgy, ∑gy²\n' +
          '    suw += u*w; svw += v*w;                // ∑gx·Δ, ∑gy·Δ\n' +
          '  }\n' +
          '  int rls_alpha = (bw*bh>>4)*OPFL_RLS_PARAM; // 정규화 LS\n' +
          '  calc_mv_process(su2,sv2,suv,suw,svw, ..., vx0,vy0,vx1,vy1);\n' +
          '}',
        note: '⭐ **광류 = 디코더측 Lucas-Kanade 최소자승.** gradient 공분산 누적 → 정규화 LS 해 → 1/16-pel 정제 MV. (MHCCP·DIP에 이은 또 하나의 디코더 LS/MAC.)' },
      { file: 'av2/common/reconinter.c', line: 2711, name: 'apply_mv_refinement (DMVR)', lang: 'c',
        note: 'refineMV = **24-이웃 SAD 대칭 탐색**(ref0 +offset / ref1 -offset 미러). 확장 (bw+4)×(bh+4) 블록에 예측 후 SAD. 추가 ref fetch.' },
      { file: 'av2/common/tip.c', line: 243, name: 'av2_setup_tip_motion_field', lang: 'c',
        note: 'TIP A상: tpl_mvs 투영(`get_mv_projection_clamp`) → 홀 4-이웃 전파 채움 → 5-tap MV 평균(나눗셈 없는 LUT). B상 `av2_setup_tip_frame`(tip.c:949)=2참조 compound 평균으로 프레임 생성, DMVR+광류 적용.' },
      { file: 'av2/common/reconinter.c', line: 130, name: 'av2_make_inter_predictor', lang: 'c',
        note: 'per-ref 예측 디스패치: WARP→`av2_warp_plane` / TRANSLATION→`highbd_inter_predictor`→convolve. hbd 전용(AV1 8bit 템플릿 제거).' },
      { file: 'av2/common/filter.h', line: 124, name: '12-tap sharp filter', lang: 'c',
        excerpt: 'DECLARE_ALIGNED(256, static const int16_t,\n                av2_sub_pel_filters_12sharp[SUBPEL_SHIFTS][12]) = {…};',
        note: 'AV2 신규 **12-tap**(MULTITAP_SHARP2). AV1 최대 8-tap → 보간 fetch 윈도우 (bw+11)×(bh+11)로 확대.' },
    ],
    structs: [
      { name: 'MvSubpelPrecision (7-레벨)', file: 'av2/common/mv.h', line: 75,
        fields: [
          { f: '8_PEL … ONE_EIGHTH_PEL (0..6)', d: '적응 MV 정밀도 7단계' },
          { f: 'pb_mv_precision / max_mv_precision', d: '블록별 정밀도(MB_MODE_INFO)' },
        ],
        note: 'AV1 2-레벨(low/high) → AV2 7-레벨. 블록마다 MPP-flag로 신호(decodemv.c:2592).' },
      { name: 'REF_MV_BANK', file: 'av2/common/blockd.h', line: 1787,
        fields: [
          { f: 'rmb_buffer[9][4]', d: '9 리스트 × 4 깊이 링버퍼' },
          { f: 'rmb_count / rmb_start_idx', d: '링버퍼 관리' },
        ],
        note: 'AV2 신규. SB 경계 넘는 MV 후보 은행(`enable_refmvbank`). 갱신=`update_ref_mv_bank`(SB당 직렬).' },
      { name: 'MB_MODE_INFO (inter)', file: 'av2/common/blockd.h', line: 430,
        fields: [
          { f: 'refinemv_flag / jmvd_scale_mode', d: 'DMVR·JMVD' },
          { f: 'bawp_flag / cwp_idx', d: 'BAWP·CWP 가중' },
          { f: 'pb_mv_precision', d: '적응 MV 정밀도' },
        ] },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '§7.13.3 보간 필터', cLine: 'av2_sub_pel_filters_12sharp (filter.h:124)',
      kind: 'changed', delta: 'AV1 최대 8-tap → AV2 **12-tap sharp 추가** → fetch 윈도우 확대.' },
    { specLine: 'MV 정밀도', cLine: 'MvSubpelPrecision 7-레벨 (mv.h:75)',
      kind: 'changed', delta: 'AV1 2-레벨(low/high) → AV2 **7-레벨 적응**.' },
    { specLine: '§7.10 TIP', cLine: 'tip.c (av2_setup_tip_frame)',
      kind: 'new', delta: 'AV1 **TIP 없음**(0). 보간 프레임 + 새 프레임 타입(TIP_FRAME).' },
    { specLine: '§7.13.3 MV 정제', cLine: 'apply_mv_refinement / av2_opfl_mv_refinement (:2711/:1048)',
      kind: 'new', delta: 'AV1 **DMVR·광류 없음**. 디코더측 SAD 정제 + LS 광류.' },
    { specLine: '§7.12 MV 예측', cLine: 'REF_MV_BANK + warp 후보 (blockd.h:1787)',
      kind: 'new', delta: 'AV1 ref-MV bank/WRL 없음. AV2 SB 넘는 MV 은행 추가.' },
    { specLine: 'inter 가중', cLine: 'BAWP/CWP/JMVD (reconinter.c)',
      kind: 'new', delta: 'AV1 없음. 블록적응/결합 가중 + 결합 MVD.' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  MVB["ref-MV bank"] --> MC["MC interpolation<br/>8 / 12-tap"]\n' +
      '  DRAM["ref frame<br/>(DRAM)"] --> MC\n' +
      '  TIP["TIP frame<br/>(separate MC pass)"] --> MC\n' +
      '  MC --> DMVR["DMVR<br/>24-SAD"]\n' +
      '  DMVR --> OF["optical-flow LS<br/>gradient + solve"]\n' +
      '  OF --> CP["compound<br/>BAWP / CWP"]\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
      '  class DRAM mem;\n  class TIP mem;\n  class MVB mem;\n' +
      '  class MC hot;\n  class DMVR op;\n  class OF hot;\n  class CP op;',
    throughput:
      '**MC가 DRAM 대역폭 지배.** AV2가 늘리는 비용: 12-tap fetch 윈도우 (bw+11)²(8-tap (bw+7)² 대비↑), ' +
      '**TIP = 프레임 전체 추가 MC 패스**(2참조 compound), **DMVR = 24 SAD 평가**(확장 윈도우 재fetch), ' +
      '**광류 = per-pixel gradient + per-block LS 솔버**(2차 예측 패스). 정제가 MC 뒤 직렬 패스로 추가.',
    memory:
      '12-tap·DMVR 확장윈도우(±2 라인)로 **ref fetch 타일 확대**. TIP 보간 프레임은 별도 프레임버퍼. ' +
      'ref-MV bank·warp bank = SB 경계 넘는 신규 on-chip 상태. 광류 gradient/pred 버퍼(`pdiff/gx/gy`).',
    hazard:
      'MV 예측이 **ref-MV bank 갱신에 SB당 직렬** 의존. **TIP 프레임은 이를 참조하는 블록보다 먼저 완성**돼야 함(프레임 레벨 배리어). ' +
      'DMVR→광류는 MC 결과에 순차 의존(정제 사슬). 광류 LS는 가변(블록크기) 연산.',
    parallel:
      '블록/서브블록 단위 MC 병렬(타일 간 무관). 단 ref-MV bank 갱신·TIP 프레임 생성은 직렬 구간. ' +
      'DMVR SAD·광류 gradient는 내부 데이터 병렬(SIMD) 적합.',
    av1delta:
      '- 보간 8-tap → **12-tap 추가**(fetch↑).\n' +
      '- MV 정밀도 2 → **7-레벨**.\n' +
      '- **추가:** TIP(추가 MC 패스), DMVR(24-SAD), 광류(gradient+LS 2차 패스), ref-MV bank, BAWP/CWP/JMVD.\n' +
      '- 8-tap separable convolution·warp 코어는 재사용.',
    openQ: [
      'TIP 추가 MC 패스가 대역폭을 키움 → TIP 프레임을 on-the-fly 생성 vs 프레임버퍼 캐시? 대역폭 vs SRAM.',
      'DMVR(24 SAD)+광류(gradient+LS)가 MC 뒤 직렬 정제 → 정제 유닛을 MC 파이프에 융합 vs 별도 패스?',
      '광류 LS 솔버 = inter 모듈 내 **전용** 소형 최소자승 유닛(MHCCP/CfL과 다른 스테이지라 공유 아님). 가변 블록크기 → 고정 파이프 vs 멀티사이클?',
      '12-tap·확장윈도우로 ref fetch 타일↑ → 프레임버퍼 압축(FBC)·캐시 재사용으로 대역폭 상쇄 전략?',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'AV2 inter가 AV1 대비 DRAM 대역폭을 키우는 요인 3가지?',
      a: '① 12-tap sharp 필터 → fetch 윈도우 (bw+11)²로 확대 ② TIP = 프레임 전체 추가 MC 패스(2참조) ③ DMVR 확장윈도우 + 24 SAD 재fetch. (+광류 2차 예측 패스.)',
      hint: 'fetch 윈도우·추가 패스 관점.' },
    { q: 'DMVR과 광류 정제가 HW 파이프에 만드는 구조는?',
      a: 'MC 예측 후 **직렬 정제 사슬**: DMVR(대칭 24-SAD 탐색)→광류(gradient+LS 솔버)→2차 예측 재구성. 각각 추가 fetch/연산. MC와 융합할지 별도 패스로 둘지가 설계 포인트.',
      hint: '예측→정제→재예측 순서.' },
    { q: 'ref-MV bank가 만드는 의존성은?',
      a: 'SB 경계를 넘는 MV 후보 링버퍼 → `update_ref_mv_bank`가 SB당 직렬 갱신. MV 예측이 이 은행 상태에 의존해 SB 순차성을 만든다.',
      hint: 'bank 갱신 시점.' },
  ],
  quiz: [
    { q: 'TIP(Temporal Interpolated Prediction)는?',
      options: ['새 엔트로피 코더', '2참조 보간으로 만든 프레임(+DMVR/광류)', '인트라 모드', '양자화 기법'],
      answer: 1, why: 'tpl_mvs 투영→홀채움→2참조 compound로 TIP 프레임 생성, DMVR+광류 정제.' },
    { q: 'AV2 MV 정밀도 레벨 수는?',
      options: ['2 (low/high)', '7 (8-pel..1/8-pel)', '4', '무한'],
      answer: 1, why: 'MvSubpelPrecision 0..6 = 7레벨(mv.h:75). AV1은 2레벨.' },
    { q: 'AV2가 추가한 보간 필터 길이는?',
      options: ['4-tap', '12-tap sharp', '16-tap', '변화 없음'],
      answer: 1, why: 'av2_sub_pel_filters_12sharp(filter.h:124). AV1 최대 8-tap.' },
    { q: '디코더측 광류(optical flow) 정제의 연산 성격은?',
      options: ['LUT 조회', 'gradient 공분산 + 최소자승 해', '단순 평균', 'DCT'],
      answer: 1, why: 'av2_opfl_mv_refinement: ∑gx²/gxgy/gy²/gxΔ/gyΔ → 정규화 LS(calc_mv_process).' },
  ],

  chapters: [
    { id: 'r1', n: 1, title: 'Inter predictor dispatch', stage: 'skeleton',
      fn: { name: 'av2_make_inter_predictor', file: 'av2/common/reconinter.c', line: 130,
        role: 'Per-ref predictor: WARP_PRED → av2_warp_plane, TRANSLATION_PRED → highbd_inter_predictor → convolve.' },
      spec: { num: '7.13.3', title: 'Inter prediction process' },
      qna: [
        { tag: 'common', ref: 'reconinter.c:139',
          q: 'make_inter_predictor의 기본 분기는? (AV1 공통)',
          a: '블록당 2-way: `WARP_PRED` → `av2_warp_plane`(affine/warped motion), `TRANSLATION_PRED` → `highbd_inter_predictor`(subpel MC → convolve r2). warp vs translation 분기 자체는 AV1에서 물려받음.' },
        { tag: 'common', ref: 'reconinter.c:131',
          q: 'compound(양방향)은 어디서? (AV1 공통)',
          a: '`conv_params.is_compound`이면 2 참조 예측을 dst 버퍼에 누적 후 블렌드(가중/거리). AV1 bi-pred 골격. 상위 dispatch가 OBMC/wedge/compound를 결정하고, 이 함수는 **단일 ref 예측 1개**를 생성.' },
        { tag: 'delta', ref: 'reconinter.c:165',
          q: 'AV2가 이 위에 얹은 것은? (AV2 델타)',
          a: 'wedge 경계 확장(`MAX_WEDGE_BOUNDARY_TYPES`·`WEDGE_ANGLES` cos/sin LUT), TIP/DMVR/optical-flow는 **상위 dispatch + 정제 패스**(r3~r7). make_inter_predictor 본체는 베이스 MC 엔진 — 정제는 호출 전후로 감싸짐.' },
        { tag: 'hw', ref: 'reconinter.c:139',
          q: 'warp vs translation의 HW 차이는?',
          a: 'translation = 블록단위 **정규 fetch + 분리형 subpel convolve**. warp = **픽셀별 affine 좌표** → 불규칙 subpel fetch(주소 생성 복잡, 대역폭·연산 더 큼). 둘 다 hbd(uint16) datapath. 보통 별도 유닛 또는 configurable convolver.' },
      ] },
    { id: 'r2', n: 2, title: 'MC interpolation (12-tap)', stage: 'skeleton',
      fn: { name: 'av2_highbd_convolve_2d_facade', file: 'av2/common/convolve.c', line: 524,
        role: 'Separable subpel interpolation (H→temp→V); facade routes scaled / compound / single. AV2 adds a 12-tap sharp filter.' },
      spec: { num: '7.13.3', title: 'Inter prediction process' },
      qna: [
        { tag: 'common', ref: 'convolve.c:524',
          q: 'subpel MC 보간의 공통 구조는? (AV1 공통)',
          a: '**분리형 2D**: 수평 보간 → 중간 temp 버퍼 → 수직 보간. facade가 `scaled`/`is_compound`/`single` 3경로로 분기. 기본 필터 **8-tap**(`SUBPEL_TAPS=8`, `highbd_*_scalar_product`). AV1 골격 그대로.' },
        { tag: 'delta', ref: 'filter.h:124',
          q: 'AV2의 12-tap이란? (AV2 델타)',
          a: '`av2_sub_pel_filters_12sharp[SUBPEL_SHIFTS][12]`(`MULTITAP_SHARP2`) = **12-tap sharp 보간필터** 추가. AV1은 최대 8-tap(`MAX_FILTER_TAP=8`). 더 날카로운 subpel 응답 → 고주파 보존.' },
        { tag: 'verified', ref: 'filter.h:251',
          q: '12-tap이 코드에서 어떻게 갈라지나? (실측)',
          a: '`if (filter_params->taps == 12 || taps == 2)` 별도 경로. 즉 필터 파라미터의 `taps`로 8 vs 12 vs 2(bilinear) 선택. 12-tap은 SUBPEL_SHIFTS개 위상 × 12계수 LUT.' },
        { tag: 'hw', ref: 'convolve.c:524',
          q: '12-tap의 fetch/대역폭 영향은?',
          a: '⭐ fetch window **(bw+11)×(bh+11)** (8-tap은 (bw+7)²) → 참조 fetch 타일·**DRAM 대역폭 증가**(작은 블록일수록 오버헤드 큼). 픽셀당 **12 MAC × 2패스**(H/V). MC가 inter 대역폭 지배의 핵심 — tap 증가가 직접 가중.' },
        { tag: 'hw', ref: 'convolve.c:573',
          q: 'separable 파이프의 중간버퍼는?',
          a: 'H 패스 → temp(`(bw)×(bh+taps−1)`, 최대 `WIENER_MAX_EXT_SIZE=263`행) → V 패스. 12-tap이면 세로 오버랩 +11행. compound면 두 ref 예측을 누적 버퍼에 합. 라인버퍼 = f(tap, 블록폭).' },
      ] },
    { id: 'r3', n: 3, title: '⭐ TIP motion-field setup', stage: 'skeleton',
      fn: { name: 'av2_setup_tip_motion_field', file: 'av2/common/tip.c', line: 243,
        role: 'Project stored tpl_mvs onto the TIP frame, fill holes (4-neighbor), 5-tap MV average.' },
      spec: { num: '7.10', title: 'Setup TIP motion field process' },
      io: {
        diagCaption: 'project → hole-fill → average (frame pre-pass)',
        diagram: 'graph TD\n' +
          '  TPL["tpl_mvs<br/>stored motion field (DRAM)"] --> PRJ["project<br/>get_mv_projection_clamp"]\n' +
          '  PRJ --> FILL["hole fill<br/>4-neighbor propagate"]\n' +
          '  FILL --> AVG["5-tap MV average<br/>(LUT, no divide)"]\n' +
          '  AVG --> OUT["TIP motion field<br/>→ frame build (r4)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class TPL mem;\n  class OUT mem;\n  class PRJ op;\n  class FILL op;\n  class AVG op;',
        in: [
          { sig: 'tpl_mvs', type: 'MV field (int16 x/y)', peer: 'motion-field storage (DRAM)', vol: 'per 8×8 grid / frame', note: 'projected by ref distance' },
          { sig: 'ref order/scale', type: 'int', peer: 'frame header', vol: 'few/frame', note: 'projection scale' },
        ],
        out: [
          { sig: 'tip_mf', type: 'MV grid', peer: '→ TIP frame build (r4)', vol: 'frame grid', note: 'project + hole-fill + 5-tap avg; frame-level pre-pass' },
        ],
        note: 'A **frame-level serial pre-pass** — must finish before any block that references the TIP frame decodes (frame barrier).',
      },
      qna: [
        { tag: 'delta', ref: 'tip.c:243',
          q: 'TIP란 무엇인가? (AV2 신규)',
          a: '**Temporal Interpolated Prediction** — 저장된 시간적 MV(`tpl_mvs`)를 투영해 **가상 참조 프레임의 motion field**를 만드는 AV2 도구. AV1 전무. r3=motion field 셋업, r4=그 field로 실제 프레임 보간.' },
        { tag: 'verified', ref: 'tip.c:247',
          q: 'motion-field 셋업 단계는? (실측)',
          a: '`tip_temporal_scale_motion_field`(ref 거리로 tpl_mvs 투영) → (hole_fill 허용시) `tip_fill_motion_field_holes`(이웃 전파) + `tip_blk_average_filter_mv`(블록 평균) → `av2_fill_tpl_mvs_sample_gap`. both-sides refs면 `use_optflow_tip=1`.' },
        { tag: 'delta', ref: 'tip.c:244',
          q: 'TIP 게이트 조건은? (AV2 신규)',
          a: 'KEY/INTRA/S 프레임은 disable. `tip_frame_mode` = DISABLED / AS_REF. 양쪽 ref가 있고 motion field 가용률이 임계(`TIP_ENABLE_COUNT_THRESHOLD`) 이상일 때만 활성. 즉 시간적 상관이 충분할 때만.' },
        { tag: 'hw', ref: 'tip.c:243',
          q: 'TIP setup이 만드는 HW 제약은?',
          a: '**frame-level 직렬 pre-pass** — TIP 프레임을 참조하는 어느 블록이든 디코드 전 motion field 전체가 완성돼야 함 = **frame barrier**. `tpl_mvs`는 DRAM motion-field 저장 → read. 블록 파이프 앞에 프레임 전처리 단이 추가됨.' },
        { tag: 'hw', ref: 'tip.c:248',
          q: 'project/fill/average의 연산 성격은?',
          a: 'project = ref 거리 스케일 곱(MV 격자 8×8 단위), hole-fill = 이웃 전파(반복), average = 블록 평균(LUT, divide 없음). 연산 자체는 가볍지만 **frame 전역** + DRAM tpl_mvs 트래픽이 핵심.' },
      ] },
    { id: 'r4', n: 4, title: 'TIP frame build', stage: 'skeleton',
      fn: { name: 'av2_setup_tip_frame', file: 'av2/common/tip.c', line: 949,
        role: 'Build an interpolated frame from the TIP motion field — per 8×8+ unit, 2-ref compound (+optional optical-flow).' },
      spec: { num: '7.10', title: 'Setup TIP motion field process' },
      qna: [
        { tag: 'delta', ref: 'tip.c:949',
          q: 'TIP frame build이 하는 일은? (AV2 신규)',
          a: 'r3에서 만든 motion field로 **전체 프레임을 MC 보간**해 가상 참조 프레임을 생성. `tip_setup_tip_frame_planes`가 plane별·**8×8(이상) 단위블록**마다 `tip_build_inter_predictors_8x8`로 채움. AV1 전무.' },
        { tag: 'verified', ref: 'tip.c:718',
          q: '단위블록 예측의 실제 구성은? (실측)',
          a: '`tip_weight != TIP_SINGLE_WTD`면 **2-ref compound 평균**(ref0+ref1, `for ref < 1+is_compound`). `use_optflow_tip`이면 optical-flow 정제까지(tip.c:648). 즉 TIP 블록 = 양방향 MC + 선택적 광류.' },
        { tag: 'hw', ref: 'tip.c:949',
          q: 'TIP frame의 대역폭 비용은?',
          a: '⭐ **정상 디코드 전 full-frame MC 패스 1장**(2-ref compound) 추가 → DRAM 대역폭에 프레임 1장분 모션보상이 더해짐. inter가 대역폭 지배인데 TIP가 이를 크게 키우는 최대 항.' },
        { tag: 'hw', ref: 'tip.c:949',
          q: 'TIP frame 버퍼는 SRAM/DRAM?',
          a: '한 번 만든 TIP 프레임은 일반 블록이 **참조로 재사용** → on-the-fly(참조 영역만 즉석 생성, 재계산↑) vs 통째로 캐시(SRAM 부족→DRAM 저장, 대역폭↑) trade. 프레임 크기라 보통 DRAM 저장 + 블록 fetch.' },
      ] },
    { id: 'r5', n: 5, title: 'DMVR (refineMV, 24-SAD)', stage: 'skeleton',
      fn: { name: 'apply_mv_refinement', file: 'av2/common/reconinter.c', line: 2711,
        role: 'Decoder-side bilateral MV refinement: ±2-pel search, mirror offsets, min-SAD between the two ref predictions (BILINEAR search).' },
      spec: { num: '7.13.3', title: 'Inter prediction process (DMVR)' },
      qna: [
        { tag: 'delta', ref: 'reconinter.c:2711',
          q: 'DMVR이란? (AV2 신규)',
          a: '**Decoder-side Motion Vector Refinement** — 전송된 MV를 디코더가 **양방향(bilateral) 탐색**으로 정제(추가 비트 0). 인코더·디코더가 같은 규칙으로 정제하므로 비트 절감. **AV1 전무**(VVC식 도구).' },
        { tag: 'verified', ref: 'reconinter.c:2727',
          q: 'DMVR 탐색의 실제 파라미터는? (실측)',
          a: '`max_sr=2`(±2 pel 탐색범위), `mv[0]`/`mv[1]` 두 ref를 **대칭 정제**. 탐색 예측은 **BILINEAR**(저비용), 블록을 `SUBBLK_REF_EXT_LINES`만큼 확장. MV가 범위 벗어나면 정제 skip.' },
        { tag: 'delta', ref: 'reconinter.c:2752',
          q: 'bilateral matching의 원리는? (AV2 신규)',
          a: 'ref0를 `+offset`, ref1을 `−offset`(mirror) 한 쌍의 예측 간 **SAD를 최소화**하는 offset 선택(±2 격자 ≈24 후보). 양방향 모션이 대칭이라는 가정 → 신호 없이 더 정확한 MV.' },
        { tag: 'hw', ref: 'reconinter.c:2741',
          q: 'DMVR의 fetch 증폭은?',
          a: '후보마다 두 ref 예측 → ±2 패딩으로 **(bw+4)×(bh+4) fetch window**, 블록당 ~24 SAD. 탐색은 bilinear라 연산은 싸지만 **참조 fetch가 크게 증가**. 본 MC가 같은 window를 쓰면 fetch 재사용으로 절감.' },
        { tag: 'hw', ref: 'reconinter.c:2711',
          q: 'DMVR이 만드는 직렬성은?',
          a: '정제 MV가 확정돼야 본 MC 진행 → **predict(탐색)→refine→re-predict** 직렬 체인. SAD 어레이(±2×±2) + 두 ref 예측 버퍼. optical-flow(r6/r7)와 함께 MC 뒤에 붙는 정제 단.' },
      ] },
    { id: 'r6', n: 6, title: 'Optical-flow gradients', stage: 'skeleton',
      fn: { name: 'av2_bicubic_grad_interpolation_highbd', file: 'av2/common/reconinter.c', line: 854,
        role: 'Per-pixel bicubic spatial gradients (gx, gy) of the predictor — input to the optical-flow solve.' },
      spec: { num: '7.13.3', title: 'Inter prediction process (optical flow)' },
      qna: [
        { tag: 'delta', ref: 'reconinter.c:854',
          q: 'optical-flow gradient는 무엇을 계산하나? (AV2 신규)',
          a: '예측 픽셀의 **공간 gradient `gx,gy`**를 bicubic으로 계산 → optical-flow(BDOF류) solver(r7)의 입력. AV1 전무. compound 양방향 예측에서 모션 미세조정을 위한 영상 기울기.' },
        { tag: 'verified', ref: 'reconinter.c:868',
          q: 'bicubic gradient 식은? (실측)',
          a: '중앙차분 가중: `gx = c0·(P[j+1]−P[j−1]) + c1·(P[j+2]−P[j−2])` (`coeffs_bicubic`), round/clamp(`OPFL_GRAD_CLAMP_VAL`). gy도 세로 동일. 경계는 인덱스 clamp. 즉 4-tap bicubic 미분 커널.' },
        { tag: 'hw', ref: 'reconinter.c:856',
          q: 'gradient 패스의 HW 비용은?',
          a: '예측 블록에 대한 **2차 compute 패스**(픽셀당 gx·gy 각 4-tap). MC로 예측 만든 뒤 그 위를 다시 훑음. 라인버퍼 ±2 오버랩. solver(r7) 앞단의 전처리 — feed-forward.' },
        { tag: 'hw', ref: 'reconinter.c:854',
          q: 'gradient를 줄이는 방법은?',
          a: 'subblock 단위(8×8/nxn)로 gradient를 모아 solver 입력을 줄임 → 정확도 vs 연산/버퍼 trade. gradient는 int16 클램프라 datapath 좁음. r6→r7은 gradient→covariance 누적으로 직결.' },
      ] },
    { id: 'r7', n: 7, title: '⭐ Optical-flow LS solver', stage: 'skeleton',
      fn: { name: 'av2_opfl_mv_refinement', file: 'av2/common/reconinter.c', line: 1048,
        role: 'Accumulate gradient covariance (∑gx², ∑gxgy, ∑gy², ∑gxΔ, ∑gyΔ) → regularized least-squares MV at 1/16-pel.' },
      spec: { num: '7.13.3', title: 'Inter prediction process (optical flow)' },
      io: {
        diagCaption: 'accumulate 5 sums → regularized LS',
        diagram: 'graph TD\n' +
          '  GX["gx, gy<br/>int16 gradients (r6)"] --> ACC["covariance accumulate<br/>∑gx² ∑gxgy ∑gy² ∑gxΔ ∑gyΔ"]\n' +
          '  PD["pdiff Δ<br/>int16 (ref0−ref1)"] --> ACC\n' +
          '  ACC --> SOL["regularized LS solve<br/>calc_mv_process (divide)"]\n' +
          '  SOL --> MV["refined MV 1/16-pel<br/>→ re-predict (MC)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class GX mem;\n  class PD mem;\n  class MV mem;\n  class ACC op;\n  class SOL hot;',
        in: [
          { sig: 'gx, gy', type: 'int16[bw×bh]', peer: 'gradient buffer (r6)', vol: 'block', note: 'spatial gradients of predictors' },
          { sig: 'pdiff (Δ)', type: 'int16[bw×bh]', peer: 'pred-diff buffer', vol: 'block', note: 'ref0 − ref1 prediction' },
        ],
        out: [
          { sig: 'vx0/vy0/vx1/vy1', type: 'int (1/16-pel)', peer: '→ re-predict (MC pass)', vol: 'per block/subblock', note: 'regularized LS; rls_alpha = f(block size)' },
        ],
        note: 'The third decoder least-squares unit (after CfL-implicit and MHCCP): 5-sum covariance + a small 2×2 solve. Followed by a **second MC pass** to rebuild the refined predictor. The three LS units share a *design pattern* (accumulate → solve), not silicon — each is a dedicated per-stage module.',
      },
      qna: [
        { tag: 'delta', ref: 'reconinter.c:1048',
          q: 'optical-flow MV refinement이란? (AV2 신규)',
          a: 'BDOF류 — compound 양방향 예측의 **gradient와 예측차(Δ)로 MV를 미세 정제**(픽셀/서브블록 단위, 1/16-pel). `av2_opfl_mv_refinement`. AV1 전무. DMVR(블록 ±2)보다 더 정밀한 sub-pel 보정.' },
        { tag: 'verified', ref: 'reconinter.c:1062',
          q: '5개 covariance 합은? (실측)',
          a: 'block(bw×bh)에서 `u=gx, v=gy, w=Δ(pdiff)`로: `su2=Σu²`, `suv=Σuv`, `sv2=Σv²`, `suw=Σuw`, `svw=Σvw`. = **2×2 정규방정식**의 행렬·우변(gradient 공분산 + gradient·잔차).' },
        { tag: 'verified', ref: 'reconinter.c:1075',
          q: 'solve와 정규화는? (실측)',
          a: '`rls_alpha=(bw·bh>>4)·OPFL_RLS_PARAM`(블록크기 비례 **정규화**) → `calc_mv_process(su2,sv2,suv,suw,svw,…,rls_alpha,…)`가 2×2 regularized LS를 풀어 `vx0/vy0/vx1/vy1` 산출. nxn으로 subblock 분할.' },
        { tag: 'hw', ref: 'reconinter.c:1062',
          q: 'optical-flow solver의 HW 형태와 모듈성은?',
          a: '디코더의 **세 번째 LS 유닛**(CfL-implicit·MHCCP 다음): 5-sum 공분산(곱-누적) + 2×2 solve(divide). ⚠️ 셋은 **동일 설계패턴(accumulate→solve)**일 뿐 **전용 모듈**(streaming 동시가동→솔버 실리콘 공유 불가). 스킬 전이지 공유 어레이 아님.' },
        { tag: 'hw', ref: 'reconinter.c:1048',
          q: '정제 후 비용은?',
          a: 'refined MV로 **2차 MC 패스**(예측 재생성) 필요 → gradient(r6)→5-sum→solve→re-predict 직렬 체인. solver 자체는 작지만 앞의 gradient 패스 + 뒤의 재예측 MC가 대역폭/지연을 더함.' },
      ] },
    { id: 'r8', n: 8, title: 'Flexible MV precision (7-level)', stage: 'skeleton',
      fn: { name: 'av2_read_pb_mv_precision', file: 'av2/decoder/decodemv.c', line: 2592,
        role: 'Per-block adaptive MV precision: 7 levels (8-pel..1/8-pel) via mpp_flag + down symbol, vs AV1 single high-precision flag.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'delta', ref: 'mv.h:75',
          q: 'AV2 MV 정밀도 레벨은? (AV2 신규)',
          a: '**7 레벨**: `MV_PRECISION_8_PEL`(0)·4-pel·2-pel·1-pel·HALF·QTR·`ONE_EIGHTH_PEL`(6) (`NUM_MV_PRECISIONS=7`). AV1은 사실상 `allow_high_precision_mv` **단일 플래그**(¼ vs ⅛) + integer-MV. AV2는 **per-block 적응 정밀도**.' },
        { tag: 'verified', ref: 'decodemv.c:2608',
          q: 'precision을 어떻게 파싱하나? (실측)',
          a: '`mpp_flag`(most-probable-precision) 먼저 읽고, set이면 `most_probable_pb_mv_precision` 사용. 아니면 `down` 심볼(`pb_mv_precision_cdf[down_ctx][max−HALF]`) 읽어 `av2_get_precision_from_index`. precision set `av2_mv_precision_sets[mb_precision_set]`.' },
        { tag: 'hw', ref: 'decodemv.c:2592',
          q: '7-level이 MV path에 주는 영향은?',
          a: '정밀도별 **가변 MV 라운딩/shift** → MV 재구성 datapath에 레벨 의존 시프트 로직. 블록마다 mpp_flag + down 컨텍스트 CDF read(작음). 정밀도가 subpel 보간 위상(r2 filter phase) 선택까지 연결.' },
        { tag: 'hw', ref: 'decodemv.c:2600',
          q: '정밀도 컨텍스트 비용은?',
          a: '`down_ctx`·`mpp_flag_context` 유도(이웃/SB 상태 의존) → 엔트로피 CDF 뱅크가 정밀도 레벨만큼 확장(`pb_mv_precision_cdf[ctx][level]`). 연산은 가볍지만 MV 파싱 경로에 분기·LUT가 늘어남.' },
      ] },
    { id: 'r9', n: 9, title: 'ref-MV bank', stage: 'skeleton',
      fn: { name: 'update_ref_mv_bank', file: 'av2/common/mvref_common.c', line: 4635,
        role: 'LRU ring-buffer of recently-used MV candidates per ref list, persisting across SB boundaries; consumed by find_mv_refs.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'delta', ref: 'mvref_common.c:4635',
          q: 'ref-MV bank이란? (AV2 신규)',
          a: '최근 사용된 MV 후보를 ref_frame 리스트별 **ring buffer**(`rmb_buffer[list][REF_MV_BANK_SIZE]`)에 누적해 **SB 경계를 넘어 유지**하는 영속적 MV 메모리. `find_mv_refs`가 예측 후보로 소비. AV1은 spatial/temporal 후보만(영속 bank 없음).' },
        { tag: 'verified', ref: 'mvref_common.c:4668',
          q: 'bank 갱신 규칙은? (실측)',
          a: '현재 MV가 buffer에 **이미 있으면 끝(most-recent)으로 이동**(LRU), 없으면 append(가장 오래된 것 밀어냄). `rmb_list_index=get_rmb_list_index(ref_frame)`로 리스트 선택. hit 한도(`MAX_RMB_SB_HITS`)로 갱신량 제한.' },
        { tag: 'hw', ref: 'mvref_common.c:4635',
          q: 'ref-MV bank의 HW 직렬성은?',
          a: '**per-block 직렬 갱신** → MV 예측이 bank 상태에 의존 → 블록(및 SB) 처리 **순차 제약**(엔트로피 체인과 유사한 carried state). MV 디코드가 bank read↔update에 묶임.' },
        { tag: 'hw', ref: 'mvref_common.c:4659',
          q: 'bank의 on-chip 비용은?',
          a: 'ring buffer state(`rmb_buffer[list][size]` CANDIDATE_MV + ref_frame 태그 + warp bank) = on-chip SRAM/레지스터. LRU 이동(검색+shift)·append를 위해 **다중 포트** 필요. SB 단위로 유지되므로 line/SB 버퍼 예산에 포함.' },
      ] },
    { id: 'r10', n: 10, title: 'HW synthesis (inter, MC bandwidth)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Tie it together: MC dominates DRAM bandwidth; AV2 stacks TIP frame pass + DMVR + optical-flow refinement; serial = TIP barrier + ref-MV bank.' },
      figures: [
        { title: 'Inter datapath — bandwidth + refinement chain',
          mermaid:
'graph TD\n' +
'  TPL["tpl_mvs (DRAM)"] --> TIP["TIP frame pre-pass<br/>(full-frame MC, barrier)"]\n' +
'  REF["reference frames<br/>(DRAM) + TIP frame"] --> MC["MC fetch + convolve<br/>8/12-tap subpel"]\n' +
'  TIP --> REF\n' +
'  BANK["ref-MV bank<br/>(LRU, per-block serial)"] --> MV["MV reconstruct<br/>7-level precision"]\n' +
'  MV --> MC\n' +
'  MC --> DMVR["DMVR ±2 SAD<br/>(bilateral)"]\n' +
'  DMVR --> OPFL["optical-flow<br/>grad → 2×2 LS"]\n' +
'  OPFL --> RE["re-predict (2nd MC)"]\n' +
'  RE --> ADD["+ residual (IQT) → recon"]\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
'  class TPL mem;\n  class REF mem;\n  class BANK mem;\n' +
'  class TIP hot;\n  class MC hot;\n  class DMVR op;\n  class OPFL op;\n  class MV op;\n  class RE op;\n  class ADD op;',
          caption: 'Red = the DRAM-bandwidth-dominant / frame-barrier nodes. AV2 stacks TIP (an extra full-frame MC), 12-tap windows, and DMVR/optical-flow re-prediction on top of the AV1 MC — bandwidth, not compute, is the inter ceiling.' },
      ],
      qna: [
        { tag: 'hw',
          q: 'inter가 대역폭 지배인 이유와 AV2 추가분은?',
          a: 'inter는 **MC 참조 fetch가 DRAM 대역폭 지배**. AV2가 더한 fetch: **12-tap window**(8-tap 대비 넓음, r2) + **TIP full-frame MC 패스**(r4) + **DMVR ±2 window**(r5) + 정제용 2차 MC(r7). 연산보다 **메모리가 천장**.' },
        { tag: 'hw',
          q: '정제 체인의 구조는?',
          a: 'MC → **DMVR**(±2 bilateral SAD) → **optical-flow**(gradient→2×2 LS) → **re-predict**(2차 MC) → 잔차가산. 직렬 단계가 쌓임. MC 파이프에 fuse(window 재사용)할지 별도 패스로 둘지가 핵심 설계 결정.' },
        { tag: 'hw',
          q: 'inter의 직렬/순차 제약은?',
          a: '①**TIP frame barrier**(r3 — 프레임 전처리 완료 후 블록 디코드) ②**ref-MV bank** per-block LRU(r9 — MV 예측 carried state) ③정제 체인(r5/r7). intra의 recon-feedback 이웃의존은 **없지만**(참조프레임 사용), 메모리/정제 의존이 그 자리를 채움.' },
        { tag: 'hw',
          q: 'inter의 연산 블록(전용 모듈)은?',
          a: 'warp/translation **MC 엔진**(convolve) + DMVR **SAD 어레이** + optical-flow **LS 솔버**(세 번째 디코더 LS, CfL/MHCCP와 동일 *설계패턴*·전용 모듈) + TIP **frame MC**. 각 파이프 단 전용 — streaming 동시가동이라 공유 불가.' },
        { tag: 'delta',
          q: 'AV1 대비 inter 추가 총정리는? (델타)',
          a: '**추가:** TIP(가상참조 프레임)·DMVR(디코더 MV정제)·optical-flow(BDOF)·7-level MV정밀도·12-tap sharp·ref-MV bank. **재사용:** translation/warp MC·compound·8-tap subpel·spatial/temporal MV 후보는 AV1 그대로.' },
        { tag: 'hw',
          q: '【recon 공유부 → 별도 recon 페이지 참조】',
          a: '**forward-pointer:** predict(inter, 여기) → IQT(dequant→CCTX→IST→2D) → clip-add → 다음 블록 = **intra와 공통 골격**(`decode_reconstruct_tx`, decodeframe.c:450). ▶ 공유 재구성 루프는 **`app.html?tool=recon`**(RECON 페이지)에 정리됨. inter 고유 = MC 대역폭 + 정제 체인 + 참조프레임(이웃 의존 없음 → intra보다 블록 병렬 자유, 대신 메모리 지배).' },
      ] },
  ],
};
