/* tools/cdef.js — In-loop filter 2/5: CDEF (Constrained Directional Enhancement Filter).
   실측: ~/work/avm (AV2) · ~/work/aom (AV1, cdef.c 존재 → 공통 기반). */
window.TOOL = {
  id: 'cdef',
  title: 'CDEF — directional (LPF 2/5)',
  stage: 'LPF',
  coupling: ['lpf', 'PRD'],
  role: '방향성 에지 보존 디링잉 필터. **AV1에 이미 존재**(aom cdef.c) — AV2는 구조 거의 동일, 시그널/통합만 손봄. 64×64 FB 단위 8방향 탐색 + primary/secondary 2-pass. ' +
    '▶ 전체 체인은 <a href="app.html?tool=lpf">LPF 허브</a>.',
  spec: {
    sections: [
      { num: '7.18', title: 'CDEF process',
        pseudo: '64×64 filter block마다: 8방향 분산 탐색으로 지배 방향 찾기 → primary 탭(방향 따라) + secondary 탭(45°)으로 2-pass 필터. strength는 시그널.' },
    ],
  },
  chapters: [
    { id: 'cd1', n: 1, title: 'CDEF frame & 64×64 FB', stage: 'skeleton',
      fn: { name: 'av2_cdef_frame / av2_cdef_fb_row', file: 'av2/common/cdef.c', line: 479,
        role: 'Iterate 64×64 filter-block rows; per-FB direction search + 2-pass filter.' },
      spec: { num: '7.18', title: 'CDEF process' },
      qna: [
        { tag: 'common', ref: 'cdef.c:479',
          q: 'CDEF의 처리 단위와 골격은? (AV1 공통)',
          a: '`av2_cdef_frame`이 **64×64 filter block(FB)** 행(`nvfb`)마다 `av2_cdef_fb_row` 호출. 각 FB: 8방향 탐색 → primary/secondary 2-pass 필터. **AV1에 이미 있던 도구**(aom `cdef.c` 존재) — 구조 거의 그대로.' },
        { tag: 'delta', ref: 'cdef.c:479',
          q: 'AV2에서 CDEF가 바뀐 점은? (AV2 델타, 작음)',
          a: '코어 8방향 구조는 **AV1과 동일**. AV2는 시그널/통합 측면만 — skip-txfm 정보 활용, 체인 위치(deblock→**CDEF**→CCSO→LR→GDF)에서 CCSO가 뒤따름. delta는 LPF 5종 중 가장 작음.' },
        { tag: 'hw', ref: 'cdef.c:485',
          q: 'CDEF의 HW 비용은?',
          a: 'FB(64×64)마다 **halo(주변 2px) line/col buffer** 필요(방향 탐색·필터가 경계 픽셀 참조). 방향 탐색 = 8방향 분산 비교, 필터 = 소수 탭 가중합. AV1 CDEF 블록을 **거의 재사용** 가능 — AV2 신규 부담 적음.' },
      ] },
    { id: 'cd2', n: 2, title: 'Direction search + 2-pass filter', stage: 'skeleton',
      fn: { name: 'av2_cdef_filter_fb (dir + pri/sec)', file: 'av2/common/cdef.c', line: 142,
        role: '8-direction variance search picks the dominant edge; primary taps follow it, secondary taps at ±45°.' },
      spec: { num: '7.18', title: 'CDEF process' },
      qna: [
        { tag: 'common', ref: 'cdef.c:142',
          q: 'CDEF의 방향 탐색·2-pass란? (AV1 공통)',
          a: '8방향 각각의 분산을 계산해 **지배 에지 방향** 선택 → **primary 필터**(그 방향 따라 탭)로 에지 보존 평활 + **secondary 필터**(±45°)로 추가 디링잉. `pri_strength`/`sec_strength`는 시그널/유도. AV1과 동일 알고리즘.' },
        { tag: 'hw', ref: 'cdef.c:305',
          q: '방향 탐색+2-pass의 datapath는?',
          a: '방향 탐색 = 8방향 누적 분산(곱-합) → argmin/argmax 비교. 필터 = 방향별 탭 오프셋 LUT + constrained(클립) 가중합. **전용 CDEF 모듈**(다른 LPF 패스와 동시가동 → 공유 불가). strength 0이면 스킵.' },
      ] },
  ],
};
