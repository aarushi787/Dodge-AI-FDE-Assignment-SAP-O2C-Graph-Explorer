# AI Session Log — Dodge AI FDE Assignment
**Tool:** Claude (claude.ai)

---

## Workflow
Describe requirement → Claude generates code → run it → find what breaks → fix with context → repeat. Every major component went through 2–4 iterations.

---

## Key Decisions I Made

**Architecture:** SQLite WASM over Neo4j/Postgres — 944KB DB loads entirely in-browser, zero backend, deploys to any static host.

**LLM prompt design:** Layered system prompt — role, guardrails (`isOffTopic:true` for non-O2C), full schema with FK annotations, explicit O2C join chain, raw JSON response contract `{sql, explanation, isOffTopic}`. Raw JSON so SQL can be parsed deterministically and run directly against WASM SQLite.

**Anomaly checks I designed** (5 checks, Claude wrote the SQL):
- Delivered not billed → revenue leakage
- Billed not posted to AR → accounting gap
- Open AR no payment → cash flow risk
- Cancelled docs → 49% cancellation rate in this dataset is a red flag worth surfacing
- Orders without delivery → stalled/blocked

---

## Bugs I Caught & Fixed

| Bug | Root Cause | Fix |
|---|---|---|
| API key modal blocked UI | App called `/api/chat` but ran as static files | Direct Anthropic API call with browser access header |
| Search wiped query highlights | Single `highlighted` Set overwritten | Two independent Sets merged at canvas render |
| Payment→JE join wrong | `payments.accountingDocument` ≠ JE doc number | Changed to `payments.clearingAccountingDocument` |
| Graph silently incomplete | LIMIT 50 on 100 SOs, LIMIT 60 on 163 billing docs | Removed all LIMITs, node count ~200→~500+ |

---

## What I Did vs Claude

| Task | Me | Claude |
|---|---|---|
| FK mapping & O2C chain | Directed | Executed |
| Architecture choice | Decided | Implemented |
| System prompt design | Designed | Wrote final text |
| Anomaly check logic | Designed | Wrote SQL |
| Bug identification | Found all 4 | Fixed on instruction |
