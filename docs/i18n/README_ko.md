# 🧠 Prism MCP — AI 에이전트를 위한 마인드 팰리스

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://github.com/modelcontextprotocol/servers)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers?query=prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: BSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../CONTRIBUTING.md)

🌐 **언어:** [English](../../README.md) · [Español](README_es.md) · [Français](README_fr.md) · [Português](README_pt.md) · [Română](README_ro.md) · [Українська](README_uk.md) · [Русский](README_ru.md) · [Deutsch](README_de.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [中文](README_zh.md) · [العربية](README_ar.md)

> **참고:** 이 번역은 메인 README의 최근 변경 사항을 모두 반영하지 않을 수 있습니다.
> 가장 완전하고 최신 버전은 **[영문 README](../../README.md)**를 참조하세요.

---

## Prism Coder IDE — 코딩만 하지 말고, 출시하세요

> **신규:** 코딩, 빌드, 배포를 하나의 도구로 결합한 풀스택 AI 네이티브 데스크톱 IDE.

### 다운로드

| 플랫폼 | 패키지 | 크기 |
|----------|---------|------|
| **Windows** | [Prism Coder-1.0.0-Setup.exe](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-Setup.exe) | 99 MB |
| **macOS (Apple Silicon)** | [Prism Coder-1.0.0-arm64.dmg](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-arm64.dmg) | 113 MB |
| **Linux** | [Prism Coder-1.0.0.AppImage](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0.AppImage) | 119 MB |
| **npm (MCP Server)** | `npx -y prism-mcp-server` | — |

| 제공 기능 | 기존 대비 시간 절약 |
|---|:---:|
| 🤖 **에이전트 모드** — diff 미리보기가 포함된 자율 멀티스텝 작업 실행 | ~95% |
| 🏗️ **웹사이트 빌더** — 6개 템플릿, 섹션 에디터, HTML/ZIP 내보내기 | ~90% |
| 🎨 **비주얼 드래그 앤 드롭** — 11개 컴포넌트 타입, 캔버스 드롭 존, 라이브 속성 에디터 | ~85% |
| 🔑 **인증 & 데이터베이스** — 6개 인증 제공자, 테이블 CRUD, RLS, 스토리지 버킷 | ~90% |
| 🐳 **DevContainers** — 8개 베이스 이미지, 포트 포워딩, 리소스 제한, Codespaces 내보내기 | ~80% |
| 📋 **고객 보드 (HIPAA)** — 12패턴 PHI 스캐너, 중재자 제어, 티켓 라이프사이클 | ~70% |
| 🎨 **미디어 스튜디오** — AI 이미지/비디오/3D 생성, 티어별 품질 | ~98% |
| 🚀 **원클릭 배포** — Vercel, Netlify, Synalux Cloud, 커스텀 서버 | ~98% |
| 👥 **실시간 협업** — 커서 프레즌스가 있는 멀티플레이어 편집 | ~60% |
| 📊 **SEO + 분석** — 8개 카테고리 감사 + 트래픽 대시보드 | ~99% |
| 🏪 **마켓플레이스** — 10개 카테고리 확장 레지스트리, 원클릭 설치 | ~90% |
| 📋 **워크플로우 엔진** — 자연어를 구조화된 프로젝트 워크플로우로 변환 | ~90% |
| 🔀 **Git 통합** — IDE를 벗어나지 않고 branch, stage, commit, push | ~60% |
| 🌐 **12개 언어 i18n** — 아랍어 RTL을 포함한 전체 UI 번역 | ~100% |

**27/27 기능** — 어떤 경쟁사보다 많음 (Cursor: 9, Windsurf: 9, Replit: 12, Bolt: 9).

👉 **[스크린샷, 아키텍처, 기술 세부사항이 포함된 전체 IDE README →](https://github.com/dcostenco/prism-coder/releases/tag/v1.0.0)**

---

![Prism Hivemind Multi-Agent Dashboard](../v11_hivemind_multi_agent_dashboard.jpg)

**AI 에이전트는 세션 사이에 모든 것을 잊어버립니다. Prism이 이를 해결하고 — 그런 다음 생각하는 법을 가르칩니다.**

Prism v12.5는 인간 뇌의 메커니즘에서 영감을 받은 진정한 **인지 아키텍처**입니다. 단순한 벡터 검색을 넘어, 에이전트는 이제 경험에서 원칙을 형성하고, 인과적 사고 사슬을 따르며, 정보가 부족할 때를 아는 자기 인식을 갖추고 있습니다. 전체 인지 파이프라인이 **100% 디바이스에서** 실행됩니다.

```bash
npx -y prism-mcp-server
```

**Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — **모든 MCP 클라이언트**에서 작동합니다.

---

## 왜 Prism인가?

AI 코딩 어시스턴트와 새 대화를 시작할 때마다 처음부터 시작합니다. 아키텍처를 다시 설명하고, 결정을 다시 기술하고, TODO를 다시 나열합니다. 수시간의 컨텍스트 — 사라집니다.

**Prism은 에이전트에게 지속되는 두뇌를 제공하고 — 그런 다음 추론하는 법을 가르칩니다.**

---

## 주요 기능 (v12.5)

| 기능 | 설명 |
|---|---|
| 🧠 **인지 메모리 ($O(1)$)** | 홀로그래픽 축소 표현을 통한 무검색 검색 |
| 🔗 **멀티홉 추론** | ACT-R 확산 활성화를 통한 인과 그래프 순회 |
| 🏭 **Dark Factory** | 페일-클로즈드 평가가 포함된 적대적 자율 파이프라인 |
| 🐝 **Hivemind** | 역할 격리 메모리를 가진 멀티에이전트 조정 |
| 🕰️ **타임 트래블** | `memory_checkout` 되돌리기가 포함된 버전 스냅샷 |
| 🔮 **Mind Palace 대시보드** | `localhost:3000`의 글래스모피즘 UI |
| 🧬 **10배 압축** | TurboQuant — 임베딩당 3,072에서 400바이트로 |
| 🔭 **Web Scholar** | 백그라운드 연구 파이프라인 (Brave + Firecrawl + LLM) |
| 🛡️ **HIPAA 등급 보안** | 22개 적대적 발견 사항 해결, 엄격한 로컬 모드 |
| 🖼️ **비주얼 메모리** | VLM 캡션이 포함된 스크린샷 저장소 |
| 📥 **유니버설 임포트** | Claude Code, Gemini, OpenAI 히스토리 가져오기 |
| 🚦 **태스크 라우터** | 호스트 vs. 로컬 위임을 위한 6-신호 휴리스틱 |
| 💳 **통합 빌링** | Prism + Synalux를 하나의 빌링 아키텍처로, 14일 무료 체험 |
| 🏗️ **인프라 복원력** | 자가 복구, 데이터베이스 복구, 헬스 모니터링 |
| 🔬 **Auto-Scholar** | PubMed/ERIC를 통한 딥 리서치 인텔리전스 |

---

## 빠른 시작

```bash
npx -y prism-mcp-server
```

> **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — 모든 MCP 클라이언트에서 작동합니다.

---

📌 **[← 영어 전체 버전으로 돌아가기 (README.md)](../../README.md)**
