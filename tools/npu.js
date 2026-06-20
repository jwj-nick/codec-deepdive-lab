/* tools/npu.js — Decoder-NPU synthesis (cross-stage integer-MAC blocks)
   실측: ~/work/avm. 각 블록의 file:line·MAC수·ROM·activation은 해당 ⭐챕터에서 검증됨.
   이 페이지 = Nick의 NPU 학습 spine. 흩어진 정수 MAC/solver 블록을 한 장에 모아
   "공유 MAC 어레이(decoder-NPU) vs 스테이지별 전용" 아키텍처 질문으로 수렴. 전부 공개. */
window.TOOL = {
  id: 'npu',
  title: 'Decoder-NPU — the integer-MAC blocks hiding in the AV2 decoder',
  intro: 'The AV2 **decoder** (not encoder) normative path quietly grew a handful of **learned, bit-exact integer ' +
    'MAC / linear-solver blocks**. They live in different pipeline stages but share **one datapath shape**. ' +
    'For an NPU-minded HW architect, that shared shape is the whole story.',
  thesis: '**Thesis:** weight ROM → integer MAC array → bias/normalize → LUT/clip activation. ' +
    'DIP, GDF, MHCCP, IST, DDT, optical-flow, PC-Wiener all instantiate it. ' +
    'So the design question is not "build N filters" but **"do they fold into one shared MAC array (a decoder-NPU), or stay per-stage dedicated?"**',

  // The one shape every block below instantiates (vertical, colored)
  diagram:
    'graph TD\n' +
    '  IN["inputs<br/>pixels / coeffs / gradients"] --> CLP["clip / quantize<br/>(alpha, feature)"]\n' +
    '  ROM["weight ROM<br/>(learned, integer)"] --> MAC["integer MAC array<br/>Σ w·x"]\n' +
    '  CLP --> MAC\n' +
    '  MAC --> ACC["+ bias → normalize<br/>(shift)"]\n' +
    '  ACC --> ACT["activation<br/>LUT  or  clip"]\n' +
    '  LUT["activation LUT<br/>(int8, optional)"] --> ACT\n' +
    '  ACT --> OUT["output<br/>pred / residual / filtered / MV"]\n' +
    '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
    '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
    '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
    '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
    '  class IN mem;\n  class OUT mem;\n  class ROM rom;\n  class LUT rom;\n' +
    '  class CLP op;\n  class ACC op;\n  class ACT op;\n  class MAC hot;',

  // Inventory — each maps onto the signature above
  blocks: [
    { key: 'DIP', stage: 'PRD · intra', tool: 'intra', ch: 'n3',
      mac: '**704** int MAC / 8×8', weights: 'uint16[6][64][11]', act: '>>12, −sum, clip',
      pipe: 'recon-feedback serial loop' },
    { key: 'GDF', stage: 'LPF', tool: 'lpf', ch: 'l6',
      mac: '**66** int MAC / px (22×3)', weights: 'int16 [QP6][refdst5][4·22·3]', act: '3D int8 error-LUT',
      pipe: 'separate full-frame pass after LR' },
    { key: 'MHCCP', stage: 'PRD · intra', tool: 'intra', ch: 'n6',
      mac: '3×3 normal-eqn + Gauss elim', weights: '— (per-block solved)', act: 'per-px 3-tap MAC + V²',
      pipe: 'chroma after luma recon' },
    { key: 'IST', stage: 'IQT', tool: 'iqt', ch: 'i5',
      mac: 'dense matmul 16 / 64', weights: 'int kernel LUT', act: '—',
      pipe: 'before primary 2D transform' },
    { key: 'DDT', stage: 'IQT', tool: 'iqt', ch: 'i8',
      mac: 'dense matmul N×N (4/8/16)', weights: 'int kernel ROM', act: '—',
      pipe: 'replaces ADST (inter blocks)' },
    { key: 'Optical-flow LS', stage: 'PRD · inter', tool: 'inter', ch: 'r7',
      mac: '5-sum covariance + solve', weights: '—', act: 'divide (calc_mv)',
      pipe: 'after MC, before 2nd MC pass' },
    { key: 'PC-Wiener', stage: 'LPF', tool: 'lpf', ch: 'l8',
      mac: '64 × 13-tap filter bank', weights: 'int16 64×13', act: '4096 class LUT',
      pipe: 'Loop Restoration pass' },
    { key: 'CfL-implicit', stage: 'PRD · intra', tool: 'intra', ch: 'n5',
      mac: 'least-squares + 1 divide', weights: '—', act: '—',
      pipe: 'chroma after luma recon' },
    { key: 'CCTX', stage: 'IQT', tool: 'iqt', ch: 'i3',
      mac: '2×2 rotate, 4 mul/coeff', weights: 'cctx_mtx[7][2]', act: '—',
      pipe: 'after dequant, U/V join' },
  ],
  invNote: 'All **integer, bit-exact** — not float NN inference, but structurally a weight-ROM + MAC + activation datapath. ' +
    'ENT is deliberately absent: it is the serial-bottleneck engine, not a MAC block. Click a block to open its chapter.',

  questions: [
    'Utilization: DIP fires only on intra 8×8, GDF on every luma pixel, optical-flow only on refined inter blocks. A **shared array** must time-multiplex very different duty cycles — does one array stay busy, or does it starve/stall per frame type?',
    'Precision: DIP weights uint16, GDF int16, CCTX 8-bit rotate, MHCCP fixed-point solve. One array width (worst-case) vs reconfigurable lanes — area vs flexibility?',
    'Activation: GDF/PC-Wiener use **LUTs** (int8 error-table, 4096 class table); DIP uses shift+clip. Is a shared LUT-activation block worth it, or keep activations per-block?',
    'Dataflow distance: these blocks sit in 4 different stages (IQT, intra-PRD, inter-PRD, LPF) with line buffers between them. Routing operands to one central array = wiring/bandwidth cost. Does locality kill the shared-array idea?',
    'The solvers (MHCCP, optical-flow, CfL) need **divide / Gaussian elimination** — not plain MAC. Do they share the MAC array at all, or do they need a separate small linear-solver unit?',
    'If you DID build one shared decoder-NPU array: what is its size (MACs), and which block sets the worst-case throughput requirement (GDF per-pixel luma is the obvious suspect)?',
  ],
};
