# 🧠 Prism MCP — Palats Rozumu dlia AI Ahentiv

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://github.com/modelcontextprotocol/servers)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers?query=prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: BSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../CONTRIBUTING.md)

🌐 **Мова:** [English](../../README.md) · [Español](README_es.md) · [Français](README_fr.md) · [Português](README_pt.md) · [Română](README_ro.md) · [Українська](README_uk.md) · [Русский](README_ru.md) · [Deutsch](README_de.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [中文](README_zh.md) · [العربية](README_ar.md)

> **Примітка:** Цей переклад може не відображати всі останні зміни з основного README.
> Для найповнішої та актуальної версії дивіться **[README англійською](../../README.md)**.

---

## Prism Coder IDE — Доставляй, а не просто кодуй

> **НОВЕ:** Повноцінний AI-нативний десктопний IDE, що поєднує кодування, збірку та розгортання в одному інструменті.

### Завантаження

| Платформа | Пакет | Розмір |
|----------|---------|------|
| **Windows** | [Prism Coder-1.0.0-Setup.exe](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-Setup.exe) | 99 MB |
| **macOS (Apple Silicon)** | [Prism Coder-1.0.0-arm64.dmg](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0-arm64.dmg) | 113 MB |
| **Linux** | [Prism Coder-1.0.0.AppImage](https://github.com/dcostenco/prism-coder/releases/download/v1.0.0/Prism.Coder-1.0.0.AppImage) | 119 MB |
| **npm (MCP Server)** | `npx -y prism-mcp-server` | — |

| Що ви отримуєте | Економія vs. Традиційний |
|---|:---:|
| 🤖 **Режим Агента** — автономне виконання багатокрокових завдань з попереднім переглядом змін | ~95% |
| 🏗️ **Конструктор Сайтів** — 6 шаблонів, редактор секцій, експорт в HTML/ZIP | ~90% |
| 🎨 **Візуальне Перетягування** — 11 типів компонентів, зона розміщення, живий редактор властивостей | ~85% |
| 🔑 **Auth та База Даних** — 6 провайдерів auth, CRUD таблиць, RLS, бакети зберігання | ~90% |
| 🐳 **DevContainers** — 8 базових образів, переадресація портів, ліміти ресурсів, експорт Codespaces | ~80% |
| 📋 **Панель Клієнтів (HIPAA)** — сканер PHI з 12 патернів, контролі модератора, життєвий цикл тікетів | ~70% |
| 🎨 **Медіа Студія** — генерація зображень/відео/3D з AI, якість за рівнями | ~98% |
| 🚀 **Розгортання Одним Кліком** — Vercel, Netlify, Synalux Cloud, власний сервер | ~98% |
| 👥 **Співпраця в Реальному Часі** — мультиплеєрне редагування з присутністю курсору | ~60% |
| 📊 **SEO + Аналітика** — аудит 8 категорій + панель трафіку | ~99% |
| 🏪 **Маркетплейс** — реєстр розширень 10 категорій, встановлення одним кліком | ~90% |
| 📋 **Двигун Робочих Процесів** — природна мова до структурованих робочих процесів | ~90% |
| 🔀 **Інтеграція Git** — branch, stage, commit, push не виходячи з IDE | ~60% |
| 🌐 **i18n на 12 Мовах** — повний переклад UI включаючи арабську RTL | ~100% |

**27/27 функцій** — більше ніж будь-який конкурент (Cursor: 9, Windsurf: 9, Replit: 12, Bolt: 9).

👉 **[Повний README IDE зі скріншотами, архітектурою та технічними деталями →](https://github.com/dcostenco/prism-coder/releases/tag/v1.0.0)**

---

![Prism Hivemind Multi-Agent Dashboard](../v11_hivemind_multi_agent_dashboard.jpg)

**Ваш AI агент забуває все між сесіями. Prism виправляє це — а потім навчає його думати.**

Prism v12.5 — це справжня **Когнітивна Архітектура**, натхненна механікою людського мозку. Крім плоского векторного пошуку, ваш агент тепер формує принципи з досвіду, слідує каузальним ланцюгам думки та має самосвідомість, щоб знати, коли йому бракує інформації. Весь когнітивний конвеєр працює **100% на пристрої**.

```bash
npx -y prism-mcp-server
```

Працює з **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — **будь-який MCP клієнт.**

---

## Чому Prism?

Щоразу, коли ви починаєте нову розмову з AI-помічником для кодування, він починає з нуля. Ви знову пояснюєте архітектуру, знову описуєте рішення, знову перераховуєте TODO. Години контексту — втрачені.

**Prism дає вашому агенту мозок, який зберігається — а потім навчає його мислити.**

---

## Основні Функції (v12.5)

| Функція | Опис |
|---|---|
| 🧠 **Когнітивна Пам'ять ($O(1)$)** | Отримання без пошуку через Голографічні Зменшені Представлення |
| 🔗 **Багатокроковий Висновок** | Обхід каузального графу ACT-R з Активацією Розповсюдження |
| 🏭 **Dark Factory** | Змагальні автономні конвеєри з оцінкою безпечного закриття |
| 🐝 **Hivemind** | Координація мульти-агентів з ізольованою пам'яттю за ролями |
| 🕰️ **Подорож у Часі** | Знімки версій з відкатом `memory_checkout` |
| 🔮 **Панель Mind Palace** | UI Glassmorphism на `localhost:3000` |
| 🧬 **Стиснення 10x** | TurboQuant — 3 072 до 400 байтів на embedding |
| 🔭 **Web Scholar** | Конвеєр дослідження у фоні (Brave + Firecrawl + LLM) |
| 🛡️ **Безпека Рівня HIPAA** | 22 змагальні знахідки закриті, суворий локальний режим |
| 🖼️ **Візуальна Пам'ять** | Сховище знімків з підписами VLM |
| 📥 **Універсальний Імпорт** | Завантаження історій Claude Code, Gemini, OpenAI |
| 🚦 **Маршрутизатор Завдань** | Евристика з 6 сигналів для делегування host vs. local |
| 💳 **Уніфікована Білінг** | Prism + Synalux в одній архітектурі білінгу з безкоштовним пробним періодом 14 днів |
| 🏗️ **Стійкість Інфраструктури** | Авто-відновлення, відновлення бази даних та моніторинг здоров'я |
| 🔬 **Auto-Scholar** | Інтелект глибокого дослідження з PubMed/ERIC |

---

## Швидкий Старт

```bash
npx -y prism-mcp-server
```

> Працює з **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — будь-який MCP клієнт.

---

📌 **[← Повернутися до повної англійської версії (README.md)](../../README.md)**
