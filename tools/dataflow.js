/* tools/dataflow.js — Superblock Dataflow (top-level HW view)
   "한 superblock 이 파이프라인을 어떻게 흐르나" — 큰 함수들의 I/O 포맷.
   실측 출처: ~/work/avm. 볼륨은 포맷 레벨 추정(256×256 inter worst-case 기준).
   경계: I/O 포맷·per-SB volume = 공개. 실제 RTL/Verilog 코드만 private.
   참조 SB = 256×256 (inter worst-case). intra 최대 128, chroma 4:2:0 서브샘플은 표기로 병기. */
window.TOOL = {
  id: 'dataflow',
  title: 'Superblock Dataflow',
  intro: 'One **256×256 superblock** through the decoder. Two regimes: a **block-serial reconstruction loop** ' +
    '(`ENT → MIP → IQT → PRD → REC`, finishes inside the SB) and **frame/stripe filter passes** ' +
    '(`deblock → CDEF → CCSO → LR → GDF`, need neighbor SBs → separate phase). ' +
    'This split is the **first fork of HW scheduling**. Volumes are format-level (luma; chroma 4:2:0 ⇒ ¼).',

  loops: [
    // ── (A) per-SB reconstruction loop ─────────────────────────
    {
      id: 'recon',
      title: 'A · Per-SB reconstruction loop (block-serial)',
      caption: 'Stays inside one SB. **ENT is the serial bottleneck** (red); the rest is a regular datapath. ' +
        'ENT parses symbols feeding both the mode path (MIP) and the coeff path (IQT); PRD + residual = REC.',
      diagCaption: 'one superblock — parse → reconstruct (vertical)',
      diagram:
        'graph TD\n' +
        '  BS["bitstream bytes<br/>(tile, DRAM)"] --> ENT["ENT · symbol decode<br/>av2_read_coeffs_txb"]\n' +
        '  CDF["CDF ctx<br/>tctx SRAM (per tile)"] --> ENT\n' +
        '  ENT -->|"mode / MV / partition symbols"| MIP["MIP · partition + mode<br/>decode_partition"]\n' +
        '  ENT -->|"dqcoeff int32 + eob"| IQT["IQT · dequant + inv-tx<br/>av2_inv_txfm2d_add"]\n' +
        '  MIP -->|"MB_MODE_INFO (mode/MV/ref/tx)"| PRD["PRD · intra / inter<br/>build_predictors"]\n' +
        '  REF["ref pixels<br/>DRAM (inter) · recon nbr (intra)"] --> PRD\n' +
        '  IQT -->|"residual int16"| REC["REC · add + clip"]\n' +
        '  PRD -->|"prediction int16"| REC\n' +
        '  REC -->|"reconstructed SB"| FB["frame buffer<br/>(pre-filter)"]\n' +
        '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
        '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
        '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
        '  class BS mem;\n  class CDF mem;\n  class REF mem;\n  class FB mem;\n' +
        '  class ENT hot;\n  class MIP op;\n  class IQT op;\n  class PRD op;\n  class REC op;',
      stages: [
        {
          hw: 'ENT', tool: 'ent', fn: 'av2_read_coeffs_txb',
          role: 'Arithmetic-decode all symbols of the SB — the only serial bottleneck. Parses mode/MV + quantized coeffs.',
          in: [
            { sig: 'bitstream', type: 'uint8[] byte-serial', peer: 'tile buffer / DRAM', vol: 'variable (entropy)', note: 'window refill, ≈1 sym/clk' },
            { sig: 'cdf_ctx', type: 'uint16[…] (Q15)', peer: 'tctx SRAM (per tile)', vol: '~thousands of CDFs', note: 'RMW every symbol' },
            { sig: 'above/left_ctx', type: 'nbr context', peer: 'line buffer', vol: 'f(SB width)', note: 'coeff/mode context' },
          ],
          out: [
            { sig: 'mode/mv/part', type: 'enum / int', peer: '→ MIP', vol: 'per coding block', note: 'parsed symbols' },
            { sig: 'dqcoeff + eob', type: 'int32[≤4096]/TX', peer: '→ IQT coeff buffer', vol: '≤65536/luma SB', note: 'TCQ dequant inline; sparse (eob)' },
          ],
        },
        {
          hw: 'MIP', tool: 'mip', fn: 'decode_partition / mode_info',
          role: 'Recursive partition tree (SDP dual tree) + mode/MV reconstruction. Neighbor-dependent.',
          in: [
            { sig: 'part/mode sym', type: 'enum', peer: '← ENT', vol: 'per node', note: 'NONE/HORZ/VERT/H3/V3/H4/V4/SPLIT' },
            { sig: 'nbr_mode_ctx', type: 'MB_MODE_INFO*', peer: 'line buffer (above row)', vol: 'f(frame width)', note: 'SDP: luma & chroma separate trees' },
          ],
          out: [
            { sig: 'geometry', type: 'BLOCK_SIZE tree', peer: '→ IQT / PRD', vol: 'partition tree / SB', note: '' },
            { sig: 'mode_info', type: 'struct (mode/MV/ref/tx)', peer: '→ PRD + mode grid', vol: '1 per ≥4×4 block', note: 'written to mode-info grid' },
          ],
        },
        {
          hw: 'IQT', tool: 'iqt', fn: 'av2_inv_txfm2d_add',
          role: 'Inverse quantize + inverse transform (idct.c dispatch). Regular, parallelizable datapath.',
          in: [
            { sig: 'dqcoeff', type: 'int32[≤4096]/TX', peer: '← ENT coeff buffer', vol: '≤16 nonzero typical', note: 'sparse, eob-bounded' },
            { sig: 'tx_type/size', type: 'TX_TYPE/TX_SIZE enum', peer: '← ENT', vol: '1/TX', note: 'IST packed in upper bits; CCTX for chroma' },
          ],
          out: [
            { sig: 'residual', type: 'int16[TX]', peer: '→ REC', vol: 'up to TX area (≤64×64)', note: 'spatial domain' },
          ],
        },
        {
          hw: 'PRD', tool: 'inter', fn: 'build_inter / intra_predictors',
          role: 'Prediction. Inter = motion comp (DRAM bandwidth dominant); intra = recon-neighbor feedback.',
          in: [
            { sig: 'mode/mv', type: 'MB_MODE_INFO', peer: '← MIP', vol: 'per block', note: '7-level MV precision' },
            { sig: 'ref_pixels', type: 'uint16 (hbd)', peer: 'DRAM (inter) · recon nbr (intra)', vol: '(bw+11)×(bh+11)/ref', note: '12-tap interp; ×2 compound → DRAM BW' },
            { sig: 'interp_taps', type: 'int8 taps', peer: 'coeff ROM', vol: '12 taps × subpel phase', note: '' },
          ],
          out: [
            { sig: 'prediction', type: 'int16[block]', peer: '→ REC', vol: 'block area', note: '' },
          ],
        },
        {
          hw: 'REC', tool: 'intra', fn: 'av2_reconstruct (add + clip)',
          role: 'Reconstructed = prediction + residual, clipped to bitdepth. Closes the intra feedback.',
          in: [
            { sig: 'prediction', type: 'int16', peer: '← PRD', vol: 'block area', note: '' },
            { sig: 'residual', type: 'int16', peer: '← IQT', vol: 'block area', note: '' },
          ],
          out: [
            { sig: 'recon_sb', type: 'uint16 (hbd)', peer: '→ frame buffer', vol: '256×256 luma + chroma', note: 'clip to bitdepth; feeds intra nbr + filters' },
          ],
        },
      ],
    },

    // ── (B) frame / stripe filter passes ───────────────────────
    {
      id: 'filter',
      title: 'B · Frame / stripe filter passes (neighbor-coupled)',
      caption: 'Each pass needs neighbor SBs, so it runs **after** the recon loop fills a region. ' +
        'Five sequential passes; **GDF runs as a separate full-frame pass after LR** (NN-like integer datapath). ' +
        'Line/stripe buffers dominate here.',
      diagCaption: 'in-loop filters — five passes (vertical)',
      diagram:
        'graph TD\n' +
        '  FB["reconstructed frame<br/>(pre-filter)"] --> DB["deblock<br/>loop_filter"]\n' +
        '  DB -->|"deblocked"| CDEF["CDEF<br/>cdef_filter_fb"]\n' +
        '  CDEF -->|"cdef out"| CCSO["CCSO<br/>cross-component offset"]\n' +
        '  CCSO -->|"offset-corrected"| LR["LR<br/>PC-Wiener / nonsep"]\n' +
        '  LR -->|"restored"| GDF["GDF<br/>guided · NN-like pass"]\n' +
        '  GDF -->|"final"| DPB["DPB / output<br/>+ ref for next frame"]\n' +
        '  LUMA["co-located luma<br/>ext_rec_y"] --> CCSO\n' +
        '  CLS["filter / class params"] --> LR\n' +
        '  WT["weight · bias · 3D error LUT"] --> GDF\n' +
        '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
        '  classDef rom fill:#2a2410,stroke:#ffcf6b,color:#e6edf3;\n' +
        '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
        '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
        '  class FB mem;\n  class DPB mem;\n  class LUMA mem;\n' +
        '  class CLS rom;\n  class WT rom;\n' +
        '  class DB op;\n  class CDEF op;\n  class CCSO op;\n  class LR op;\n  class GDF hot;',
      stages: [
        {
          hw: 'LPF', tool: 'lpf', fn: 'loop_filter (deblock)',
          role: 'Edge-adaptive deblocking across block boundaries.',
          in: [
            { sig: 'recon', type: 'uint16', peer: 'frame buffer', vol: 'SB + 4px neighbor', note: '' },
            { sig: 'edge/level', type: 'loop_filter_info', peer: 'derived from mode', vol: 'per edge', note: '' },
          ],
          out: [{ sig: 'deblocked', type: 'uint16', peer: '→ CDEF', vol: 'SB', note: '' }],
        },
        {
          hw: 'LPF', tool: 'lpf', fn: 'cdef_filter_fb (CDEF)',
          role: 'Directional de-ringing per 64×64 unit.',
          in: [
            { sig: 'deblocked', type: 'uint16', peer: '← deblock', vol: '64×64 + 2px halo', note: '' },
            { sig: 'cdef_strength', type: '8-dir params', peer: 'frame header', vol: 'per 64×64', note: 'direction search' },
          ],
          out: [{ sig: 'cdef_out', type: 'uint16', peer: '→ CCSO', vol: '64×64', note: '' }],
        },
        {
          hw: 'LPF', tool: 'lpf', fn: 'ccso_filter (CCSO)',
          role: 'Cross-component sample offset — luma guides chroma correction.',
          in: [
            { sig: 'cdef_out', type: 'uint16', peer: '← CDEF', vol: 'block', note: '' },
            { sig: 'ext_rec_y', type: 'uint16 luma', peer: 'recon luma plane', vol: 'co-located, chroma-aligned', note: 'cross-component read' },
          ],
          out: [{ sig: 'offset_out', type: 'uint16', peer: '→ LR', vol: 'block', note: '' }],
        },
        {
          hw: 'LPF', tool: 'lpf', fn: 'PC-Wiener / nonsep (LR)',
          role: 'Loop restoration. PC-Wiener = classifier → one of 64 learned 13-tap filters.',
          in: [
            { sig: 'ccso_out', type: 'uint16', peer: '← CCSO', vol: 'restoration unit (64/128/256)', note: '' },
            { sig: 'filter/class', type: 'wiener coeffs / class', peer: 'frame header + classifier', vol: '64 learned 13-tap', note: 'classifier → filter bank' },
          ],
          out: [{ sig: 'restored', type: 'uint16', peer: '→ GDF', vol: 'restoration unit', note: '' }],
        },
        {
          hw: 'LPF', tool: 'lpf', fn: 'GDF (guided, NN-like)',
          role: '⭐ Separate full-frame pass after LR. 66 int MAC/px perceptron + 3D error LUT — an NPU-shaped integer datapath.',
          in: [
            { sig: 'restored', type: 'uint16', peer: '← LR', vol: 'full-frame pass', note: 'separate pass (no RESTORE_GDF enum)' },
            { sig: 'weights/bias/LUT', type: 'int weights + 3D LUT', peer: 'weight ROM', vol: '66 int MAC/px', note: 'NN-like integer MAC + LUT activation' },
          ],
          out: [{ sig: 'final', type: 'uint16', peer: '→ DPB / output', vol: 'full frame', note: 'also ref for next frame' }],
        },
      ],
    },
  ],
};
