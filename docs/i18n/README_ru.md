# 🧠 Prism MCP — Дворец Разума для AI Агентов

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://github.com/modelcontextprotocol/servers)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers?query=prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: BSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../CONTRIBUTING.md)

🌐 **Язык:** [English](../../README.md) · [Español](README_es.md) · [Français](README_fr.md) · [Português](README_pt.md) · [Română](README_ro.md) · [Українська](README_uk.md) · [Русский](README_ru.md) · [Deutsch](README_de.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [中文](README_zh.md) · [العربية](README_ar.md)

> **Примечание:** Данный перевод может не отражать все последние изменения из основного README.
> Для наиболее полной и актуальной версии см. **[README на английском](../../README.md)**.

---

## Prism Coder IDE — Доставляй, а не просто кодируй

> **НОВОЕ:** Полнофункциональный AI-нативный десктопный IDE, объединяющий кодирование, сборку и развертывание в одном инструменте.

### Загрузки

| Платформа | Пакет | Размер |
|----------|---------|------|
| **Windows** | [Prism Coder-1.0.0-Setup.exe](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-Setup.exe) | 99 MB |
| **macOS (Apple Silicon)** | [Prism Coder-1.0.0-arm64.dmg](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-arm64.dmg) | 113 MB |
| **Linux** | [Prism Coder-1.0.0.AppImage](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0.AppImage) | 119 MB |
| **npm (MCP Server)** | `npx -y prism-mcp-server` | — |

| Что вы получаете | Экономия vs. Традиционный |
|---|:---:|
| 🤖 **Режим Агента** — автономное выполнение многошаговых задач с предпросмотром изменений | ~95% |
| 🏗️ **Конструктор Сайтов** — 6 шаблонов, редактор секций, экспорт в HTML/ZIP | ~90% |
| 🎨 **Визуальное Перетаскивание** — 11 типов компонентов, зона размещения, живой редактор свойств | ~85% |
| 🔑 **Auth и База Данных** — 6 провайдеров auth, CRUD таблиц, RLS, бакеты хранения | ~90% |
| 🐳 **DevContainers** — 8 базовых образов, проброс портов, лимиты ресурсов, экспорт Codespaces | ~80% |
| 📋 **Панель Клиентов (HIPAA)** — сканер PHI с 12 паттернами, контроли модератора, жизненный цикл тикетов | ~70% |
| 🎨 **Медиа Студия** — генерация изображений/видео/3D с AI, качество по уровням | ~98% |
| 🚀 **Развертывание Одним Кликом** — Vercel, Netlify, Synalux Cloud, собственный сервер | ~98% |
| 👥 **Совместная Работа в Реальном Времени** — мультиплеерное редактирование с присутствием курсора | ~60% |
| 📊 **SEO + Аналитика** — аудит 8 категорий + панель трафика | ~99% |
| 🏪 **Маркетплейс** — реестр расширений 10 категорий, установка одним кликом | ~90% |
| 📋 **Движок Рабочих Процессов** — естественный язык в структурированные рабочие процессы | ~90% |
| 🔀 **Интеграция Git** — branch, stage, commit, push не выходя из IDE | ~60% |
| 🌐 **i18n на 12 Языках** — полный перевод UI включая арабский RTL | ~100% |

**27/27 функций** — больше чем любой конкурент (Cursor: 9, Windsurf: 9, Replit: 12, Bolt: 9).

👉 **[Полный README IDE со скриншотами, архитектурой и техническими деталями →](https://github.com/dcostenco/prism-coder/releases/tag/v1.0.0)**

---

![Prism Hivemind Multi-Agent Dashboard](../v11_hivemind_multi_agent_dashboard.jpg)

**Ваш AI агент забывает всё между сессиями. Prism исправляет это — а затем учит его думать.**

Prism v12.5 — это настоящая **Когнитивная Архитектура**, вдохновленная механикой человеческого мозга. Помимо плоского векторного поиска, ваш агент теперь формирует принципы из опыта, следует каузальным цепочкам мышления и обладает самосознанием, чтобы знать, когда ему не хватает информации. Весь когнитивный конвейер работает **100% на устройстве**.

```bash
npx -y prism-mcp-server
```

Работает с **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — **любой MCP клиент.**

---

## Почему Prism?

Каждый раз, когда вы начинаете новый разговор с AI-ассистентом для кодирования, он начинает с нуля. Вы снова объясняете архитектуру, снова описываете решения, снова перечисляете TODO. Часы контекста — потеряны.

**Prism даёт вашему агенту мозг, который сохраняется — а затем учит его рассуждать.**

---

## Основные Функции (v12.5)

| Функция | Описание |
|---|---|
| 🧠 **Когнитивная Память ($O(1)$)** | Извлечение без поиска через Голографические Сокращённые Представления |
| 🔗 **Многошаговый Вывод** | Обход каузального графа ACT-R с Активацией Распространения |
| 🏭 **Dark Factory** | Состязательные автономные конвейеры с оценкой безопасного закрытия |
| 🐝 **Hivemind** | Координация мульти-агентов с изолированной памятью по ролям |
| 🕰️ **Путешествие во Времени** | Снимки версий с откатом `memory_checkout` |
| 🔮 **Панель Mind Palace** | UI Glassmorphism на `localhost:3000` |
| 🧬 **Сжатие 10x** | TurboQuant — 3 072 до 400 байт на embedding |
| 🔭 **Web Scholar** | Конвейер исследования в фоне (Brave + Firecrawl + LLM) |
| 🛡️ **Безопасность Уровня HIPAA** | 22 состязательных находки закрыты, строгий локальный режим |
| 🖼️ **Визуальная Память** | Хранилище снимков с подписями VLM |
| 📥 **Универсальный Импорт** | Загрузка историй Claude Code, Gemini, OpenAI |
| 🚦 **Маршрутизатор Задач** | Эвристика с 6 сигналами для делегирования host vs. local |
| 💳 **Единый Биллинг** | Prism + Synalux в единой архитектуре биллинга с бесплатным пробным периодом 14 дней |
| 🏗️ **Устойчивость Инфраструктуры** | Авто-восстановление, восстановление базы данных и мониторинг здоровья |
| 🔬 **Auto-Scholar** | Интеллект глубокого исследования с PubMed/ERIC |

---

## Быстрый Старт

```bash
npx -y prism-mcp-server
```

> Работает с **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — любой MCP клиент.

---

📌 **[← Вернуться к полной английской версии (README.md)](../../README.md)**
