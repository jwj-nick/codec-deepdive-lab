/* tools/deblock.js — In-loop filter 1/5: Deblocking (generic asymmetric filter).
   실측: ~/work/avm (AV2) · ~/work/aom (AV1). LPF 체인의 첫 패스. */
window.TOOL = {
  id: 'deblock',
  title: 'Deblocking filter (LPF 1/5)',
  stage: 'LPF',
  coupling: ['lpf', 'PRD'],
  role: 'In-loop 첫 패스 — 블록 경계 불연속 평활. AV2는 AV1의 고정 4/6/8/14-tap 필터군을 **런타임 비대칭 가변폭 generic 필터** 하나로 통합. ' +
    '▶ 전체 체인은 <a href="app.html?tool=lpf">LPF 허브</a>.',
  spec: {
    sections: [
      { num: '7.17', title: 'Deblocking filter process',
        pseudo: '수직 경계 → 수평 경계 순. 경계마다 임계(q/side threshold)로 필터 강도 선택 → 비대칭 폭 필터 적용. lossless 경계는 스킵.' },
    ],
  },
  chapters: [
    { id: 'd1', n: 1, title: 'Generic asymmetric filter', stage: 'skeleton',
      fn: { name: 'avm_highbd_lpf_horizontal/vertical_generic', file: 'avm_dsp/loopfilter.c', line: 181,
        role: 'One parameterized filter with runtime tap widths (filt_width_neg/pos), replacing AV1 fixed filter4/6/8/14.' },
      spec: { num: '7.17', title: 'Deblocking filter process' },
      qna: [
        { tag: 'common', ref: 'loopfilter.c:181',
          q: 'deblock의 기본 동작은? (AV1 공통)',
          a: '블록 경계의 양쪽 픽셀을 저역통과 필터로 평활해 블로킹 아티팩트 제거. **수직 경계 → 수평 경계** 2-pass, 한 호출당 `count=4`줄 처리. 경계 평활이라는 개념·임계 기반 강도 선택은 AV1 계승.' },
        { tag: 'delta', ref: 'loopfilter.c:181',
          q: 'AV2 deblock이 AV1과 구조적으로 다른 점은? (AV2 델타)',
          a: 'AV1은 탭 수별 **고정 함수**(`aom_highbd_lpf_horizontal_4/6/8/14`)였는데, AV2는 **`*_generic` 단일 함수 + 런타임 폭**(`filt_width_neg`/`filt_width_pos`). 즉 경계마다 **비대칭 가변폭**(경계 음/양쪽 탭 수가 다를 수 있음)을 한 커널로 처리.' },
        { tag: 'verified', ref: 'loopfilter.c:191',
          q: '비대칭 폭은 코드에서 어떻게 나타나나? (실측)',
          a: '`filt_neg=(filt_width_neg>>1)−1`, 적용은 `filt_generic_asym_highbd(q_thresh, MIN(filter,filt_neg), filter, …)` — 음/양 폭을 따로 받아 **경계 양쪽 탭 수를 독립**으로 둠. `is_lossless_neg/pos`로 lossless 쪽은 스킵.' },
        { tag: 'hw', ref: 'loopfilter.c:181',
          q: '가변폭이 HW에 주는 영향은?',
          a: '런타임 폭 → 파이프라인은 **최대 폭 기준 사이징** + 데이터 의존 제어(어느 탭까지 쓸지). 고정폭 SIMD보다 mux/시프트 로직이 늘지만 단일 datapath로 통합돼 면적은 절감. 경계 line/col buffer는 최대 폭만큼 확보.' },
      ] },
    { id: 'd2', n: 2, title: 'Filter strength choice', stage: 'skeleton',
      fn: { name: 'filt_choice_highbd', file: 'avm_dsp/loopfilter.c', line: 59,
        role: 'Pick the effective filter width per edge from q_threshold / side_threshold (gradient masks).' },
      spec: { num: '7.17', title: 'Deblocking filter process' },
      qna: [
        { tag: 'common', ref: 'loopfilter.c:59',
          q: '필터 강도는 어떻게 정해지나? (AV1 공통)',
          a: '`filt_choice_highbd`이 경계 픽셀들의 기울기를 `q_thresh`(평탄도)·`side_thresh`(경계 강도) 임계와 비교해 **실효 필터 폭**을 결정. 평탄+약한 경계 → 넓은 필터, 진짜 에지 → 좁게/스킵. AV1의 임계 마스크 개념 계승.' },
        { tag: 'delta', ref: 'loopfilter.c:192',
          q: 'AV2에서 강도 선택의 차이는? (AV2 델타)',
          a: 'AV1은 임계가 4/8/14 중 어느 **고정 함수**를 부를지 결정했지만, AV2는 같은 임계가 **연속적인 가변폭 파라미터**(`filter` 값)를 만들어 generic 커널에 전달. 분기 대신 폭 파라미터화.' },
        { tag: 'hw', ref: 'loopfilter.c:59',
          q: '강도 선택의 HW 비용은?',
          a: '경계당 기울기 계산(차분 + abs) + 임계 비교 = 소형 조합회로. 결과가 **datapath 폭/스킵을 게이트** → 필터 MAC 앞단의 제어. 4줄 단위라 SIMD 친화. deblock은 LPF 패스 중 가장 가벼운 축.' },
      ] },
  ],
};
