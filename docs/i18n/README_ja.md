# 🧠 Prism MCP — AIエージェントのためのマインドパレス

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://github.com/modelcontextprotocol/servers)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers?query=prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: BSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../CONTRIBUTING.md)

🌐 **言語:** [English](../../README.md) · [Español](README_es.md) · [Français](README_fr.md) · [Português](README_pt.md) · [Română](README_ro.md) · [Українська](README_uk.md) · [Русский](README_ru.md) · [Deutsch](README_de.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [中文](README_zh.md) · [العربية](README_ar.md)

> **注意:** この翻訳はメインREADMEの最新の変更をすべて反映していない場合があります。
> 最も完全で最新のバージョンについては、**[英語版README](../../README.md)**をご覧ください。

---

## Prism Coder IDE — コードするだけでなく、出荷せよ

> **新機能:** コーディング、ビルド、デプロイを1つのツールで組み合わせたフルスタックAIネイティブデスクトップIDE。

### ダウンロード

| プラットフォーム | パッケージ | サイズ |
|----------|---------|------|
| **Windows** | [Prism Coder-1.0.0-Setup.exe](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-Setup.exe) | 99 MB |
| **macOS (Apple Silicon)** | [Prism Coder-1.0.0-arm64.dmg](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-arm64.dmg) | 113 MB |
| **Linux** | [Prism Coder-1.0.0.AppImage](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0.AppImage) | 119 MB |
| **npm (MCP Server)** | `npx -y prism-mcp-server` | — |

| 機能 | 従来比の時間節約 |
|---|:---:|
| 🤖 **エージェントモード** — 差分プレビュー付き自律的マルチステップタスク実行 | ~95% |
| 🏗️ **ウェブサイトビルダー** — 6テンプレート、セクションエディタ、HTML/ZIPエクスポート | ~90% |
| 🎨 **ビジュアルドラッグ&ドロップ** — 11コンポーネントタイプ、キャンバスドロップゾーン、ライブプロパティエディタ | ~85% |
| 🔑 **認証&データベース** — 6認証プロバイダ、テーブルCRUD、RLS、ストレージバケット | ~90% |
| 🐳 **DevContainers** — 8ベースイメージ、ポートフォワーディング、リソース制限、Codespacesエクスポート | ~80% |
| 📋 **カスタマーボード（HIPAA）** — 12パターンPHIスキャナー、モデレーターコントロール、チケットライフサイクル | ~70% |
| 🎨 **メディアスタジオ** — AI画像/動画/3D生成、ティア別品質 | ~98% |
| 🚀 **ワンクリックデプロイ** — Vercel、Netlify、Synalux Cloud、カスタムサーバー | ~98% |
| 👥 **リアルタイムコラボレーション** — カーソルプレゼンス付きマルチプレイヤー編集 | ~60% |
| 📊 **SEO + アナリティクス** — 8カテゴリ監査 + トラフィックダッシュボード | ~99% |
| 🏪 **マーケットプレイス** — 10カテゴリ拡張レジストリ、ワンクリックインストール | ~90% |
| 📋 **ワークフローエンジン** — 自然言語から構造化プロジェクトワークフローへ | ~90% |
| 🔀 **Git統合** — IDEを離れずにbranch、stage、commit、push | ~60% |
| 🌐 **12言語i18n** — アラビア語RTLを含む完全なUI翻訳 | ~100% |

**27/27機能** — どの競合よりも多い（Cursor: 9、Windsurf: 9、Replit: 12、Bolt: 9）。

👉 **[スクリーンショット、アーキテクチャ、技術詳細を含むIDE完全README →](https://github.com/dcostenco/prism-coder/releases/tag/v1.0.0)**

---

![Prism Hivemind Multi-Agent Dashboard](../v11_hivemind_multi_agent_dashboard.jpg)

**AIエージェントはセッション間ですべてを忘れます。Prismはそれを修正し — 考えることを教えます。**

Prism v12.5は人間の脳のメカニクスに触発された真の**コグニティブアーキテクチャ**です。フラットなベクトル検索を超え、エージェントは経験から原則を形成し、因果的思考連鎖をたどり、情報が不足している時を知る自己認識を持ちます。認知パイプライン全体が**100%デバイス上**で動作します。

```bash
npx -y prism-mcp-server
```

**Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — **あらゆるMCPクライアント**で動作します。

---

## なぜPrismなのか？

AIコーディングアシスタントと新しい会話を始めるたびに、ゼロから始まります。アーキテクチャを再説明し、決定を再記述し、TODOを再リストアップします。何時間ものコンテキスト — 失われます。

**Prismはエージェントに永続するブレインを与え — そして推論することを教えます。**

---

## 主な機能（v12.5）

| 機能 | 説明 |
|---|---|
| 🧠 **コグニティブメモリ ($O(1)$)** | ホログラフィック縮約表現による検索不要の取得 |
| 🔗 **マルチホップ推論** | ACT-R拡散活性化による因果グラフ走査 |
| 🏭 **Dark Factory** | フェイルクローズド評価付き敵対的自律パイプライン |
| 🐝 **Hivemind** | ロール分離メモリによるマルチエージェント連携 |
| 🕰️ **タイムトラベル** | `memory_checkout`リバート付きバージョンスナップショット |
| 🔮 **Mind Palaceダッシュボード** | `localhost:3000`のGlassmorphism UI |
| 🧬 **10倍圧縮** | TurboQuant — エンベディングあたり3,072から400バイト |
| 🔭 **Web Scholar** | バックグラウンド研究パイプライン（Brave + Firecrawl + LLM） |
| 🛡️ **HIPAAグレードセキュリティ** | 22の敵対的知見を解決、厳格なローカルモード |
| 🖼️ **ビジュアルメモリ** | VLMキャプション付きスクリーンショット保管庫 |
| 📥 **ユニバーサルインポート** | Claude Code、Gemini、OpenAI履歴の取り込み |
| 🚦 **タスクルーター** | ホストvs.ローカル委任の6シグナルヒューリスティック |
| 💳 **統合課金** | Prism + Synaluxを1つの課金アーキテクチャに統合、14日間無料トライアル |
| 🏗️ **インフラ耐障害性** | 自己修復、データベース復旧、ヘルスモニタリング |
| 🔬 **Auto-Scholar** | PubMed/ERICによるディープリサーチインテリジェンス |

---

## クイックスタート

```bash
npx -y prism-mcp-server
```

> **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — あらゆるMCPクライアントで動作します。

---

📌 **[← 英語版の完全なREADMEに戻る（README.md）](../../README.md)**
