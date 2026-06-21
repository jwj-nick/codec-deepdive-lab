/* tools/ent.js — Entropy Decoder (ENT 스테이지)
   실측 출처: ~/work/avm (AV2) · ~/work/aom (AV1). 모든 file:line은 grep/소스 확인.
   ⚠️ AVM 네이밍: avm_ 접두 / avm_dsp/ (aom_dsp 아님). */
window.TOOL = {
  id: 'ent',
  title: 'Entropy Decoder',
  stage: 'ENT',
  coupling: ['MIP', 'IQT'],
  role: '비트스트림에서 심볼을 산술복호 — 파이프라인의 **유일한 순차 병목**. AV2는 계수 복호에 TCQ 상태머신을 결합해 직렬성이 더 강해짐.',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '8.2', title: 'Parsing process for symbol decoder',
        pseudo:
          '다중심볼 **산술 복호기**(Daala `od_ec`). 상태 = `{dif(윈도우), rng(범위), cnt}`.\n\n' +
          '- **8.2.2 Init** — `rng=0x8000`, `cnt=-15`, 윈도우 리필\n' +
          '- **8.2.6 Symbol decode** — 역CDF(icdf) 배열을 선형 탐색해 `c < v`가 되는 심볼 `s` 선택 → `rng` 갱신 → 정규화\n' +
          '- **8.2.3 read_literal / bool** — 등확률(bypass) 비트. (AV2 신규 bypass 경로)\n' +
          '- nsyms ≤ 16 (알파벳 상한).',
        elements: [
          { name: 'symbol', desc: 'S()', meaning: 'CDF 적응 다중심볼' },
          { name: 'literal', desc: 'L(n)', meaning: '등확률 n-bit (bypass)' },
        ] },
      { num: '8.3', title: 'Parsing process for CDF encoded syntax elements',
        pseudo:
          '각 syntax element은 **context를 골라 그 CDF로** 심볼 복호.\n\n' +
          '- **8.3.2 Cdf selection** — 이웃/위치/plane으로 context index 산출 → `FRAME_CONTEXT`에서 해당 CDF 선택\n' +
          '- 복호 직후 `update_cdf`로 그 CDF를 적응(빈도 반영). `allow_update_cdf` 게이트.' },
      { num: '5.20.6', title: 'Transform and quantization structures (계수 syntax)',
        pseudo:
          '한 TX 블록의 계수 읽는 순서(syntax):\n\n' +
          '`txb_skip → tx_type(+IST) → eob 위치 → (역스캔) base level + low-range → parity-hidden 계수 → (정스캔) sign + high-range → dequant`' },
      { num: '7.5', title: 'Frame end update CDF process',
        pseudo: '타일 복호 후 적응된 CDF를 프레임 컨텍스트로 반영/저장(다음 프레임 초기 CDF 후보).' },
      { num: '9.3', title: 'Default CDF tables',
        pseudo: '초기 CDF 값 LUT(623p~). 디코더는 프레임 시작 시 여기서 컨텍스트를 초기화.' },
    ],
    bitfields: [
      { name: 'TX 블록 심볼 디코드 순서 (산술부호 → 폭 가변, 좌→우 직렬)',
        bits: [
          { f: 'txb_skip', w: null, d: '블록 전체 0 여부' },
          { f: 'tx_type', w: null, d: 'IST 2차변환 타입이 상위비트에 패킹(코드 확인)', hl: true },
          { f: 'eob', w: null, d: 'end-of-block 위치 토큰(다중심볼)' },
          { f: 'base+LR', w: null, d: '역스캔 base level + low-range. **CDF가 TCQ 상태로 선택됨**', hl: true },
          { f: 'PH', w: null, d: 'parity-hidden 계수(AV2 신규)', hl: true },
          { f: 'sign', w: null, d: 'bypass 비트(DC는 CDF)' },
          { f: 'HR', w: null, d: 'high-range = 적응 Truncated-Rice/Exp-Golomb(AV2 신규)', hl: true },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  A["decode_block<br/>decodeframe.c:1668"] --> B["av2_read_coeffs_txb_facade<br/>decodetxb.c:979"]\n' +
      '  B --> C["av2_read_sig_txtype<br/>:420 (txb_skip, tx_type)"]\n' +
      '  B --> D["av2_read_coeffs_txb<br/>:658 (메인 계수 reader)"]\n' +
      '  D --> E["decode_eob<br/>:300"]\n' +
      '  D --> F["read_coeffs_reverse(_2d)<br/>:162/:219 (base+LR, +TCQ state)"]\n' +
      '  D --> G["read_high_range→read_adaptive_hr<br/>:118/:112"]\n' +
      '  D --> H["TCQ dequant pass<br/>:935-968"]\n' +
      '  F --> S["avm_read_symbol<br/>bitreader.h:61"]\n' +
      '  S --> EC["avm_od_ec_decode_cdf_q15<br/>avm_dsp/entdec.c:192"]',
    funcs: [
      { file: 'avm_dsp/entdec.c', line: 192, name: 'avm_od_ec_decode_cdf_q15_c', lang: 'c',
        excerpt:
          'int avm_od_ec_decode_cdf_q15_c(od_ec_dec *dec, const uint16_t *icdf,\n' +
          '                               int nsyms) {\n' +
          '  ...\n' +
          '  c = (unsigned)(dif >> (OD_EC_WINDOW_SIZE - 16));\n' +
          '  v = r; ret = -1;\n' +
          '  do {                       // 역CDF 선형 탐색\n' +
          '    u = v; ret++;\n' +
          '    v = od_ec_prob_scale(icdf[ret], r, ret, nsyms);\n' +
          '  } while (c < v);\n' +
          '  r = u - v;                 // 범위 축소\n' +
          '  dif -= (od_ec_window)v << (OD_EC_WINDOW_SIZE - 16);\n' +
          '  return od_ec_dec_normalize(dec, dif, r, ret);  // 정규화\n' +
          '}',
        note: '핵심 다중심볼 복호. **AV1 `od_ec_decode_cdf_q15`와 byte-identical 알고리즘** — 엔진은 동일, 이름만 `avm_`.' },
      { file: 'av2/common/quant_common.c', line: 73, name: 'tcq_next_state', lang: 'c',
        excerpt:
          'int tcq_next_state(const int cur_state, const int abs_level) {\n' +
          '  const int tcq_mode = cur_state >> 8;\n' +
          '  int state = cur_state & 0xFF;\n' +
          '  if (tcq_mode != TCQ_8ST) return tcq_mode << 8;\n' +
          '  static const uint8_t next_state_lut_8st[8][2] = {\n' +
          '    {0,4},{4,0},{1,5},{5,1},{6,2},{2,6},{7,3},{3,7}\n' +
          '  };\n' +
          '  const int parity = abs_level & 1;        // 계수 패리티가 천이 구동\n' +
          '  return (tcq_mode << 8) | next_state_lut_8st[state][parity];\n' +
          '}',
        note: '⭐ **TCQ 8-state FSM.** 직전 계수 패리티로 다음 상태 결정. `tcq_quant(state)=state&2` → Q0/Q1 양자화기 선택. 이 상태가 **CDF 선택과 dequant 둘 다** 구동.' },
      { file: 'av2/decoder/decodetxb.c', line: 118, name: 'read_high_range', lang: 'c',
        excerpt:
          'static INLINE int read_high_range(MACROBLOCKD *xd, avm_reader *r,\n' +
          '         int tcq_mode, int level, int lf, int *hr_avg, int plane) {\n' +
          '  int max_br = lf ? ... : MAX_BASE_BR_RANGE;\n' +
          '  int use_hr = (tcq_mode && level>=max_br-1) || level>=max_br;\n' +
          '  if (use_hr) {\n' +
          '    int hr = read_adaptive_hr(xd, r, *hr_avg);   // 적응 Rice/Golomb\n' +
          '    level += hr << (tcq_mode ? 1 : 0);\n' +
          '    *hr_avg = (*hr_avg + hr) >> 1;               // 러닝 평균으로 Rice param 적응\n' +
          '  }\n' +
          '  return level;\n' +
          '}',
        note: 'high-range = `read_adaptive_hr`→`read_truncated_rice`→`read_exp_golomb`. AV1의 비트단위 `read_golomb`을 **적응형으로 대체**. 모듈 `av2/common/hr_coding.{h,c}`.' },
      { file: 'av2/decoder/decodetxb.c', line: 658, name: 'av2_read_coeffs_txb', lang: 'c',
        note: '메인 계수 reader. 순서: sec-tx-type(:720) → `tcq_init_state`(:729) → EOB 비영계수 → 역스캔 base+low-range(state 갱신) → parity-hidden → 정스캔 sign+high-range → TCQ dequant(:935). FSC(forward) 분기 별도.' },
      { file: 'avm_dsp/bitreader.h', line: 61, name: 'avm_read_symbol', lang: 'c',
        note: '심볼 read 매크로 → `avm_read_symbol_`(:367) → `avm_read_cdf_`(:310) → `avm_od_ec_decode_cdf_q15`. 직후 `allow_update_cdf`면 `update_cdf`(:371).' },
    ],
    structs: [
      { name: 'od_ec_dec', file: 'avm_dsp/entdec.h', line: 36,
        fields: [
          { f: 'od_ec_window dif', d: '코드 윈도우(상위 16b가 현재 c)' },
          { f: 'uint16_t rng', d: '현재 범위(≥32768 유지)' },
          { f: 'int16_t cnt', d: '윈도우 내 유효 비트 카운트' },
          { f: 'bptr / end', d: '비트스트림 포인터' },
        ],
        note: 'AV1 `aom_dsp/entdec.h`와 **동일 레이아웃**. 산술 복호기 상태 = 직렬 의존의 핵심.' },
      { name: 'avm_reader', file: 'avm_dsp/bitreader.h', line: 77,
        fields: [
          { f: 'od_ec_dec ec', d: '내장 산술 복호기' },
          { f: 'uint8_t allow_update_cdf', d: 'CDF 적응 on/off' },
        ],
        note: '**타일당 1개** 생성(`avm_reader_init`, decodeframe.c:2293). 타일 간 독립 = 유일한 병렬 축.' },
      { name: 'FRAME_CONTEXT (coeff CDFs)', file: 'av2/common/entropymode.h', line: 131,
        fields: [
          { f: 'coeff_base_cdf[TX_SIZES][SIG_COEF_CONTEXTS][TCQ_CTXS]…', d: '⭐ `[TCQ_CTXS]` 차원이 AV2 신규 — TCQ 상태로 CDF 선택' },
          { f: 'coeff_br_cdf[LEVEL_CONTEXTS]…', d: 'base-range(low-range) 루프 CDF' },
          { f: 'coeff_base_ph_cdf[…]', d: 'parity-hiding 전용 CDF(신규)' },
          { f: 'eob_flag_cdf16/32/…/1024', d: 'EOB 위치 토큰(TX 크기별)' },
        ],
        note: '타일별 사본 `tile_data->tctx`에 바인딩(`xd->tile_ctx`, decodeframe.c:4823). `TCQ_CTXS=2`(entropy.h:64) → 계수 CDF 테이블 ~2배.' },
      { name: '계수 출력 버퍼', file: 'av2/decoder/decodetxb.c', line: 686,
        fields: [
          { f: 'dqcoeff_block[plane]', d: '역양자화 계수 출력(IQT로 전달)' },
          { f: 'eob_data / bob_data', d: 'EOB / begin-of-block(AV2 추가)' },
          { f: 'levels (scratch)', d: 'context 산출용 레벨 맵' },
        ] },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '§8.2 산술 복호기(다중심볼)', cLine: 'avm_od_ec_decode_cdf_q15 (entdec.c:192)',
      kind: 'same', delta: 'AV1 `od_ec_decode_cdf_q15`(aom_dsp/entdec.c:193)와 **동일 알고리즘**. 엔진 재사용.' },
    { specLine: '§8.2.3 등확률 비트', cLine: 'od_ec_decode_{bool,literal,unary}_bypass (entdec.c:117/124/155)',
      kind: 'new', delta: 'AV1 entdec.c엔 bypass 함수 **부재**. AV2 신규 등확률 고속 경로.' },
    { specLine: '§5.20.6 high-range 계수', cLine: 'read_adaptive_hr / hr_coding.* (:112)',
      kind: 'changed', delta: 'AV1 비트단위 `read_golomb`(decodetxb.c:22) → AV2 **적응 Truncated-Rice/Exp-Golomb**.' },
    { specLine: '§5.20.6 계수 양자화 상태', cLine: 'tcq_next_state / tcq_quant (quant_common.c:73)',
      kind: 'new', delta: 'AV1 **TCQ 없음**(grep tcq/trellis=0). AV2 8-state FSM이 CDF 선택+dequant 구동.' },
    { specLine: '§8.3.2 CDF 선택', cLine: 'coeff_base_cdf[…][TCQ_CTXS] (entropymode.h:147)',
      kind: 'changed', delta: 'AV1엔 TCQ 차원 없음. AV2는 `[TCQ_CTXS]` 추가 → CDF 테이블 ~2배.' },
    { specLine: '계수 read 경로', cLine: 'av2_read_coeffs_txb (decodetxb.c:658)',
      kind: 'changed', delta: 'AV1도 decodetxb.c(`av1_read_coeffs_txb:324`) 사용. 골격 유사, TCQ/PH/HR 추가로 분기 증가.' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  BS["bitstream"] --> EC["od_ec<br/>range decoder"]\n' +
      '  CDF["CDF RMW<br/>tctx SRAM"] --> EC\n' +
      '  EC --> CDF\n' +
      '  EC --> LV["level / sign"]\n' +
      '  LV --> TCQ["TCQ FSM<br/>8-state"]\n' +
      '  TCQ -->|select q_i| CDF\n' +
      '  TCQ --> DQ["dequant<br/>Q0/Q1"]\n' +
      '  DQ --> OUT["dqcoeff → IQT"]\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
      '  class BS mem;\n  class CDF mem;\n  class OUT mem;\n' +
      '  class EC hot;\n  class TCQ hot;\n  class LV op;\n  class DQ op;',
    throughput:
      '**본질적 순차.** 심볼 1개 = `od_ec` 상태(dif/rng/cnt) 읽기 → 역CDF 선형탐색(최대 nsyms≤16 반복) → 정규화 → `update_cdf` RMW. ' +
      '다음 심볼은 갱신된 상태에 의존 → **≈1 symbol/clk 상한**, 계수 많은 블록이 전체 fps를 좌우. ' +
      '역CDF 루프가 가변 반복이라 timing closure 시 worst=nsyms로 잡아야 함.',
    memory:
      '활성 컨텍스트 CDF를 **단일 사이클 RMW** 가능한 SRAM/레지스터파일에 둬야 함(매 심볼 read+update). ' +
      'AV2는 컨텍스트 증가(`[TCQ_CTXS]` ~2배, parity-hiding CDF 신규) → **CDF SRAM 용량 증가**. ' +
      'CDF 저장은 타일 단위(`tctx`) → 타일 병렬 시 인스턴스마다 사본 필요.',
    hazard:
      '⭐ **TCQ가 직렬성을 강화.** `state = tcq_next_state(state, |level|)` — 각 계수의 양자화 상태가 **직전 계수 패리티**에 의존(스캔체인). ' +
      '게다가 `base_cdf[ctx][tcq_quant(state)]`라 **다음 계수의 엔트로피 복호 CDF 선택조차 러닝 상태에 의존** → parse↔state가 한 루프에 묶임. ' +
      'AV1은 level read를 비교적 느슨히 파이프라인 가능했으나 AV2는 TCQ FSM을 심볼 복호기와 **인라인**(1-cycle state update)해야 lookahead 불가.',
    parallel:
      '**타일 병렬이 유일한 실질 병렬 축**(각 타일 독립 reader+`tctx`). 타일 내부는 직렬. ' +
      '→ HW throughput은 **#타일 × 엔트로피 인스턴스 수**로 스케일(블록 내부 병렬화 거의 불가). ' +
      'bypass/4-part 비트는 CDF 없이 다비트 시프트로 한 사이클 다중 복호 가능 → sign/HR suffix 가속.',
    av1delta:
      '- 산술 엔진 코어는 **재사용**(AV1 od_ec 그대로).\n' +
      '- **추가:** TCQ 8-state FSM(저렴한 LUT지만 critical path 압박), parity-hiding 분기, 4-part 심볼 read.\n' +
      '- **확대:** 계수 CDF SRAM(TCQ_CTXS·PH 컨텍스트).\n' +
      '- **단순화(역설):** high-range가 비트단위 golomb → 적응 Rice + bypass 경로로 바뀌어 suffix 복호는 오히려 HW 친화적.',
    openQ: [
      'TCQ가 엔트로피 parse와 dequant 상태를 묶음 → **dequant를 ENT 스테이지에 흡수** vs IQT 분리하고 상태만 forward? 어디서 경계를 그을까.',
      '역CDF 선형탐색(가변 반복)을 timing close하려면 병렬 비교(16-way)로 1-cycle 고정 vs 반복 허용? 면적/주파수 트레이드.',
      '타일 직렬 가정에서 목표 Mpix/s를 맞추려면 타일 수/엔트로피 인스턴스 몇 개? (스트림이 타일을 적게 쓰면 병렬화 한계.)',
      'parity-hiding은 한 계수의 패리티를 부호화에서 생략 → 스캔 FSM의 특수분기. 제어 복잡도 vs 비트 절감.',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'AV2 엔트로피 "엔진"은 AV1과 무엇이 같고 무엇이 다른가?',
      a: '코어 산술 복호기(`od_ec`, decode_cdf_q15, `od_ec_dec` 구조체)는 **byte-identical**로 동일. 다른 건 그 위의 계수 모델링 — TCQ 상태기반 CDF 선택, parity-hiding, 적응 high-range, bypass/4-part read가 신규.',
      hint: '엔진 vs 컨텍스트 모델링을 분리해서 보라.' },
    { q: 'TCQ가 왜 HW에서 "병목을 더 조이는" 도구인가?',
      a: '각 계수의 양자화 상태가 직전 계수 패리티에 직렬 의존(스캔체인)이고, 그 상태가 **다음 계수의 CDF 선택까지** 결정 → 엔트로피 parse와 dequant 상태가 한 직렬 루프에 묶임. lookahead/병렬화가 막힌다.',
      hint: '`tcq_next_state`와 `base_cdf[ctx][tcq_quant(state)]`를 같이 보라.' },
    { q: '엔트로피 디코더의 병렬화 가능 축은?',
      a: '타일 단위(각 타일이 독립 reader+`tctx`). 블록 내부는 직렬. throughput은 타일/인스턴스 수로 스케일.',
      hint: '`avm_reader`가 어디서 생성되나?' },
  ],
  quiz: [
    { q: 'AVM에서 계수 복호 경로의 메인 파일은?',
      options: ['av2/decoder/detokenize.c', 'av2/decoder/decodetxb.c', 'avm_dsp/entdec.c', 'av2/common/hr_coding.c'],
      answer: 1, why: '`av2_read_coeffs_txb`(decodetxb.c:658). detokenize.c는 존재하나 계수 경로는 decodetxb.c.' },
    { q: 'AV2의 high-range 계수 코딩이 AV1과 다른 점은?',
      options: ['동일한 비트단위 Golomb', '적응 Truncated-Rice/Exp-Golomb(hr_coding)', 'CDF 적응만 사용', '항상 고정 8비트'],
      answer: 1, why: 'AV1 `read_golomb`(비트단위) → AV2 `read_adaptive_hr`(러닝 평균으로 Rice param 적응).' },
    { q: 'TCQ 8-state에서 양자화기(Q0/Q1) 선택 식은?',
      options: ['state & 1', 'state & 2', 'state >> 8', 'parity ^ state'],
      answer: 1, why: '`tcq_quant(state) = state & 2` (상태 0/1/4/5=Q0, 2/3/6/7=Q1).' },
    { q: 'AV2에서 계수 CDF 테이블이 커진 주된 이유는?',
      options: ['256×256 SB', 'CDF에 [TCQ_CTXS] 차원 추가', '비트심도 12bit', '타일 수 증가'],
      answer: 1, why: '`coeff_base_cdf[…][TCQ_CTXS]` — TCQ 상태로 CDF를 고르므로 컨텍스트가 ~2배.' },
  ],

  // ── Mega-deep 함수챕터 (E1~E11) — 함수레벨 줄단위 + HW(Nick 도출) ──
  chapters: [
    { id: 'e1', n: 1, title: 'Range decoder init', stage: 'skeleton',
      fn: { name: 'avm_od_ec_dec_init', file: 'avm_dsp/entdec.c', line: 75,
        role: 'Initialize the arithmetic decoder: range = 0x8000, cnt = -15, first window refill.' },
      spec: { num: '8.2.2', title: 'Initialization process for symbol decoder' },
      qna: [
        { tag: 'verified', ref: 'entdec.c:75',
          q: 'What state does init set, and why those exact values?',
          a: '`rng = 0x8000` (32768, MSB set) = **full-scale range** — it plants the precision invariant (ch.3) from cycle 0. `cnt = -15` — the valid-bit counter starts negative so the first `od_ec_dec_refill` brings it positive. `dif = 2^63 − 1` = the code window pre-fill (all ones below the MSB). `bptr / end` = bitstream bounds. Then `od_ec_dec_refill(dec)` loads the first bytes.' },
        { tag: 'common',
          q: 'AV1 vs AV2 here?',
          a: 'Identical to AV1 `od_ec_dec_init` — the arithmetic engine is byte-reused (ch.2). Only the `avm_` prefix differs.' },
        { tag: 'hw',
          q: 'What does reset cost in HW?',
          a: 'A constant load of `{dif, rng=0x8000, cnt=−15}` + one window refill (byte-aligned burst from the tile buffer). It is **per-tile**, so the cost amortizes over the whole tile; the refill datapath is the same barrel-shifter / refill used by renormalize (ch.3).' },
      ] },
    {
      id: 'e2', n: 2, title: 'Multi-symbol decode core', stage: 'full',
      fn: { name: 'avm_od_ec_decode_cdf_q15_c', file: 'avm_dsp/entdec.c', line: 192,
        role: 'Arithmetic-decode one multi-symbol value — the **innermost loop** of the entropy decoder (every syntax element ends up here).',
        callers: 'avm_read_symbol → avm_read_cdf_ (bitreader.h)', callees: 'od_ec_prob_scale · od_ec_dec_normalize' },
      spec: { num: '8.2.6', title: 'Symbol decoding process',
        pseudo: 'Input = inverse-CDF array `icdf` (stored = `CDF_PROB_TOP - cumulative` ⇒ larger value = lower symbol). ' +
          'Take the top 16 bits of the code window as `c`, scale each symbol boundary `v` to the range, and **linearly search which sub-interval `c` falls in** — that index is the decoded symbol. Then narrow the range and renormalize.\n\n' +
          '> Algorithm is **byte-identical to AV1**. Engine reuse is the key ENT-HW leverage.' },
      figures: [
        { title: 'Interval narrowing — the core idea',
          ascii:
'  r |--------|------|----------|----|-----------| 0\n' +
'    symbol 0 |  1   |    2     | 3  |     4\n' +
'    icdf: v0  v1     v2         v3   v4         v5=0\n' +
'                      ^ c\n' +
'    c falls in v3..v2   =>  decoded symbol = 2\n' +
'    r_new = v2 - v3         (new range = slot width)\n' +
'    dif  -= v3              (re-base low -> 0)\n' +
'    normalize: rescale r_new back up to >= 32768',
          caption: 'Arithmetic decoding = repeatedly zoom into the sub-interval the code points to.' },
        { title: 'Inverse-CDF linear search (the do-while loop)',
          mermaid:
'graph TD\n' +
'  A["ret = -1, v = r"] --> B["u = v; ret++;<br/>v = scaled icdf boundary"]\n' +
'  B --> C{"c &lt; v ?"}\n' +
'  C -->|yes| B\n' +
'  C -->|no| D["symbol = ret<br/>interval v..u"]\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
'  classDef out fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  class B op;\n  class C hot;\n  class D out;' },
        { title: 'Serial dependency — the ENT throughput wall',
          mermaid:
'graph TD\n' +
'  P["decode symbol n-1"] --> S["dec.dif / rng / cnt<br/>carried state"]\n' +
'  S --> N["decode symbol n"]\n' +
'  N --> S2["updated state"]\n' +
'  S2 --> M["decode symbol n+1"]\n' +
'  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
'  classDef op fill:#161b22,stroke:#2b3440,color:#e6edf3;\n' +
'  class S hot;\n  class S2 hot;\n  class P op;\n  class N op;\n  class M op;',
          caption: 'Each call read-modify-writes the same decoder state, so calls cannot overlap — this is why ENT is the throughput bottleneck.' },
      ],
      walkthrough: [
        { code: 'int avm_od_ec_decode_cdf_q15_c(od_ec_dec *dec,\n                  const uint16_t *icdf, int nsyms) {', line: 192,
          note: '`icdf` = **inverse CDF**. Stored value = `TOP - cumulative`, so "larger value = lower symbol". `nsyms` = alphabet size (≤16).' },
        { code: 'dif = dec->dif;\nr   = dec->rng;', line: 201,
          note: 'Load decoder state. `dif` = 64-bit **code window**, `r` = current **range** (16-bit, always kept ≥ 32768).' },
        { code: 'c = (unsigned)(dif >> (OD_EC_WINDOW_SIZE - 16));', line: 208,
          note: 'Take the **top 16 bits** of the window as compare value `c` (`OD_EC_WINDOW_SIZE=64` ⇒ `>>48`) — "where in the range are we".' },
        { code: 'v = r;\nret = -1;', line: 209,
          note: '`v` starts at the full range; `ret` = symbol index counter (from -1).' },
        { code: 'do {\n  u = v;\n  ret++;\n  v = od_ec_prob_scale(icdf[ret], r, ret, nsyms);\n} while (c < v);', line: 211,
          note: '⭐ **Inverse-CDF linear search.** Scale each boundary `v` to the range and walk down until `c >= v`. On exit `ret` = decoded symbol, `[v,u)` = its sub-interval. **Iteration count is data-dependent (≤ nsyms).**' },
        { code: 'r = u - v;', line: 218,
          note: 'New range = width of the decoded symbol\'s sub-interval (the "narrowing").' },
        { code: 'dif -= (od_ec_window)v << (OD_EC_WINDOW_SIZE - 16);', line: 219,
          note: 'Subtract the sub-interval low bound `v` from the window — **re-base the low to 0**.' },
        { code: 'return od_ec_dec_normalize(dec, dif, r, ret);', line: 220,
          note: 'Renormalize (shift range back to ≥ 32768, consume/refill the window) and **return the symbol**.' },
        { code: '// helper: prob.h:238\nint rr = r >> 8;\nint pp = (p >> EC_PROB_SHIFT) << 4;\npp += av2_prob_inc_tbl[nsym-2][n];   // AV2 trained PARA increment\nreturn ((rr*pp >> (7-EC_PROB_SHIFT-CDF_SHIFT+1+6)) << 3);', line: 240,
          note: '`od_ec_prob_scale`: scale the icdf prob to the range. The **multiply `rr*pp` is the per-iteration critical path.** `av2_prob_inc_tbl` (15×16) = a **trained** per-(alphabet, position) increment — an AV2 nuance (same engine, refined probability adaptation).' },
        { code: '// helper: entdec.h:140 (normalize)\nint d = 16 - OD_ILOG_NZ(rng);   // leading-zeros -> shift amount\ndec->cnt -= d;\ndec->dif = ((dif + 1) << d) - 1;\ndec->rng = rng << d;\nif (dec->cnt < OD_EC_MIN_BITS) od_ec_dec_refill(dec);', line: 140,
          note: '`od_ec_dec_normalize`: left-shift by `d` = leading-zeros of `rng` to restore the range; the window consumes `d` bits; if `cnt` < threshold, **refill** from the bitstream.' },
      ],
      structs: [
        { name: 'od_ec_dec', file: 'avm_dsp/entdec.h', line: 36,
          fields: [
            { f: 'od_ec_window dif (uint64)', d: 'code window; top 16b is the compare value c' },
            { f: 'uint16_t rng', d: 'current range (kept ≥ 32768)' },
            { f: 'int16_t cnt', d: 'valid-bit count in the window (< threshold → refill)' },
            { f: 'bptr / end', d: 'bitstream pointers' },
          ],
          note: 'Same layout as AV1 `aom_dsp/entdec.h`. **The read-modify-write of these 3 state words (dif/rng/cnt) is the core of the symbol-to-symbol serial dependency.**' },
        { name: 'constants', file: 'avm_dsp/prob.h · entcode.h', line: 0,
          fields: [
            { f: 'OD_EC_WINDOW_SIZE = 64', d: 'od_ec_window = uint64' },
            { f: 'CDF_PROB_TOP = 32768 (2^15)', d: 'icdf normalization top' },
            { f: 'EC_PROB_SHIFT = 7', d: 'probability scaling shift' },
            { f: 'av2_prob_inc_tbl[15][16]', d: 'trained PARA increment (entcode.h:37)' },
          ] },
      ],
      io: {
        diagCaption: 'one symbol decode — port boundary',
        diagram: 'graph TD\n' +
          '  IN1["icdf[nsyms]<br/>CDF SRAM"] --> BLK["decode_cdf_q15<br/>(1 symbol)"]\n' +
          '  IN2["dec state<br/>dif/rng/cnt regs"] --> BLK\n' +
          '  BLK --> O1["symbol ret<br/>⌈log2 nsyms⌉ b"]\n' +
          '  BLK --> O2["dec&#39; state<br/>RMW (serial)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class IN1 mem;\n  class IN2 hot;\n  class BLK op;\n  class O1 op;\n  class O2 hot;',
        in: [
          { sig: 'dec', type: 'od_ec_dec* (dif 64b, rng 16b, cnt 16b)', peer: 'decoder state regs', vol: '3 state words', note: 'RMW — serial dependency' },
          { sig: 'icdf', type: 'uint16[nsyms] (Q15)', peer: 'CDF SRAM', vol: 'nsyms ≤ 16', note: 'read-only this call' },
          { sig: 'nsyms', type: 'int', peer: 'caller', vol: '≤ 16', note: 'alphabet size' },
        ],
        out: [
          { sig: 'ret', type: 'symbol, ⌈log2 nsyms⌉ b', peer: '→ caller', vol: '1 symbol', note: 'decoded value' },
          { sig: "dec'", type: 'od_ec_dec* (updated)', peer: 'state regs', vol: '3 state words', note: 'side-effect → next symbol depends on it' },
        ],
        note: 'This is the **leaf RTL block** of ENT. The 64b window + 16b range + 16b cnt RMW each call = the symbol-to-symbol serial chain. ' +
          'The downstream `update_cdf` (chapter 4) adds a second RMW to the CDF SRAM.',
      },
      hw: {
        datapath: 'graph TD\n' +
          '  WIN["dif window (64b)"] --> TOP["top 16b → c"]\n' +
          '  TOP --> CMP{"c &lt; v ?"}\n' +
          '  ICDF["icdf[ret]<br/>CDF SRAM"] --> PS["prob_scale<br/>mul rr*pp + shift"]\n' +
          '  PARA["prob_inc_tbl<br/>ROM"] --> PS\n' +
          '  PS --> CMP\n' +
          '  CMP -->|yes, ret++| ICDF\n' +
          '  CMP -->|no| RNG["r = u - v"]\n' +
          '  RNG --> NRM["normalize<br/>LZ-count + shift + refill"]\n' +
          '  NRM --> WIN\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class ICDF mem;\n  class PARA rom;\n  class PS op;\n  class RNG op;\n  class NRM op;\n  class CMP hot;',
      },
      qna: [
        { tag: 'common', ref: 'entdec.c:192',
          q: 'AV1 vs AV2 — what is the same, what changed?',
          a: 'The multi-symbol decode loop is **byte-identical to AV1** `od_ec`. The only AV2 nuance = `av2_prob_inc_tbl` (a trained probability increment) inside `od_ec_prob_scale`. Engine reused; modelling refined.' },
        { tag: 'hw',
          q: 'Why is this the throughput bottleneck (chain 1)?',
          a: 'The next symbol reads the *just-written* state: `c = dif>>48`, `v = prob_scale(icdf, rng)` — both produced by the previous symbol narrow + renormalize ⇒ **operand n+1 is produced by step n** ⇒ no lookahead (speculation = fork ≤16 symbols, exponential) ⇒ ≈ **1 symbol/clk**.' },
        { tag: 'hw',
          q: 'RMW vs RAW — and where is the second chain?',
          a: '**RMW** = one op reads→modifies→writes a location; **RAW** = the next op must read what the previous wrote. Chain 1 = one shared `{dif,rng,cnt}` ⇒ RAW **every** symbol (unavoidable). Chain 2 = `update_cdf` (ch.4) ⇒ RAW **only on a same-context run**.' },
      ],
      checks: [
        { q: 'Why is `icdf` an "inverse" CDF, and why does that make the `c < v` test natural?',
          a: 'Stored value = `CDF_PROB_TOP - cumulative`, so the value shrinks as the symbol index grows. Walking `v` from the high boundary downward while `c < v`, the `ret` where it stops (`c >= v`) is the interval `c` belongs to.',
          hint: 'Relation between the stored value and the cumulative probability.' },
        { q: 'How many symbols does this function decode? What is the loop actually doing?',
          a: '**One.** The loop is a linear search over the inverse CDF for that single symbol\'s sub-interval (not multiple symbols).',
          hint: 'Meaning of ret.' },
        { q: 'The engine equals AV1 — name one detail AV2 changed here.',
          a: '`av2_prob_inc_tbl[nsym-2][n]` inside `od_ec_prob_scale` — a trained per-(alphabet, position) probability increment. The core algorithm is identical.',
          hint: 'The table inside prob_scale.' },
      ],
    },
    { id: 'e3', n: 3, title: 'Renormalization & bit accounting', stage: 'skeleton',
      fn: { name: 'od_ec_dec_normalize', file: 'avm_dsp/entdec.h', line: 140,
        role: 'After each symbol: shift range back to >= 32768, consume d bits from the window, refill if low.' },
      spec: { num: '8.2.6', title: 'Symbol decoding process (renorm)' },
      qna: [
        { tag: 'verified', ref: 'prob.h · entdec.h',
          q: 'Why must renormalize keep rng ≥ 32768?',
          a: '`od_ec_prob_scale` uses `rr = rng >> 8`. Full-scale `rng` ⇒ `rr ∈ [128,255]` = 8 significant bits ⇒ 16 boundaries stay separable. If `rng < 256` ⇒ `rr = 0` ⇒ every `v = 0` ⇒ sub-intervals collapse ⇒ decode breaks + enc/dec mismatch. **The invariant = precision.**' },
        { tag: 'hw',
          q: 'What is the dual role of the renorm shift?',
          a: '`d = 16 − ilog(rng)` restores precision **and** consumes `d` bits from the `dif` window ⇒ bitstream advance (+ refill when `cnt` low). One op = precision restore + bit consumption. HW = leading-zero count → variable barrel shift; refill = data-dependent branch (tail of chain 1).' },
      ] },
    { id: 'e4', n: 4, title: 'Symbol read & CDF update', stage: 'skeleton',
      fn: { name: 'avm_read_symbol / update_cdf', file: 'avm_dsp/bitreader.h', line: 61,
        role: 'Wrapper: decode via od_ec, then adapt the active CDF (update_cdf) when allow_update_cdf.' },
      spec: { num: '8.3', title: 'Parsing process for CDF encoded syntax elements' },
      qna: [
        { tag: 'verified',
          q: 'Which way does update_cdf move, and how?',
          a: 'The decoded symbol probability is **raised**, by **exponential decay toward the observed symbol**: `delta = (target − cdf[i]) >> rate`. `rate` grows with a per-CDF count ⇒ fast early, slow later = **learning-rate decay**. Effectively a 1-tap EMA — an online learner (same shape as a DL adaptive optimizer).' },
        { tag: 'hw',
          q: 'Why is it a cost, and how does it combine with chain 1?',
          a: 'It is a **RMW on the CDF every symbol**. Same-context next symbol ⇒ RAW. Combined: `critical path = (narrow+renorm) ∥ (CDF read+update+writeback)` — two serial RMW loops per symbol. Different context ⇒ independent ⇒ pipelineable. Keep hot CDFs in single-cycle-RMW SRAM/registers.' },
      ] },
    { id: 'e5', n: 5, title: 'CDF selection & context', stage: 'skeleton',
      fn: { name: 'cdf selection (context derivation)',
        role: 'Derive the context index (neighbors / position / plane) and pick the CDF to decode with.' },
      spec: { num: '8.3.2', title: 'Cdf selection process' },
      qna: [
        { tag: 'hw',
          q: 'Which context can be precomputed, which cannot?',
          a: '**Class 1** (neighbor-block / position / plane — mode, partition): depends on already-decoded *neighbors* ⇒ **precompute ahead** of the serial engine — the one hideable latency. **Class 2** (intra-block coeff context, `get_lower_levels_ctx_2d(levels,…)`): depends on *just-decoded* coeffs ⇒ on the serial chain, **not** precomputable.' },
        { tag: 'delta',
          q: 'How does TCQ make class 2 worse?',
          a: 'TCQ makes the CDF **selection** itself ride the running state — `base_cdf[coeff_ctx][q_i]`, `q_i = tcq_quant(state)` ⇒ context + CDF-select fold into the per-coeff serial loop. That is exactly where the hideable boundary breaks (→ ch.9).' },
      ] },
    { id: 'e6', n: 6, title: 'Coefficient block entry', stage: 'skeleton',
      fn: { name: 'av2_read_coeffs_txb_facade', file: 'av2/decoder/decodetxb.c', line: 979,
        role: 'Enter coefficient decode for one TX block: build TXB_CTX, read txb_skip/tx_type, dispatch FSC vs normal.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      qna: [
        { tag: 'verified', ref: 'decodetxb.c:437',
          q: 'How does a TX block decode start?',
          a: 'Read **`txb_skip` (all_zero)** from `txb_skip_cdf[pred_mode_ctx][txs_ctx][txb_skip_ctx]` (binary). If `all_zero`, the block has no coefficients → skip entirely (`tx_skip` set). Context comes from neighbor skip/eob state. This is the cheap early-out that keeps empty blocks off the serial coeff loop.' },
        { tag: 'delta', ref: 'decodetxb.c:442',
          q: 'What is FSC, and how is it dispatched?',
          a: '**FSC = Forward Skip Coding** (`mbmi->fsc_mode`) — a coeff path for **IDTX (identity transform)** blocks that reads coefficients in **forward scan** (low→high) with dedicated CDFs (`coeff_base_cdf_idtx`, `read_coeffs_forward_2d`), vs the normal **reverse-scan** path. `pred_mode_ctx = (is_inter || fsc_mode) ? 1 : 0` feeds the skip context.' },
        { tag: 'delta', ref: 'decodetxb.c:447',
          q: 'Cross-component context at entry?',
          a: 'For the **V plane**, `txb_skip` uses `v_txb_skip_cdf` with a context offset by `eob_u_flag` (whether U had coefficients, set at :462) — V skip probability is conditioned on U. A small chroma cross-component coupling.' },
        { tag: 'hw',
          q: 'HW cost of block entry?',
          a: 'Per TX block: build `TXB_CTX` once (neighbor-derived), one binary `txb_skip` symbol, then a **divergent dispatch** — FSC-forward vs normal-reverse, two control paths sharing one `od_ec` engine. Pipeline-fill into the per-coeff serial loop happens once per non-skipped block.' },
      ] },
    { id: 'e7', n: 7, title: 'EOB decode', stage: 'skeleton',
      fn: { name: 'decode_eob', file: 'av2/decoder/decodetxb.c', line: 300,
        role: 'Decode the end-of-block position token (eob_flag_cdf16..1024 by TX size), then extra bits.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      qna: [
        { tag: 'verified', ref: 'decodetxb.c:300',
          q: 'How is the EOB position decoded?',
          a: 'Two parts: a **group token** `eob_pt` via a multi-symbol CDF, then **`eob_extra` refinement bits**. Reconstruct: `eob = av2_eob_group_start[eob_token]; if (eob > 2) eob += extra;` (`rec_eob_pos` :135). Same group + extra structure as AV1.' },
        { tag: 'verified', ref: 'decodetxb.c:327',
          q: 'Why banked eob_flag_cdf16…1024?',
          a: '`eob_multi_size = txsize_log2_minus4[tx_size]` selects `eob_flag_cdf16 / 32 / 64 / … / 1024` — **one bank per coefficient count**. Bigger TX ⇒ more possible EOB positions ⇒ larger token alphabet ⇒ a wider CDF bank.' },
        { tag: 'delta',
          q: 'AV2 addition vs AV1?',
          a: 'A **`bob` (begin-of-block)** is decoded alongside `eob` for the forward / FSC path (ch.6) — AV1 has only `eob`. The `eob_pt + extra` mechanism itself is AV1-like.' },
        { tag: 'hw',
          q: 'What does EOB set up downstream?',
          a: 'EOB = the **loop length** of the per-coefficient serial scan (ch.8) ⇒ it drives scheduling and enables early termination. The banks are ROM/SRAM **addressed by TX size + plane context** (`get_eob_plane_ctx`). Decode EOB first, then run exactly `eob` iterations.' },
      ] },
    { id: 'e8', n: 8, title: 'Base + low-range reverse scan', stage: 'skeleton',
      fn: { name: 'read_coeffs_reverse_2d', file: 'av2/decoder/decodetxb.c', line: 162,
        role: 'Reverse-scan base level + low-range per position; advances the TCQ state each coefficient.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      qna: [
        { tag: 'verified', ref: 'decodetxb.c:658',
          q: 'Read order of one TX block?',
          a: '`txb_skip`/`tx_type` → `tcq_init_state` → **EOB** → **reverse scan** base(0..3) + low-range (`tcq_next_state` each coeff) → **DC parity-hiding** → **sign + high-range** → **TCQ dequant** (`qIdx = 2·level − Qx`).' },
        { tag: 'delta',
          q: 'How is a coefficient magnitude built?',
          a: 'In **escalating pieces**: base level (0..3) → if saturated, low-range (`br`) → if still saturated, high-range (rice). Most coeffs end at the base symbol; only large ones climb.' },
        { tag: 'hw',
          q: 'Why two passes?',
          a: 'pass 1 (reverse, base + low-range) = the CDF + TCQ-state **serial loop**; pass 2 (sign + high-range) = mostly **bypass** ⇒ deferred, parallelizable. high-range adds `hr << (tcq_mode?1:0)` = even ⇒ **parity preserved** ⇒ TCQ state is fully known from pass 1.' },
        { tag: 'delta', ref: 'decodetxb.c:643',
          q: 'Parity-hiding — what, and why the DC?',
          a: 'When luma & `eob > 4` & ≥4 nonzeros, the **DC parity (LSB) is not coded** — inferred from `sum_abs1 & 1`; only the quotient is coded (dedicated `coeff_base_ph_cdf`), `level = 2·q_index + parity`. ~1 bit/block. **Why DC?** it is last in the reverse scan ⇒ its parity drives **no downstream TCQ state** ⇒ hiding it is free. TCQ *uses* parity; PH *omits coding* the one parity TCQ does not need.' },
      ] },
    { id: 'e9', n: 9, title: '⭐ TCQ state machine', stage: 'skeleton',
      fn: { name: 'tcq_next_state', file: 'av2/common/quant_common.c', line: 73,
        role: '8-state FSM: parity of |level| picks the next state via an 8x2 LUT; state selects CDF and Q0/Q1.' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      figures: [
        { title: 'TCQ per-coefficient serial loop (reverse scan)',
          mermaid:
'graph TD\n' +
'  ST["state (coeff k−1)"] --> QI["q_i = state &amp; 2<br/>(Q0 / Q1)"]\n' +
'  NB["neighbor levels[]<br/>(coeff_ctx)"] --> CDF["base_cdf[ctx][q_i]<br/>pick CDF"]\n' +
'  QI --> CDF\n' +
'  CDF --> LV["decode base level 0..3<br/>+ low-range"]\n' +
'  LV --> NS["tcq_next_state(state, |level|)<br/>8×2 LUT, parity-driven"]\n' +
'  NS --> ST2["state (coeff k+1)"]\n' +
'  LV --> DQ["dequant: qIdx = 2·level − Qx<br/>Q0 even grid / Q1 odd grid"]\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef st fill:#241a2e,stroke:#c08bff,color:#e6edf3;\n' +
'  class NB mem;\n  class CDF mem;\n  class QI op;\n  class LV op;\n  class NS op;\n  class DQ op;\n  class ST st;\n  class ST2 st;',
          caption: 'The base_cdf address for coeff k+1 (via q_i and neighbor levels) cannot form until coeff k is decoded → serial.' },
      ],
      qna: [
        { tag: 'verified', ref: 'quant_common.h:71',
          q: 'What is tcq_quant, and the Q0/Q1 dequant difference?',
          a: '`tcq_quant(state) = state & 2` → `Qx ∈ {0,1}` (one bit). Dequant (decodetxb.c:944): `qIdx = max(0, 2·level − Qx)`, `dq = (qIdx·dqv) >> (shift+1)`. **Q0 = even-multiple grid, Q1 = odd-multiple grid** of a half-step-finer lattice = **dependent quantization** (VVC-style). State picks which sub-grid this coeff lands on.' },
        { tag: 'verified', ref: 'decodetxb.c:206',
          q: 'What does base_cdf parse, and why is it serial?',
          a: '`base_cdf[coeff_ctx][q_i]` parses the base level (0..3). **Both** indices come from prior coeffs — neighbor `levels[]` + TCQ `state` — so coeff k+1’s CDF address cannot form until coeff k is decoded ⇒ serial. `coeff_base_cdf[…][TCQ_CTXS=2]` (entropy.h:64) is the dimension that ~2× the coeff CDF tables.' },
        { tag: 'hw',
          q: 'Why does TCQ tighten the bottleneck?',
          a: 'State couples **entropy parse (CDF select) + dequant** into one carried-state loop; `tcq_next_state` is a cheap 8×2 LUT but it sits **inline** ⇒ no lookahead even though the FSM itself is nearly free. The gain (finer effective quantization for the same bits) is paid in serialization.' },
      ] },
    { id: 'e10', n: 10, title: 'High-range Rice / Golomb', stage: 'skeleton',
      fn: { name: 'read_adaptive_hr', file: 'av2/decoder/decodetxb.c', line: 112,
        role: 'High-range suffix: adaptive Truncated-Rice / Exp-Golomb via bypass bits (no CDF).' },
      spec: { num: '5.20.6', title: 'Transform and quantization structures' },
      qna: [
        { tag: 'verified', ref: 'decodetxb.c:112',
          q: 'How does high-range coding work?',
          a: 'Only when base+low-range saturates. `m = get_adaptive_param(hr_avg)` → `read_truncated_rice(m, k=m+1, cmax=min(m+4,6))` → `level += hr << (tcq?1:0)` → `hr_avg = (hr_avg+hr)>>1`. **Adaptive Rice parameter**, updated by a 1-tap EMA. Truncated Rice + Exp-Golomb tail.' },
        { tag: 'delta', ref: 'hr_coding.c:29',
          q: 'vs AV1?',
          a: 'AV1 fixed bit-golomb → AV2 **adaptive** Truncated-Rice/Exp-Golomb: `m` self-tunes to recent magnitudes via a threshold table (`get_adaptive_param`).' },
        { tag: 'hw',
          q: 'Why is it HW-friendly?',
          a: 'All **bypass** (equiprobable) ⇒ no CDF, multi-bit shift, parallel. Rare (large levels) + a tiny running-avg register + a threshold LUT = a small Rice/Golomb decoder sharing the bypass shifter. This is the light pass-2 work.' },
      ] },
    { id: 'e11', n: 11, title: 'HW synthesis (ENT stage) — capstone', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Synthesis of E2–E10 + parity-hiding: the symbols/clk ceiling, the only scaling axis, total CDF SRAM, what offloads the serial path.' },
      spec: { num: '8.2–8.3 · 5.20.6', title: 'Entropy decode — stage synthesis' },
      figures: [
        { title: 'ENT throughput model — one serial chain, scale by tiles',
          mermaid:
'graph TD\n' +
'  S["od_ec state<br/>{dif, rng, cnt}"] --> SY["decode 1 symbol"]\n' +
'  CDF["CDF RMW<br/>(same context)"] --> SY\n' +
'  SY --> TCQ["TCQ state update<br/>(coeff path)"]\n' +
'  TCQ --> S\n' +
'  SY --> NXT["next symbol<br/>(serial, ~1 / clk)"]\n' +
'  NXT --> SCALE["raise Mpix/s only by<br/>#tiles × #entropy instances"]\n' +
'  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  class S hot;\n  class TCQ hot;\n  class CDF mem;\n  class SY op;\n  class NXT op;\n  class SCALE op;',
          caption: 'Everything inside a tile is one carried-state serial chain; only tiles are independent.' },
      ],
      qna: [
        { tag: 'hw',
          q: 'What serial sum sets the symbols/clk ceiling?',
          a: 'Per symbol: **chain 1** = inverse-CDF boundary search (≤16 iters, each a multiply `rr·pp`) + narrow + renormalize (LZ-count + barrel shift); **chain 2** = CDF read + `update_cdf` + writeback (only on a same-context run); + **TCQ** state LUT. The boundary-search multiply loop and renormalize dominate, and the **dual RMW** (od_ec state + CDF) must both close in one symbol period ⇒ ≈ **1 symbol/clk** best case.' },
        { tag: 'hw',
          q: 'The only way to raise total Mpix/s?',
          a: '**Tile-level parallelism.** Inside a tile everything is serial (carried `od_ec` + TCQ + same-context CDF). Tiles are independent — each its own `avm_reader` + `tctx` copy — so throughput scales with **#tiles × #entropy instances**; nothing inside a block parallelizes. (The one independent boundary from ch.2 / ch.5.)' },
        { tag: 'delta',
          q: 'Total CDF SRAM budget — what grew in AV2?',
          a: 'Coeff CDFs: `coeff_base[…][TCQ_CTXS=2]` (≈2× vs AV1) + `coeff_base_lf` + `coeff_br` + **parity-hiding** `coeff_base_ph` (new) + **EOB banks** `eob_flag_cdf16…1024` + all mode/partition CDFs. The `[TCQ_CTXS]` dimension and the PH table are the AV2 adders; the per-tile `tctx` copy multiplies by the number of tile-parallel instances.' },
        { tag: 'hw',
          q: 'How much do bypass / sign offload the serial path?',
          a: 'bypass / 4-part / sign are **CDF-free** (equiprobable) ⇒ no RMW, no adaptation ⇒ a **multi-bit shifter** can consume several bits/clock in parallel. They take the high-range suffix and signs **off** the serial CDF loop (pass 2), which is exactly why the coeff path defers them. The serial bottleneck is the CDF-coded base/low-range, not the bypass tail.' },
        { tag: 'hw',
          q: 'Where can you safely pipeline?',
          a: 'Only **context-class-1 precompute** (ch.5): neighbor-block / position / plane context (and the CDF address) can be derived ahead of the serial engine, because it depends on already-decoded neighbors — not on the just-decoded symbol. Anything carrying `od_ec_dec` state or TCQ state cannot be pipelined across symbols.' },
      ] },
  ],
};
