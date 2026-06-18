# tool 데이터 스키마 (`tools/<id>.js`)

각 tool 앱 = `window.TOOL = {…}` 객체 하나. 렌더(`core/render.js`)는 공유, **데이터만** 채운다.
**실측 원칙:** `code`/`bridge`의 `file:line`·함수명은 `~/work/avm` grep·gdb로 확인한 것만. 미확인은 본문에 "미확인" 명시.

```js
window.TOOL = {
  id: 'ent',                      // StageMap의 stage id (ent/mip/iqt/intra/inter/lpf)
  title: 'Entropy Decoder',
  stage: 'ENT',                   // HW 스테이지 라벨 (hero 태그)
  coupling: ['MIP','IQT'],        // 강결합 스테이지 (앱바 미니맵 하이라이트)
  role: '비트스트림 심볼 복호 — 유일한 순차 병목',  // 인라인 md 가능

  // ── L1 Spec ──────────────────────────────
  spec: {
    sections: [{
      num: '8.3.2', title: 'Symbol decoding process',
      pseudo: 'markdown 허용. decode process 의사코드를 패러프레이즈(원문 장문 인용 금지).',
      elements: [{ name:'coeff_base', desc:'S()', meaning:'…' }]   // descriptor 표
    }],
    bitfields: [{                 // BitField 뷰어
      name: 'coefficient 시그널 순서',
      bits: [{ f:'eob', w:null, d:'가변(uvlc)' }, { f:'base', w:2, d:'…', hl:true }]
      // w:null → 가변(~) 표기. hl:true → 강조.
    }]
  },

  // ── L2 C-Model ───────────────────────────
  code: {
    callgraph: 'graph TD\n A[decode_block]-->B[…]',   // mermaid 문법 문자열
    funcs: [{ file:'av2/decoder/decodetxb.c', line:412, name:'av2_read_coeffs_txb',
              lang:'c', excerpt:'…실제 코드 발췌(AVM=BSD)…', note:'…마크다운 한 줄…' }],
    structs: [{ name:'DecoderCodingBlock', file:'…', line:0,
                fields:[{ f:'…', d:'…' }], note:'…' }],
    gdb: [{ at:'av2_read_coeffs_txb', val:'eob=17, tx_size=TX_8X8' }]
  },

  // ── L3 Bridge (Spec ↔ Code, AV1→AV2 델타) ──
  bridge: [{ specLine:'…', cLine:'av2_read_…()', kind:'changed', delta:'AV1 `aom_…` → AV2 `avm_…`: …' }],
  // kind: 'same'(동일) | 'changed'(변경) | 'new'(신규)

  // ── L4 HW (일반 사고법만 — 가드레일) ────────
  hw: {
    guardrail: true,             // false로 끄지 말 것(공개 경계)
    datapath: 'graph LR\n …',    // mermaid datapath 개념도
    throughput: 'markdown. symbol·pixel/cycle 관점, 일반론.',
    memory:    'markdown. 라인버퍼/컨텍스트 SRAM 스케일식(공개 도출).',
    hazard:    'markdown. 직렬 병목/의존성.',
    parallel:  'markdown. tile/SB/block 병렬화.',
    av1delta:  'markdown. AV1 디코더 HW 대비 신규/변경.',
    openQ: ['설계 trade-off 질문(사고 sandbox) …']
  },

  // ── 5 Checkpoints + Quiz ─────────────────
  checks: [{ q:'…', a:'…', hint:'…' }],            // 접이식, read-gated
  quiz:   [{ q:'…', options:['…','…'], answer:1, why:'…' }]
};
```

## 작성 체크
- [ ] 모든 `file:line` grep로 확인 (◻ 미확정은 "확인 예정" 표기, 추측 금지)
- [ ] AV1 델타는 `~/work/aom` 대응 함수와 대비 (same/changed/new)
- [ ] L4는 **§2 판별식** 통과분만 ("공개 자료로 누구나 도출 가능?")
- [ ] `node --check tools/<id>.js` 통과
