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
      '광류 LS 솔버(가변 블록)도 디코더 내 최소자승 — MHCCP/DIP 솔버/MAC와 **공용 연산유닛** 가능?',
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
        role: 'Per-ref predictor: WARP → warp_plane, TRANSLATION → highbd_inter_predictor → convolve.' },
      spec: { num: '7.13.3', title: 'Inter prediction process' },
      hw: { questions: [
        'Translation vs warp datapaths — separate units or a configurable convolver?',
        'High-bit-depth only (uint16) — datapath width.',
      ], derived: null } },
    { id: 'r2', n: 2, title: 'MC interpolation (12-tap)', stage: 'skeleton',
      fn: { name: 'av2_highbd_convolve_2d_facade', file: 'av2/common/convolve.c', line: 524,
        role: 'Separable subpel interpolation; AV2 adds a 12-tap sharp filter (AV1 max 8-tap).' },
      spec: { num: '7.13.3', title: 'Inter prediction process' },
      hw: { questions: [
        '12-tap → fetch window (bw+11)×(bh+11) vs 8-tap (bw+7)². Ref fetch tile and bandwidth?',
        'Separable H then V — intermediate buffer; MAC count per output pixel?',
      ], derived: null } },
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
      hw: { questions: [
        'Frame-level motion-field passes (project/fill/average) — serial preprocessing before block decode?',
        'tpl_mvs storage + projection arithmetic — memory and compute?',
      ], derived: null } },
    { id: 'r4', n: 4, title: 'TIP frame build', stage: 'skeleton',
      fn: { name: 'av2_setup_tip_frame', file: 'av2/common/tip.c', line: 949,
        role: 'Build an interpolated frame from 2 refs (compound average), per 8/16 unit block.' },
      spec: { num: '7.10', title: 'Setup TIP motion field process' },
      hw: { questions: [
        'TIP = an extra full-frame MC pass (2-ref compound) before normal decode. Bandwidth budget?',
        'On-the-fly vs cached TIP frame buffer — SRAM vs DRAM trade?',
      ], derived: null } },
    { id: 'r5', n: 5, title: 'DMVR (refineMV, 24-SAD)', stage: 'skeleton',
      fn: { name: 'apply_mv_refinement', file: 'av2/common/reconinter.c', line: 2711,
        role: 'Bilateral mirror-MV search: 24-neighbor SAD over ±2 grid; predict on extended (bw+4)×(bh+4).' },
      spec: { num: '7.13.3', title: 'Inter prediction process (DMVR)' },
      hw: { questions: [
        '24 SAD evals on offset windows → extra ref fetch (±2 padding). Fetch amplification?',
        'Symmetric +offset/−offset search — two ref reads per candidate. SAD array width?',
      ], derived: null } },
    { id: 'r6', n: 6, title: 'Optical-flow gradients', stage: 'skeleton',
      fn: { name: 'av2_bicubic_grad_interpolation_highbd', file: 'av2/common/reconinter.c', line: 854,
        role: 'Per-pixel spatial gradients (gx, gy) of the predictors for the optical-flow solve.' },
      spec: { num: '7.13.3', title: 'Inter prediction process (optical flow)' },
      hw: { questions: [
        'Per-pixel gradient interpolation — a second compute pass over the block.',
        'avg-pooling of gradients to cut solver size — accuracy vs cost.',
      ], derived: null } },
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
        note: 'Third decoder least-squares unit (after CfL-implicit and MHCCP): 5-sum covariance + a small solve. Followed by a **second MC pass** to rebuild the refined predictor.',
      },
      hw: { questions: [
        'Covariance accumulation (5 sums) + a small solve → another decoder LS unit. Share with MHCCP/CfL solvers?',
        'Regularization rls_alpha = f(block size) — fixed-point divide in calc_mv_process?',
        'Second predictor rebuild after refinement — extra MC pass.',
      ], derived: null } },
    { id: 'r8', n: 8, title: 'Flexible MV precision (7-level)', stage: 'skeleton',
      fn: { name: 'av2_read_pb_mv_precision', file: 'av2/decoder/decodemv.c', line: 2592,
        role: 'Per-block adaptive MV precision (8-pel..1/8-pel, 7 levels) vs AV1 2-level.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      hw: { questions: [
        '7-level precision → variable MV rounding/shift. Control overhead in the MV path?',
        'MPP-flag + down-context decode — small CDF reads per block.',
      ], derived: null } },
    { id: 'r9', n: 9, title: 'ref-MV bank', stage: 'skeleton',
      fn: { name: 'update_ref_mv_bank', file: 'av2/common/mvref_common.c', line: 4635,
        role: 'Ring-buffer MV candidate bank (rmb_buffer[9][4]) spanning SB boundaries; consumed by find_mv_refs.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      hw: { questions: [
        'Per-SB serial update of the bank → MV prediction depends on it. SB ordering constraint?',
        'rmb_buffer[9][4] + warp bank — on-chip state size and ports?',
      ], derived: null } },
    { id: 'r10', n: 10, title: 'HW synthesis (inter, MC bandwidth)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Put it together: MC dominates DRAM bandwidth; AV2 adds TIP/DMVR/optical-flow refinement passes.' },
      hw: { questions: [
        'Sum the added fetch: 12-tap window + TIP frame pass + DMVR ±2 windows. Total bandwidth vs AV1?',
        'Refinement chain (MC → DMVR → optical-flow → re-predict) — fuse into the MC pipe or separate passes?',
        'ref-MV bank serial update + TIP frame barrier — scheduling constraints.',
      ], derived: null } },
  ],
};
