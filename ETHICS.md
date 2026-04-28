# Prism IDE — Ethics & Export Control Policy

> **Effective Date:** April 27, 2026  
> **Policy Version:** 2.0.0  
> **Enforcement:** Automated + Human Review

---

## Acceptable Use

Prism IDE is designed for **civilian software development, creative production, and education**. We welcome developers, studios, educators, and enterprises building apps, games, websites, tools, and creative content.

## Prohibited Use

The following uses are **absolutely prohibited** regardless of subscription tier, geography, or organizational type. No exception, no override.

| # | Category | Description |
|---|----------|-------------|
| 1 | **Weapons Development** | Design, manufacture, testing, or guidance of any weapons system |
| 2 | **Military Operations** | Command & control, targeting, kill chains, battlefield management |
| 3 | **Mass Surveillance** | Surveillance of civilian populations without lawful individual consent |
| 4 | **Autonomous Lethal Systems** | LAWS — any system that selects and engages targets without human control |
| 5 | **Nuclear / Biological / Chemical** | Development of NBC weapons or delivery systems |
| 6 | **Offensive Cyber Operations** | Cyberweapons, exploit development, offensive hacking tools |
| 7 | **Disinformation** | State-sponsored disinformation, deepfake political content, election manipulation |
| 8 | **Human Rights Abuse** | Tools enabling oppression, torture, unlawful detention, or forced labor |
| 9 | **Child Exploitation** | Any CSAM-related use |
| 10 | **Sanctions Evasion** | Using Prism to circumvent international sanctions or export controls |

> [!CAUTION]
> Violation of any prohibited use category results in **immediate, permanent account termination** with no refund. Data may be preserved under legal hold for law enforcement.

---

## Embargoed Countries

Accounts cannot be created from, billed to, or operated from the following countries under comprehensive US/EU sanctions:

| Code | Country | Basis |
|------|---------|-------|
| 🇷🇺 RU | Russia | US/EU comprehensive sanctions |
| 🇧🇾 BY | Belarus | Sanctions facilitation |
| 🇨🇺 CU | Cuba | US comprehensive sanctions |
| 🇮🇷 IR | Iran | US/EU comprehensive sanctions |
| 🇰🇵 KP | North Korea (DPRK) | UN/US/EU comprehensive sanctions |
| 🇸🇾 SY | Syria | US/EU comprehensive sanctions |

### Restricted Countries (Enhanced Due Diligence)

The following countries require enhanced verification. Military end-use is blocked.

`CN` · `VE` · `MM` · `SD` · `SS` · `LY` · `SO` · `YE` · `ZW` · `CD` · `CF` · `IQ` · `LB`

---

## How Enforcement Works — 6 Layers

Prism enforces these policies **technically, not just contractually**. Policy violations are caught by automated systems at multiple layers:

### Layer 1: Registration Gate
- **KYC/Sanctions screening** against 8+ international sanctions lists (OFAC SDN, EU Consolidated, UN, UK OFSI, BIS Entity/Denied/Unverified)
- Sanctions lists refresh **every 6 hours**
- Organization names screened against entity lists with fuzzy matching
- Individual users screened against SDN list

### Layer 2: Geofence Gate
- **IP geolocation** verified against MaxMind database
- **GPS/location API** check (mobile/browser)
- **Billing address** country verification
- **VPN/Tor exit node detection** — known anonymizing proxies are flagged
- **Triangulation**: at least **2 of 3 signals** (IP + billing + GPS) must agree
- Mismatches are flagged for human review

### Layer 3: Use-Case Classification Gate
- **AI classifier** analyzes project descriptions at creation time
- **Code pattern scanning** for prohibited keywords and patterns
- **Dependency scanning** for military/surveillance libraries
- Projects above 50% confidence are sent to **human review queue**
- Projects above 85% confidence are **auto-rejected**

### Layer 4: Runtime Monitoring (Continuous)
- API call pattern analysis for anomalous behavior
- Usage spike detection (>10× above baseline)
- Geographic anomaly detection (access from unexpected countries)
- Temporal anomaly detection (access outside normal hours)
- Data exfiltration pattern monitoring

### Layer 5: Kill Switch
When a violation is confirmed, Trust & Safety can execute an instant, multi-scope termination:
- Revoke all API keys
- Terminate all running VMs
- Block authentication
- Delist all marketplace components
- Freeze payouts
- Propagate to all team member accounts
- Blacklist associated email domains

### Layer 6: Tamper-Proof Audit Trail
- Every enforcement decision is logged with **hash-chain integrity** (each entry contains SHA-256 of the previous entry)
- **Append-only storage** — entries cannot be modified or deleted
- **Infinite retention** — logs are preserved permanently for compliance investigations
- High-severity events (sanctions failures, kill switches) trigger **real-time alerts** via webhook

---

## Enforcement is NOT Tier-Gated

> [!IMPORTANT]
> Unlike other Prism features, ethics enforcement applies **equally to all subscription tiers** — Free, Standard, Advanced, and Enterprise. No tier can purchase exemption from prohibited use restrictions.

The only tier difference is **compliance visibility**:

| Capability | Free | Standard | Advanced | Enterprise |
|-----------|------|----------|----------|------------|
| Enforcement Active | ✅ Always | ✅ Always | ✅ Always | ✅ Always |
| View Own Audit Logs | ❌ | ✅ | ✅ | ✅ |
| Compliance Reports | ❌ | ❌ | ✅ | ✅ |
| Dedicated Trust Contact | ❌ | ❌ | ❌ | ✅ |
| Custom Geofence Rules | ❌ | ❌ | ❌ | ✅ |
| Pre-Clearance | ❌ | ❌ | ✅ | ✅ |

---

## Reporting Violations

If you believe Prism is being used in violation of this policy, report to:

- **Email:** trust-safety@synalux.com
- **In-App:** Settings → Report Abuse
- **Legal:** legal@synalux.com

All reports are investigated within 48 hours.

---

## Legal Compliance

This policy is designed to comply with:
- **US Export Administration Regulations (EAR)**
- **US International Traffic in Arms Regulations (ITAR)**
- **EU Dual-Use Regulation (EC 428/2009)**
- **UN Security Council Sanctions**
- **UK Export Control Act 2002**
- **EU AI Act — Prohibited AI Practices (Article 5)**

---

*Last updated: April 27, 2026 · Policy v2.0.0*
