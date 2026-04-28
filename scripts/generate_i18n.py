#!/usr/bin/env python3
"""
Auto-generate Prism i18n landing pages from the main README.md.
Triggered by GitHub Actions on README.md changes.

Usage:
  python3 scripts/generate_i18n.py

Output:
  docs/i18n/README_{lang}.md for each supported language
"""
import os

LANGS = {
    "es": {"name": "Español", "title": "🧠 Prism MCP — El Palacio Mental para Agentes de IA", "tagline": "Tu agente de IA olvida todo entre sesiones. Prism lo corrige — y luego le enseña a pensar.", "why": "¿Por qué Prism?", "why_desc": "Cada vez que inicias una nueva conversación con un asistente de codificación IA, comienza desde cero. Vuelves a explicar tu arquitectura, vuelves a describir tus decisiones, vuelves a listar tus TODOs. Horas de contexto — perdidas.\n\n**Prism le da a tu agente un cerebro que persiste — y luego le enseña a razonar.**", "features_title": "Características Principales", "back": "← Volver a la versión en inglés", "quick_start": "Inicio Rápido", "translate_label": "Idioma"},
    "fr": {"name": "Français", "title": "🧠 Prism MCP — Le Palais Mental pour Agents IA", "tagline": "Votre agent IA oublie tout entre les sessions. Prism corrige cela — puis lui apprend à penser.", "why": "Pourquoi Prism ?", "why_desc": "Chaque fois que vous démarrez une nouvelle conversation avec un assistant de codage IA, il repart de zéro. Vous réexpliquez votre architecture, redécrivez vos décisions, relistez vos TODOs. Des heures de contexte — perdues.\n\n**Prism donne à votre agent un cerveau qui persiste — puis lui apprend à raisonner.**", "features_title": "Fonctionnalités Principales", "back": "← Retour à la version anglaise", "quick_start": "Démarrage Rapide", "translate_label": "Langue"},
    "pt": {"name": "Português", "title": "🧠 Prism MCP — O Palácio Mental para Agentes de IA", "tagline": "Seu agente de IA esquece tudo entre as sessões. Prism corrige isso — e depois ensina a pensar.", "why": "Por que Prism?", "why_desc": "Toda vez que você inicia uma nova conversa com um assistente de codificação IA, ele começa do zero. Você re-explica sua arquitetura, re-descreve suas decisões, re-lista seus TODOs. Horas de contexto — perdidas.\n\n**Prism dá ao seu agente um cérebro que persiste — e depois ensina a raciocinar.**", "features_title": "Funcionalidades Principais", "back": "← Voltar à versão em inglês", "quick_start": "Início Rápido", "translate_label": "Idioma"},
    "ro": {"name": "Română", "title": "🧠 Prism MCP — Palatul Minții pentru Agenți IA", "tagline": "Agentul tău AI uită totul între sesiuni. Prism rezolvă asta — apoi îl învață să gândească.", "why": "De ce Prism?", "why_desc": "De fiecare dată când începi o conversație nouă cu un asistent de codare AI, acesta pornește de la zero. Re-explici arhitectura, re-descrii deciziile, re-listezi TODO-urile. Ore de context — pierdute.\n\n**Prism oferă agentului tău un creier care persistă — apoi îl învață să raționeze.**", "features_title": "Funcționalități Principale", "back": "← Înapoi la versiunea în engleză", "quick_start": "Pornire Rapidă", "translate_label": "Limba"},
    "uk": {"name": "Українська", "title": "🧠 Prism MCP — Палац Розуму для AI Агентів", "tagline": "Ваш AI агент забуває все між сесіями. Prism виправляє це — а потім навчає його думати.", "why": "Чому Prism?", "why_desc": "Щоразу, коли ви починаєте нову розмову з AI-помічником для кодування, він починає з нуля. Ви знову пояснюєте архітектуру, знову описуєте рішення, знову перераховуєте TODO. Години контексту — втрачені.\n\n**Prism дає вашому агенту мозок, який зберігається — а потім навчає його мислити.**", "features_title": "Основні Функції", "back": "← Повернутися до англійської версії", "quick_start": "Швидкий Старт", "translate_label": "Мова"},
    "ru": {"name": "Русский", "title": "🧠 Prism MCP — Дворец Разума для AI Агентов", "tagline": "Ваш AI агент забывает всё между сессиями. Prism исправляет это — а затем учит его думать.", "why": "Почему Prism?", "why_desc": "Каждый раз, когда вы начинаете новый разговор с AI-ассистентом для кодирования, он начинает с нуля. Вы снова объясняете архитектуру, снова описываете решения, снова перечисляете TODO. Часы контекста — потеряны.\n\n**Prism даёт вашему агенту мозг, который сохраняется — а затем учит его рассуждать.**", "features_title": "Основные Функции", "back": "← Вернуться к английской версии", "quick_start": "Быстрый Старт", "translate_label": "Язык"},
    "de": {"name": "Deutsch", "title": "🧠 Prism MCP — Der Gedankenpalast für KI-Agenten", "tagline": "Ihr KI-Agent vergisst alles zwischen Sitzungen. Prism behebt das — und lehrt ihn dann zu denken.", "why": "Warum Prism?", "why_desc": "Jedes Mal, wenn Sie ein neues Gespräch mit einem KI-Codierassistenten beginnen, startet er von Null. Sie erklären die Architektur erneut, beschreiben Entscheidungen erneut, listen TODOs erneut auf. Stunden an Kontext — verloren.\n\n**Prism gibt Ihrem Agenten ein Gehirn, das bestehen bleibt — und lehrt ihn dann zu denken.**", "features_title": "Hauptfunktionen", "back": "← Zurück zur englischen Version", "quick_start": "Schnellstart", "translate_label": "Sprache"},
    "ja": {"name": "日本語", "title": "🧠 Prism MCP — AIエージェントのためのマインドパレス", "tagline": "AIエージェントはセッション間ですべてを忘れます。Prismはそれを修正し、考えることを教えます。", "why": "なぜPrismなのか？", "why_desc": "AIコーディングアシスタントと新しい会話を始めるたびに、ゼロから始まります。アーキテクチャを再説明し、決定を再記述し、TODOを再リストアップします。何時間ものコンテキスト — 失われます。\n\n**Prismはエージェントに永続するブレインを与え — そして推論することを教えます。**", "features_title": "主な機能", "back": "← 英語版に戻る", "quick_start": "クイックスタート", "translate_label": "言語"},
    "ko": {"name": "한국어", "title": "🧠 Prism MCP — AI 에이전트를 위한 마인드 팰리스", "tagline": "AI 에이전트는 세션 사이에 모든 것을 잊어버립니다. Prism이 이를 해결하고 — 그런 다음 생각하는 법을 가르칩니다.", "why": "왜 Prism인가?", "why_desc": "AI 코딩 어시스턴트와 새 대화를 시작할 때마다 처음부터 시작합니다. 아키텍처를 다시 설명하고, 결정을 다시 기술하고, TODO를 다시 나열합니다. 수시간의 컨텍스트 — 사라집니다.\n\n**Prism은 에이전트에게 지속되는 두뇌를 제공하고 — 그런 다음 추론하는 법을 가르칩니다.**", "features_title": "주요 기능", "back": "← 영어 버전으로 돌아가기", "quick_start": "빠른 시작", "translate_label": "언어"},
    "zh": {"name": "中文", "title": "🧠 Prism MCP — AI代理的心智宫殿", "tagline": "您的AI代理在会话之间忘记一切。Prism修复了这个问题 — 然后教它思考。", "why": "为什么选择Prism？", "why_desc": "每次您与AI编程助手开始新对话时，它都从零开始。您重新解释架构，重新描述决策，重新列出TODO。数小时的上下文 — 丢失了。\n\n**Prism给您的代理一个持久的大脑 — 然后教它推理。**", "features_title": "核心功能", "back": "← 返回英文版", "quick_start": "快速开始", "translate_label": "语言"},
    "ar": {"name": "العربية", "title": "🧠 Prism MCP — قصر العقل لوكلاء الذكاء الاصطناعي", "tagline": "وكيل الذكاء الاصطناعي الخاص بك ينسى كل شيء بين الجلسات. Prism يصلح ذلك — ثم يعلمه التفكير.", "why": "لماذا Prism؟", "why_desc": "في كل مرة تبدأ محادثة جديدة مع مساعد برمجة بالذكاء الاصطناعي، يبدأ من الصفر. تعيد شرح البنية، تعيد وصف القرارات، تعيد إدراج المهام. ساعات من السياق — ضائعة.\n\n**Prism يمنح وكيلك دماغاً يستمر — ثم يعلمه التفكير المنطقي.**", "features_title": "الميزات الرئيسية", "back": "← العودة إلى النسخة الإنجليزية", "quick_start": "بداية سريعة", "translate_label": "اللغة"},
}

LANG_SWITCHER = " · ".join(
    ["[English](../../README.md)"] +
    [f"[{v['name']}](README_{k}.md)" for k, v in LANGS.items()]
)

FEATURES_TABLE = """| Feature | Description |
|---|---|
| 🧠 **Cognitive Memory ($O(1)$)** | Zero-search retrieval via Holographic Reduced Representations |
| 🔗 **Multi-Hop Reasoning** | ACT-R Spreading Activation causal graph traversal |
| 🏭 **Dark Factory** | Adversarial autonomous pipelines with fail-closed evaluation |
| 🐝 **Hivemind** | Multi-agent coordination with role-isolated memory |
| 🕰️ **Time Travel** | Version snapshots with `memory_checkout` revert |
| 🔮 **Mind Palace Dashboard** | Glassmorphism UI at `localhost:3000` |
| 🧬 **10× Compression** | TurboQuant — 3,072 → 400 bytes per embedding |
| 🔭 **Web Scholar** | Background research pipeline (Brave + Firecrawl + LLM) |
| 🛡️ **HIPAA-Grade Security** | 22 adversarial findings closed, strict local mode |
| 🖼️ **Visual Memory** | VLM-captioned screenshot vault |
| 📥 **Universal Import** | Ingest Claude Code, Gemini, OpenAI histories |
| 🚦 **Task Router** | 6-signal heuristic for host vs. local delegation |"""


def main():
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "i18n")
    os.makedirs(outdir, exist_ok=True)

    for code, lang in LANGS.items():
        content = f"""# {lang['title']}

> {lang['tagline']}

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![License: BSL-1.1](https://img.shields.io/badge/License-BSL--1.1-blue.svg)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

🌐 **{lang['translate_label']}:** {LANG_SWITCHER}

📌 **[{lang['back']}](../../README.md)**

---

## {lang['why']}

{lang['why_desc']}

---

## {lang['features_title']}

{FEATURES_TABLE}

---

## {lang['quick_start']}

```bash
npx -y prism-mcp-server
```

> Works with **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — any MCP client.

---

📌 **[{lang['back']}](../../README.md)**
"""
        filepath = os.path.join(outdir, f"README_{code}.md")
        with open(filepath, "w") as f:
            f.write(content)
        print(f"✅ {filepath}")

    print(f"\nGenerated {len(LANGS)} i18n files in {outdir}")


if __name__ == "__main__":
    main()
