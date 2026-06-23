/* tools/gdf.js — In-loop filter 5/5: GDF (Guided Detail Filter). AV2 신규.
   실측: ~/work/avm. 학습 weight/bias/alpha/error 테이블 → 픽셀당 66 정수 MAC + error-LUT activation. bit-exact. */
window.TOOL = {
  id: 'gdf',
  title: 'GDF — learned integer-MAC filter (LPF 5/5)',
  stage: 'LPF',
  coupling: ['lpf', 'PRD'],
  role: '⭐⭐ AV2 신규 — 학습 weight/bias/alpha ROM을 쓰는 **정수 퍼셉트론형 luma 필터**. 픽셀당 22입력×3누산 = **66 정수 MAC** + 3D error-LUT(activation). ' +
    '부동소수 없음·bit-exact. 디코더에서 가장 NN을 닮은 datapath(설계기법 NPU 전이점). ▶ 전체 체인은 <a href="app.html?tool=lpf">LPF 허브</a>.',
  spec: {
    sections: [
      { num: '7.20.5', title: 'Apply GDF filter process',
        pseudo: 'LR 뒤 별도 full-frame 패스(RESTORE_GDF 타입 없음). 학습 테이블 선택(intra/inter×QP6×refdst5×class4) → 22입력 클립 → MAC → bias → 정규화 → error-LUT → 복원에 가산.' },
    ],
  },
  chapters: [
    { id: 'g1', n: 1, title: 'Table selection', stage: 'skeleton',
      fn: { name: 'gdf_get_qp_idx_base / ref_dst_idx', file: 'av2/common/gdf.c', line: 505,
        role: 'Select weight/bias/alpha/error tables by intra/inter × QP bucket (6) × ref-distance bucket (5) × pixel class (4).' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      qna: [
        { tag: 'delta', ref: 'gdf.c:505',
          q: 'GDF란 무엇이고 AV1엔 있나? (AV2 신규)',
          a: '**Guided Detail Filter** — 학습된 정수 가중치로 복원 luma의 디테일을 보정하는 **퍼셉트론형 필터**. **AV1엔 전무**(aom `gdf`=0건). LR과 별개로 **LR 뒤 별도 full-frame 패스**(`RESTORE_GDF` 타입 없음 — spec은 LR 하위로 묶지만 코드는 분리).' },
        { tag: 'verified', ref: 'gdf_block.c:610',
          q: '학습 테이블은 어떻게 선택되나? (실측)',
          a: 'is_intra면 `gdf_intra_{alpha,weight,bias,error}_table[qp_idx]`, inter면 `gdf_inter_*_table[ref_dst_idx-1][qp_idx]`. 즉 **intra/inter × QP(6버킷) × ref거리(5버킷)**로 ROM 뱅크 선택. + 픽셀 class(4)까지 = 작은 클래스화 퍼셉트론.' },
        { tag: 'hw', ref: 'gdf.c:505',
          q: '테이블 선택의 HW 의미는?',
          a: 'QP·ref거리·intra/inter가 **ROM 뱅크 주소** → 프레임/블록 단위로 weight/bias/alpha/error 뱅크 스위치. 픽셀 class(2×2 단위 사전계산)가 같은 뱅크 내 인덱스. 뱅크 스위치는 프레임당 드물어 부담 작음.' },
      ] },
    { id: 'g2', n: 2, title: '⭐⭐ Inference (66 MAC/px)', stage: 'skeleton',
      fn: { name: 'gdf_inference_unit', file: 'av2/common/gdf_block.c', line: 585,
        role: '22 inputs (18 sample-diffs + 4 gradients) → alpha-clip → 22×3 integer MACs → +bias → normalize → 3D error-LUT.' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      io: {
        diagCaption: 'gather → clip → 66 MAC → LUT activation',
        diagram: 'graph TD\n' +
          '  REC["recon luma<br/>+ line buffer (fwd/bwd nbr)"] --> GTH["gather 22 inputs<br/>18 diff + 4 grad"]\n' +
          '  ALP["alpha ROM<br/>int16"] --> CLP["per-input clip"]\n' +
          '  GTH --> CLP\n' +
          '  WT["weight ROM<br/>int16 [QP6][refdst5][4·22·3]"] --> MAC["MAC array<br/>22×3 = 66 int MAC/px"]\n' +
          '  CLP --> MAC\n' +
          '  BIA["bias ROM int32"] --> NRM["+bias → GDF_NORM_IDX"]\n' +
          '  MAC --> NRM\n' +
          '  ELU["error-LUT int8<br/>3D (intra 16³ / inter 10³)"] --> ACT["LUT activation"]\n' +
          '  NRM --> ACT\n' +
          '  ACT --> OUT["err residual<br/>→ compensation (g3)"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class REC mem;\n  class OUT mem;\n  class ALP rom;\n  class WT rom;\n  class BIA rom;\n  class ELU rom;\n' +
          '  class GTH op;\n  class CLP op;\n  class NRM op;\n  class ACT op;\n  class MAC hot;',
        in: [
          { sig: 'rec nbr (fwd/bwd)', type: 'uint16', peer: 'recon luma + line buffer', vol: '22 inputs/px', note: '18 sample-diff + 4 gradient' },
          { sig: 'weight', type: 'int16 [QP6][refdst5][4·22·3]', peer: 'weight ROM', vol: 'per (intra/inter,QP,refdst,class)', note: 'learned MAC weights' },
          { sig: 'alpha / bias', type: 'int16 / int32', peer: 'ROM', vol: 'per class/input', note: 'clip bounds + accum bias' },
          { sig: 'error_table', type: 'int8 3D (intra 16³ / inter 10³)', peer: 'ROM', vol: 'activation LUT', note: 'replaces arithmetic activation' },
        ],
        out: [
          { sig: 'err residual', type: 'int16', peer: '→ compensation (g3) → rec add', vol: '1 / luma px', note: '66 int MAC/px — the decoder NN-like datapath' },
        ],
        note: 'The flagship "NN-like" decoder datapath: **weight ROM → integer MAC array → LUT activation**, bit-exact, every luma pixel. Same *shape* as DIP/MHCCP/IST — but a **dedicated LPF module** (streaming concurrency forbids sharing one array across stages). NPU link = MAC-array design-skill transfer per module.',
      },
      qna: [
        { tag: 'verified', ref: 'gdf_block.c:585',
          q: 'GDF inference의 입력과 MAC 수는? (실측)',
          a: '픽셀당 **22 입력**(18 복원샘플차 + 4 gradient)을 모아 per-input **alpha 클립**(학습 경계) → `gdf_idx[j][idx] += gdf_inp · weight[...]`를 **3 누산기(idx<3)**에 → **22×3 = 66 정수 MAC/픽셀**. fwd/bwd 대칭 이웃차 사용.' },
        { tag: 'verified', ref: 'gdf_block.c:660',
          q: 'MAC 뒤 activation은? (실측)',
          a: '3 누산기에 **+bias** → `GDF_NORM_IDX`로 정규화 → 그 인덱스로 **3D error-LUT(int8)** 조회 → `err_pnt[j] = *tb_ptr`(예측 잔차). 즉 산술 activation 대신 **LUT 조회**(intra 16³ / inter 10³ 엔트리)가 비선형성을 담당.' },
        { tag: 'delta', ref: 'gdf_block.c:585',
          q: '이게 왜 "디코더 속 NN"인가? (AV2 신규)',
          a: '학습 **weight/bias/alpha ROM** + **정수 MAC 어레이** + **LUT activation** = NN 추론의 정수 bit-exact 버전. 부동소수 CNN은 아니지만 **datapath 형태가 동형**. AV2가 규범 디코드 경로에 학습 가중치 행렬을 넣은 첫 in-loop 사례.' },
        { tag: 'hw', ref: 'gdf_block.c:585',
          q: 'GDF inference의 HW 사이징은?',
          a: '**전용 LPF MAC 모듈**: 66 MAC/px를 luma **전 픽셀**에 → GDF가 LPF worst-case throughput을 정의. systolic vs time-mux MAC 어레이 사이징이 핵심. ⚠️ IQT/intra MAC와 **동시가동**이므로 스테이지 간 공유 불가 — 전용. NPU 연결은 *모듈별 MAC-array 설계기법 전이*.' },
      ] },
    { id: 'g3', n: 3, title: 'Compensation', stage: 'skeleton',
      fn: { name: 'gdf_compensation_unit', file: 'av2/common/gdf_block.c', line: 553,
        role: 'Scale the error-LUT residual and add to the reconstructed sample with clip.' },
      spec: { num: '7.20.5', title: 'Apply GDF filter process' },
      qna: [
        { tag: 'verified', ref: 'gdf_block.c:553',
          q: 'compensation 단계는? (실측)',
          a: 'inference가 낸 **error 잔차를 스케일**해 복원 샘플에 **clip 가산**(`rec + scaled_err`). 즉 GDF는 직접 픽셀을 만드는 게 아니라 **보정 잔차(residual)를 예측**해 더하는 구조 — residual learning.' },
        { tag: 'hw', ref: 'gdf_block.c:553',
          q: 'compensation의 HW 특성은?',
          a: '픽셀당 1 곱(scale) + clip 가산 = 소형 back-end. inference(66 MAC) → compensation(scale-add) 2-스테이지 파이프. stripe 기반 reference-line setup(line buffer)이 앞단. 가벼운 종착단.' },
      ] },
  ],
};
