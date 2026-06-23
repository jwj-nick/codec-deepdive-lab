/* tools/intra.js — Intra Prediction (PRD-intra 스테이지)
   실측: ~/work/avm (AV2) · ~/work/aom (AV1). file:line 근거.
   ⭐ NPU 교집합: DIP(행렬 인트라)·MHCCP(최소자승+가우스소거)가 디코더 규범 경로의 정수 MAC/행렬 커널. */
window.TOOL = {
  id: 'intra',
  title: 'Intra Prediction',
  stage: 'PRD',
  coupling: ['MIP', 'IQT'],
  role: '복원된 이웃으로 인트라 예측. AV2는 **DIP(행렬 인트라)·MHCCP·암시 CfL·MRL/IBP** 추가 — ⭐디코더에 정수 MAC/행렬 솔버 datapath가 실재(NPU 교집합).',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '7.13.2', title: 'Intra prediction process',
        pseudo:
          '기본 13 모드(DC/V/H/방향8/SMOOTH/PAETH)는 **AV1과 동일**. 신규는 그 위에 얹힘:\n\n' +
          '- **DIP** — 학습 행렬 인트라(VVC MIP 유사, 결정론적 정수)\n' +
          '- **MRL** 다중 참조라인, **IBP** 인트라 양방향, IDIF 방향예측\n' +
          '- ⚠️ AV1 FILTER_INTRA는 **제거**(DIP가 학습예측 대체).' },
      { num: '7.13.5', title: 'Predict chroma from luma (CfL)',
        pseudo: 'CfL 3종: **EXPLICIT**(AV1 신호) / **DERIVED_ALPHA**(암시, 복원 이웃 최소자승) / **MULTI_PARAM**(MHCCP).' },
      { num: '7.13.6~8', title: 'MHCCP · Derive multi param · Gaussian elimination',
        pseudo:
          '**MHCCP** = 다가설 교차성분 예측. L자 이웃에서 **3-param 선형모델 최소자승 해**(비선형 V² 항 포함) → ' +
          '정규방정식 3×3 → **가우스 소거**(고정소수) → per-pixel 3-tap MAC.' },
      { num: '5.20.8', title: 'Coding tools (mode syntax)',
        pseudo: 'intra 모드/DIP/CfL idx/MRL/angle_delta 신호. (모드값 자체는 AV1 동일 13종.)' },
    ],
    bitfields: [
      { name: '인트라 예측기 디스패치 우선순위 (조건 분기)',
        bits: [
          { f: 'palette', w: null, d: '색인맵 복사면 우선' },
          { f: 'DIP', w: null, d: 'use_intra_dip → 행렬 예측(luma)', hl: true },
          { f: 'directional', w: null, d: '방향모드(IDIF/IBP/MRL/wide-angle)' },
          { f: 'DC', w: null, d: 'DC(+IBP-DC)' },
          { f: 'SMOOTH/PAETH/V/H', w: null, d: 'pred_high[mode][tx] 테이블' },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  F["av2_predict_intra_block_facade<br/>reconintra.c:2147"] -->|chroma CfL| CFL["av2_cfl_predict_block<br/>cfl.c:606"]\n' +
      '  F -->|일반| P["av2_predict_intra_block<br/>:1687"]\n' +
      '  P --> B["av2_build_intra_predictors_high<br/>:1074"]\n' +
      '  B -->|use_intra_dip| DIP["av2_highbd_intra_dip_predictor<br/>intra_dip.cc:97"]\n' +
      '  DIP --> MM["av2_dip_matrix_multiplication<br/>intra_matrix.c:423 (704 MAC)"]\n' +
      '  CFL -->|MULTI_PARAM| MH["mhccp derive+predict<br/>cfl.c:880/1171"]',
    funcs: [
      { file: 'av2/common/intra_matrix.c', line: 423, name: 'av2_dip_matrix_multiplication_c', lang: 'c',
        excerpt:
          'void av2_dip_matrix_multiplication_c(const uint16_t *A, const uint16_t *B,\n' +
          '                                     uint16_t *C, int bd) {\n' +
          '  int sum = 0;\n' +
          '  for (int j = 0; j < DIP_FEATURES; j++) sum += B[j];   // 11 feature\n' +
          '  for (int i = 0; i < DIP_ROWS; i++) {                  // 64 출력\n' +
          '    int c = 0;\n' +
          '    for (int j = 0; j < DIP_FEATURES; j++)\n' +
          '      c += DIP_SCALE * A[i*DIP_COLS + j] * B[j];        // 정수 MAC\n' +
          '    c = ((c + DIP_OFFSET) >> DIP_BITS) - sum;           // >>12, 정규화\n' +
          '    C[i] = clip_pixel_highbd(c, bd);\n' +
          '  }\n' +
          '}',
        note: '⭐ **DIP 코어 = 64×11 = 704 정수 MAC / 8×8 블록.** 가중치 ROM `av2_intra_matrix_weights[6][64][16]`(uint16). 결과 8×8을 TX크기로 resample. **부동소수 NN 아님, bit-exact.** avx2 SIMD 등록.' },
      { file: 'av2/common/intra_matrix.h', line: 19, name: 'DIP 상수', lang: 'c',
        excerpt: '#define DIP_ROWS 64\n#define DIP_COLS 16   // 11 사용\n#define DIP_BITS 12\n#define DIP_OFFSET (1<<11)\n#define DIP_SCALE 4\n#define DIP_FEATURES 11',
        note: '11-feature = 코너 + 다운샘플 above 4 + left 4 + above-left + bottom-left. `INTRA_DIP_MODE_CNT=6`, transpose 플래그(mode>>4).' },
      { file: 'av2/common/cfl.c', line: 504, name: 'cfl_derive_implicit_scaling_factor', lang: 'c',
        note: '암시 CfL alpha = 복원 above/left 이웃에서 chroma↔luma **최소자승 선형핏**(sum_x/y/xy/xx, luma>>3 Q3, ≤8 샘플 + 1 나눗셈). AV1엔 없음(explicit만).' },
      { file: 'av2/common/cfl.c', line: 880, name: 'av2_mhccp_derive_multi_param_hv_c', lang: 'c',
        excerpt:
          '#define NON_LINEAR(V, M, BD) ((V * V + M) >> BD)   // 비선형 항\n' +
          '// L자 이웃에서 3-param 모델: [luma tap, NON_LINEAR(V), bias]\n' +
          '// → ATA(3x3), A^T y 누적 → gauss_elimination_mhccp(...)',
        note: '⭐ **MHCCP = per-block 3-param 최소자승 솔버.** 정규방정식 3×3 + **가우스 소거**(고정소수, 나눗셈) → `mhccp_implicit_param`. 예측은 `mhccp_predict_hv_hbd`(cfl.c:1171): per-pixel 3-tap MAC + **제곱유닛**.' },
    ],
    structs: [
      { name: 'CFL_TYPE', file: 'av2/common/enums.h', line: 910,
        fields: [
          { f: 'CFL_EXPLICIT', d: 'AV1식 신호 alpha' },
          { f: 'CFL_DERIVED_ALPHA', d: '암시 최소자승 alpha(신규)' },
          { f: 'CFL_MULTI_PARAM', d: 'MHCCP(신규)' },
        ],
        note: '`mbmi->cfl_idx`로 선택(blockd.h:531).' },
      { name: 'DIP 가중치 ROM', file: 'av2/common/intra_matrix.c', line: 18,
        fields: [
          { f: 'av2_intra_matrix_weights[6][64][16]', d: 'uint16 학습 가중치(6 모드)' },
          { f: 'intra_dip_features[11]', d: '입력 feature 벡터(blockd.h:524)' },
        ],
        note: '학습/사전계산 ROM. 디코더에 고정 가중치 행렬이 들어옴 = NPU ROM과 동형.' },
      { name: 'MB_MODE_INFO (intra)', file: 'av2/common/blockd.h', line: 516,
        fields: [
          { f: 'angle_delta / use_intra_dip / intra_dip_mode', d: '방향·DIP' },
          { f: 'cfl_idx / cfl_implicit_alpha[2]', d: 'CfL 타입·암시 alpha' },
          { f: 'mh_dir / mhccp_implicit_param[2][3]', d: 'MHCCP 방향·해' },
          { f: 'mrl_index / multi_line_mrl', d: '다중 참조라인' },
        ] },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '§7.13.2 기본 13 모드', cLine: 'PREDICTION_MODE DC…PAETH (enums.h:837)',
      kind: 'same', delta: 'DC/V/H/방향8/SMOOTH/PAETH·angle_delta(±3) **AV1과 동일**.' },
    { specLine: 'FILTER_INTRA', cLine: '(av2/common에 없음)',
      kind: 'changed', delta: 'AV1 `FILTER_INTRA_MODES` → AV2 **제거**. DIP가 학습예측 자리 대체.' },
    { specLine: '§7.13.2 행렬 인트라', cLine: 'av2_dip_matrix_multiplication (intra_matrix.c:423)',
      kind: 'new', delta: 'AV1 **DIP 없음**. 64×11 정수 MAC + 가중치 ROM(VVC MIP 유사).' },
    { specLine: '§7.13.5 CfL alpha', cLine: 'cfl_derive_implicit_scaling_factor (cfl.c:504)',
      kind: 'changed', delta: 'AV1 explicit 신호만 → AV2 **암시 최소자승 alpha** 추가.' },
    { specLine: '§7.13.6 MHCCP', cLine: 'av2_mhccp_derive_multi_param_hv (cfl.c:880)',
      kind: 'new', delta: 'AV1 **없음**. 3-param 최소자승 + 가우스소거 + 비선형 V² 항.' },
    { specLine: '다중 참조라인/양방향', cLine: 'MRL/IBP (reconintra.c:1771/1354)',
      kind: 'new', delta: 'AV1 없음. MRL(4 라인)·IBP 추가.' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  N["recon neighbors<br/>(above/left)"] --> FE["11-feature vector"]\n' +
      '  FE --> MAC["DIP MAC<br/>64×11 int mul-acc"]\n' +
      '  ROM["weight ROM<br/>[6][64][11]"] --> MAC\n' +
      '  MAC --> RS["resample 8×8 → TX"]\n' +
      '  N --> CFL["CfL / MHCCP<br/>least-squares + V²"]\n' +
      '  RS --> OUT["prediction"]\n' +
      '  CFL --> OUT\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
      '  class N mem;\n  class OUT mem;\n  class ROM rom;\n' +
      '  class FE op;\n  class RS op;\n  class CFL hot;\n  class MAC hot;',
    throughput:
      '기존 DC/방향/SMOOTH는 가벼운 per-pixel 연산. **신규는 MAC 집약:** DIP=8×8당 **704 정수 MAC**(+resample), ' +
      'MHCCP=블록당 3×3 정규방정식+가우스소거(나눗셈)+per-pixel 3-tap MAC&제곱, CfL암시=최소자승 누적+1 나눗셈. ' +
      '이들이 throughput-critical(전부 avx2 SIMD 등록). DIP/MHCCP는 작은 블록에만 적용되나 datapath는 추가 필요.',
    memory:
      'DIP 가중치 ROM(6모드×64×11 uint16) + MHCCP/CfL은 ROM 작음. 이웃 참조 **라인버퍼**: above-row+left-col+above-left+' +
      'top-right/bottom-left, **MRL은 참조라인 4개**(라인버퍼 ↑). CfL/MHCCP는 복원 luma·chroma 이웃 버퍼(`recon_yuv_buf_above/left`).',
    hazard:
      '⭐ **recon-feedback 직렬 사슬:** 인트라 예측기가 **복원된 이웃 픽셀**을 읽음 → 예측→역변환→재구성→다음예측이 ' +
      'per-block 순차(파이프 막힘). CfL/MHCCP는 **같은 블록의 복원 luma**까지 의존(루마 recon 후 chroma 예측). ' +
      'DIP/MHCCP의 MAC/솔버는 그 직렬 구간 안에서 지연을 키움.',
    parallel:
      '인트라는 본질적으로 블록 순차(이웃 의존). 병렬화는 plane(luma/chroma)·블록 내 픽셀 정도. ' +
      'DIP/MHCCP MAC는 내부 데이터 병렬(SIMD/systolic) 가능하나 블록 간은 직렬.',
    av1delta:
      '- 기본 13 모드·angle_delta **재사용**.\n' +
      '- **제거:** FILTER_INTRA.\n' +
      '- **추가(⭐NPU 교집합):** DIP 행렬 MAC 어레이 + 가중치 ROM, MHCCP 3×3 솔버(가우스소거+나눗셈+V²), 암시 CfL 최소자승.\n' +
      '- MRL(라인버퍼↑)·IBP(블렌드 경로) 추가.',
    openQ: [
      '⭐ DIP MAC(64×11)는 **전용 DIP 모듈**(기본 디자인). 설계 포인트 = 그 전용 MAC 어레이를 systolic vs time-mux로 둘지·weight ROM read 대역폭. (IQT의 IST/DDT와는 **다른 스테이지=동시가동→공유 불가.**)',
      'MHCCP의 per-block 가우스 소거(나눗셈 포함)는 가변 지연 — 전용 소형 LS-솔버를 고정 파이프(나눗셈 근사/뉴턴) vs 멀티사이클 FSM?',
      'recon-feedback 직렬 사슬에서 DIP/MHCCP 지연이 critical → 예측 후보 투기적 계산 vs 블록 순차 고수?',
      'DIP는 8×8 고정 후 resample — 작은 TX엔 과한 연산. eligible 크기 제한이 전용 모듈 활용도에 주는 영향?',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'DIP가 왜 Nick의 NPU 관점에서 핵심인가?',
      a: '디코더 **규범 경로**에 학습 가중치(ROM) 기반 **정수 행렬곱**(8×8당 704 MAC)이 실재. 부동소수 NN은 아니지만 MAC 어레이+가중치 ROM = NPU datapath와 동형. IQT의 IST/DDT, MHCCP까지 합치면 디코더에 "NN 닮은" 정수 연산 블록 필요.',
      hint: 'av2_dip_matrix_multiplication의 곱누적 + ROM.' },
    { q: 'MHCCP가 일반 예측과 다른 연산 부담은?',
      a: 'per-block 3-param 최소자승 → 정규방정식 3×3 + **가우스 소거(나눗셈)** + 비선형 V² 항, 그리고 per-pixel 3-tap MAC. 행렬 솔버가 가변 지연이라 고정 파이프 설계가 까다롭다.',
      hint: 'NON_LINEAR 매크로와 gauss_elimination.' },
    { q: '인트라 예측의 본질적 HW 병목은?',
      a: 'recon-feedback 직렬 사슬 — 예측기가 복원된 이웃을 읽으므로 예측→역변환→재구성→다음블록예측이 순차. CfL/MHCCP는 같은 블록 복원 luma까지 의존. DIP/MHCCP MAC가 이 구간 지연을 키움.',
      hint: '예측 입력이 어디서 오나.' },
  ],
  quiz: [
    { q: 'AV2 DIP(행렬 인트라)의 연산 성격은?',
      options: ['부동소수 NN 추론', '학습 가중치 기반 정수 행렬곱(bit-exact)', '단순 평균', 'FFT'],
      answer: 1, why: 'av2_intra_matrix_weights ROM × feature의 정수 MAC, >>12 정규화. 부동소수 아님.' },
    { q: 'AV1에 있다가 AV2에서 제거된 인트라 도구는?',
      options: ['CfL', 'FILTER_INTRA', 'PAETH', 'angle delta'],
      answer: 1, why: 'av2/common에 FILTER_INTRA 없음. DIP가 학습예측 자리 대체.' },
    { q: 'AV2 CfL에 새로 생긴 alpha 방식은?',
      options: ['신호 alpha만', '암시 최소자승 derived alpha', 'alpha 고정', '항상 0'],
      answer: 1, why: 'CFL_DERIVED_ALPHA: 복원 이웃에서 최소자승 핏(cfl.c:504).' },
    { q: 'MHCCP 파라미터 해를 구하는 방법은?',
      options: ['반복 경사하강', '3×3 정규방정식 + 가우스 소거', 'LUT 조회', '신호로 전송'],
      answer: 1, why: 'L자 이웃 최소자승 → ATA 3×3 → gauss_elimination_mhccp(고정소수).' },
  ],

  chapters: [
    { id: 'n1', n: 1, title: 'Intra entry & CfL branch', stage: 'skeleton',
      fn: { name: 'av2_predict_intra_block_facade', file: 'av2/common/reconintra.c', line: 2147,
        role: 'Pick luma vs chroma mode; route UV_CFL_PRED to one of 3 CfL variants (explicit/implicit/MHCCP), else the generic predictor.' },
      spec: { num: '7.13.2', title: 'Intra prediction process' },
      qna: [
        { tag: 'common', ref: 'reconintra.c:2266',
          q: 'facade의 기본 라우팅은? (AV1 공통)',
          a: 'mode = `(plane==Y) ? mbmi->mode : get_uv_mode(uv_mode)`. luma·일반 chroma는 `av2_predict_intra_block`(→n2 일반 디스패치)로 직행. CfL(chroma-from-luma) 개념 자체는 AV1에서 물려받음.' },
        { tag: 'delta', ref: 'enums.h:911',
          q: '색차 CfL 경로가 AV1과 어떻게 달라졌나? (AV2 델타)',
          a: 'chroma `UV_CFL_PRED`이 **cfl_idx 3-way 분기**: `CFL_EXPLICIT`(AV1식 signaled α) / `CFL_DERIVED_ALPHA`(**implicit α**, n5) / `CFL_MULTI_PARAM`(**MHCCP**, n6). AV1엔 explicit CfL만 — 나머지 2종이 AV2 신규.' },
        { tag: 'verified', ref: 'reconintra.c:2230',
          q: 'cfl_idx 분기의 실제 호출은? (실측)',
          a: '`cfl_idx==CFL_DERIVED_ALPHA` → `cfl_implicit_fetch_neighbor_chroma` + `cfl_derive_implicit_scaling_factor`(LS). `==CFL_MULTI_PARAM` → `mhccp_implicit_fetch_*` + `av2_mhccp_derive_multi_param_hv`(LS+소거). 끝에 `av2_cfl_predict_block`로 합성.' },
        { tag: 'hw', ref: 'reconintra.c:2147',
          q: 'facade의 HW 역할은?',
          a: '**predictor 라우터** — plane·mode·cfl_idx로 어느 예측 datapath가 발화할지 선택(블록당 1개 배타). 각 모드는 **전용 모듈**(streaming 동시가동이라 모드 간 datapath 공유 불가). facade는 그 디먹스 + per-block 셋업.' },
        { tag: 'hw', ref: 'reconintra.c:2205',
          q: 'CfL/MHCCP가 만드는 순차의존은?',
          a: 'CfL/MHCCP는 **복원된 luma**를 읽음(`cfl_store(luma_dst)`) → **같은 블록 luma가 복원돼야 chroma 예측 진입** = intra **cross-plane 순차의존**. `dc_pred_is_cached`로 DC 예측 캐시 재사용해 재계산 절감.' },
      ] },
    { id: 'n2', n: 2, title: 'Predictor dispatch', stage: 'skeleton',
      fn: { name: 'av2_build_intra_predictors_high', file: 'av2/common/reconintra.c', line: 1074,
        role: 'Prep neighbor edges (NEED_* mask, 2 ref lines for MRL), then dispatch DIP → directional(IDIF) → DC/SMOOTH/PAETH.' },
      spec: { num: '7.13.2', title: 'Intra prediction process' },
      qna: [
        { tag: 'common', ref: 'reconintra.c:1100',
          q: '디스패치의 공통 골격은? (AV1 공통)',
          a: '`extend_modes[mode]`의 `NEED_LEFT/ABOVE/ABOVELEFT/BOTTOMLEFT` 비트마스크로 어느 이웃을 가져올지 결정 → 없는 에지 픽셀은 마지막 값으로 복제(`avm_memset16`). 그 뒤 directional vs table 모드(DC/SMOOTH/PAETH/V/H) 분기. 이 뼈대는 AV1 그대로.' },
        { tag: 'delta', ref: 'reconintra.c:1099',
          q: '여기서 게이트되는 AV2 신규 3종은? (AV2 델타)',
          a: '`use_intra_dip`(luma **DIP**, n3) · `mrl_index`(**MRL** — 1st/2nd **2개 참조라인** 버퍼 준비) · `apply_ibp = seq_ibp_flag && tx≠4×4`(**IBP**, n4 — `second_pred` 필요). 각각 이웃 요구를 NEED_all로 확장.' },
        { tag: 'verified', ref: 'reconintra.c:1265',
          q: '실제 분기 순서는? (실측)',
          a: '①`use_intra_dip` → `av2_highbd_intra_dip_predictor` 후 **return**(DIP 최우선). ②`is_dr_mode` → 에지필터 후 luma `highbd_dr_predictor_idif` / chroma `highbd_dr_predictor`. ③else DC/SMOOTH/PAETH 테이블 모드. 블록당 1경로 배타.' },
        { tag: 'delta', ref: 'reconintra.c:1318',
          q: 'luma 방향예측이 chroma와 다른 점은? (AV2 델타)',
          a: 'luma는 **IDIF**(`highbd_dr_predictor_idif` = intra directional **interpolation filter**), chroma는 평이한 `highbd_dr_predictor`. AV2가 luma 방향예측에 보간필터를 추가(n4에서 상술).' },
        { tag: 'hw', ref: 'reconintra.c:1093',
          q: '이웃 에지의 line-buffer 비용은?',
          a: '위/좌/좌상/좌하 에지 read + **MRL 최대 4 참조라인** → 이웃 line-buffer 폭 확대. SB 경계에선 `above_mrl_idx=0` 강제(SB 넘는 read 불가). MRL/IBP용 **2개 ref-line 버퍼**(1st=mrl라인, 2nd=인접) 동시 유지.' },
        { tag: 'hw', ref: 'reconintra.c:1074',
          q: 'datapath 분할(cheap vs heavy)은?',
          a: 'DC/방향/SMOOTH/PAETH는 **per-pixel 저비용**, DIP(n3 MAC 어레이)·IBP(2차 예측 블렌드)는 **무거움**. 예측기는 모드별 **전용 경로 one-of-N**(facade가 디먹스). 무거운 모드만 별도 datapath로 분리하는 게 자연스러움.' },
      ] },
    { id: 'n3', n: 3, title: '⭐ DIP matrix intra (704 MAC/8×8)', stage: 'skeleton',
      fn: { name: 'av2_dip_matrix_multiplication', file: 'av2/common/intra_matrix.c', line: 423,
        role: 'Matrix intra: 11-feature vector × learned uint16 ROM = 64×11 integer MACs → 8×8 pred, then resample to TX.' },
      spec: { num: '7.13.2', title: 'Intra prediction process (DIP)' },
      io: {
        diagCaption: 'feature gather → 64×11 MAC → resample',
        diagram: 'graph TD\n' +
          '  NBR["recon neighbors<br/>above/left (hbd)"] --> FE["11-feature vector<br/>uint16[11]"]\n' +
          '  FE --> MAC["MAC array<br/>64×11 int mul-acc"]\n' +
          '  ROM["weight ROM<br/>[mode][64][11] uint16"] --> MAC\n' +
          '  MAC --> NRM["+offset, &gt;&gt;12, −sum<br/>clip"]\n' +
          '  NRM --> RS["resample 8×8 → TX"]\n' +
          '  RS --> OUT["prediction"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class NBR mem;\n  class OUT mem;\n  class ROM rom;\n  class FE op;\n  class MAC hot;\n  class NRM op;\n  class RS op;',
        in: [
          { sig: 'A (weights)', type: 'uint16[64×16] (11 used)', peer: 'weight ROM (per DIP mode)', vol: '64×11/mode', note: 'learned matrix; 6 modes' },
          { sig: 'B (features)', type: 'uint16[11]', peer: 'feature buf (from recon nbr)', vol: '11', note: 'downsampled above/left + corners' },
          { sig: 'bd', type: 'int', peer: 'caller', vol: '1', note: 'bitdepth for clip' },
        ],
        out: [
          { sig: 'C (pred 8×8)', type: 'uint16[64]', peer: '→ resample → prediction', vol: '8×8, resampled to TX', note: '704 int MAC, +DIP_OFFSET >>12 −sum, clip' },
        ],
        note: '**The clearest "NN-like" datapath in the decoder:** weight ROM + integer MAC array + shift/clip activation, bit-exact. But it is a **per-mode dedicated module** — streaming concurrency forbids time-sharing one array across stages. The NPU link is **design-skill transfer** (the 64×11 MAC-array technique applies per module), not a shared silicon array.',
      },
      qna: [
        { tag: 'delta', ref: 'intra_matrix.c:423',
          q: 'DIP는 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**Data-driven Intra Prediction = 행렬기반 인트라**(VVC MIP 계열). 다운샘플한 이웃을 **학습 가중행렬과 곱해** 8×8 예측 생성. luma 전용, **6모드**(`INTRA_DIP_MODE_CNT`). **AV1엔 전무**(aom `intra_matrix`/`dip_matrix` grep=0건, 실측).' },
        { tag: 'verified', ref: 'intra_dip.cc',
          q: '11-feature 벡터는 어떻게 만드나? (실측)',
          a: '`av2_highbd_intra_dip_predictor`: **11 feature** = 코너 `edge0[-1]` + 위 4개(각 `down0`픽셀 평균 다운샘플) + 좌 4개(`down1` 평균) + 좌상 overhang 1 + 좌하 overhang 1. `transpose=mode>>4`, `iml_mode=mode&15`. 즉 이웃을 4점으로 **avg-pooling**.' },
        { tag: 'verified', ref: 'intra_matrix.c:429',
          q: '행렬곱의 실제 연산은? (실측)',
          a: '`c = Σ_j DIP_SCALE·A[i·16+j]·B[j]` (j<**11** feature, i<**64** 출력) → `c = ((c+DIP_OFFSET)>>DIP_BITS) − sum` → `clip_pixel_highbd`. = **64×11 = 704 int MAC/8×8**. `DIP_SCALE=4`, `DIP_BITS=12`, `DIP_OFFSET=2048`, `sum=Σ B[j]`.' },
        { tag: 'delta', ref: 'intra_matrix.c:431',
          q: '−sum 항과 가중 ROM의 의미는? (AV2 신규)',
          a: '`−sum`(feature 합)을 출력마다 빼는 건 **feature 평균 제거(DC 정규화)** — 행렬이 잔차 패턴만 학습. ROM `av2_intra_matrix_weights[6][64][16]` uint16(11열만 사용). 6모드 × 64×16 = 6144 uint16.' },
        { tag: 'delta', ref: 'intra_dip.cc',
          q: 'DIP 출력 크기와 TX 적용은? (AV2 신규)',
          a: '행렬 출력은 **고정 8×8**(`ml_output[64]`). 이후 **TX 크기로 resample(업샘플 보간)**. `transpose`로 세로/가로 블록 대응. 즉 DIP는 8×8 격자에서 돌고 결과를 블록 크기에 맞춰 늘림.' },
        { tag: 'hw', ref: 'intra_matrix.c:423',
          q: 'DIP의 HW datapath 형태는?',
          a: '**전용 MAC 모듈**: weight ROM(uint16) → **64×11 정수 MAC** → `+offset >>12 −sum` → clip. 디코더에서 가장 "NN스러운" datapath. ⚠️ 단 **per-mode 전용 유닛** — streaming 동시가동이라 스테이지 간 어레이 공유 불가. NPU 연결 = **MAC-array 설계기법 전이**(모듈마다 적용), 공유 실리콘 아님.' },
        { tag: 'hw', ref: 'intra_dip.cc',
          q: 'DIP의 pre/post 스테이지와 사이징은?',
          a: 'pre = 이웃 **avg-pool 다운샘플**(11 feature), post = **8×8→TX resample**(분리형 보간). 코어는 704 MAC/8×8 → PE 수 vs 블록 처리율로 사이징. 64폭 등 큰 블록은 8×8 격자 후 업샘플이라 MAC 수는 블록 크기와 무관(고정 704).' },
      ] },
    { id: 'n4', n: 4, title: 'Directional / IDIF / IBP / MRL', stage: 'skeleton',
      fn: { name: 'highbd_dr_predictor_idif (+ IBP/MRL)', file: 'av2/common/reconintra.c', line: 1275,
        role: 'Angular prediction (luma IDIF interp), multi reference line (MRL, avg of 2 lines), intra bi-prediction (IBP z1/z3 weighted blend).' },
      spec: { num: '7.13.2', title: 'Intra prediction process' },
      qna: [
        { tag: 'common', ref: 'reconintra.c:1276',
          q: '방향예측의 공통 골격은? (AV1 공통)',
          a: '각도 → **에지필터**(`av2_filter_intra_edge_high`, strength=f(size,angle) + 코너필터)로 이웃 평활 → 각도 따라 위/좌에서 보간 예측. 에지 스무딩 + DC/SMOOTH/PAETH 테이블 모드(`pred_high[mode][tx_size]`)는 AV1 그대로.' },
        { tag: 'delta', ref: 'reconintra.c:1318',
          q: 'IDIF란? (AV2 신규)',
          a: 'luma 방향예측이 `highbd_dr_predictor_idif` = **Intra Directional Interpolation Filter** — 각도 방향으로 **sub-pixel 보간 탭**을 써서 예측(계단현상 감소). chroma는 평이한 `highbd_dr_predictor`. **AV2 luma 전용**(AV1 grep 0건).' },
        { tag: 'delta', ref: 'reconintra.c:1322',
          q: 'MRL(다중 참조라인)은? (AV2 신규)',
          a: '`mrl_index`(CDF 4종 → **최대 4 참조라인**)로 어느 라인에서 예측할지 선택. `multi_line_mrl`이면 2nd 라인에서도 예측해 **평균** `(dst + dst_mrl_line_0 + 1)/2`. SB 경계에선 라인0 강제. AV1은 인접 1라인만.' },
        { tag: 'verified', ref: 'reconintra.c:1360',
          q: 'IBP(인트라 bi-prediction)의 실제 블렌드는? (실측)',
          a: '`z1`(0<θ<90)/`z3`(180<θ<270)에서 **2차 방향예측** `highbd_second_dr_predictor_idif` 생성 후 `av2_highbd_ibp_dr_prediction_z1/z3`가 `ibp_weights[mode_index]`로 **가중 블렌드**. 게이트: `mrl_index==0` & `angle_delta` 짝수 & luma & `is_ibp_enabled[mode]`.' },
        { tag: 'delta', ref: 'enums.h:1164',
          q: 'IBP 가중치와 DC 변형은? (AV2 신규)',
          a: 'DC 모드도 IBP 변형 `ibp_dc_pred_high` 존재. 가중치 `IBP_WEIGHT_SIZE=16`(=1<<4), `IBP_WEIGHT_SHIFT=DIV_LUT_BITS` — DIV_LUT 기반 위치별 블렌드 가중. 즉 IBP는 **거리 가중 양방향 인트라**.' },
        { tag: 'hw', ref: 'reconintra.c:1322',
          q: 'MRL/IBP의 HW 비용은?',
          a: 'MRL = **이웃 line-buffer 최대 4×** + 2 예측 평균(2-pass). IBP = **2차 예측 패스 추가 + 가중 블렌드 유닛**(weight ROM). IDIF = 픽셀당 보간 탭 MAC. 즉 방향예측 경로가 가장 무거운 분기(2 predictor + blend).' },
        { tag: 'hw', ref: 'reconintra.c:1318',
          q: '방향예측 datapath 구조는?',
          a: '각도 → 탭 선택(IDIF 보간) → 픽셀당 MAC. IBP면 **두 방향예측 동시 + 위치가중 합성**으로 2배. DC/SMOOTH/PAETH는 저비용 per-pixel. 전용 directional 엔진에 IDIF 보간 + IBP 블렌드를 옵션 스테이지로 붙이는 형태.' },
      ] },
    { id: 'n5', n: 5, title: 'CfL implicit alpha (least-squares)', stage: 'skeleton',
      fn: { name: 'cfl_derive_implicit_scaling_factor', file: 'av2/common/cfl.c', line: 504,
        role: 'Derive CfL alpha by least-squares fit of chroma↔luma over ≤8 reconstructed neighbors (no signaled alpha).' },
      spec: { num: '7.13.5', title: 'Predict chroma from luma process' },
      qna: [
        { tag: 'common', ref: 'cfl.c:580',
          q: 'CfL 예측 모델 자체는? (AV1 공통)',
          a: 'chroma = DC + **alpha·(luma_AC)** — 복원 luma의 AC 성분에 스칼라 alpha를 곱해 chroma 예측. 이 chroma-from-luma 모델은 AV1에서 물려받음. 차이는 alpha를 **어떻게 얻느냐**.' },
        { tag: 'delta', ref: 'cfl.c:504',
          q: 'AV2 implicit alpha가 AV1과 다른 점은? (AV2 델타)',
          a: 'AV1은 alpha를 **비트스트림에 signaling**. AV2 `CFL_DERIVED_ALPHA`는 **복원 이웃에서 least-squares로 alpha를 유도**(전송 안 함) → 비트 절감. AV1엔 implicit derive 전무(grep 0건, 실측).' },
        { tag: 'verified', ref: 'cfl.c:540',
          q: '레퍼런스 샘플 선택과 누적은? (실측)',
          a: '최대 `NUM_REF_SAM_CFL=8` 샘플을 위/좌로 분배(`w>2h`→위 전부, `h>2w`→좌 전부, 아니면 4/4), strided 샘플링. 누적 `sum_x/sum_y/sum_xy/sum_xx`(x=`luma>>3`, y=chroma). ≤8 샘플뿐 → 작은 누적기.' },
        { tag: 'verified', ref: 'cfl.c:578',
          q: 'alpha 산출(solve)은? (실측)',
          a: '`derive_linear_parameters_alpha(sum_x,sum_y,sum_xx,sum_xy,count,shift)` = LS 기울기 `(count·Σxy − Σx·Σy)/(count·Σxx − Σx²)`. **나눗셈 1회**. `shift=3+CFL_ADD_BITS_ALPHA`.' },
        { tag: 'hw', ref: 'cfl.c:543',
          q: 'CfL implicit의 HW 형태는?',
          a: '**작은 LS 솔버**: ≤8 샘플 4-sum 누적 + **divide 1개**(또는 reciprocal LUT). 복원 luma·chroma 이웃을 읽으므로 **chroma는 luma 복원 후** 순차의존. MHCCP(n6)의 축소판 — 1-param 버전.' },
      ] },
    { id: 'n6', n: 6, title: '⭐ MHCCP derive (LS + Gaussian elim)', stage: 'skeleton',
      fn: { name: 'av2_mhccp_derive_multi_param_hv', file: 'av2/common/cfl.c', line: 880,
        role: 'Per-block 3-param least-squares (non-linear V² term): build ATA 3×3, solve by Gaussian elimination.' },
      spec: { num: '7.13.6', title: 'MHCCP process' },
      io: {
        diagCaption: 'accumulate ATA/ATy → solve 3×3',
        diagram: 'graph TD\n' +
          '  NBR["L-shape recon nbr<br/>luma + chroma (hbd)"] --> FEAT["per-sample<br/>{luma, V², bias}"]\n' +
          '  FEAT --> ACC["accumulate<br/>ATA 3×3 + ATy"]\n' +
          '  ACC --> SOL["Gaussian elimination<br/>(fixed-point, divide)"]\n' +
          '  SOL --> P["mhccp params[3]<br/>→ predict (mbmi)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class NBR mem;\n  class P mem;\n  class FEAT op;\n  class ACC op;\n  class SOL hot;',
        in: [
          { sig: 'recon L-nbr', type: 'uint16 luma + chroma', peer: 'recon neighbor buffer', vol: '≤ MHCCP_MAX_REF_SAMPLES', note: 'builds {luma tap, V², bias} per sample' },
        ],
        out: [
          { sig: 'mhccp_param', type: 'int[3] (fixed-point)', peer: '→ mbmi → predict (n7)', vol: '3 params/block', note: 'via 3×3 normal eqns + Gaussian elimination' },
        ],
        note: 'A **linear solver** in the normative path: 3×3 ATA accumulate + Gaussian elimination with a divide. Variable-latency — the HW question is fixed-pipe vs reciprocal approximation.',
      },
      qna: [
        { tag: 'delta', ref: 'cfl.c:880',
          q: 'MHCCP는 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**Multi-Hypothesis Cross-Component Prediction**(`CFL_MULTI_PARAM`) — 색차를 **3-param 비선형 모델**로 예측(선형 CfL 확장). 블록마다 **LS로 3 param을 풀어** 유도. **AV1엔 전무**(grep 0건, 실측).' },
        { tag: 'verified', ref: 'cfl.c:914',
          q: '3 param의 feature 구성은? (실측)',
          a: '레퍼런스 샘플마다 `A[0]`=luma 탭(`dir`=0 C/1 T/2 L), `A[1]`=`NON_LINEAR(luma)`(**V²류 비선형항**), `A[2]`=`mid`(bias). 타깃 `Y`=chroma. L자 이웃 ≤`MHCCP_MAX_REF_SAMPLES`개 수집. `MHCCP_NUM_PARAMS=3`.' },
        { tag: 'verified', ref: 'cfl.c:945',
          q: 'normal equation과 solve는? (실측)',
          a: 'ATA[3][3]=`Σ A_i·A_j`(상삼각만) + Ty[3]=`Σ A_i·Y` 누적 → dynamic range 스케일 → **`gauss_elimination_mhccp(ATA, C, Ty, params)`** = 3×3 가우스 소거로 `mhccp_implicit_param[3]` 산출.' },
        { tag: 'delta', ref: 'cfl.c:982',
          q: '왜 Gaussian elimination인가? (AV2 신규)',
          a: '3×3 정규방정식을 직접 역행렬 대신 **가우스 소거**(pivot + 나눗셈)로 품. 1-param CfL(n5)의 단일 divide와 달리 **다변수 연립방정식 솔버**가 정규 디코드 경로에 들어옴 — AV2 인트라의 가장 무거운 산술.' },
        { tag: 'hw', ref: 'cfl.c:945',
          q: 'MHCCP derive의 HW 형태는?',
          a: '**정규경로 내 선형 솔버**: 샘플당 **V² square 유닛** + ATA 3×3 누적(MAC) → **가우스 소거**(pivot·divide, **가변 지연**). 고정 파이프로 만들려면 reciprocal-approx LUT. DIP와 함께 intra의 두 "solver/MAC" 전용 모듈.' },
        { tag: 'hw', ref: 'enums.h:158',
          q: 'accumulator·ROM 사이징은?',
          a: 'ATA/Ty는 ≤`MHCCP_MAX_REF_SAMPLES` 샘플 곱-합 → **넓은 누적기**(int32). 솔버는 3×3+1 증강행렬 작업버퍼. param 3개/블록만 출력 → predict(n7)로 전달. 솔버 자체는 작지만 가변지연이 파이프 스케줄 난점.' },
      ] },
    { id: 'n7', n: 7, title: 'MHCCP predict (3-tap MAC + V²)', stage: 'skeleton',
      fn: { name: 'mhccp_predict_hv_hbd', file: 'av2/common/cfl.c', line: 1171,
        role: 'Per chroma pixel: build {luma tap C/T/L, NON_LINEAR(luma), bias}, dot with solved params (convolve), clip.' },
      spec: { num: '7.13.6', title: 'MHCCP process' },
      qna: [
        { tag: 'verified', ref: 'cfl.c:1171',
          q: 'MHCCP predict의 픽셀당 연산은? (실측)',
          a: 'chroma 픽셀마다 `vector[0]`=luma 탭(dir C/T/L), `vector[1]`=`NON_LINEAR(luma>>3)`, `vector[2]`=`mid` → `convolve(alpha_q3, vector, 3)`(n6 param과 **3-tap 내적**) → `clip_pixel_highbd`. 즉 유도한 3 param을 전 chroma 픽셀에 적용.' },
        { tag: 'delta', ref: 'cfl.c:1185',
          q: 'predict가 단순 선형 CfL과 다른 점은? (AV2 델타)',
          a: '선형 CfL은 1-tap(alpha·luma)인데 MHCCP는 **3-tap + 비선형 V²항** → 색차-휘도 비선형 상관까지 모델. 방향(`dir`)에 따라 luma 탭을 C/T/L로 바꿔 공간 컨텍스트도 반영.' },
        { tag: 'hw', ref: 'cfl.c:1186',
          q: 'predict의 HW 비용과 병렬성은?',
          a: '픽셀당 **3-tap MAC + square 1개(V²)** = 작은 고정 MAC. param은 블록당 상수라 **전 chroma 픽셀 병렬** 가능. 무거운 건 n6 솔버(가변지연)뿐 — predict는 cheap·parallel feed-forward.' },
        { tag: 'hw', ref: 'cfl.c:1180',
          q: 'predict 앞단 제어는?',
          a: '`dir`(C/T/L) 탭 선택 **mux**가 MAC 앞에 1개. 입력은 복원 luma(이웃 포함), 출력 chroma 예측. n6→n7은 **derive(직렬 솔버) → predict(병렬 MAC)** 2-스테이지 — 솔버 결과가 predict 파이프의 계수 ROM처럼 작동.' },
      ] },
    { id: 'n8', n: 8, title: 'HW synthesis (intra)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Tie it together: the recon-feedback serial loop (intra-defining) + per-mode dedicated predictor modules (DIP MAC, MHCCP solver), and the shared recon skeleton to factor out later.' },
      figures: [
        { title: 'Intra recon-feedback loop — the defining serial hazard',
          mermaid:
'graph TD\n' +
'  NBR["recon neighbors<br/>(above/left, MRL ≤4 lines)"] --> PRED["predictor (one of N)<br/>DC/dir-IDIF/smooth/paeth<br/>DIP / CfL / MHCCP"]\n' +
'  ROM["weight/param<br/>DIP ROM · MHCCP solver"] --> PRED\n' +
'  PRED --> P["prediction"]\n' +
'  P --> ADD["+ residual<br/>(IQT: dequant→CCTX→IST→2D)"]\n' +
'  ADD --> REC["reconstructed block"]\n' +
'  REC -. "becomes neighbor<br/>(serial: block N+1 waits)" .-> NBR\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
'  class NBR mem;\n  class REC mem;\n  class ROM rom;\n  class PRED op;\n  class P op;\n  class ADD op;\n  class NBR hot;',
          caption: 'Intra’s defining hazard: a block must be fully reconstructed (predict + residual add) before the next block can use it as a neighbor. The predictor modules sit inside this per-block serial loop. (Inter has no such feedback — it reads reference frames.)' },
      ],
      qna: [
        { tag: 'hw',
          q: 'intra의 정의적 직렬 hazard는?',
          a: '**recon-feedback 루프**: predict → IQT 잔차가산 → 복원 → 그 픽셀이 **다음 블록의 이웃**. 블록 N+1 예측은 N 복원 후 가능 → 블록단위 순차. 이게 intra가 IQT보다 병렬화 어려운 이유. **inter엔 없음**(참조프레임 read).' },
        { tag: 'hw',
          q: '예측 모드들은 HW에서 어떻게 배치되나?',
          a: '**모드별 전용 datapath**: DC/방향(IDIF)/smooth/paeth = cheap per-pixel; **DIP = 704 MAC 어레이**(n3); **CfL implicit = 소형 LS**(n5); **MHCCP = 3×3 가우스 솔버**(n6). 블록당 1개 발화(facade 디먹스). ⚠️ streaming 동시가동 → 모드 간/스테이지 간 어레이 **공유 불가, 전용 모듈**.' },
        { tag: 'hw',
          q: 'NPU와의 연결은 정확히 무엇인가?',
          a: '**설계기법 전이**(skill transfer): DIP의 정수 MAC 어레이, MHCCP의 선형 솔버 설계가 NPU의 MAC/solver 설계와 동형 → **모듈마다** 그 기법 적용. 공유 실리콘 어레이를 만드는 게 아니라, 각 전용 모듈을 작은 MAC datapath로 설계하는 노하우가 겹침.' },
        { tag: 'hw',
          q: '온칩 버퍼 예산은?',
          a: 'MRL **최대 4 line-buffer** + 복원 luma/chroma 이웃 버퍼(CfL/MHCCP/DIP feature용). DIP는 8×8 격자 작업버퍼 + weight ROM(6모드×6144 uint16), MHCCP는 3×3 솔버 스크래치. 이웃 의존이라 SB 경계 버퍼 관리가 핵심.' },
        { tag: 'delta',
          q: 'AV1 대비 intra 추가 총정리는? (델타)',
          a: '**추가:** DIP(행렬 인트라)·IDIF(luma 방향 보간)·IBP(양방향 인트라)·MRL(≤4 라인)·CfL implicit(α LS 유도)·MHCCP(3-param 비선형 솔버). **재사용:** DC/SMOOTH/PAETH/기본 방향예측·explicit CfL은 AV1 그대로.' },
        { tag: 'hw',
          q: '【recon 공유부 → 별도 recon 페이지 참조】',
          a: '**forward-pointer:** predict → IQT(dequant→CCTX→IST→2D) → clip-add → 다음 블록 = **intra·inter 공통 골격**(`decode_reconstruct_tx`, decodeframe.c:450). 예측 소스만 다름(이웃 vs 참조). ▶ 공유 재구성 루프는 **`app.html?tool=recon`**(RECON 페이지)에 한 곳으로 정리됨. intra 고유분 = 위 recon-feedback **이웃 의존**(여기 유지).' },
      ] },
  ],
};
