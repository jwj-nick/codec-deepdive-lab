/* tools/recon.js — Reconstruct loop (REC): the intra/inter SHARED block-reconstruct skeleton.
   실측: ~/work/avm (AV2). Factored out of intra(n8) + inter(r10) — predict differs, reconstruct is identical. */
window.TOOL = {
  id: 'recon',
  title: 'Reconstruct loop (REC) — intra/inter 공유',
  stage: 'REC',
  coupling: ['IQT', 'PRD'],
  role: '블록 복원 골격 — **predict(intra 이웃 / inter 참조) → IQT(dequant→CCTX→IST→2D) → clip-add → 다음 블록**. ' +
    '예측 소스만 다르고 **재구성 체인은 intra·inter 동일**. intra·inter 정독에서 추출해 한 곳에 정리(중복 제거).',

  spec: {
    sections: [
      { num: '7.13', title: 'Prediction + Reconstruction process',
        pseudo:
          '블록 = **예측 + 잔차**. 디코더는 TX 블록마다:\n' +
          '1. **predict** — intra(복원 이웃) 또는 inter(참조 프레임 MC). 함수포인터로 분기.\n' +
          '2. **read coeffs + dequant** — 엔트로피 계수 복호(역양자화 내장).\n' +
          '3. **CCTX**(색차) → **IST**(2차) → **1차 2D 역변환**.\n' +
          '4. **clip-add** — 잔차를 예측에 더해 복원.\n' +
          '핵심: 1번만 intra/inter가 다르고 2~4는 **공통**.' },
      { num: '6.10.x', title: 'decode_reconstruct_tx (decodeframe.c:450)',
        pseudo: 'TX 블록 단위 재구성. CCTX 허용 시 U/V를 함께 읽고 CCTX 후 역변환. TX 파티션이면 sub-TX 재귀.' },
    ],
  },

  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  SEL{"frame/block<br/>type"} -->|intra| PI["intra predict<br/>(복원 이웃)"]\n' +
      '  SEL -->|inter| PR["inter predict<br/>(참조 MC)"]\n' +
      '  PI --> PRED["prediction"]\n' +
      '  PR --> PRED\n' +
      '  ENT["read_coeffs + dequant<br/>(ENT)"] --> CCX["CCTX (chroma)"]\n' +
      '  CCX --> TX["IST → 1차 2D 역변환"]\n' +
      '  TX --> ADD["clip-add<br/>잔차 + 예측"]\n' +
      '  PRED --> ADD\n' +
      '  ADD --> REC["복원 블록"]\n' +
      '  REC -.->|intra만: 다음 블록 이웃| PI\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
      '  class REC mem;\n  class PRED mem;\n  class PI op;\n  class PR op;\n  class ENT op;\n  class CCX op;\n  class TX op;\n  class ADD op;',
    throughput:
      '재구성 체인(read_coeffs→CCTX→IST→2D→add)은 **intra·inter 공통 datapath** — IQT 스테이지가 그대로 잔차를 공급. ' +
      '앞단 predict만 두 front-end(intra 예측 / inter MC)로 갈림. 공유 add 단은 1개면 충분.',
    hazard:
      '**intra**: predict_and_reconstruct가 TX 블록마다 fuse → 복원 픽셀이 다음 블록 이웃 → **recon-feedback 직렬**. ' +
      '**inter**: 블록 전체를 먼저 예측(참조 fetch) 후 재구성 → intra-block 피드백 없음(블록 병렬 자유), 대신 DRAM 대역폭 지배.',
    av1delta:
      '재구성 골격은 AV1 계승. AV2 변경 = 체인 *내부*: **CCTX 삽입**(색차 U/V 결합)·**IST 2차변환**·dequant int32. predict front-end는 각 tool(intra/inter) 참조.',
  },

  checks: [
    { q: 'intra와 inter에서 "재구성"의 무엇이 같고 무엇이 다른가?',
      a: '**다른 것 = predict 단 하나**(intra 복원 이웃 vs inter 참조 MC, 함수포인터 분기). **같은 것 = 재구성 체인 전부**: read_coeffs+dequant → CCTX → IST → 1차 2D → clip-add. 그래서 한 곳(recon)에 정리.',
      hint: 'decode_reconstruct_tx는 intra/inter 공용.' },
    { q: 'intra가 inter보다 블록 병렬화가 어려운 구조적 이유는?',
      a: 'intra는 `predict_and_reconstruct_intra_block`이 **TX 블록마다 예측+재구성을 fuse** → 복원 픽셀이 다음 블록의 이웃이 됨(recon-feedback 직렬). inter는 블록 전체를 먼저 예측해 그 피드백이 없음(대신 대역폭 지배).',
      hint: 'predict_and_reconstruct vs predict_inter_block 호출 시점.' },
  ],

  chapters: [
    { id: 'rc1', n: 1, title: 'Reconstruct loop overview', stage: 'skeleton',
      fn: { name: 'decode_reconstruct_tx', file: 'av2/decoder/decodeframe.c', line: 450,
        role: 'Per TX block: read coeffs+dequant → CCTX(chroma) → inverse-tx(IST+2D) → accumulate eob; TX-partition recursion.' },
      spec: { num: '7.13', title: 'Prediction + Reconstruction process' },
      qna: [
        { tag: 'common', ref: 'decodeframe.c:450',
          q: '블록 재구성의 공통 골격은? (intra·inter 공유)',
          a: '`decode_reconstruct_tx`가 TX 블록마다: `read_coeffs_tx_*_block_visit`(엔트로피 계수+dequant) → `inverse_cctx_block_visit`(CCTX, 색차) → `inverse_tx_*_block_visit`(IST+2D 역변환+가산) → eob 누적. **intra·inter가 똑같이** 이 함수를 씀(`_intra_`/`_inter_` visit는 이름만 다르고 재구성 산술 동일).' },
        { tag: 'delta', ref: 'decodeframe.c:466',
          q: '재구성 체인 내부의 AV2 변경은? (AV2 델타)',
          a: '골격은 AV1 계승, 변경은 *체인 내부*: 색차면 **U/V를 함께 read → `inverse_cctx_block_visit`(CCTX) → 함께 역변환**(cross-plane join, IQT i3). 그 안에 **IST 2차변환**·dequant **int32**도 AV2 추가.' },
        { tag: 'verified', ref: 'decodeframe.c:495',
          q: 'TX 파티션은 어떻게 처리되나? (실측)',
          a: '`tx_partition_type != TX_PARTITION_NONE`이면 `get_tx_partition_sizes`로 sub-TX 분할 후 각 `txb_idx`마다 재귀 재구성. 즉 한 코딩블록이 여러 TX로 쪼개져도 동일 체인을 반복.' },
        { tag: 'hw', ref: 'decodeframe.c:450',
          q: '재구성 루프의 HW 의미는?',
          a: '재구성 체인 = **IQT 스테이지가 잔차를 공급하는 공통 datapath**. 앞단 predict만 두 front-end(intra/inter)로 갈림 → **clip-add 단은 1개**면 충분(예측 소스 무관). 파이프 후반부를 intra/inter가 공유.' },
      ] },
    { id: 'rc2', n: 2, title: 'Predict dispatch (intra vs inter)', stage: 'skeleton',
      fn: { name: 'predict_and_reconstruct_intra_block / predict_inter_block', file: 'av2/decoder/decodeframe.c', line: 271,
        role: 'Function-pointer dispatch: intra → av2_predict_intra_block_facade; inter → av2_setup_pre_planes + av2_build_inter_predictors.' },
      spec: { num: '7.13', title: 'Prediction process' },
      qna: [
        { tag: 'verified', ref: 'decodeframe.c:4604',
          q: 'predict 분기는 어떻게 결정되나? (실측)',
          a: '함수포인터 셋업: `predict_and_recon_intra_block_visit = predict_and_reconstruct_intra_block`(decodeframe.c:4604), `predict_inter_block_visit = predict_inter_block`(:4607). `parse_decode_flag` 비트로 활성. 프레임/블록 타입이 **유일한 분기점**.' },
        { tag: 'delta', ref: 'decodeframe.c:271',
          q: 'intra 경로의 특징은? (구조)',
          a: '`predict_and_reconstruct_intra_block` → `av2_predict_intra_block_facade`(intra tool n1~n7). 이름이 "predict_**and_reconstruct**" — 예측과 재구성을 **TX 블록 단위로 묶음**(복원 이웃 의존 때문).' },
        { tag: 'delta', ref: 'decodeframe.c:822',
          q: 'inter 경로의 특징은? (구조)',
          a: '`predict_inter_block` → ref별 `av2_setup_pre_planes`(참조 프레임 평면 설정) + `av2_build_inter_predictors`(MC, inter tool r1~r9). compound면 ref 2개. **블록 전체를 먼저 예측** 후 재구성 — TX 단위 fuse 아님.' },
        { tag: 'hw', ref: 'decodeframe.c:4595',
          q: '두 front-end의 HW 배치는?',
          a: '**intra 예측기**(DC/dir/DIP/CfL/MHCCP — 전용 모듈)와 **inter MC 엔진**(warp/translation+정제)이 별도 front-end로 공존, 같은 재구성 back-end(IQT add)로 합류. 블록 타입에 따라 한쪽만 발화(배타).' },
      ] },
    { id: 'rc3', n: 3, title: 'Residual add → reconstructed block', stage: 'skeleton',
      fn: { name: 'inverse_tx_*_block_visit → highbd_clip_pixel_add', file: 'av2/common/idct.c', line: 760,
        role: 'IST → 2D inverse transform → clip-add the residual onto the prediction buffer in place.' },
      spec: { num: '7.13', title: 'Reconstruction process' },
      qna: [
        { tag: 'common', ref: 'idct.c:760',
          q: '잔차 가산은 어디서 일어나나? (공유)',
          a: '역변환 마지막 `highbd_clip_pixel_add(dst, residual, bd)` — **잔차를 예측 버퍼에 in-place 가산** + 픽셀범위 clip. 예측(intra/inter)이 미리 `dst`에 써둔 위에 IQT 잔차를 더해 복원 완성. 이 add가 intra/inter 공통 종착점.' },
        { tag: 'delta', ref: 'idct.c:1019',
          q: '가산 전 체인(AV2 추가)은? (AV2 델타)',
          a: '잔차 = dequant(int32+QUANT_TABLE_BITS) → CCTX(색차 2×2 회전) → IST(2차 dense matmul) → 1차 2D. **CCTX·IST가 AV2 신규 삽입**(AV1은 dequant→2D 직행). 가산 자체는 AV1과 동일.' },
        { tag: 'hw', ref: 'idct.c:760',
          q: '가산 단의 HW 특성은?',
          a: '픽셀당 1 add + clip = **저비용 공유 단**. 예측 버퍼(SRAM)에 read-modify-write. eob=0이면 가산 skip(잔차 없음 → 예측이 곧 복원). intra/inter 모두 같은 add 유닛 재사용.' },
      ] },
    { id: 'rc4', n: 4, title: 'Dependency contrast (feedback vs fetch)', stage: 'skeleton',
      fn: { name: '(intra recon-feedback vs inter reference-fetch)',
        role: 'Why intra is block-serial (neighbor feedback) and inter is bandwidth-bound (reference fetch, no feedback).' },
      qna: [
        { tag: 'hw',
          q: 'intra와 inter의 의존성이 근본적으로 어떻게 다른가?',
          a: '**intra = recon-feedback**: 복원 블록이 다음 블록의 *이웃* → 블록 N 완성 전 N+1 예측 불가 → **블록 직렬**. **inter = reference-fetch**: 예측이 *이전 프레임*에서 옴(현재 프레임 이웃 무관) → 블록 피드백 없음 → **블록 병렬 자유**, 대신 DRAM 대역폭 지배.' },
        { tag: 'hw',
          q: '이 차이가 스케줄링에 주는 함의는?',
          a: 'intra 프레임/블록은 **순차 처리**(이웃 준비 대기)가 강제 — recon 루프가 임계경로. inter는 **여러 블록 동시 MC** 가능하지만 fetch 대역폭이 천장 → 직렬성은 ref-MV bank·TIP barrier 같은 *메모리/상태* 의존에서 옴(공간적 이웃 아님).' },
        { tag: 'hw',
          q: '공유 back-end 입장에서 두 모드를 어떻게 먹이나?',
          a: '재구성 back-end(IQT add)는 동일하니, 차이는 **front-end가 예측을 얼마나 빨리 dst에 채우느냐**. intra는 이웃 대기로 띄엄띄엄, inter는 fetch 대역폭에 맞춰 흐름. back-end는 예측이 준비된 블록부터 잔차 가산 → front-end 속도에 종속.' },
      ] },
    { id: 'rc5', n: 5, title: 'HW synthesis (shared recon)', stage: 'skeleton',
      fn: { name: '(whole reconstruct loop)',
        role: 'One shared reconstruct back-end (IQT add) fed by two prediction front-ends (intra modules / inter MC); intra adds the serial neighbor feedback.' },
      figures: [
        { title: 'Two predict front-ends → one shared reconstruct back-end',
          mermaid:
'graph TD\n' +
'  IF["intra front-end<br/>DC/dir/DIP/CfL/MHCCP<br/>(복원 이웃)"] --> PRED["prediction (dst)"]\n' +
'  RF["inter front-end<br/>warp/translation MC<br/>+ TIP/DMVR/optflow<br/>(참조 프레임)"] --> PRED\n' +
'  ENT["ENT: read_coeffs + dequant"] --> IQT["IQT: CCTX → IST → 2D"]\n' +
'  IQT --> ADD["clip-add (공유 back-end)"]\n' +
'  PRED --> ADD\n' +
'  ADD --> REC["복원 블록"]\n' +
'  REC -. "intra만: 이웃 피드백 (직렬)" .-> IF\n' +
'  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
'  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
'  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
'  class REC mem;\n  class PRED mem;\n  class IF op;\n  class RF op;\n  class ENT op;\n  class IQT op;\n  class ADD op;\n  class IF hot;',
          caption: '재구성 back-end(IQT→add)는 하나로 공유. intra/inter는 prediction을 dst에 채우는 front-end만 다름. intra의 이웃 피드백(빨강)만 back-end로 직렬 루프를 만든다.' },
      ],
      qna: [
        { tag: 'hw',
          q: 'recon 전체를 HW로 한 장에 요약하면?',
          a: '**2 predict front-end → 1 공유 reconstruct back-end**. front-end = intra 예측 모듈군(전용) | inter MC 엔진+정제. back-end = ENT(계수+dequant) → IQT(CCTX→IST→2D) → **clip-add**. 블록 타입이 front-end만 고르고, back-end는 그대로 잔차를 더함.' },
        { tag: 'hw',
          q: 'recon이 파이프라인 병렬성에 주는 결론은?',
          a: 'back-end는 feed-forward라 병렬 친화. **병목은 front-end 쪽**: intra는 recon-feedback(이웃 직렬), inter는 DRAM 대역폭. 즉 디코더 처리율은 "예측을 얼마나 빨리 채우나"가 좌우하고, 재구성 산술은 천장이 아님.' },
        { tag: 'delta',
          q: 'recon 관점의 AV1→AV2 변경 요약은? (델타)',
          a: '**골격 불변**(predict→잔차→add→다음). 변경은 ① 재구성 체인에 **CCTX·IST 삽입** + dequant int32(IQT) ② predict front-end 대폭 강화(intra: DIP/CfL/MHCCP/IBP·MRL / inter: TIP/DMVR/optical-flow/12-tap/7-level MV). back-end add는 그대로.' },
      ] },
  ],
};
