# Codec Deep-Dive Lab

AV2 디코더를 **tool 하나씩** 심층 학습하는 공개 학습 앱 모음. 입문/투어는
[Codec C-Model Lab](https://jwj-nick.github.io/codec-cmodel-lab/), 여기는 **심화 과정**.

각 앱(= HW 파이프라인 스테이지 1개)이 4계층으로 한 tool을 판다:

- **L1 Spec** — decode process 의사코드 · syntax element · 비트 레이아웃 (AV2 spec § 인용)
- **L2 C-Model** — AVM 실제 함수/구조체 `file:line` · 호출그래프 · gdb 실측값
- **L3 Spec↔Code** — 나란히 보기 + **AV1→AV2 델타**
- **L4 HW Architecture** — datapath · throughput · 라인버퍼 · hazard · 병렬화 *(일반 사고법만)*

## 6 앱 (= 6 스테이지)
`Entropy(ENT)` · `Partition&Mode(MIP)` · `Transform&Quant(IQT)` · `Intra(PRD)` · `Inter(PRD·MEM)` · `In-loop(LPF)`

## 구조 (빌드 없음 · 바닐라 JS + CDN)
```
index.html         랜딩(파이프라인 런처)
app.html           공유 셸 — app.html?tool=<id>
core/              렌더러 + 컴포넌트(stagemap/bitfield/sidebyside/codeblock/render) + styles
tools/<id>.js      tool별 데이터 (스키마 = tools/_schema.md)
```
로컬 미리보기: `python -m http.server` 후 `localhost:8000`.

## ⚠️ 공개 경계
HW 계층은 **공개 spec + 오픈소스 코드로 누구나 도출 가능한 일반 사고법**까지만.
특정 IP의 라인버퍼 SRAM 정량·대역폭 예산·모듈 추출은 범위 밖(비공개 스터디 전용).

## 출처
AVM(AV2 reference C model) = BSD. AV2 spec = AOMedia, "AV2 Bitstream & Decoding Process
Specification" v1.0.0. 코드 인용은 학습 목적 발췌.
