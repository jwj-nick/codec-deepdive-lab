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
        note: '⭐ **CCTX = U/V 색차 계수 2×2 회전**(decorrelation). 계수당 4 곱셈. `cctx_mtx=[cosθ,sinθ]·256`, 7종 각도. **U·V를 함께** 처리(교차의존).' },
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
      '**커널 ROM 증가:** IST(`ist_4x4_kernel[14][3][16][16]`+8×8), DDT(`tx_kernel_ddtx_size4/8/16`), CCTX(`cctx_mtx[7][2]`) + 1차 1D 계수 ROM + QM. ' +
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
        role: 'Per-coefficient dequant during parsing: level × dqv (DC/AC, optional QM), round by QUANT_TABLE_BITS, >> tx_scale.' },
      spec: { num: '7.14.4', title: 'Dequantization process' },
      hw: { questions: [
        'dequant is int32 now (AV1 int16) — multiplier and coefficient-buffer width?',
        'QM weighting adds a multiply + round. Always-on cost vs QM-disabled fast path?',
        'Dequant lives inside the coeff parse loop — stay in ENT or move to IQT with state forwarded?',
      ], derived: null } },
    { id: 'i2', n: 2, title: 'TX_TYPE packing (IST signaling)', stage: 'skeleton',
      fn: { name: 'get_primary/secondary_tx_type', file: 'av2/common/blockd.h', line: 2870,
        role: '32-bit TX_TYPE packs primary (4b) | IST type (2b) | IST set (4b); unpack selects primary kernel + secondary transform.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      hw: { questions: [
        'Bit-field unpack is trivial combinational — but it gates which datapaths fire. Decode-time vs setup?',
        'IST set/type selects a kernel ROM bank — addressing scheme?',
      ], derived: null } },
    { id: 'i3', n: 3, title: '⭐ CCTX (cross-chroma 2×2 rotate)', stage: 'skeleton',
      fn: { name: 'av2_inv_cross_chroma_tx_block', file: 'av2/common/idct.c', line: 964,
        role: 'Rotate U/V dequant coeffs by a 2×2 matrix [cosθ,sinθ]·256, round, clamp. 4 mults/coeff.' },
      spec: { num: '7.14.3', title: 'Reconstruct process (CCTX)' },
      io: {
        diagCaption: 'U/V 2×2 rotation — cross-plane join',
        diagram: 'graph TD\n' +
          '  U["dqcoeff U<br/>int32[ncoeff]"] --> R["2×2 rotate<br/>4 mul/coeff"]\n' +
          '  V["dqcoeff V<br/>int32[ncoeff]"] --> R\n' +
          '  ROM["cctx_mtx[7][2]<br/>[cosθ,sinθ]·256"] --> R\n' +
          '  R --> UO["U&#39; → IST/2D"]\n' +
          '  R --> VO["V&#39; → IST/2D"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class U mem;\n  class V mem;\n  class ROM rom;\n  class R op;\n  class UO op;\n  class VO op;',
        in: [
          { sig: 'c1 (U)', type: 'tran_low_t int32[ncoeff]', peer: 'dqcoeff U buffer', vol: '≤ TX area', note: 'in-place RMW' },
          { sig: 'c2 (V)', type: 'tran_low_t int32[ncoeff]', peer: 'dqcoeff V buffer', vol: '≤ TX area', note: 'cross-plane join — both must be ready' },
          { sig: 'cctx_type', type: 'CctxType enum', peer: '← parse', vol: '1/block', note: 'selects 1 of 7 angles' },
          { sig: 'cctx_mtx', type: 'int[7][2] ([cosθ,sinθ]·256)', peer: 'ROM', vol: '2 coeffs/type', note: 'rotation matrix' },
        ],
        out: [
          { sig: "c1'/c2'", type: 'int32 (rotated, clamped 8+bd)', peer: '→ IST / 2D inv-tx', vol: 'same buffers', note: '4 mults/coeff, ROUND>>CCTX_PREC_BITS' },
        ],
        note: 'Breaks plane independence: the U and V coeff buffers are read **together**. Schedule chroma as a pair, or insert a small rotate unit between dequant and the per-plane transform.',
      },
      hw: { questions: [
        'Needs BOTH U and V buffers present → cross-plane join. Schedule chroma together or insert a rotate unit?',
        '4 mults/coeff — small MAC. Share with the transform datapath or dedicate?',
        '7 angle types in cctx_mtx ROM — per-block type selection cost?',
      ], derived: null } },
    { id: 'i4', n: 4, title: 'Inverse transform entry', stage: 'skeleton',
      fn: { name: 'av2_inverse_transform_block', file: 'av2/common/idct.c', line: 998,
        role: 'init_txfm_param → IST pre-stage → primary 2D → clip-add to prediction.' },
      spec: { num: '7.15', title: 'Inverse transform process' },
      hw: { questions: [
        'IST runs before the primary 2D — fixed 2-stage pipe (secondary → primary)?',
        'init_txfm_param gathers tx_type/sec/use_ddt/eob — per-block setup latency?',
      ], derived: null } },
    { id: 'i5', n: 5, title: '⭐ IST secondary transform', stage: 'skeleton',
      fn: { name: 'av2_inv_stxfm', file: 'av2/common/idct.c', line: 1073,
        role: 'Secondary transform on top-left low-freq coeffs (4×4/8×8) via learned int16 kernel; scatter back by IST scan.' },
      spec: { num: '7.15.3', title: 'Secondary transform process' },
      io: {
        diagCaption: 'gather → dense matmul → scatter',
        diagram: 'graph TD\n' +
          '  IN["top-left coeffs<br/>16 (4×4) / 64 (8×8)"] --> G["gather<br/>(IST scan)"]\n' +
          '  G --> MM["dense matmul<br/>K · x"]\n' +
          '  ROM["ist kernel LUT<br/>[type][class] int32"] --> MM\n' +
          '  MM --> S["scatter back<br/>(IST scan)"]\n' +
          '  S --> OUT["coeffs&#39; → primary 2D"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  class IN mem;\n  class OUT mem;\n  class ROM rom;\n  class G op;\n  class MM op;\n  class S op;',
        in: [
          { sig: 'coeffs (low-freq)', type: 'tran_low_t int32', peer: 'dqcoeff (after CCTX)', vol: '16 (4×4) / 64 (8×8)', note: 'gathered by IST scan' },
          { sig: 'stx_type/size_class', type: 'int', peer: '← TX_TYPE upper bits', vol: '1/block', note: 'selects kernel bank' },
          { sig: 'ist_kernel', type: 'int32 LUT (from int16 ist_4x4_kernel[14][3][16][16])', peer: 'ROM', vol: '16×16 / 64×64 per (type,class)', note: 'dense matrix' },
        ],
        out: [
          { sig: "coeffs'", type: 'int32 (scattered)', peer: '→ primary 2D inv-tx', vol: 'same positions', note: 'gather→matmul→scatter, runs before primary' },
        ],
        note: 'Dense small matrix-multiply — candidate to **share a MAC array with DIP/MHCCP/DDT** (the decoder-NPU thesis).',
      },
      hw: { questions: [
        'Small dense matrix-multiply on top-left 16/64 coeffs — a MAC array. Share with DIP/MHCCP/DDT MAC?',
        'Kernel ist_4x4_kernel[14][3][16][16] int16 → int32 LUT at init. ROM size and addressing?',
        'Gather/scatter via IST scan orders — permutation network cost?',
      ], derived: null } },
    { id: 'i6', n: 6, title: '2D inverse transform core', stage: 'skeleton',
      fn: { name: 'inv_txfm_c', file: 'av2/common/idct.c', line: 643,
        role: 'Separable 2D: sqrt2 rescale → 1D row → 1D col → clip-add. >32 uses zero-out + 2× duplication.' },
      spec: { num: '7.15.4', title: '2D inverse transform process' },
      hw: { questions: [
        'Separable row/col = classic pipelined butterfly. Row buffer between passes = f(TX width)?',
        '64-wide: only top-left 32 non-zero → skip + duplicate. Compute savings vs control complexity?',
      ], derived: null } },
    { id: 'i7', n: 7, title: '1D kernels (DCT2 / ADST / IDTX)', stage: 'skeleton',
      fn: { name: 'inv_transform_1d_c', file: 'av2/common/idct.c', line: 534,
        role: 'Dispatch by size × type to 1D butterfly kernels (DCT2, IDTX, ADST/DST7, FDST).' },
      spec: { num: '7.15.2', title: '1D transforms' },
      hw: { questions: [
        'Shared butterfly network across types vs per-type units? Reconfigurable datapath?',
        'Coefficient ROM per size — total 1D coefficient storage?',
      ], derived: null } },
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
      hw: { questions: [
        'DDT = dense matrix multiply (not a fast butterfly). Dedicated unit vs general matmul shared with IST?',
        'ROM tx_kernel_ddtx_size4/8/16 — sizing; inter-only. Utilization?',
      ], derived: null } },
    { id: 'i9', n: 9, title: 'HW synthesis (IQT stage)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Put it together: the most parallel decoder stage, plus IST/CCTX/DDT matrix ops and the TCQ-dequant serial wrinkle.' },
      hw: { questions: [
        'Which AV2 additions (IST, CCTX, DDT) share one MAC array vs dedicated? Area vs flexibility.',
        'Feed-forward except TCQ-dequant (serial) and CCTX (U/V join). Pipeline depth?',
        'Total kernel ROM (1D coeffs + IST + DDT + CCTX + QM) budget.',
      ], derived: null } },
  ],
};
