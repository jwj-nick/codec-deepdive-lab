/* tools/npu.js — Integer-MAC modules (dedicated MAC datapaths in the decoder)
   실측: ~/work/avm. 각 블록 file:line·MAC수·ROM·activation은 해당 ⭐챕터에서 검증.
   ⚠️ 프레이밍(2026-06-20 정정, Nick): 디코더 = fixed-function streaming 파이프라인.
   스테이지가 동시 가동 → 스테이지 간 HW 시분할 불가 → **모드별 전용 module이 기본 디자인.**
   "공유 MAC 어레이/NPU 통합"은 코덱 IP 설계가 아님. NPU 연결 = 각 전용 모듈이 작은 MAC datapath라
   설계 기법이 전이된다는 것. 전부 공개 (RTL만 private). */
window.TOOL = {
  id: 'npu',
  title: 'Integer-MAC modules — dedicated MAC datapaths in the decoder',
  intro: 'The AV2 decoder is a **fixed-function streaming pipeline**: ENT, IQT, PRD and LPF run **concurrently** ' +
    'on different superblocks/pixels. So hardware **cannot be time-shared across stages** — each mode/tool is a ' +
    '**dedicated module**. That is the baseline, not a choice. What makes these worth cataloguing: several of those ' +
    'dedicated modules are **integer MAC / linear-solver datapaths** — exactly where MAC-array / NPU design skill ' +
    'maps onto codec IP. The design *techniques* transfer; the hardware does **not** merge.',
  thesis: '**Design principle:** per-mode **dedicated module** is mandatory (the pipeline is concurrent — a shared, ' +
    'programmable NPU/GPU-style fabric would have to be in many places at once). The payoff of the inventory below is ' +
    'that each row is a **small fixed-function MAC engine to design well** — weight ROM → MAC array → bias/normalize → ' +
    'activation. The open work is the **micro-architecture of each dedicated module**, not merging them.',

  // The shape each dedicated module instantiates (vertical, colored)
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

  // Inventory — each is its OWN dedicated module; they share a shape, not silicon
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
  invNote: 'All **integer, bit-exact** — not float NN inference. Each is a **dedicated module** sized for its own ' +
    'worst-case throughput. They are active concurrently (different stages, different data) → **no cross-stage sharing**. ' +
    'The shared *shape* is why the design know-how carries across. Click a block to open its chapter.',

  questions: [
    'Why dedicated, restated as the constraint: ENT, IQT, PRD, LPF are all busy on different SBs in the same cycle. Convince yourself a single compute block **cannot** serve two stages — what would it have to be in two places at once?',
    'GDF runs on **every luma pixel** (66 MAC/px). For real-time decode at your target resolution/fps, size GDF\'s **own** MAC array: required MAC/clk → systolic array vs time-multiplexed MACs inside the GDF module?',
    'DIP: 704 MAC per 8×8 from uint16[6][64][11]. Weight-ROM read bandwidth and operand reuse inside the **dedicated DIP module** — how do you keep the array fed?',
    'Within ONE stage, sequential ops *may* share: IST and DDT are both matmuls in the IQT transform path of the same block. Can one matmul engine inside the IQT module serve both, or does the 1D-transform schedule force two? (intra-module reuse — the legitimate version of "sharing.")',
    'The solvers (MHCCP, optical-flow, CfL) need **divide / Gaussian elimination**, not plain MAC. Each is a tiny dedicated linear-solver — fixed pipe via reciprocal approximation, or a multi-cycle FSM?',
    'Per-module micro-architecture is the real choice: for each block, which fits — systolic, SIMD lanes, or a time-multiplexed MAC — given its duty cycle (GDF every pixel vs DIP intra-8×8-only) and latency budget in the pipe?',
  ],
};
