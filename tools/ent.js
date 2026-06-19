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
      'graph LR\n' +
      '  BS[bitstream] --> EC["od_ec<br/>range decoder"]\n' +
      '  CDF["CDF RMW<br/>tctx SRAM"] --> EC\n' +
      '  EC --> CDF\n' +
      '  EC --> LV["level / sign"]\n' +
      '  LV --> TCQ["TCQ FSM<br/>8-state"]\n' +
      '  TCQ -->|q_i 선택| CDF\n' +
      '  TCQ --> DQ["dequant<br/>Q0/Q1"]\n' +
      '  DQ --> OUT[dqcoeff → IQT]',
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
    { id: 'e1', n: 1, title: 'Range decoder 엔진 init', fn: { name: 'avm_od_ec_dec_init' }, ready: false },
    {
      id: 'e2', n: 2, title: '다중심볼 복호 코어', ready: true,
      fn: { name: 'avm_od_ec_decode_cdf_q15_c', file: 'avm_dsp/entdec.c', line: 192,
        role: '하나의 다중심볼을 산술 복호 — **엔트로피 디코더의 가장 안쪽 루프**(모든 syntax element이 결국 여기로).',
        callers: 'avm_read_symbol → avm_read_cdf_ (bitreader.h)', callees: 'od_ec_prob_scale · od_ec_dec_normalize' },
      spec: { num: '8.2.6', title: 'Symbol decoding process',
        pseudo: '입력 = 역CDF 배열 `icdf`(저장값 = `CDF_PROB_TOP - 누적확률`). 코드 윈도우 상위 16b를 `c`로 두고, ' +
          '심볼 경계 `v`를 range로 스케일하며 **`c`가 어느 구간에 드는지 선형 탐색** → 그 인덱스가 복호 심볼. 이후 범위 축소+정규화.\n\n' +
          '> AV1과 **byte-identical** 알고리즘. (엔진 재사용 = ENT HW의 핵심 레버리지.)' },
      walkthrough: [
        { code: 'int avm_od_ec_decode_cdf_q15_c(od_ec_dec *dec,\n                  const uint16_t *icdf, int nsyms) {', line: 192,
          note: '`icdf` = **역(inverse) CDF**. 저장값이 `TOP-누적`이라 "큰 값=낮은 심볼". `nsyms` = 알파벳 크기(≤16).' },
        { code: 'dif = dec->dif;\nr   = dec->rng;', line: 201,
          note: '디코더 상태 로드. `dif` = 64-bit **코드 윈도우**, `r` = 현재 **범위**(16-bit, 항상 ≥32768 유지).' },
        { code: 'c = (unsigned)(dif >> (OD_EC_WINDOW_SIZE - 16));', line: 208,
          note: '윈도우 **상위 16b**를 비교값 `c`로. (`OD_EC_WINDOW_SIZE=64` → `>>48`.) "지금 범위 어디에 있나".' },
        { code: 'v = r;\nret = -1;', line: 209,
          note: '`v`=전체 범위에서 시작, `ret`=심볼 인덱스 카운터(-1에서 증가).' },
        { code: 'do {\n  u = v;\n  ret++;\n  v = od_ec_prob_scale(icdf[ret], r, ret, nsyms);\n} while (c < v);', line: 211,
          note: '⭐ **역CDF 선형 탐색.** 심볼 경계 `v`를 range로 스케일하며 내려가다 `c >= v`가 되면 멈춤. 종료 시 `ret`=복호 심볼, `[v,u)`=그 심볼 구간. **반복수 가변(최대 nsyms).**' },
        { code: 'r = u - v;', line: 218,
          note: '새 범위 = 복호 심볼 구간의 폭. (산술부호의 "구간 좁히기".)' },
        { code: 'dif -= (od_ec_window)v << (OD_EC_WINDOW_SIZE - 16);', line: 219,
          note: '윈도우에서 구간 하한 `v`를 빼 **하한을 0으로 재정렬**.' },
        { code: 'return od_ec_dec_normalize(dec, dif, r, ret);', line: 220,
          note: '정규화(범위를 ≥32768로 되돌리며 윈도우 시프트·리필) 후 **심볼 반환**.' },
        { code: '// 헬퍼: prob.h:238\nint rr = r >> 8;\nint pp = (p >> EC_PROB_SHIFT) << 4;\npp += av2_prob_inc_tbl[nsym-2][n];   // ⭐ AV2 학습 PARA 증분\nreturn ((rr*pp >> (7-EC_PROB_SHIFT-CDF_SHIFT+1+6)) << 3);', line: 240,
          note: '`od_ec_prob_scale`: icdf 확률을 range로 스케일. **곱셈 `rr*pp`가 루프 내부 critical path.** `av2_prob_inc_tbl`(15×16) = 학습된 per-(알파벳,위치) 미세증분 — AV2 nuance(엔진은 같지만 확률 적응 디테일).' },
        { code: '// 헬퍼: entdec.h:140 (normalize)\nint d = 16 - OD_ILOG_NZ(rng);   // leading-zero → 시프트량\ndec->cnt -= d;\ndec->dif = ((dif + 1) << d) - 1;\ndec->rng = rng << d;\nif (dec->cnt < OD_EC_MIN_BITS) od_ec_dec_refill(dec);', line: 140,
          note: '`od_ec_dec_normalize`: `rng`의 leading-zero 수 `d`만큼 좌시프트해 범위 복원, 윈도우도 `d`비트 소비, `cnt`<임계면 윈도우 **리필**(비트스트림 read).' },
      ],
      structs: [
        { name: 'od_ec_dec', file: 'avm_dsp/entdec.h', line: 36,
          fields: [
            { f: 'od_ec_window dif (uint64)', d: '코드 윈도우. 상위 16b가 비교값 c' },
            { f: 'uint16_t rng', d: '현재 범위(≥32768 유지)' },
            { f: 'int16_t cnt', d: '윈도우 유효 비트 카운트(<임계 시 리필)' },
            { f: 'bptr / end', d: '비트스트림 포인터' },
          ],
          note: 'AV1 `aom_dsp/entdec.h`와 동일 레이아웃. **이 3개 상태(dif/rng/cnt)의 read-modify-write가 심볼 간 직렬 의존의 핵심.**' },
        { name: '상수', file: 'avm_dsp/prob.h · entcode.h', line: 0,
          fields: [
            { f: 'OD_EC_WINDOW_SIZE = 64', d: 'od_ec_window=uint64' },
            { f: 'CDF_PROB_TOP = 32768 (2^15)', d: 'icdf 정규화 상한' },
            { f: 'EC_PROB_SHIFT = 7', d: '확률 스케일 시프트' },
            { f: 'av2_prob_inc_tbl[15][16]', d: '학습 PARA 증분(entcode.h:37)' },
          ] },
      ],
      hw: {
        datapath: 'graph LR\n' +
          '  WIN["dif 윈도우(64b)"] --> TOP["상위16b → c"]\n' +
          '  ICDF["icdf[ret]<br/>(CDF SRAM)"] --> PS["prob_scale<br/>곱 rr*pp + 시프트"]\n' +
          '  PARA["prob_inc_tbl<br/>(ROM)"] --> PS\n' +
          '  TOP --> CMP{"c < v ?"}\n' +
          '  PS --> CMP\n' +
          '  CMP -->|yes, ret++| ICDF\n' +
          '  CMP -->|no| RNG["r = u-v"]\n' +
          '  RNG --> NRM["normalize<br/>LZ count + 시프트 + refill"]\n' +
          '  NRM --> WIN',
        questions: [
          'do-while는 **가변 반복**(최대 nsyms≤16). 16-way 병렬 비교로 1-cycle 고정 vs 순차 반복 — 면적 vs 주파수 트레이드?',
          '`od_ec_prob_scale`의 곱셈(`rr*pp`)이 루프 내부에 있음. 매 반복 곱 vs 모든 경계 사전계산? 파이프라인 가능 지점은?',
          '`av2_prob_inc_tbl`(per 반복 조회) + `icdf`(CDF SRAM) — 한 반복에 필요한 ROM/SRAM **read 포트 수**는? 16-way면?',
          'normalize의 leading-zero count + 가변 시프트 + 조건부 refill — 별도 파이프 스테이지로? refill(비트스트림 read)의 가변 지연을 어떻게 가리나?',
          '이 함수 = **심볼 1개/호출**. throughput 상한(심볼/cycle)을 결정하는 직렬 합은? (경계탐색 반복 + 곱셈 + normalize)',
          '다음 호출이 갱신된 `dec->{dif,rng,cnt}`에 의존 → 호출 간 직렬. 파이프라이닝으로 이 의존을 가릴 수 있나, 아니면 본질적 병목인가?',
        ],
        derived: null,
      },
      checks: [
        { q: '`icdf`가 "inverse" CDF인 이유와, 그게 비교 `c<v`를 왜 자연스럽게 만드나?',
          a: '저장값 = `CDF_PROB_TOP - 누적확률`이라 심볼이 커질수록 값이 작아짐. `v`를 큰 경계→작은 경계로 내려가며 `c<v`인 동안 반복 → `c>=v`에서 멈춘 `ret`이 c가 속한 구간.',
          hint: '저장값과 누적확률의 관계.' },
        { q: '이 함수는 심볼 몇 개를 디코드하나? 루프의 정체는?',
          a: '**1개.** 루프는 그 1심볼의 구간을 역CDF에서 선형 탐색하는 것(심볼 여러 개가 아님).',
          hint: 'ret의 의미.' },
        { q: '엔진이 AV1과 같은데 AV2가 손댄 디테일 하나는?',
          a: '`od_ec_prob_scale`의 `av2_prob_inc_tbl[nsym-2][n]` — 학습된 per-(알파벳,위치) 확률 미세증분. 코어 알고리즘은 동일.',
          hint: 'prob_scale 안의 테이블.' },
      ],
    },
    { id: 'e3', n: 3, title: '정규화·비트회계', fn: { name: 'od_ec_dec_normalize' }, ready: false },
    { id: 'e4', n: 4, title: '심볼 read·CDF 업데이트', fn: { name: 'avm_read_symbol / update_cdf' }, ready: false },
    { id: 'e5', n: 5, title: 'CDF 선택·컨텍스트 유도', fn: { name: 'cdf selection (§8.3.2)' }, ready: false },
    { id: 'e6', n: 6, title: '계수블록 진입', fn: { name: 'av2_read_coeffs_txb_facade' }, ready: false },
    { id: 'e7', n: 7, title: 'EOB 디코드', fn: { name: 'decode_eob' }, ready: false },
    { id: 'e8', n: 8, title: 'base+low-range 역스캔', fn: { name: 'read_coeffs_reverse_2d' }, ready: false },
    { id: 'e9', n: 9, title: '⭐ TCQ 상태기계', fn: { name: 'tcq_next_state' }, ready: false },
    { id: 'e10', n: 10, title: 'high-range Rice/Golomb', fn: { name: 'read_adaptive_hr' }, ready: false },
    { id: 'e11', n: 11, title: 'HW 종합 (ENT 스테이지)', fn: { name: '(전체)' }, ready: false },
  ],
};
