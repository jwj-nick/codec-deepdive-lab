/* tools/mvp.js — Motion Vector Prediction (MVP) — inter에서 분리한 전용 페이지.
   실측: ~/work/avm. find_mv_refs(후보 스택) → DRL(후보 선택) → MVD 복호 → 최종 MV. ref-MV bank·7-level 정밀도 포함. */
window.TOOL = {
  id: 'mvp',
  title: 'Motion Vector Prediction (MVP)',
  stage: 'MIP·PRD',
  coupling: ['inter', 'mip'],
  role: 'MV를 어떻게 예측·복원하나 — 후보 스택(`find_mv_refs`, 6칸) + warp 후보 → **DRL**로 예측자 선택 → **MVD** 가산 → 최종 MV. ' +
    'AV2는 DRL 확장·**ref-MV bank**(영속)·**7-level 정밀도**·warp 후보·AMVD 추가. ' +
    'inter 예측(<a href="app.html?tool=inter">inter</a>)의 입력단. mode 파싱은 <a href="app.html?tool=mip">MIP</a>.',
  spec: {
    sections: [
      { num: '7.12', title: 'Motion vector prediction processes',
        pseudo: '공간(이웃)·시간(tpl_mvs)·파생·global 후보를 모아 `ref_mv_stack`(6칸, 가중 정렬) → DRL idx로 1개 선택 → MVD(joint+component) 가산 → MV. ref-MV bank가 SB 경계 넘어 후보 보강.' },
    ],
  },
  chapters: [
    { id: 'v1', n: 1, title: 'MVP overview & ref_mv_stack', stage: 'skeleton',
      fn: { name: 'av2_find_mv_refs', file: 'av2/common/mvref_common.c', line: 2829,
        role: 'Build ref_mv_stack[6] + weights + global_mvs + warp candidate stack from spatial/temporal/derived candidates.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      io: {
        diagCaption: 'gather candidates → weighted stack → DRL → +MVD',
        diagram: 'graph TD\n' +
          '  SP["spatial nbr MVs<br/>(scan row/col)"] --> ST["ref_mv_stack[6]<br/>weighted, dedup"]\n' +
          '  TP["temporal tpl_mvs"] --> ST\n' +
          '  BK["ref-MV bank<br/>(persistent LRU)"] --> ST\n' +
          '  GM["global motion"] --> ST\n' +
          '  ST --> DRL["DRL idx<br/>(read_drl_idx)"]\n' +
          '  DRL --> PRED["MV predictor"]\n' +
          '  MVD["MVD (read_mv)<br/>joint + component"] --> ADD["+ predictor"]\n' +
          '  PRED --> ADD\n' +
          '  ADD --> MV["final MV → inter MC"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff6b6b,color:#e6edf3;\n' +
          '  class SP mem;\n  class TP mem;\n  class BK mem;\n  class GM mem;\n  class MVD mem;\n  class MV mem;\n' +
          '  class ST op;\n  class DRL op;\n  class PRED op;\n  class ADD op;\n  class BK hot;',
        in: [
          { sig: 'spatial/temporal/bank/global', type: 'CANDIDATE_MV', peer: 'neighbors + tpl_mvs + ref-MV bank', vol: '→ stack 6', note: 'weighted, dedup' },
        ],
        out: [
          { sig: 'ref_mv_stack', type: 'CANDIDATE_MV[6] + weight[6]', peer: '→ DRL select', vol: 'MAX_REF_MV_STACK_SIZE=6', note: '+ warp_param_stack' },
        ],
        note: 'MV prediction = build a weighted candidate stack, pick one by DRL, add the signaled MVD. The stack build reads many neighbors → neighbor-serial.',
      },
      qna: [
        { tag: 'common', ref: 'mvref_common.c:2829',
          q: 'MV 예측의 큰 그림은? (AV1 공통)',
          a: '`av2_find_mv_refs`가 **공간 이웃·시간(tpl_mvs)·파생·global** MV 후보를 모아 **`ref_mv_stack`(6칸, 가중 정렬)** 구성 → DRL로 1개 선택 → MVD 가산 → 최종 MV. "후보 스택 + 인덱스 + 차분" 구조는 AV1 계승.' },
        { tag: 'verified', ref: 'enums.h:1054',
          q: '후보 스택 크기는? (실측)',
          a: '`MAX_REF_MV_STACK_SIZE=6`, `MAX_MV_REF_CANDIDATES=2`. `find_mv_refs`가 `ref_mv_stack[][6]` + `ref_mv_weight[][6]` + `warp_param_stack`(warp 후보)까지 채움. 가중치로 정렬해 상위 후보가 DRL idx 0.' },
        { tag: 'delta', ref: 'mvref_common.c:2864',
          q: 'AV2가 후보에 추가한 것은? (AV2 델타)',
          a: '**warp candidate stack**(`derive_wrl`, motion-variation 허용 시) + **ref-MV bank**(영속 LRU, v4) + 파생 MV(derived_mv). AV1보다 후보 출처가 많아 스택 정렬·dedup이 복잡. global motion은 `get_warp_motion_vector`로.' },
      ] },
    { id: 'v2', n: 2, title: 'Candidate scan (spatial/temporal)', stage: 'skeleton',
      fn: { name: 'add_ref_mv_candidate / scan_row/col + tpl', file: 'av2/common/mvref_common.c', line: 820,
        role: 'Scan neighbor mbmi (row/col) + temporal tpl_mvs, dedup into the stack with weights.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'common', ref: 'mvref_common.c:820',
          q: '후보 스캔은 어떻게? (AV1 공통)',
          a: '`add_ref_mv_candidate`가 위/왼쪽 이웃 `mbmi`의 MV를 스택에 넣되 **중복 제거 + 가중치 누적**(같은 MV면 weight↑). 시간 후보는 `tpl_mvs`(동위치 이전 프레임 MV) 투영. 공간+시간 스캔은 AV1과 동형.' },
        { tag: 'verified', ref: 'mvref_common.c:754',
          q: '스택 삽입 규칙은? (실측)',
          a: '`index == *refmv_count && refmv_count < 6`이면 기존 후보에 weight 가산, 아니면 새 칸 append(6칸 한도). derived MV는 `derived_mv_count`로 별도 관리 후 병합. 즉 LRU가 아니라 **weight 기반 우선순위** 스택.' },
        { tag: 'hw', ref: 'mvref_common.c:820',
          q: '후보 스캔의 HW 직렬성은?',
          a: '여러 이웃 `mbmi`를 순회하며 dedup/weight → **이웃 의존 직렬**(이웃 mode가 먼저 확정돼야). tpl_mvs는 DRAM read. 스택 6칸 + weight = 작은 on-chip state지만 스캔 순서가 MV 파싱 지연을 만듦.' },
      ] },
    { id: 'v3', n: 3, title: 'DRL — candidate index', stage: 'skeleton',
      fn: { name: 'read_drl_idx', file: 'av2/decoder/decodemv.c', line: 440,
        role: 'Read which stack candidate is the predictor: up to max_drl_bits binary symbols → ref_mv_idx.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'delta', ref: 'decodemv.c:440',
          q: 'DRL이란? (AV2 델타)',
          a: '**Dynamic Reference List** — 6칸 후보 스택 중 **어느 것을 예측자로 쓸지**의 인덱스. `read_drl_idx`가 `max_drl_bits`까지 **binary 심볼 연속**으로 읽어 `ref_mv_idx` 결정(0 나오면 중단). AV2는 second DRL(`has_second_drl`)·확장 컨텍스트로 AV1보다 정교.' },
        { tag: 'verified', ref: 'decodemv.c:450',
          q: 'DRL 읽기 루프는? (실측)',
          a: 'ref마다(1 + has_second_drl) `idx < max_drl_bits` 루프: `drl_cdf = av2_get_drl_cdf(…, idx)` → `drl_idx = read_symbol(2)` → `ref_mv_idx = idx + drl_idx`, `!drl_idx`면 break. NEAR_NEARMV 동일ref 특수 케이스로 두 번째 idx 보정.' },
        { tag: 'hw', ref: 'decodemv.c:440',
          q: 'DRL의 HW 특성은?',
          a: '후보 스택(v1)이 완성돼야 인덱스가 유효 → **스택 build → DRL read 직렬**. 심볼은 ENT 산술 체인. idx로 6칸 중 1개 select = 작은 mux. MVP 직렬성의 한 고리.' },
      ] },
    { id: 'v4', n: 4, title: 'ref-MV bank (persistent)', stage: 'skeleton',
      fn: { name: 'update_ref_mv_bank', file: 'av2/common/mvref_common.c', line: 4635,
        role: 'LRU ring-buffer of recently-used MVs per ref list, persisting across SB boundaries; feeds find_mv_refs.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'delta', ref: 'mvref_common.c:4635',
          q: 'ref-MV bank이란? (AV2 신규)',
          a: '최근 사용 MV를 ref_frame 리스트별 **ring buffer**(`rmb_buffer[list][REF_MV_BANK_SIZE]`)에 누적해 **SB 경계를 넘어 유지** → `find_mv_refs`가 추가 후보로 소비. AV1은 영속 bank 없음(공간/시간 후보만). 멀리 떨어진 블록의 MV도 재활용.' },
        { tag: 'verified', ref: 'mvref_common.c:4668',
          q: 'bank 갱신 규칙은? (실측)',
          a: '현재 MV가 buffer에 **있으면 끝(most-recent)으로 이동**(LRU), 없으면 append(가장 오래된 것 evict). `rmb_list_index=get_rmb_list_index(ref_frame)`. hit 한도(`MAX_RMB_SB_HITS`)로 갱신량 제한.' },
        { tag: 'hw', ref: 'mvref_common.c:4635',
          q: 'ref-MV bank의 HW 직렬성·비용은?',
          a: '**per-block 직렬 갱신**(carried state) → MV 예측이 bank 상태에 의존, 블록/SB 순차 제약. ring buffer state(CANDIDATE_MV + ref 태그 + warp bank) = on-chip SRAM, LRU 이동(검색+shift)에 다중 포트. (inter 페이지의 r9에서 이관.)' },
      ] },
    { id: 'v5', n: 5, title: 'Flexible MV precision (7-level)', stage: 'skeleton',
      fn: { name: 'av2_read_pb_mv_precision', file: 'av2/decoder/decodemv.c', line: 2592,
        role: 'Per-block adaptive MV precision: 7 levels (8-pel..1/8-pel) via mpp_flag + down symbol.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'delta', ref: 'mv.h:75',
          q: 'AV2 MV 정밀도 레벨은? (AV2 신규)',
          a: '**7 레벨**: `MV_PRECISION_8_PEL`(0)·4-pel·2-pel·1-pel·HALF·QTR·`ONE_EIGHTH_PEL`(6) (`NUM_MV_PRECISIONS=7`). AV1은 `allow_high_precision_mv` **단일 플래그**(¼/⅛). AV2는 **per-block 적응 정밀도** → MVD 비트 절감.' },
        { tag: 'verified', ref: 'decodemv.c:2608',
          q: 'precision 파싱은? (실측)',
          a: '`mpp_flag`(most-probable-precision) → set이면 `most_probable_pb_mv_precision`. 아니면 `down` 심볼(`pb_mv_precision_cdf[ctx][max−HALF]`) → `av2_get_precision_from_index`. precision set `av2_mv_precision_sets[mb_precision_set]`.' },
        { tag: 'hw', ref: 'decodemv.c:2592',
          q: '7-level의 HW 영향은?',
          a: '정밀도별 **가변 MV 라운딩/shift** + subpel 보간 위상 선택(inter r2 필터). 블록당 mpp_flag/down 컨텍스트 CDF read. (inter r8에서 이관.) MVD를 어느 격자로 해석할지를 정함 → MVD 복호(v6)와 직결.' },
      ] },
    { id: 'v6', n: 6, title: 'MVD decode (joint + AMVD)', stage: 'skeleton',
      fn: { name: 'read_mv / read_mv_component', file: 'av2/decoder/decodemv.c', line: 1866,
        role: 'MV difference: joint type (which components nonzero) + per-component magnitude; AMVD adaptive joints.' },
      spec: { num: '7.12', title: 'Motion vector prediction processes' },
      qna: [
        { tag: 'common', ref: 'decodemv.c:1866',
          q: 'MVD는 어떻게 복호되나? (AV1 공통)',
          a: '`read_mv`: **MV_JOINT** 심볼(row/col 중 어느 성분이 0이 아닌지) → 성분별 magnitude/sign. 예측자 + MVD = 최종 MV. joint+component 구조는 AV1 계승.' },
        { tag: 'delta', ref: 'decodemv.c:1841',
          q: 'AMVD란? (AV2 델타)',
          a: 'Adaptive MVD — `amvd_joints_cdf`로 joint를 **적응 코딩**, 정밀도(v5)에 맞춰 MVD 해상도 조정. AV2는 정밀도가 7-level이라 MVD 코딩이 레벨에 적응 → 같은 MV를 더 적은 비트로.' },
        { tag: 'hw', ref: 'decodemv.c:1866',
          q: 'MVD 복호의 HW 위치는?',
          a: 'ENT 산술 심볼(joint + 성분). 예측자(v1~v4)와 정밀도(v5)가 정해진 뒤 **MVD 가산 → 최종 MV → ref-MV bank 갱신**(v4). MVP 직렬 체인의 종착: stack→DRL→MVD→MV→bank update.' },
      ] },
    { id: 'v7', n: 7, title: 'HW synthesis (MVP)', stage: 'skeleton',
      fn: { name: '(whole MVP)',
        role: 'A neighbor-serial, ENT-coupled candidate-and-difference chain feeding the inter MC; persistent bank state.' },
      qna: [
        { tag: 'hw',
          q: 'MVP 전체를 HW로 요약하면?',
          a: '**직렬 체인**: 이웃/시간/bank 후보 스캔 → ref_mv_stack(6) → DRL idx → 예측자 → MVD 가산 → 최종 MV → **bank 갱신**. 연산은 가볍지만(스택 정렬·mux·가산) 전부 **이웃·상태 의존 직렬** + ENT 산술 결합 → MV 파싱이 디코더 front 직렬성의 핵심.' },
        { tag: 'hw',
          q: 'MVP가 inter MC와 어떻게 맞물리나?',
          a: 'MVP 출력(최종 MV) = inter MC(<a href="app.html?tool=inter">inter</a>)의 입력. 또 DMVR/optical-flow가 그 MV를 **다시 정제** → MVP(예측)·MC(보상)·정제가 직렬. MVP는 MIP mode 파싱 안에서 일어나므로 MIP·ENT와도 강결합.' },
        { tag: 'hw',
          q: 'MVP의 on-chip state 예산은?',
          a: 'ref_mv_stack(6×CANDIDATE_MV + weight) + warp_param_stack + **ref-MV bank**(ring buffer ×ref list) + 이웃 mbmi MV. bank가 SB 경계 넘어 유지돼 가장 큰 항. precision CDF·DRL CDF 뱅크도 ENT 컨텍스트에 추가.' },
      ] },
  ],
};
