/* tools/mip.js — Partition & Mode (MIP 스테이지)
   실측: ~/work/avm (AV2) · ~/work/aom (AV1). file:line 근거. */
window.TOOL = {
  id: 'mip',
  title: 'Partition & Mode (분할·모드)',
  stage: 'MIP',
  coupling: ['ENT', 'PRD'],
  role: 'SB를 블록으로 분할(트리)하고 모드/MV를 재구성. AV2는 **SDP**(luma/chroma 분리 트리)·비대칭 분할·256 SB로 이웃 의존과 라인버퍼가 커짐.',

  // ── L1 Spec ────────────────────────────────────────────────
  spec: {
    sections: [
      { num: '5.20.3', title: 'Partition structures',
        pseudo:
          '256×256 SB를 **재귀 분할**. AV2 분할타입 = `NONE/HORZ/VERT/HORZ_3/VERT_3/HORZ_4A/4B/VERT_4A/4B/SPLIT`.\n\n' +
          '- HORZ_3 = 4:1·2:1·4:1 비대칭 3분할\n' +
          '- HORZ_4A = 1:2:4:1, HORZ_4B = 1:4:2:1 비대칭 4분할\n' +
          '- 분할타입은 **계층 다중심볼**(do_split→square→rect→ext→4way)로 신호.' },
      { num: '5.4.3 / SB', title: 'Sequence partition config · Superblock size',
        pseudo: 'SB 크기 = {256, 128, 64} seq 신호. **256×256**(AV1 128의 4배 면적). intra 프레임은 128로 강제.' },
      { num: '5.20.4 / 5.20.5', title: 'Block decoding · Mode information',
        pseudo: 'leaf 블록에서 모드/예측정보 복호. AV2 신규 모드 필드 대량(DIP/CfL implicit/MV precision/DMVR/BAWP/CWP/JMVD).' },
    ],
    bitfields: [
      { name: '분할타입 계층 심볼 (산술부호, 좌→우 직렬·조건부)',
        bits: [
          { f: 'do_split', w: null, d: '분할 여부. 0이면 PARTITION_NONE' },
          { f: 'do_square_split', w: null, d: '1이면 SPLIT(4등분)' },
          { f: 'rect_type', w: null, d: 'HORZ vs VERT' },
          { f: 'do_ext_partition', w: null, d: '2분할 vs 3/4분할 구분', hl: true },
          { f: 'do_uneven_4way', w: null, d: 'HORZ_3 vs HORZ_4A/4B', hl: true },
          { f: '4way_type', w: null, d: '4A vs 4B (avm_read_bit)', hl: true },
        ] },
    ],
  },

  // ── L2 C-Model ─────────────────────────────────────────────
  code: {
    callgraph:
      'graph TD\n' +
      '  SB["decode_partition_sb<br/>decodeframe.c:2300"] --> P["decode_partition<br/>:1851 (재귀, +ptree_luma)"]\n' +
      '  P --> RP["read_partition<br/>:1728 (계층 5심볼)"]\n' +
      '  P -->|PARTITION_NONE| BV["block_visit[flag]<br/>:1895"]\n' +
      '  P -->|HORZ/VERT/…| P\n' +
      '  BV --> DB["decode_block<br/>:1668"]\n' +
      '  BV --> MI["av2_read_mode_info<br/>decodemv.c:3204"]',
    funcs: [
      { file: 'av2/common/enums.h', line: 506, name: 'PARTITION_TYPE', lang: 'c',
        excerpt:
          'enum {\n' +
          '  PARTITION_NONE, PARTITION_HORZ, PARTITION_VERT,\n' +
          '  PARTITION_HORZ_3,  // 3분할 4:1, 2:1, 4:1\n' +
          '  PARTITION_VERT_3,\n' +
          '  PARTITION_HORZ_4A, // 4분할 1:2:4:1\n' +
          '  PARTITION_HORZ_4B, // 4분할 1:4:2:1\n' +
          '  PARTITION_VERT_4A, PARTITION_VERT_4B,\n' +
          '  PARTITION_SPLIT,\n' +
          '  PARTITION_INVALID = 255\n' +
          '};',
        note: '⚠️ AV1의 T자형(`HORZ_A/B`)·등4분할(`HORZ_4`)은 **없음**. AV2는 비대칭 3/4A/4B로 대체.' },
      { file: 'av2/decoder/decodeframe.c', line: 1879, name: 'decode_partition (SDP)', lang: 'c',
        excerpt:
          '// 키프레임 SDP, BLOCK_64X64에서 luma 트리 먼저 → chroma\n' +
          'if (total_loop_num == 2 && xd->tree_type == SHARED_PART) {\n' +
          '  xd->tree_type = LUMA_PART;\n' +
          '  decode_partition(..., ptree, ptree_luma, flag);\n' +
          '  xd->tree_type = CHROMA_PART;\n' +
          '  decode_partition(..., ptree_luma, ptree, flag);  // 인자 swap\n' +
          '  xd->tree_type = SHARED_PART;\n' +
          '  return;\n' +
          '}',
        note: '⭐ **SDP** = luma 분할 트리를 먼저 settle → chroma가 그것을 참조(`ptree_luma`). 64×64에서 luma/chroma 분할 분리.' },
      { file: 'av2/decoder/decodeframe.c', line: 1728, name: 'read_partition', lang: 'c',
        note: '계층 분할 신호: `do_split_cdf`→`do_square_split_cdf`→`rect_type_cdf`→`do_ext_partition_cdf`→`do_uneven_4way_partition_cdf`→`avm_read_bit`. plane=(tree_type==CHROMA_PART)로 별도 CDF. 최종 `rect_part_table[...]` 매핑.' },
      { file: 'av2/decoder/decodemv.c', line: 3204, name: 'av2_read_mode_info', lang: 'c',
        note: 'intra(`read_intra_frame_mode_info`:1579) / inter(`read_inter_frame_mode_info`:3065) 분기. AV2: `av2_update_ref_mv_bank`(enable_refmvbank), warp param bank 갱신 추가.' },
    ],
    structs: [
      { name: 'PARTITION_TREE', file: 'av2/common/blockd.h', line: 700,
        fields: [
          { f: 'sub_tree[4] / parent', d: '재귀 트리' },
          { f: 'PARTITION_TYPE partition', d: '이 노드 분할' },
          { f: 'REGION_TYPE region_type', d: '확장 SDP(inter) 영역' },
          { f: 'CHROMA_REF_INFO chroma_ref_info', d: 'SDP chroma 참조' },
        ],
        note: 'SB당 `SB_INFO.ptree_root[2]`(blockd.h:739) — luma/chroma 두 트리 루트. `TREE_TYPE`=SHARED/LUMA/CHROMA(enums.h:455).' },
      { name: 'MB_MODE_INFO (AV2 신규 필드)', file: 'av2/common/blockd.h', line: 408,
        fields: [
          { f: 'sb_type[PARTITION_STRUCTURE_NUM]', d: 'tree별(luma/chroma) 블록 크기' },
          { f: 'pb_mv_precision / max_mv_precision', d: '적응 MV 정밀도' },
          { f: 'refinemv_flag', d: 'DMVR' },
          { f: 'use_intra_dip / cfl_implicit_alpha', d: 'DIP·암시 CfL' },
          { f: 'bawp_flag / cwp_idx / jmvd_scale_mode', d: '신규 인터 가중/JMVD' },
        ] },
      { name: '분할 컨텍스트 (라인버퍼)', file: 'av2/common/blockd.h', line: 2111,
        fields: [
          { f: 'above_partition_context[MAX_MB_PLANE]', d: '⭐ **plane별**(SDP) 위쪽 컨텍스트 = 프레임폭 라인버퍼' },
          { f: 'left_partition_context[MAX_MB_PLANE][MAX_MIB_SIZE]', d: 'SB높이 좌측 컨텍스트(256으로 확대)' },
        ],
        note: 'SDP가 luma/chroma 컨텍스트를 분리 → above-context 라인버퍼 ~3배(×MAX_MB_PLANE).' },
    ],
  },

  // ── L3 Spec ↔ Code + AV1→AV2 델타 ──────────────────────────
  bridge: [
    { specLine: '§5.20.3 분할 트리', cLine: 'decode_partition(…, ptree, ptree_luma) (decodeframe.c:1851)',
      kind: 'changed', delta: 'AV1 단일 트리(ptree 인자 없음) → AV2 **듀얼 트리**(SDP).' },
    { specLine: '§5.20.3 분할타입', cLine: 'PARTITION_TYPE enum (enums.h:506)',
      kind: 'changed', delta: 'AV1 T자형(HORZ_A/B)+등4분할 → AV2 **비대칭 3(HORZ_3)·4A/4B**. T자형 제거.' },
    { specLine: 'SB 크기', cLine: 'MAX_SB_SIZE_LOG2=8 → 256 (enums.h:140)',
      kind: 'changed', delta: 'AV1 128(LOG2=7) → AV2 **256**(intra는 128 강제).' },
    { specLine: '§5.20.3 분할 신호', cLine: 'read_partition 계층 5심볼 (decodeframe.c:1728)',
      kind: 'changed', delta: 'AV1 단일 컨텍스트 read → AV2 **do_split→square→rect→ext→4way** 직렬 다심볼.' },
    { specLine: '§5.20.5 모드', cLine: 'MB_MODE_INFO 신규 필드 (blockd.h:408)',
      kind: 'new', delta: 'DIP·암시CfL·MV정밀도·DMVR·BAWP/CWP/JMVD·refmvbank 등 대량 추가.' },
    { specLine: 'SB 하강 구조', cLine: 'block_visit[parse_decode_flag] (decodeframe.c:1895)',
      kind: 'same', delta: 'AV1과 동일 2-pass(parse/decode) 디스패치 패턴.' },
  ],

  // ── L4 HW Architecture (일반 사고법) ───────────────────────
  hw: {
    guardrail: true,
    datapath:
      'graph TD\n' +
      '  SB["256×256 SB"] --> REC["partition recursion<br/>(tree descent)"]\n' +
      '  CTX["above/left context<br/>(per-plane line buffer)"] --> REC\n' +
      '  REC -->|"keyframe 64×64"| SDP["SDP: luma tree<br/>settles first"]\n' +
      '  SDP --> CH["chroma tree<br/>(references luma)"]\n' +
      '  REC --> LEAF["leaf block<br/>mode / MV decode"]\n' +
      '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
      '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
      '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
      '  class SB mem;\n  class CTX mem;\n' +
      '  class REC op;\n  class LEAF op;\n  class SDP hot;\n  class CH hot;',
    throughput:
      '분할타입이 **노드당 최대 5개 직렬 산술심볼**(AV1 단일 read 대비) + 각 심볼이 이웃 컨텍스트 유도 필요 → ' +
      '파티션 노드당 CDF-read 지연 증가. ENT와 강결합(분할/모드도 산술복호). 256 SB로 재귀 깊이 +1단.',
    memory:
      '⭐ **분할 컨텍스트 라인버퍼가 plane별**(`above_partition_context[MAX_MB_PLANE]`) → SDP가 luma/chroma 컨텍스트 분리 = ' +
      'above-context 저장 **~3배** vs 단일 공유. 256 SB는 좌측 컨텍스트(`MAX_MIB_SIZE`)를 넓힘. ' +
      'ref-MV bank·warp param bank = SB 경계 넘는 신규 이웃 상태 저장.',
    hazard:
      '1. **SDP luma→chroma 의존**(64×64): chroma 블록 복호는 동위치 luma 트리가 settle돼야 시작 → SB 내 직렬화.\n' +
      '2. 분할/모드 컨텍스트의 **이웃(위/좌) 의존** → 라인버퍼 read-after-write. ' +
      'ENT와 마찬가지로 본질 순차(분할 결정이 하위 블록 파싱을 좌우).',
    parallel:
      'SB 단위 파이프라인(타일 내 SB 순차, 타일 간 병렬). SB 내부는 SDP가 luma/chroma를 직렬화. ' +
      '256 SB는 더 큰 작업단위지만 라인버퍼·재귀 깊이 비용 동반.',
    av1delta:
      '- 단일 트리 → **듀얼 트리(SDP)**: 컨텍스트/트리 상태 2배, luma→chroma 의존 신규.\n' +
      '- 분할 shape 재편(T자형 제거, 비대칭 추가) → 분할 분기 로직 변경.\n' +
      '- 128 → **256 SB**: 라인버퍼 폭 2배(인터), 재귀 깊이 +1.\n' +
      '- 분할 신호 단일→5심볼 계층: 파티션 노드 파싱 직렬성 증가.',
    openQ: [
      'SDP가 SB 내 luma/chroma를 직렬화 → 두 트리를 별도 파이프 패스로 vs 한 패스에 인터리브? 컨텍스트 RAM 포트 경쟁.',
      'per-plane partition 컨텍스트(~3배)를 전부 on-chip vs chroma 컨텍스트만 압축/재계산?',
      '256 SB는 인터에서만 이득(intra는 128 강제) → SB 크기 가변을 HW가 런타임 처리 vs 256 고정 데이터패스?',
      '노드당 5심볼 직렬 파싱이 partition throughput을 떨어뜨림 → 컨텍스트 사전계산/투기적 디코드 가능?',
    ],
  },

  // ── Checkpoints + Quiz ─────────────────────────────────────
  checks: [
    { q: 'SDP가 무엇이고 HW에 만드는 의존성은?',
      a: 'Semantically Decoupled Partitioning — luma와 chroma가 **분리된 분할 트리**를 가짐(키프레임 64×64). luma 트리를 먼저 settle한 뒤 chroma가 참조 → SB 내 luma→chroma 직렬 의존 + 분할 컨텍스트가 plane별(라인버퍼 ~3배).',
      hint: 'decode_partition의 ptree/ptree_luma 인자 swap.' },
    { q: 'AV2 분할타입이 AV1과 어떻게 다른가?',
      a: 'AV1 T자형(HORZ_A/B)·등4분할(HORZ_4) → AV2 **비대칭** 3분할(HORZ_3=4:1:2:1:4:1… 실제 4:1,2:1,4:1)·4분할(4A=1:2:4:1, 4B=1:4:2:1). T자형 제거.',
      hint: 'enums.h:506 주석 비율.' },
    { q: '분할 신호의 파싱 비용이 왜 늘었나?',
      a: '한 노드 분할타입이 단일 read가 아니라 do_split→square→rect→ext→4way까지 **최대 5개 직렬 산술심볼**, 각각 이웃 컨텍스트 유도 필요 → 노드당 직렬 지연 증가.',
      hint: 'read_partition의 심볼 순서.' },
  ],
  quiz: [
    { q: 'AV2 superblock 최대 크기는?',
      options: ['128×128', '256×256', '64×64', '512×512'],
      answer: 1, why: 'MAX_SB_SIZE_LOG2=8 → 256(enums.h:140). 단 intra 프레임은 128로 강제.' },
    { q: 'SDP에서 먼저 복호되는 트리는?',
      options: ['chroma 먼저', 'luma 먼저(chroma가 참조)', '동시', 'tile마다 다름'],
      answer: 1, why: 'tree_type=LUMA_PART 재귀 후 CHROMA_PART. chroma가 ptree_luma 참조.' },
    { q: '다음 중 AV2에 없는 분할타입은?',
      options: ['PARTITION_HORZ_3', 'PARTITION_HORZ_A (T자형)', 'PARTITION_HORZ_4A', 'PARTITION_SPLIT'],
      answer: 1, why: 'T자형 HORZ_A/B는 AV1 전용. AV2는 비대칭 3/4A/4B로 대체.' },
    { q: 'SDP가 분할 컨텍스트 라인버퍼에 주는 영향은?',
      options: ['변화 없음', 'plane별 분리로 ~3배', '절반으로 감소', 'chroma만 사용'],
      answer: 1, why: '`above_partition_context[MAX_MB_PLANE]` — luma/chroma 컨텍스트 분리.' },
  ],

  chapters: [
    { id: 'm1', n: 1, title: 'Partition recursion', stage: 'skeleton',
      fn: { name: 'decode_partition_sb / decode_partition', file: 'av2/decoder/decodeframe.c', line: 2300,
        role: 'Recursively split the SB; leaf (PARTITION_NONE) → decode_block. Two-pass (parse / decode) dispatch.' },
      spec: { num: '5.20.3', title: 'Partition structures' },
      qna: [
        { tag: 'common', ref: 'decodeframe.c:2300',
          q: '분할 재귀의 기본 동작은? (AV1 공통)',
          a: '`decode_partition`이 SB를 재귀적으로 쪼개다 leaf(`PARTITION_NONE`)에서 `decode_block`. 쿼드트리 재귀 구조는 AV1 계승. `parse_decode_flag`로 **parse-only(01)/decode-only(10)/둘다(11)** 2-pass 디스패치.' },
        { tag: 'delta', ref: 'enums.h:141',
          q: 'AV2에서 재귀가 더 깊어진 이유는? (AV2 델타)',
          a: 'SB가 **256×256**(`MAX_SB_SIZE_LOG2=8`, AV1은 128)로 커져 분할 트리가 **한 레벨 더 깊음**. + 비대칭 분할(HORZ_3/4A 등)로 노드당 분기도 넓어짐. 트리 상태·이웃 컨텍스트가 AV1 대비 증가.' },
        { tag: 'hw', ref: 'decodeframe.c:2300',
          q: '재귀 분할의 HW 구조는?',
          a: '분할 트리 = **제어 FSM + 스택**(256 SB → 깊이 1↑). parse/decode 2-pass면 중간 트리 상태(`PARTITION_TREE`)를 버퍼링. MIP는 ENT와 결합된 **이웃 직렬** 파싱 — datapath보다 제어/순차성이 부담.' },
      ] },
    { id: 'm2', n: 2, title: '⭐ SDP dual tree (luma→chroma)', stage: 'skeleton',
      fn: { name: 'decode_partition (SDP path)', file: 'av2/decoder/decodeframe.c', line: 1879,
        role: 'Keyframe 64×64: decode the luma partition tree first, then chroma references it (args swapped).' },
      spec: { num: '5.20.3', title: 'Partition structures (SDP)' },
      io: {
        diagCaption: 'luma tree settles → chroma references it',
        diagram: 'graph TD\n' +
          '  SYM["partition symbols<br/>← ENT"] --> LT["LUMA_PART tree<br/>decode_partition"]\n' +
          '  CTXL["above/left ctx<br/>plane 0 (line buf)"] --> LT\n' +
          '  LT --> PTL["ptree_luma<br/>(settled)"]\n' +
          '  PTL --> CT["CHROMA_PART tree<br/>(references ptree_luma)"]\n' +
          '  CTXC["above/left ctx<br/>plane 1/2 (line buf)"] --> CT\n' +
          '  LT --> OUTL["luma geometry → PRD/IQT"]\n' +
          '  CT --> OUTC["chroma geometry → PRD/IQT"]\n' +
          '  classDef mem fill:#13283c,stroke:#4ea1ff,color:#e6edf3;\n' +
          '  classDef op fill:#13251b,stroke:#5bd17a,color:#e6edf3;\n' +
          '  classDef hot fill:#2a1414,stroke:#ff7b72,color:#fff;\n' +
          '  class SYM mem;\n  class CTXL mem;\n  class CTXC mem;\n  class OUTL mem;\n  class OUTC mem;\n' +
          '  class LT op;\n  class CT op;\n  class PTL hot;',
        in: [
          { sig: 'partition sym', type: 'hierarchical multi-symbol', peer: '← ENT', vol: '≤5/node', note: 'do_split→…→4way' },
          { sig: 'above/left ctx', type: 'partition context [MAX_MB_PLANE]', peer: 'line buffer (per plane)', vol: '~3× single-tree', note: 'SDP splits luma/chroma context' },
        ],
        out: [
          { sig: 'ptree_luma', type: 'PARTITION_TREE', peer: 'SB_INFO.ptree_root[0]', vol: '1 luma tree/SB', note: 'must settle before chroma tree starts' },
          { sig: 'ptree_chroma', type: 'PARTITION_TREE', peer: 'SB_INFO.ptree_root[1]', vol: '1 chroma tree/SB', note: 'references ptree_luma → luma→chroma serial' },
        ],
        note: 'The luma→chroma data dependency (ptree_luma feeds the chroma tree) is an **intra-SB serialization**: chroma partitioning cannot start until the co-located luma tree is settled.',
      },
      qna: [
        { tag: 'delta', ref: 'decodeframe.c:1879',
          q: 'SDP란 무엇인가? (AV2 신규)',
          a: '**Semi-Decoupled Partitioning** — luma와 chroma가 **별도 분할 트리**를 가짐. `tree_type==SHARED_PART`이고 2-loop이면 `LUMA_PART` 트리 디코드 → 그 다음 `CHROMA_PART` 트리(인자 swap)로 luma 트리 참조. **AV1엔 tree_type/SDP 전무**(grep 0건) — AV1은 단일 공유 트리.' },
        { tag: 'verified', ref: 'decodeframe.c:1880',
          q: 'luma→chroma 순서가 코드에서? (실측)',
          a: '`xd->tree_type=LUMA_PART; decode_partition(…ptree, ptree_luma…)` → `xd->tree_type=CHROMA_PART; decode_partition(…ptree_luma, ptree…)`(인자 순서 바뀜). 즉 **chroma 트리가 settled된 ptree_luma를 입력**으로 받음 → 같은 SB 내 luma→chroma 직렬.' },
        { tag: 'hw', ref: 'decodeframe.c:1882',
          q: 'SDP가 만드는 HW 제약은?',
          a: '**intra-SB 직렬화**: chroma 분할은 동위치 luma 트리가 끝나야 시작 → 두 트리를 인터리브 못 하고 순차. SB당 **ptree root 2개**(luma/chroma) → 분할 트리 상태 2배 + 컨텍스트 line buffer가 plane별로(m7).' },
      ] },
    { id: 'm3', n: 3, title: 'Hierarchical partition read', stage: 'skeleton',
      fn: { name: 'read_partition', file: 'av2/decoder/decodeframe.c', line: 1728,
        role: 'Up to 5 sequential symbols: do_split → square → rect → ext → 4way, each with neighbor context.' },
      spec: { num: '5.20.3', title: 'Partition structures' },
      qna: [
        { tag: 'verified', ref: 'decodeframe.c:1728',
          q: 'partition을 어떻게 계층적으로 읽나? (실측)',
          a: '`read_partition`: 먼저 `av2_get_normative_forced_partition_type`(경계/크기로 강제 분할 여부) → `partition_allowed[ALL_PARTITION_TYPES]` 마스크 → `do_split` → (split이면) rect(HORZ/VERT) → ext(3-way) → 4way(4A/4B). **노드당 최대 ~5 순차 심볼**, 각자 이웃 컨텍스트.' },
        { tag: 'delta', ref: 'decodeframe.c:1742',
          q: 'forced/derived partition이란? (AV2 델타)',
          a: 'AV2는 프레임/타일 경계나 블록 크기 제약으로 **분할이 강제**되면(`derived_partition != PARTITION_INVALID`) 심볼을 읽지 않고 결정 → 비트 절감. AV1보다 분할 종류가 많아 allowed 마스크로 가지치기.' },
        { tag: 'hw', ref: 'decodeframe.c:1728',
          q: 'partition read의 HW 비용은?',
          a: '노드당 **최대 5 직렬 산술 심볼** + 각 컨텍스트 유도 → 분할 노드마다 **CDF-read 지연**(ENT 직렬 체인에 직접 가중). chroma(`CHROMA_PART`)는 별도 CDF 세트 → 컨텍스트 저장 증가. MIP가 ENT의 throughput을 제약하는 지점.' },
      ] },
    { id: 'm4', n: 4, title: 'Partition enum & shapes', stage: 'skeleton',
      fn: { name: 'PARTITION_TYPE', file: 'av2/common/enums.h', line: 506,
        role: 'NONE/HORZ/VERT/HORZ_3/VERT_3/HORZ_4A/4B/VERT_4A/4B/SPLIT (asymmetric uneven shapes).' },
      spec: { num: '5.20.3', title: 'Partition structures' },
      qna: [
        { tag: 'delta', ref: 'enums.h:506',
          q: 'AV2 분할 모양이 AV1과 어떻게 다른가? (AV2 델타)',
          a: '신규 **비대칭/불균등** 분할: `PARTITION_HORZ_3/VERT_3`(3-way 4:1:2:1 비율), `PARTITION_HORZ_4A/4B/VERT_4A/4B`(4-way 불균등 1:2:4:1 / 1:4:2:1). AV1엔 `HORZ_4`(균등 4:1)만 있고 **3-way·4A/4B 불균등은 전무**(grep 0건). 콘텐츠 적응 분할 강화.' },
        { tag: 'verified', ref: 'enums.h:516',
          q: '기본 분할 타입 수는? (실측)',
          a: '`PARTITION_TYPES = PARTITION_VERT+1 = 3`(NONE/HORZ/VERT), `EXT_PARTITION_TYPES = PARTITION_SPLIT`, `ALL_PARTITION_TYPES`까지 = 10종. rect(HORZ/VERT) + uneven(4A/4B) enum 별도(`RECT_PART_TYPE`, `UNEVEN_4WAY_PART_TYPE`).' },
        { tag: 'hw', ref: 'enums.h:506',
          q: '불균등 분할의 HW 비용은?',
          a: '1:2:4:1 같은 **비대칭 sub-block 주소 생성** = 단순 1/2 분할보다 오프셋/크기 계산 복잡(LUT 또는 곱). 모양이 많아져 **분할 제어 FSM 분기 폭** 증가. 단 각 sub-block 자체는 표준 블록 → 후단(PRD/IQT)은 영향 적음.' },
      ] },
    { id: 'm5', n: 5, title: '256×256 SB & block sizes', stage: 'skeleton',
      fn: { name: 'setup_seq_sb_size', file: 'av2/decoder/decodeframe.c', line: 4026,
        role: 'SB size ∈ {256,128,64}; 256 forced to 128 on intra frames. MAX_SB_SIZE_LOG2 = 8.' },
      spec: { num: '5.4.3', title: 'Sequence partition config syntax' },
      qna: [
        { tag: 'delta', ref: 'enums.h:140',
          q: 'AV2 SB 크기가 어떻게 커졌나? (AV2 델타)',
          a: '`MAX_SB_SIZE_LOG2 = 8` → **256×256**(`BLOCK_256X256 = BLOCK_LARGEST`). AV1은 128×128 최대. 큰 SB는 저복잡 영역을 적은 분할로 표현 → 효율↑. intra 프레임은 256을 128로 강제.' },
        { tag: 'hw', ref: 'enums.h:174',
          q: '256 SB가 라인버퍼에 주는 영향은?',
          a: '⭐ above-context·이웃 버퍼가 **SB 폭 기준** → 256이면 AV1 128 대비 **2×**. `MAX_MIB_SIZE_LOG2 = 8−MI_LOG2`. left-context = SB 높이(256). MIP/예측/LPF 전반의 line buffer 예산을 키우는 주 요인.' },
        { tag: 'hw', ref: 'decodeframe.c:4026',
          q: '256(inter)/128(intra) 가변을 HW로?',
          a: '고정 256 datapath로 두고 128은 부분 사용 vs 런타임 가변 granularity. intra=128 강제라 worst-case는 inter 256 → **256 기준 사이징**. SB 크기는 시퀀스 헤더(`setup_seq_sb_size`)에서 확정 → 프레임 내 불변.' },
      ] },
    { id: 'm6', n: 6, title: 'Mode info reconstruction', stage: 'skeleton',
      fn: { name: 'av2_read_mode_info', file: 'av2/decoder/decodemv.c', line: 3204,
        role: 'Per-block intra/inter mode + MV/ref reconstruction; many new MB_MODE_INFO fields.' },
      spec: { num: '5.20.5', title: 'Mode information structures' },
      qna: [
        { tag: 'common', ref: 'decodemv.c:3204',
          q: 'mode info 재구성이 하는 일은? (AV1 공통)',
          a: '`av2_read_mode_info`가 블록마다 intra/inter 모드 + MV/ref/segment/tx 정보를 파싱·재구성해 `MB_MODE_INFO`에 채움. 분할이 정해진 leaf 블록의 "무엇으로 예측할지"를 결정. 골격은 AV1 계승.' },
        { tag: 'delta', ref: 'decodemv.c:3204',
          q: 'AV2에서 늘어난 mode 필드는? (AV2 델타)',
          a: '신규 필드 다수: `intra_dip_mode`(DIP)·`cfl_idx`(implicit/MHCCP)·`pb_mv_precision`(7-level)·`refinemv_flag`(DMVR)·`mh_dir`(MHCCP)·warp/BAWP/CWP/JMVD 등. 각 도구(intra/inter tool)의 게이트가 여기서 파싱됨 → 블록당 제어 상태 증가.' },
        { tag: 'hw', ref: 'decodemv.c:3204',
          q: 'mode 재구성의 직렬성은?',
          a: 'MV 예측은 **ref-MV bank·warp bank**(inter [MVP](app.html?tool=mvp))를 읽고 갱신 → **이웃 의존 직렬 상태**. mode 파싱은 ENT 산술 체인에 묶여 순차. MIP는 이렇게 ENT·MVP와 강결합돼 디코더 front 직렬성의 핵심.' },
      ] },
    { id: 'm7', n: 7, title: 'Partition context line buffers', stage: 'skeleton',
      fn: { name: 'above/left_partition_context', file: 'av2/common/blockd.h', line: 2111,
        role: 'Per-plane (MAX_MB_PLANE) above/left context for SDP — ~3× the single-tree line buffer.' },
      spec: { num: '5.20.3', title: 'Partition structures' },
      qna: [
        { tag: 'delta', ref: 'blockd.h:2111',
          q: 'partition context가 SDP로 어떻게 늘었나? (AV2 델타)',
          a: 'SDP라 luma/chroma가 별도 트리 → `above/left_partition_context`를 **plane별(`MAX_MB_PLANE`)** 유지 → 단일 트리 대비 **~3×**. AV1은 1개 공유 컨텍스트. 분할 종류도 많아 컨텍스트 유도가 복잡.' },
        { tag: 'hw', ref: 'blockd.h:2111',
          q: 'partition context의 line buffer 사이징은?',
          a: '**above-context = 프레임 폭** line buffer(×plane), **left-context = SB 높이(256)**. 256 SB + plane 3개 → MIP line buffer가 AV1 대비 크게 증가. chroma 컨텍스트를 저장 vs 재계산이 면적/대역폭 trade.' },
        { tag: 'hw', ref: 'blockd.h:2111',
          q: '컨텍스트가 만드는 직렬성은?',
          a: 'partition/mode 컨텍스트는 **위/왼쪽 이웃**에서 유도 → 블록을 래스터/Z 순서로 **순차** 처리(이웃 먼저 확정). ENT 산술 + 이웃 컨텍스트 = MIP의 본질적 직렬 체인. datapath보다 이 순차성이 throughput 한계.' },
      ] },
    { id: 'm8', n: 8, title: 'HW synthesis (MIP)', stage: 'skeleton',
      fn: { name: '(whole stage)',
        role: 'Per-plane context line buffers, SDP serialization, 256 SB granularity, partition parse cost.' },
      qna: [
        { tag: 'hw',
          q: 'MIP 전체를 HW로 요약하면?',
          a: 'MIP는 **연산이 아니라 제어·순차성** 스테이지. ENT 산술과 결합된 분할/모드 파싱 + 이웃 컨텍스트 의존 → **throughput 한계는 직렬 파싱**. datapath(주소 생성)는 가벼움. 큰 비용 = line buffer(256 SB×plane)와 SDP 직렬화.' },
        { tag: 'hw',
          q: 'MIP의 직렬 요소 3가지는?',
          a: '① **SDP luma→chroma**(intra-SB 직렬, m2) ② **partition read**(노드당 ~5 심볼, ENT 체인, m3) ③ **이웃 컨텍스트**(위/왼쪽 먼저 확정, m7) + ref-MV/warp bank 갱신. 모두 carried-state라 파이프 깊이를 제한.' },
        { tag: 'hw',
          q: 'MIP line buffer 예산은?',
          a: 'partition context(×plane, 256폭) + mode/MV 이웃 + ref-MV bank + warp bank. 256 SB라 AV1 128 대비 폭 2×. on-chip 유지 vs chroma 컨텍스트 재계산이 면적 trade. MIP가 디코더 **front-end SRAM**의 큰 소비자.' },
      ] },
  ],
};
