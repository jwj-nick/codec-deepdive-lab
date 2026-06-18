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
      '  N["복원 이웃<br/>(above/left)"] --> FE["11-feature 벡터"]\n' +
      '  FE --> MAC["DIP MAC<br/>64×11 정수곱누적"]\n' +
      '  ROM["가중치 ROM<br/>[6][64][11]"] --> MAC\n' +
      '  MAC --> RS["resample 8×8→TX"]\n' +
      '  N --> CFL["CfL/MHCCP<br/>최소자승+V²"]\n' +
      '  RS --> OUT[예측]\n' +
      '  CFL --> OUT',
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
      '⭐ DIP MAC(64×11)·MHCCP 솔버를 **전용 유닛 vs 디코더 내 작은 MAC 어레이(NPU 닮음) 공유**? IQT의 IST/DDT 행렬과도 공유 가능?',
      'MHCCP의 per-block 가우스 소거(나눗셈 포함)는 가변 지연 — 고정 파이프로 풀려면 나눗셈 근사/뉴턴? 면적 vs 지연.',
      'recon-feedback 직렬 사슬에서 DIP/MHCCP 지연이 critical → 예측 후보 투기적 계산 vs 블록 순차 고수?',
      'DIP는 8×8 고정 후 resample — 작은 TX엔 과한 연산. eligible 크기 제한이 HW 활용도에 주는 영향?',
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
};
