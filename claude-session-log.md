# AI Session Log — Dodge AI FDE Assignment
Tool: Claude (claude.ai)

---

## How I worked

I used Claude throughout — describe what I want, review the output, run it, see what breaks, go again. Most things took 2-3 rounds before they actually worked properly.

---

## Decisions I made

Went with SQLite WASM instead of Neo4j or Postgres. The DB is only 944KB so it loads entirely in the browser — no backend needed, works on any static host. Made the demo much simpler to deploy.

For the LLM prompting I designed the system prompt myself in layers: role definition, strict guardrails (reject anything not O2C related), full schema with FK relationships written out, and a raw JSON response contract. Raw JSON because I wanted to parse the SQL deterministically and run it directly — no regex on prose.

The 5 anomaly checks were my idea based on understanding the O2C domain. Delivered not billed, billed with no journal entry, open AR, cancelled docs (49% cancellation rate in this dataset stood out), orders stuck without delivery. Claude wrote the SQL once I told it what to look for.

---

## Bugs I found

Payment→JE join was wrong. I was linking on payments.accountingDocument which is the payment's own doc number — not the journal entry it clears. Fixed it to use clearingAccountingDocument instead.

Graph was silently showing incomplete data. Had LIMIT 50 on 100 sales orders, LIMIT 60 on 163 billing docs. Nothing errored, just dropped data. Caught it during review, removed all the limits.

Search highlights were wiping out query highlights because both used the same Set. Fixed by keeping two separate Sets and merging them at render time.

API key modal was blocking the whole UI because the app was calling /api/chat (an Express proxy) but running as static files. Switched to direct Anthropic API calls.
