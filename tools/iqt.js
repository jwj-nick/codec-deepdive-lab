/* tools/iqt.js — Transform & Quantization (inverse, IQT 스테이지)
   실측: ~/work/avm (AV2) · ~/work/aom (AV1).
   ⚠️ 구조 정정: 2D 역변환 디스패치 = av2/common/idct.c (av2_inv_txfm2d.c는 IWHT4x4 lossless만). */
window.TOOL = {
  id: 'iqt',
  title: 'Transform & Quant (역변환·역양자화)',
  stage: 'IQT',
  coupling: ['ENT', 'PRD'],
  role: '역양자화 + 역변환 — 디코더에서 가장 **규칙적·병렬친화** 스테이지. AV2는 IST 2차변환·CCTX 색차결합·DDT 학습커널·TCQ 역양자화를 추가.',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '7.14', title: 'Reconstruction and dequantization',
        pseudo:
          '**역양자화**(7.14.4) + **재구성**(7.14.3).\n\n' +
          '- 계수 `level` × dequant 값 `dqv`(= DC/AC 분리, 선택적 quant-matrix 가중) → 라운딩 → `>> shift`\n' +
          '- `shift = tx_scale(tx_size)`. TCQ면 2-pass(상태로 Q0/Q1 선택).' },
      { num: '7.15', title: 'Inverse transform process',
        pseudo:
          '**분리형 2D** 역변환.\n\n' +
          '- **7.15.3 Secondary transform(=IST)** — 1차 변환 *앞단*에서 좌상단 저주파 계수에 작은 행렬변환\n' +
          '- **7.15.2 1D transforms** — 행 1D → 열 1D (DCT2/IDTX/DST7/DCT8 + 신규 DDTX/FDDT)\n' +
          '- **7.15.4 2D** — sqrt2 직사각 보정 → 1D행 → 1D열 → 예측에 clip-add. 64폭은 좌상단 32만 비영(zero-out+2배 복제).' },
      { num: '5.20.6', title: 'Transform and quantization structures (syntax)',
        pseudo: 'TX 블록 단위 tx_type / tx_size / 계수 syntax. tx_type 상위비트에 IST가 패킹됨(아래 비트 레이아웃).' },
      { num: '9.6 / 9.7', title: '1d transform tables / Secondary transform tables',
        pseudo: '1D 변환 계수 LUT(845p), IST 커널 LUT(849p). 디코더는 ROM으로 사용.' },
    ],
    bitfields: [
      { name: 'TX_TYPE 32비트 패킹 (IST가 상위비트에) — blockd.h:2870/2972/2983',
        bits: [
          { f: 'primary', w: 4, d: '기본 변환 16종(DCT_DCT…). `tx_type & 0x0f`. AV1과 동일' },
          { f: 'IST type', w: 2, d: '2차변환 타입. `(tx_type>>4)&0x3`. AV2 신규', hl: true },
          { f: 'IST set', w: 4, d: '2차변환 세트. `(tx_type>>6)&0xf`. AV2 신규', hl: true },
          { f: '(unused)', w: 6, d: '상위 잔여' },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  RC["read_coeffs_tx_* (U,V)<br/>decodeframe.c:467 — dequant 내장"] --> CC["inverse_cctx_block_visit<br/>:470"]\n' +
      '  CC --> CCX["av2_inv_cross_chroma_tx_block<br/>idct.c:964 (U/V 2×2 회전)"]\n' +
      '  CCX --> IT["av2_inverse_transform_block<br/>idct.c:998 (plane별)"]\n' +
      '  IT --> IST["av2_inv_stxfm (IST)<br/>idct.c:1073 — 1차 앞단"]\n' +
      '  IT --> P2D["inv_txfm_c (2D)<br/>idct.c:643"]\n' +
      '  P2D --> R1["1D row → 1D col<br/>inv_transform_1d_c:534"]\n' +
      '  P2D --> ADD["highbd_clip_pixel_add → 예측에 가산"]',
    funcs: [
      { file: 'av2/decoder/decodetxb.c', line: 621, name: 'dequant apply', lang: 'c',
        excerpt:
          'static INLINE int get_dqv(const int32_t *dequant, int coeff_idx,\n' +
          '                          const qm_val_t *iqmatrix) {\n' +
          '  int dqv = dequant[!!coeff_idx];          // idx0=DC, else AC\n' +
          '  if (iqmatrix) dqv = (iqmatrix[coeff_idx]*dqv + (1<<(AVM_QM_BITS-1))) >> AVM_QM_BITS;\n' +
          '  return dqv;\n' +
          '}\n' +
          '// 적용:\n' +
          'dq_coeff_hp = (int64_t)level * get_dqv(dequant, scan[c], iqmatrix) & 0xffffff;\n' +
          'dq_coeff = ROUND_POWER_OF_TWO_64(dq_coeff_hp, QUANT_TABLE_BITS) >> shift;',
        note: '역양자화는 계수 파싱 *안에서* 수행(별도 패스 아님). `dequant`는 **int32**(AV1은 int16). `QUANT_TABLE_BITS` 라운딩이 AV1 대비 추가.' },
      { file: 'av2/common/idct.c', line: 964, name: 'av2_inv_cross_chroma_tx_block', lang: 'c',
        excerpt:
          'void av2_inv_cross_chroma_tx_block(tran_low_t *c1, tran_low_t *c2,\n' +
          '         TX_SIZE tx_size, CctxType cctx_type, const int bd) {\n' +
          '  if (cctx_type == CCTX_NONE) return;\n' +
          '  const int a = cctx_type - CCTX_START;\n' +
          '  for (int i = 0; i < ncoeffs; i++) {        // U/V 2×2 회전\n' +
          '    tmp0 = cctx_mtx[a][0]*c1[i] - cctx_mtx[a][1]*c2[i];\n' +
          '    tmp1 = cctx_mtx[a][1]*c1[i] + cctx_mtx[a][0]*c2[i];\n' +
          '    c1[i] = clamp(ROUND(tmp0, CCTX_PREC_BITS), 8+bd);\n' +
          '    c2[i] = clamp(ROUND(tmp1, CCTX_PREC_BITS), 8+bd);\n' +
          '  }\n' +
          '}',
        note: '⭐ **CCTX = U/V 색차 계수 2×2 회전**(Givens, decorrelation). 계수당 4 곱셈. `cctx_mtx[6][2]=[cosθ,sinθ]·256`, **6각도**(45°=Haar/±30/±60). **U·V를 함께** 처리(교차의존).' },
      { file: 'av2/common/idct.c', line: 998, name: 'av2_inverse_transform_block', lang: 'c',
        note: '역변환 top 진입. 흐름: `init_txfm_param`(:877) → `av2_inv_stxfm`(IST, :1019) → master_add → `inv_txfm_c`(2D 1차). IST가 **1차 변환보다 먼저** 좌상단 계수에 적용.' },
      { file: 'av2/common/idct.c', line: 643, name: 'inv_txfm_c', lang: 'c',
        note: '통합 2D 코어(AV1의 per-size 함수군을 하나로). sqrt2 직사각보정 → 행 1D → 열 1D(`inv_transform_1d_c`:534, size×type 스위치) → `highbd_clip_pixel_add`(:760). >32는 zero-out+2배 복제.' },
      { file: 'av2/common/idct.c', line: 1073, name: 'av2_inv_stxfm', lang: 'c',
        note: 'IST 적용. 스캔순으로 계수 모아 `inv_stxfm_c(buf, …, stx_type, size_class)` 호출 후 IST 스캔으로 산포. 4×4(16→8)·8×8 두 크기. 커널 `ist_4x4_kernel[14][3][16][16]`(int16)→init때 int32 LUT.' },
      { file: 'av2/common/idct.c', line: 405, name: 'inv_txfm_ddtx_size4/8/16', lang: 'c',
        note: 'DDT = 학습/사전계산 행렬커널. inter 블록에서 ADST(DST7/DCT8)를 **DDTX/FDDT로 대체**. ROM `tx_kernel_ddtx_size4/8/16`(txb_common.h:43). `replace_adst_by_ddt`(blockd.h:2364)=inter·non-intrabc만.' },
    ],
    structs: [
      { name: 'TX_TYPE 패킹 / 언팩', file: 'av2/common/blockd.h', line: 2870,
        fields: [
          { f: 'PRIMARY_TX_BITS 4', d: '`tx_type & 0x0f` = 1차 변환' },
          { f: 'SECONDARY_TX_BITS 2', d: '`(tx_type>>4)&0x3` = IST 타입' },
          { f: 'SECONDARY_TX_SET_BITS 4', d: '`(tx_type>>6)&0xf` = IST 세트' },
        ],
        note: '한 32비트 워드에 1차+2차(IST)를 패킹. 1차 16종은 AV1과 동일 값.' },
      { name: 'TxfmParam', file: 'av2/common/idct.c', line: 877,
        fields: [
          { f: 'tx_type / sec_tx_type / sec_tx_set', d: '1차+IST 파라미터' },
          { f: 'tx_size / eob', d: '크기·유효계수수(IST는 eob override)' },
          { f: 'use_ddt / is_inter / intra_mode', d: 'DDT 대체·IST 조건 게이트' },
        ] },
      { name: 'dequant / 계수 버퍼', file: 'av2/common/blockd.h', line: 1509,
        fields: [
          { f: 'seg_dequant_QTX[MAX_SEGMENTS][2]', d: '세그먼트별 DC/AC dequant. **int32**(AV1 int16)' },
          { f: 'dqcoeff_block[plane]', d: '역양자화 계수(int32). IQT 입력' },
          { f: 'temp_dqcoeff[MAX_TX_SQUARE]', d: '블록 작업버퍼' },
        ] },
      { name: 'TX1D_TYPE / 커널 ROM', file: 'av2/common/enums.h', line: 716,
        fields: [
          { f: 'DCT2, IDT, DST7, DCT8', d: '기존 1D 커널' },
          { f: 'DDTX, FDDT', d: 'AV2 신규 데이터구동 커널' },
          { f: 'cctx_mtx / ist_*_kernel', d: 'CCTX 회전·IST 행렬 LUT' },
        ] },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '§7.15 2D 역변환 디스패치', cLine: 'inv_txfm_c / inv_transform_1d_c (idct.c:643/534)',
      kind: 'changed', delta: 'AV1 per-size 함수군(`av1_inv_txfm2d_add_WxH`)+함수포인터 → AV2 **통합 스위치** 구조.' },
    { specLine: '§7.15.2 1D 변환 종류', cLine: 'TX1D_TYPE {…, DDTX, FDDT} (enums.h:716)',
      kind: 'new', delta: 'AV1 DCT/ADST/IDTX에 **DDTX/FDDT(데이터구동)** 추가.' },
    { specLine: '§7.15.3 Secondary transform', cLine: 'av2_inv_stxfm (idct.c:1073)',
      kind: 'new', delta: 'AV1 **IST 없음**(grep inv_stxfm=0). TX_TYPE 상위비트 패킹, 1차 앞단 행렬변환.' },
    { specLine: '색차 결합 변환', cLine: 'av2_inv_cross_chroma_tx_block (idct.c:964)',
      kind: 'new', delta: 'AV1 **CCTX 없음**. U/V 2×2 회전, dequant 후·plane 역변환 전.' },
    { specLine: '§7.14.4 역양자화 값', cLine: 'seg_dequant_QTX (blockd.h:1509)',
      kind: 'changed', delta: 'AV1 **int16** → AV2 **int32**. + `QUANT_TABLE_BITS` 라운딩 추가.' },
    { specLine: '§7.14.4 양자화기 선택', cLine: 'tcq_quant / 2-pass dequant (decodetxb.c:935)',
      kind: 'new', delta: 'AV1 단일 dequant → AV2 **TCQ 2-pass**(상태로 Q0/Q1, ENT와 공유 상태).' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  DQU["dqcoeff U"] --> CCX["CCTX<br/>2×2 rotate"]\n' +
      '  DQV["dqcoeff V"] --> CCX\n' +
      '  DQY["dqcoeff Y"] --> ISTc["IST<br/>secondary (top-left)"]\n' +
      '  CCX --> ISTc\n' +
      '  ISTc --> P["primary 2D<br/>1D row → col<br/>(DDT replace)"]\n' +
      '  P --> ADD["clip + add<br/>→ prediction"]\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  class DQU mem;\n  class DQV mem;\n  class DQY mem;\n' +
      '  class CCX op;\n  class ISTc op;\n  class P op;\n  class ADD op;',
    throughput:
      '**가장 병렬친화 스테이지.** 1차 변환은 분리형(행 1D→열 1D, 버터플라이 파이프) → 픽셀 병렬, 고throughput. ' +
      'IST/CCTX는 작은 오버헤드(좌상단 계수·계수당 소수 곱). 64폭은 좌상단 32만 비영(zero-out+2배 복제)이라 연산 절감. ' +
      '직렬 리스크는 **TCQ 역양자화 2-pass**(상태 carried, ENT와 공유) — IQT 본체보다 엔트로피쪽 병목.',
    memory:
      '**커널 ROM 증가:** IST(`ist_4x4_kernel[14][3][16][16]`+8×8), DDT(`tx_kernel_ddtx_size4/8/16`), CCTX(`cctx_mtx[6][2]`) + 1차 1D 계수 ROM + QM. ' +
      'int16 ROM은 init때 **int32 LUT로 확장**(곱셈 폭↑). dequant·계수 모두 **int32**(AV1 int16) → datapath/버퍼 폭 확대. 블록버퍼 `MAX_TX_SQUARE`.',
    hazard:
      '대부분 **feed-forward(HW 친화)**. 단 두 곳:\n' +
      '1. **TCQ dequant 직렬 상태**(계수 스캔 순서 의존, ENT와 공유).\n' +
      '2. **CCTX U↔V 교차의존** — U·V dqcoeff가 **둘 다 준비**돼야 색차 역변환 진입(plane 독립성 깨짐).\n' +
      'IST→1차는 고정 2-스테이지 파이프.',
    parallel:
      '블록 단위 + 블록 내부(분리형 행/열, 계수 병렬) 모두 가능 — 디코더에서 가장 병렬화 쉬운 스테이지. ' +
      'AV2 추가분(IST/CCTX/DDT)은 **유한 행렬연산**이라 파이프 큰 훼손 없음. 단 CCTX가 U/V를 약간 직렬화.',
    av1delta:
      '- 2D 디스패치 **재구성**(per-size→통합).\n' +
      '- **추가:** IST 행렬 pre-stage(작은 MAC), CCTX 색차 join(2×2 회전), DDT 행렬커널(ROM/MAC↑), TCQ 2-pass dequant(직렬).\n' +
      '- **확대:** dequant·계수 int16→**int32**(곱셈/버퍼 폭).\n' +
      '- 1차 버터플라이 코어와 16 primary TX_TYPE은 **재사용 가능**.',
    openQ: [
      'IST·DDT 둘 다 행렬곱이고 **같은 IQT 모듈 안에서 한 블록 변환 중 순차** 발생 → IQT 모듈 내부 matmul 엔진 1개로 둘을 서비스 가능? (스테이지 간 공유가 아니라 **모듈 내 reuse** — 정당한 형태.)',
      'CCTX가 U/V 동시처리를 강제 → 색차 plane을 묶어 스케줄 vs dequant↔색차tx 사이 작은 회전유닛 삽입?',
      'DDT 학습행렬은 고정 ROM — 전 크기/세트 ROM 용량은? 전용 matmul 엔진의 PE 수/throughput 사이징.',
      'TCQ dequant 2-pass를 ENT에 흡수 vs IQT에서 파싱된 상태 읽어 별도 dequant 패스? (ENT 챕터의 경계 질문과 짝.)',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'AV2 역변환에서 IST는 1차 변환의 앞인가 뒤인가, 어디에 적용되나?',
      a: '**1차 변환 앞단.** `av2_inverse_transform_block`이 `av2_inv_stxfm`(IST)를 먼저 돌리고(좌상단 저주파 계수 16/64개에 작은 행렬변환) 그 다음 `inv_txfm_c`로 1차 2D 역변환. TX_TYPE 상위비트로 신호.',
      hint: 'idct.c:1019 순서를 보라.' },
    { q: 'CCTX가 HW 파이프에서 만드는 의존성은?',
      a: 'U·V 색차 계수를 2×2 회전으로 결합 → **U와 V dqcoeff가 둘 다 준비돼야** 색차 역변환에 들어갈 수 있다. plane 독립 처리가 깨지는 교차의존 join point.',
      hint: '회전식은 c1,c2를 동시에 입력으로 받는다.' },
    { q: 'IQT가 ENT보다 병렬화가 쉬운 이유와, 그래도 남는 직렬 요소는?',
      a: '1차 변환이 분리형(행/열 독립 버터플라이)+계수 병렬이라 파이프라인·픽셀병렬 용이. 남는 직렬 = **TCQ 역양자화**(계수 상태 carried, 엔트로피와 공유)와 CCTX의 U/V join.',
      hint: 'feed-forward vs carried-state.' },
  ],
  quiz: [
    { q: 'AV2 2D 역변환 디스패치의 실제 파일은?',
      options: ['av2/common/av2_inv_txfm2d.c', 'av2/common/idct.c', 'av2/decoder/decodetxb.c', 'av2/common/secondary_tx.c'],
      answer: 1, why: '`inv_txfm_c`/`av2_inverse_transform_block`는 idct.c. av2_inv_txfm2d.c는 IWHT4x4 lossless만.' },
    { q: 'IST(2차변환)는 TX_TYPE의 어디에 신호되나?',
      options: ['하위 4비트', '상위비트(>>4 type, >>6 set)', '별도 syntax element', 'tx_size에 패킹'],
      answer: 1, why: '`get_secondary_tx_type=(tx_type>>4)&0x3`, `get_secondary_tx_set=(tx_type>>6)&0xf`.' },
    { q: 'CCTX는 무엇을 하나?',
      options: ['루마-색차 예측', 'U/V 계수 2×2 회전(decorrelation)', '색차 업샘플', 'CfL 대체'],
      answer: 1, why: '`av2_inv_cross_chroma_tx_block`: U/V dequant 계수를 `[cosθ,sinθ]` 행렬로 회전.' },
    { q: 'AV2에서 dequant 값/계수의 비트폭 변화는?',
      options: ['int8 유지', 'int16 → int32', 'int32 → int16', 'float 사용'],
      answer: 1, why: '`seg_dequant_QTX`가 AV1 int16 → AV2 int32. 곱셈/버퍼 폭 확대.' },
  ],

  chapters: [
    { id: 'i1', n: 1, title: 'Dequantization', stage: 'skeleton',
      fn: { name: 'get_dqv / dq_coeff apply', file: 'av2/decoder/decodetxb.c', line: 142,
        role: 'Per-coefficient dequant during parsing: level × dqv (DC/AC, optional QM), round by QUANT_TABLE_BITS, >> tx_scale. TCQ defers it to a 2nd reverse pass.' },
      spec: { num: '7.14.4', title: 'Dequantization process' },
      qna: [
        { tag: 'common', ref: 'decodetxb.c:142',
          q: '역양자화 기본식과 DC/AC 구분은? (AV1 공통)',
          a: '`dq = level × dqv`. dqv는 `dequant[!!coeff_idx]` — coeff_idx==0(DC)→`dequant[0]`, 그 외(AC)→`dequant[1]`. 저장은 `seg_dequant_QTX[seg][2]`로 **세그먼트별 DC/AC 2값**. 구조는 AV1과 동일.' },
        { tag: 'common', ref: 'avm_dsp_common.h:55',
          q: 'Quant-matrix(QM) 가중은 어떻게 들어가나? (AV1 공통)',
          a: '`iqmatrix`가 있으면 계수별로 `dqv = (iqmatrix[idx]·dqv + 2^4) >> 5` (`AVM_QM_BITS=5`). 주파수 위치별 dequant 미세조정 — AV1에도 있던 메커니즘. `iqmatrix==NULL`이면 곱셈 생략(fast path).' },
        { tag: 'common', ref: 'idct.c:761',
          q: '최종 스케일 shift와 포화는? (AV1 공통)',
          a: '`shift = av2_get_tx_scale = (pels>256)+(pels>1024)` ∈ {0,1,2} — TX 면적 클수록 우하향 1·2비트. **AV1과 동일 공식.** 끝에 `clamp(±(1<<(7+bd)))` = **8+bd 비트**로 포화.' },
        { tag: 'delta', ref: 'blockd.h:1509',
          q: 'dequant 값 비트폭이 AV1과 어떻게 달라졌나? (AV2 델타)',
          a: '`seg_dequant_QTX`가 AV1 **int16 → AV2 int32** (blockd.h:1509 vs aom blockd.h:476, 실측). 곱셈기·계수버퍼 datapath 폭 확대.' },
        { tag: 'delta', ref: 'avm_dsp_common.h:53',
          q: 'AV2가 추가한 고정밀 라운딩 단계는? (AV2 델타)',
          a: '`ROUND_POWER_OF_TWO_64(level·dqv & 0xffffff, QUANT_TABLE_BITS=3) >> shift`. 곱을 **24비트 마스크 → 3비트 라운딩 → tx_scale shift** 순. AV1엔 `QUANT_TABLE_BITS` 자체가 없음(aom grep=0, 실측).' },
        { tag: 'delta', ref: 'decodetxb.c:935',
          q: 'TCQ면 역양자화가 왜 2-pass로 갈라지나? (AV2 델타)',
          a: 'tcq_mode면 파싱 1-pass는 dequant 안 하고 **부호 있는 raw level**만 tcoeffs에 저장(:912). 별도 2-pass(:935)가 **역스캔**으로 FSM 재생: `Qx=tcq_quant(state)`, `qIdx=max(0, 2·level − Qx)`, dequant 후 `>> (shift+1)` (×2 보정 1비트 추가). 비-TCQ는 파싱 안 inline 1-pass.' },
        { tag: 'hw', ref: 'decodetxb.c:621',
          q: '역양자화는 파이프라인상 ENT인가 IQT인가?',
          a: '코드상 dequant는 **계수 파싱 루프 안**(decodetxb.c = 엔트로피 스테이지)에서 수행 → `dqcoeff_block[plane]`(int32)이 **ENT→IQT 핸드오프 버퍼**. IQT 본체는 이 버퍼를 입력으로 받음. 곱셈기를 ENT에 둘지 IQT 선두에 둘지가 경계 설계 질문.' },
        { tag: 'hw', ref: 'decodetxb.c:957',
          q: 'TCQ 2-pass가 만드는 HW 직렬성은?',
          a: '2-pass는 역스캔으로 **FSM state를 carry**(`state=tcq_next_state(state, level)`) → 계수 간 순차 의존. 비-TCQ feed-forward 단일패스 대비 직렬 병목. 단 곱셈·라운딩 **산술 datapath 자체는 동일**하니 두 패스가 같은 곱셈기 재사용 가능(상태머신만 추가).' },
      ] },
    { id: 'i2', n: 2, title: 'TX_TYPE packing (IST signaling)', stage: 'skeleton',
      fn: { name: 'get_primary/secondary_tx_type', file: 'av2/common/blockd.h', line: 2870,
        role: 'One TX_TYPE word packs primary (4b) | IST type (2b) | IST set (4b); unpack gates primary kernel + whether/which secondary transform fires.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      qna: [
        { tag: 'common', ref: 'blockd.h:2870',
          q: '1차 변환 타입은 TX_TYPE 어디서 뽑나? (AV1 공통)',
          a: '`get_primary_tx_type = tx_type & 0x000f` — **하위 4비트 = 16종 1차변환**(DCT_DCT…IDTX). 이 값은 **AV1 16종 enum과 동일** → AV1 1차 변환 디코드 로직을 그대로 재사용.' },
        { tag: 'delta', ref: 'blockd.h:2843',
          q: 'AV2는 TX_TYPE 워드를 어떻게 오버로드했나? (AV2 델타)',
          a: '한 워드에 packing: `[3:0]` primary(`PRIMARY_TX_BITS=4`) | `[5:4]` **IST type**(`>>4 & 0x3`, 2b) | `[9:6]` **IST set**(`>>6 & 0xf`, 4b). 총 10비트 사용. `set_secondary_tx_type/set`이 상위비트에 OR로 얹음.' },
        { tag: 'delta', ref: 'aom blockd.h (none)',
          q: '이 패킹이 AV1에도 있나? (AV2 델타)',
          a: '**아니오 — AV1엔 packing 자체가 없음**(aom grep: `PRIMARY_TX_BITS`/`get_secondary_*` = 0건, 실측). AV1 TX_TYPE은 평범한 0..15 enum. AV2는 **하위 4비트를 AV1 호환**으로 유지하면서 안 쓰던 상위비트에 IST(type+set)를 얹은 것 — backward-compatible 확장.' },
        { tag: 'hw', ref: 'blockd.h:2972',
          q: '언팩이 HW에서 실제로 하는 일은?',
          a: 'shift/mask는 trivial combinational이지만 **3-way 디먹스/게이트** 역할: 하위4 → 1차 1D 커널쌍(행/열) 선택, IST type/set → **IST 발화 여부 + 커널뱅크** 선택. 한 워드가 datapath 제어 3갈래로 fan-out, 블록 setup 시점에 디코드.' },
        { tag: 'hw', ref: 'blockd.h:2983',
          q: 'IST set/type는 ROM 주소로 어떻게 쓰이나?',
          a: 'secondary set(4b, ~16) + type(2b, ~4)가 IST 커널뱅크 `ist_4x4_kernel[14][3][…]`(14 set·3 class 사용)의 **bank+index 주소**. 하위 호환이라 1차 변환 ROM 경로는 불변, **IST ROM만 순수 추가**.' },
      ] },
    { id: 'i3', n: 3, title: '⭐ CCTX (cross-chroma 2×2 rotate)', stage: 'skeleton',
      fn: { name: 'av2_inv_cross_chroma_tx_block', file: 'av2/common/idct.c', line: 964,
        role: 'Rotate U/V dequant coeffs by a 2×2 matrix [cosθ,sinθ]·256, round, clamp. 4 mults/coeff.' },
      spec: { num: '7.14.3', title: 'Reconstruct process (CCTX)' },
      io: {
        diagCaption: 'U/V 2×2 rotation — cross-plane join',
        diagram: 'graph TD\n' +
          '  U["dqcoeff U<br/>int32[ncoeff]"] --> R["2×2 rotate<br/>4 mul/coeff"]\n' +
          '  V["dqcoeff V<br/>int32[ncoeff]"] --> R\n' +
          '  ROM["cctx_mtx[6][2]<br/>[cosθ,sinθ]·256"] --> R\n' +
          '  R --> UO["U&#39; → IST/2D"]\n' +
          '  R --> VO["V&#39; → IST/2D"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class U mem;\n  class V mem;\n  class ROM rom;\n  class R op;\n  class UO op;\n  class VO op;',
        in: [
          { sig: 'c1 (U)', type: 'tran_low_t int32[ncoeff]', peer: 'dqcoeff U buffer', vol: '≤ TX area', note: 'in-place RMW' },
          { sig: 'c2 (V)', type: 'tran_low_t int32[ncoeff]', peer: 'dqcoeff V buffer', vol: '≤ TX area', note: 'cross-plane join — both must be ready' },
          { sig: 'cctx_type', type: 'CctxType enum', peer: '← parse', vol: '1/block', note: 'selects 1 of 6 angles' },
          { sig: 'cctx_mtx', type: 'int[6][2] ([cosθ,sinθ]·256)', peer: 'ROM', vol: '2 coeffs/type', note: 'rotation matrix' },
        ],
        out: [
          { sig: "c1'/c2'", type: 'int32 (rotated, clamped 8+bd)', peer: '→ IST / 2D inv-tx', vol: 'same buffers', note: '4 mults/coeff, ROUND>>CCTX_PREC_BITS' },
        ],
        note: 'Breaks plane independence: the U and V coeff buffers are read **together**. Schedule chroma as a pair, or insert a small rotate unit between dequant and the per-plane transform.',
      },
      qna: [
        { tag: 'delta', ref: 'idct.c:964',
          q: 'CCTX는 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**U/V 색차 계수쌍에 2×2 회전**을 거는 cross-chroma transform — 색차 잔차의 U↔V 상관을 제거(decorrelation). `av2_inv_cross_chroma_tx_block`. **AV1엔 전무**(aom grep `cross_chroma`/`cctx_mtx` = 0건, 실측).' },
        { tag: 'verified', ref: 'idct.c:975',
          q: '정확한 회전 연산은? (실측)',
          a: '계수마다: `tmp0 = cos·U − sin·V`, `tmp1 = sin·U + cos·V` → `ROUND_POWER_OF_TWO_SIGNED_64(·, CCTX_PREC_BITS=8)` → `clamp(8+bd)`. = **Givens 회전** R(θ)=[cos,−sin; sin,cos]의 역(디코더는 인코더 forward 회전의 역). 계수당 **4곱 2가감 2라운드 2클램프**.' },
        { tag: 'delta', ref: 'av2_txfm.c:65',
          q: '각도 종류와 행렬 ROM은? (AV2 신규)',
          a: '**6각도**: 45°(=Haar), 30°, 60°, −45°, −30°, −60°. `cctx_mtx[6][2]`에 `(cos,sin)·256`만 저장(45°={181,181}=256·0.707). per-block `cctx_type`(parse)로 1개 선택. ROM은 12개 int뿐.' },
        { tag: 'delta', ref: 'idct.c:969',
          q: 'CCTX는 전 계수에 거나, 좌상단만? 파이프 위치는? (AV2 신규)',
          a: '`ncoeffs = av2_get_max_eob(tx_size)` — **블록 전 계수**에 적용(IST의 좌상단-only와 대비). 위치: **dequant → CCTX → IST → 1차 2D**. dequant 직후·plane별 역변환 직전.' },
        { tag: 'hw', ref: 'idct.c:966',
          q: 'CCTX가 만드는 HW 의존성은?',
          a: '루프가 `src_c1`(U)·`src_c2`(V)를 **둘 다 읽고 둘 다 쓴다**(in-place lockstep) → **U·V dqcoeff가 모두 준비돼야** 진입. plane 독립성이 깨지는 **cross-plane join point**. 색차 2 plane을 묶어 스케줄하거나 dequant↔plane-tx 사이에 작은 rotate 유닛 삽입.' },
        { tag: 'hw', ref: 'av2_txfm.c:65',
          q: 'CCTX 회전유닛의 HW 비용은?',
          a: '계수당 **4 int32×int32→int64 곱** + 2가감 = 고정 2×2 MAC. 작지만 색차 전 계수에 걸림. 6각도는 12-int ROM에서 cos/sin 2값만 읽으면 됨 → 회전유닛은 **계수쌍 단위 파이프**로 깔끔히 흐름(feed-forward, 단 U/V 동기).' },
      ] },
    { id: 'i4', n: 4, title: 'Inverse transform entry', stage: 'skeleton',
      fn: { name: 'av2_inverse_transform_block', file: 'av2/common/idct.c', line: 998,
        role: 'eob skip → init_txfm_param → memcpy to temp → IST pre-stage → primary 2D add-to-prediction.' },
      spec: { num: '7.15', title: 'Inverse transform process' },
      qna: [
        { tag: 'common', ref: 'idct.c:1003',
          q: 'entry가 공통으로 하는 일은? (AV1 공통)',
          a: '`if (!eob) return` — **빈 블록 스킵**(유효계수 0이면 변환 안 함). 끝은 `av2_highbd_inv_txfm_add_master` = **1차 2D 역변환 + 예측에 가산**(reconstruct). 이 "역변환→예측가산" 골격은 AV1과 동일.' },
        { tag: 'delta', ref: 'idct.c:1016',
          q: 'AV2가 entry에 끼워넣은 단계는? (AV2 델타)',
          a: '`memcpy(temp_dqcoeff, dqcoeff, …)` → `av2_inv_stxfm(temp_dqcoeff, …)` = **IST 사전단**을 1차 변환 *앞*에 삽입. AV1은 dqcoeff→1차 2D로 직행했지만 AV2는 **계수를 작업버퍼로 복사 후 IST부터** 돌림.' },
        { tag: 'verified', ref: 'idct.c:1019',
          q: 'IST와 1차 변환의 실제 순서는? (실측)',
          a: '`av2_inv_stxfm`(:1019) 호출이 `av2_highbd_inv_txfm_add_master`(:1037)보다 **먼저** → **secondary(IST) → primary(2D)** 고정 순서. IST는 `temp_dqcoeff` 위에서 in-place로 좌상단 저주파 계수만 갱신.' },
        { tag: 'hw', ref: 'idct.c:1015',
          q: 'entry의 HW 파이프 구조는?',
          a: '**고정 2-스테이지 파이프: IST → 1차 2D.** 사이에 `temp_dqcoeff[MAX_TX_SQUARE]` = **블록 스크래치 SRAM**(IST 출력→1차 입력 버퍼). `init_txfm_param`은 per-block 제어 번들(tx_type/sec_tx_type/sec_tx_set/eob/use_ddt) 디코드 — 이전 블록과 파이프되면 지연 은닉.' },
        { tag: 'hw', ref: 'decodeframe.c:470',
          q: '이 entry 시점에 CCTX는 끝났나? plane 독립성은?',
          a: '**CCTX는 상류**(`inverse_cctx_block_visit`, 블록-visit 레벨)에서 이미 끝남 → 이 per-plane entry에 올 땐 **plane이 다시 독립**. 즉 파이프 전체: dequant(ENT) → CCTX(색차 join) → [plane별] {IST → 1차 2D → 가산}. lossless DPCM(V/H_PRED)만 1D-only vert/horz 분기 추가.' },
      ] },
    { id: 'i5', n: 5, title: '⭐ IST secondary transform', stage: 'skeleton',
      fn: { name: 'av2_inv_stxfm', file: 'av2/common/idct.c', line: 1073,
        role: 'Secondary transform on top-left low-freq coeffs (4×4/8×8) via learned int16 kernel; scatter back by IST scan.' },
      spec: { num: '7.15.3', title: 'Secondary transform process' },
      io: {
        diagCaption: 'gather → dense matmul → scatter',
        diagram: 'graph TD\n' +
          '  IN["top-left coeffs<br/>16 (4×4) / 48 (8×8, reduced)"] --> G["gather<br/>(primary scan)"]\n' +
          '  G --> MM["dense matmul<br/>K · x"]\n' +
          '  ROM["ist kernel LUT<br/>[type][class] int32"] --> MM\n' +
          '  MM --> S["scatter back<br/>(IST scan)"]\n' +
          '  S --> OUT["coeffs&#39; → primary 2D"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class IN mem;\n  class OUT mem;\n  class ROM rom;\n  class G op;\n  class MM op;\n  class S op;',
        in: [
          { sig: 'coeffs (low-freq)', type: 'tran_low_t int32', peer: 'temp_dqcoeff (after CCTX)', vol: '16 (4×4) / 48 (8×8 reduced)', note: 'gathered by primary scan order' },
          { sig: 'set / stx_type / size_class', type: 'int', peer: '← sec_tx_set + TX_TYPE', vol: '1/block', note: 'set=mode_t, stx_idx=stx_type−1 (3 nonzero), class∈{0..3}' },
          { sig: 'ist_kernel', type: 'int16 ist_4x4_kernel[SET][3][16][16] / ist_8x8', peer: 'ROM', vol: '[8×16] used (4×4); reduced for 8×8', note: 'dense int16 matrix, round>>7' },
        ],
        out: [
          { sig: "coeffs'", type: 'int32 (scattered, clamp 8+bd)', peer: '→ primary 2D inv-tx', vol: 'same positions', note: 'gather→matmul→scatter (transpose for H-modes), runs before primary' },
        ],
        note: 'Dense small matrix-multiply. Legitimate reuse is **within the IQT module** — IST and DDT (i8) are both dense matmuls and run sequentially inside one block transform, so one matmul engine can serve both. (NOT cross-stage sharing — each pipe stage stays a dedicated module.)',
      },
      qna: [
        { tag: 'delta', ref: 'idct.c:1073',
          q: 'IST는 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**Secondary(2차) 변환** — 1차 변환 앞단에서 **좌상단 저주파 계수**에 작은 학습행렬을 곱해 잔여 상관 제거. `av2_inv_stxfm`. **AV1엔 전무**(aom idct.c grep `inv_stxfm`/`ist_*_kernel`=0건, 실측). gather→dense matmul→scatter 구조.' },
        { tag: 'verified', ref: 'idct.c:1088',
          q: 'IST 크기와 gather 방식은? (실측)',
          a: '두 크기: `sb_size = (w≥8 && h≥8) ? 8 : 4`. **4×4**는 `IST_4x4_WIDTH=16`개, **8×8**은 `IST_8x8_WIDTH=48`개(reduced) 계수를 **1차 변환 scan 순서로** 모음(`buf0[r]=src[scan[r]]`) — IST 스캔을 primary와 정렬. w·h는 32로 clamp.' },
        { tag: 'verified', ref: 'idct.c:1043',
          q: 'IST 행렬곱의 실제 연산은? (실측)',
          a: '`inv_stxfm_c`: `out[j] = Σ_i src[i]·kernel[i·W+j]` → `ROUND_POWER_OF_TWO_SIGNED(resi, 7)` → `clamp(8+bd)`. **dense 행렬-벡터곱**(버터플라이 아님). 4×4 커널 `[IST_4x4_HEIGHT=8][16]` — 역변환은 압축된 8계수를 16으로 **확장**.' },
        { tag: 'delta', ref: 'secondary_tx.h:313',
          q: 'IST 커널 선택과 ROM은? (AV2 신규)',
          a: '`ist_4x4_kernel[IST_4x4_SET_SIZE][STX_TYPES−1=3][16][16]` int16 + `ist_8x8_kernel`. 주소 = `set(=sec_tx_set)` × `stx_idx(=stx_type−1, 3종)` × `size_class∈{0..3}`(크기+DCT_DCT). **모드 의존 행렬뱅크**.' },
        { tag: 'delta', ref: 'idct.c:1108',
          q: 'intra 모드가 IST에 어떻게 개입하나? (AV2 신규)',
          a: 'H 계열 모드(`H_PRED`/`D157`/`D67`/`SMOOTH_H`)면 `transpose=1` → **전치된 IST scan**(`stx_scan_orders_transpose_*`)으로 산포. inter면 `intra_mode=DC_PRED`로 고정. 즉 IST 커널/스캔이 **예측 모드와 결합**.' },
        { tag: 'hw', ref: 'idct.c:1043',
          q: 'IST의 HW 형태와 모듈 내 reuse는?',
          a: '**작은 dense MAC 어레이**(gather/scatter 퍼뮤테이션 + K·x). 블록당 1회, 1차 변환 앞에서 temp 버퍼 위 실행. **정당한 reuse는 IQT 모듈 내부** — IST와 DDT(i8)가 둘 다 dense matmul이고 한 블록 변환 중 순차 발생 → matmul 엔진 1개로 둘 서비스 가능. (스테이지 간 공유 아님 — 각 파이프 단은 전용 모듈 유지.)' },
        { tag: 'hw', ref: 'idct.c:1115',
          q: 'gather/scatter 스캔의 HW 비용은?',
          a: '`stx_scan_orders_4x4/8x8` + 전치판 4종 = **퍼뮤테이션 네트워크** 주소생성. ROM 뱅크는 `[set][type][size_class]`로 어드레싱. 좌상단만 건드리므로 나머지 계수는 bypass(1차 변환이 그대로 받음).' },
      ] },
    { id: 'i6', n: 6, title: '2D inverse transform core', stage: 'skeleton',
      fn: { name: 'inv_txfm_c', file: 'av2/common/idct.c', line: 643,
        role: 'Separable 2D: split into row/col 1D, sqrt2 rescale → row pass → col pass → clip-add. >32 = compute 32 + 2× duplicate.' },
      spec: { num: '7.15.4', title: '2D inverse transform process' },
      qna: [
        { tag: 'common', ref: 'idct.c:669',
          q: '분리형 2D의 기본 흐름은? (AV1 공통)',
          a: '2D tx_type를 행/열 1D로 분해(`g_hor_tx_type`/`g_ver_tx_type`) → `inv_transform_1d_c`로 **행 pass**(height 줄) → tmp 버퍼 경유 → **열 pass**(width 줄) → 마지막 `highbd_clip_pixel_add`로 예측 가산. 패스 사이 `inv_tx_shift[tx_size][0/1]` 스케일. 골격은 AV1과 동일.' },
        { tag: 'common', ref: 'idct.c:701',
          q: 'sqrt2 직사각 보정이란? (AV1 공통)',
          a: '`sqrt2 = (log2width+log2height) & 1` — 가로·세로 log합이 홀수(=비정사각 변환)면 입력 전체에 `NewInvSqrt2` 곱(round_shift). 직사각 변환의 √2 이득 보정. AV1에도 있던 메커니즘.' },
        { tag: 'common', ref: 'idct.c:732',
          q: '64폭/64높이는 어떻게 처리하나? (AV1 공통)',
          a: '`skipWidth/skipHeight = dim>32 ? dim−32 : 0` — **좌상단 32만 비영**(고주파 zero-out). 32로 변환 후 행/열을 **각 2배 복제**(`block[y·2w+2x]=block[…+1]=tmp`)로 64 확장. 64×64는 실연산 ¼. AV1-common.' },
        { tag: 'delta', ref: 'idct.c:643',
          q: 'AV1 대비 디스패치 구조 변화는? (AV2 델타)',
          a: 'AV1 **per-size 함수군**(`av1_inv_txfm2d_add_WxH` + 함수포인터)을 AV2는 **단일 `inv_txfm_c` 통합 스위치**로 재구성. lossless는 `av2_highbd_iwht4x4_add`로 분기(이건 av2_inv_txfm2d.c).' },
        { tag: 'delta', ref: 'idct.c:672',
          q: 'DDT 치환이 2D 코어 어디서 일어나나? (AV2 델타)',
          a: '1D 패스 *전*에 게이트: `use_ddt`이고 행/열 타입이 `DST7`/`DCT8`이며 size∈{4,8,16}(`REPLACE_ADST*`)이면 **DST7→DDTX, DCT8→FDDT**로 교체(`tx_type_row/col` 재지정). 즉 ADST 자리를 학습커널로 바꿔치기. (실연산은 i8.)' },
        { tag: 'hw', ref: 'idct.c:719',
          q: '2D 코어의 HW 구조는?',
          a: '고전적 **행 1D → 전치 → 열 1D 파이프**. `block`/`tmp` 더블버퍼(각 `MAX_TX_SQUARE`)가 **전치/중간 SRAM**. 중간 정밀도 `bd+8`비트(`clamp_buf`), 최종 `bd`로 clip-add(reconstruct 지점). 64는 ¼ 연산 + 2배복제 제어. 가장 병렬친화 — feed-forward, hazard 없음.' },
      ] },
    { id: 'i7', n: 7, title: '1D kernels (DCT2 / ADST / IDTX + DDTX/FDDT)', stage: 'skeleton',
      fn: { name: 'inv_transform_1d_c', file: 'av2/common/idct.c', line: 534,
        role: 'Two-level switch size_index(4/8/16/32) × tx_type_index(DCT2/IDTX/ADST/FDST/DDTX/FDDT) → per-(size,type) kernel.' },
      spec: { num: '7.15.2', title: '1D transforms' },
      qna: [
        { tag: 'common', ref: 'idct.c:534',
          q: '1D 디스패치 구조는? (AV1 공통)',
          a: '2단 스위치: `size_index`(0..3 = **4/8/16/32**) × `tx_type_index`. type 0~3 = **DCT2 / IDTX / ADST(DST7) / FDST** = 버터플라이 커널 — AV1에서 물려받은 1D 셋. 각 `inv_txfm_<type>_size<N>_c` 호출.' },
        { tag: 'delta', ref: 'idct.c:557',
          q: '어떤 1D 타입이 AV2에서 추가됐나? (AV2 델타)',
          a: 'type **4 = DDTX**, **5 = FDDT** — 데이터구동(학습) 커널 추가(size 4/8/16에만). AV1은 DCT/ADST/FlipADST/IDTX 4종이었고, AV2는 여기에 2종을 더해 ADST 자리를 대체 가능하게 함.' },
        { tag: 'common', ref: 'idct.c:629',
          q: 'size 32는 왜 타입이 적나? (AV1 공통)',
          a: 'size_index 3(=32)는 **DCT2·IDTX만** 지원(case 0/1, 나머지 assert). 큰 변환은 DCT/IDTX로 제한 — AV1과 동일한 제약(ADST·DDT는 ≤16에서만).' },
        { tag: 'hw', ref: 'idct.c:557',
          q: '1D datapath가 균일하지 않은 이유는?',
          a: '⭐ DCT2/IDTX/ADST/FDST는 **fast butterfly** O(N log N)이지만, **DDTX/FDDT(case 4/5)는 `inv_txfm_ddtx_*`(idct.c:405) = dense matmul** O(N²)로 라우팅. 즉 1D 디스패치가 **4타입→버터플라이, 2타입→matmul 유닛**으로 갈라짐 → 단일 균일 datapath로 못 묶음.' },
        { tag: 'hw', ref: 'idct.c:534',
          q: '버터플라이 유닛 구성·ROM은?',
          a: 'reconfigurable 버터플라이 1개 vs per-(size,type) 전용 유닛 trade-off. 버터플라이 변형 = 4타입 × {4,8,16} + 2타입 × {32} ≈ 14종 + size별 계수 ROM. DDTX/FDDT는 별도 matmul+학습행렬 ROM(i8)으로 빠짐.' },
      ] },
    { id: 'i8', n: 8, title: 'DDT data-driven kernels', stage: 'skeleton',
      fn: { name: 'inv_txfm_ddtx / fddt', file: 'av2/common/idct.c', line: 405,
        role: 'Learned matrix kernels (DDTX/FDDT) replacing ADST for inter blocks (replace_adst_by_ddt).' },
      spec: { num: '7.15.2', title: '1D transforms (DDT)' },
      io: {
        in: [
          { sig: 'coeff line (1D)', type: 'int32', peer: '← row/col stage buffer', vol: 'size 4/8/16', note: 'replaces ADST, inter-only' },
          { sig: 'ddt_kernel', type: 'int32 (tx_kernel_ddtx_size4/8/16)', peer: 'ROM', vol: 'N×N dense', note: 'learned matrix, not a butterfly' },
        ],
        out: [
          { sig: 'residual line', type: 'int32', peer: '→ 2D accumulate', vol: 'size N', note: 'dense matmul → O(N²) vs butterfly O(N log N)' },
        ],
        note: 'Like IST, a **dense matmul** — the cost/benefit vs the fast butterfly path is the HW question. Inter-only ⇒ utilization depends on frame type.',
      },
      qna: [
        { tag: 'delta', ref: 'idct.c:405',
          q: 'DDT는 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**Data-Driven Transform** — 학습/사전계산된 행렬 커널(DDTX/FDDT)이 inter 블록에서 **ADST(DST7/DCT8)를 대체**. 버터플라이가 아니라 **dense N×N 행렬곱**. **AV1엔 전무**(aom idct.c grep `ddtx`/`DDTX`=0건, 실측).' },
        { tag: 'verified', ref: 'idct.c:412',
          q: 'DDT 1D 커널의 실제 연산은? (실측)',
          a: '`dst[j·line+i] = clamp((Σ_k src[i·N+k]·tx_mat[k·N+j] + offset) >> shift)`, `tx_mat = tx_kernel_ddtx_sizeN[INV_TXFM][0]`. **line당 N²곱**(O(N²), 버터플라이 O(N log N) 대비). 출력 인덱스 `j·line+i` = **전치 write**(2D 파이프의 전치를 커널이 흡수).' },
        { tag: 'delta', ref: 'av2_txfm.h:43',
          q: 'DDT는 언제 ADST를 대체하나? (AV2 신규)',
          a: '게이트 `replace_adst_by_ddt`(blockd.h:2364, **inter + enable_inter_ddt**) + 매크로 `REPLACE_ADST4=0 / ADST8=1 / ADST16=1` → 실제 활성은 **inter·size 8·16**(size4는 정의돼도 OFF). 매핑: `DST7→DDTX`, `DCT8→FDDT`. intra·intrabc는 제외.' },
        { tag: 'delta', ref: 'txb_common.h:43',
          q: 'DDT 커널 ROM 구성은? (AV2 신규)',
          a: '`tx_kernel_ddtx_size4/8/16[TXFM_DIRECTIONS][N][N]` int32. 역변환은 `[INV_TXFM]` 방향. 크기 = 4²+8²+16² = **336 int/방향** — ROM 자체는 작지만 N² MAC throughput이 필요.' },
        { tag: 'hw', ref: 'idct.c:412',
          q: 'DDT의 HW 비용과 모듈 내 reuse는?',
          a: 'dense **O(N²)** vs 버터플라이 O(N log N): N=16이면 **256 vs ~64 MAC = 4×**. 전용 matmul 유닛, 혹은 **IQT 모듈 내 IST와 matmul 엔진 공유**(둘 다 dense matmul, 한 블록 변환 중 순차 → 정당한 모듈 내 reuse). 스테이지 간 공유는 아님.' },
        { tag: 'hw', ref: 'av2_txfm.h:43',
          q: 'DDT 유닛의 활용률(utilization)은?',
          a: 'inter-only + size 8/16 게이트 → **프레임 타입·tx_size에 따라 가동률 변동**. intra/키프레임에선 idle. 전용 유닛이면 면적 낭비 위험 → IST와 공유하거나 작게 두고 throughput만 맞추는 사이징 판단 필요.' },
      ] },
    { id: 'i9', n: 9, title: 'HW synthesis (IQT stage)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Tie it together: most parallel decoder stage; dense-matmul subset (IST/DDT) reused within the module; serial wrinkles = TCQ-dequant + CCTX join.' },
      figures: [
        { title: 'IQT stage — full dataflow (dequant → CCTX → IST → primary 2D)',
          mermaid:
'graph TD\n' +
'  DQ["dequant<br/>(inside ENT loop)<br/>int32 × dqv, QM, TCQ 2-pass"] --> CCX["CCTX<br/>U/V 2×2 rotate<br/>cross-plane join"]\n' +
'  CCX --> TMP["temp_dqcoeff<br/>MAX_TX_SQUARE scratch"]\n' +
'  TMP --> IST["IST secondary<br/>dense matmul (top-left)"]\n' +
'  IST --> ROW["1D row pass<br/>butterfly / DDT"]\n' +
'  ROW --> TR["tmp transpose buf"]\n' +
'  TR --> COL["1D col pass<br/>butterfly / DDT"]\n' +
'  COL --> ADD["clip-add → prediction"]\n' +
'  KROM["kernel ROM<br/>1D coeff + IST + DDT + cctx_mtx + QM"] --> IST\n' +
'  KROM --> ROW\n' +
'  KROM --> COL\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
'  class TMP mem;\n  class TR mem;\n  class KROM rom;\n' +
'  class CCX hot;\n  class DQ hot;\n  class IST op;\n  class ROW op;\n  class COL op;\n  class ADD op;',
          caption: 'Feed-forward except two wrinkles (red): TCQ-dequant 2-pass (carried state, shared with ENT) and CCTX (U/V must both be ready). IST and the primary 1D passes draw from one kernel ROM.' },
      ],
      qna: [
        { tag: 'hw',
          q: 'IQT 스테이지 전체 파이프를 한 줄로?',
          a: '`dequant`(ENT 루프 내, int32×dqv·QM·TCQ) → `CCTX`(색차 U/V 2×2 회전, join) → `temp_dqcoeff` → `IST`(2차 dense matmul, 좌상단) → `1차 2D`(행 butterfly/DDT → 전치 → 열) → `clip-add 예측가산`. **디코더에서 가장 병렬친화** 스테이지.' },
        { tag: 'hw',
          q: 'IQT의 직렬 병목 2곳은?',
          a: '나머지는 전부 feed-forward, 단 **(1) TCQ dequant 2-pass**(i1 — 역스캔 carried state, ENT와 공유)와 **(2) CCTX U/V cross-plane join**(i3 — 두 plane 모두 준비 필요). 이 둘만 순차성/동기 제약을 만들고, 1차 변환·IST는 hazard 없는 파이프.' },
        { tag: 'hw',
          q: 'dense-matmul은 어디고, 모듈 내 reuse 범위는?',
          a: '**IST(i5)와 DDT(i8)만 O(N²) dense matmul**, 나머지(DCT2/IDTX/ADST/FDST)는 fast butterfly. IST·DDT는 **한 블록 변환 중 순차** 발생 → **IQT 모듈 내부 matmul 엔진 1개로 둘 서비스** 가능(정당한 stage 내 reuse). ⚠️ 스테이지 간(다른 모드와) MAC 공유는 streaming 동시가동이라 불가 — 각 파이프 단은 전용 모듈.' },
        { tag: 'hw',
          q: 'IQT 커널 ROM 예산은?',
          a: '① 1D 버터플라이 계수(size별) ② IST `ist_4x4[set][3][16][16]`+`ist_8x8` int16 ③ DDT `tx_kernel_ddtx_size4/8/16` 336 int/방향 ④ CCTX `cctx_mtx[6][2]` 12 int ⑤ QM. IST가 ROM 비중 최대(set×type×class×N²).' },
        { tag: 'delta',
          q: 'AV1 대비 IQT 변경 요약은? (델타 총정리)',
          a: '**추가:** IST(2차 pre-stage)·CCTX(색차 회전)·DDT(ADST 대체, inter 8/16)·TCQ dequant 2-pass. **확대:** dequant/계수 int16→**int32**, +QUANT_TABLE_BITS 라운딩. **재구성:** per-size 함수군→통합 `inv_txfm_c` 스위치. **재사용:** 버터플라이 코어 + 16 primary TX_TYPE은 AV1 그대로.' },
        { tag: 'hw',
          q: 'datapath 폭과 버퍼는?',
          a: 'dequant·계수 **int32**(AV1 int16) 전구간 → 곱셈기·버퍼 폭 확대. 블록 스크래치 `temp_dqcoeff[MAX_TX_SQUARE]`(IST용) + 2D 전치용 `tmp`/`block` 더블버퍼. 중간 정밀도 `bd+8`비트, 최종 `bd`로 포화.' },
      ] },
  ],
};
