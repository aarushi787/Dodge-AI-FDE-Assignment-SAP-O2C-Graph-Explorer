# ⚡ Dodge AI — SAP Order-to-Cash Graph Explorer

A **context graph system with an LLM-powered query interface** built for the Dodge AI Forward Deployed Engineer take-home assignment.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser (React)                       │
│                                                              │
│  ┌──────────────────────┐   ┌──────────────────────────────┐ │
│  │  ForceGraph2D        │   │  Chat Interface              │ │
│  │  (Canvas, 200+ nodes)│   │  NL query → SQL → Table      │ │
│  │                      │   │  Node highlighting           │ │
│  │  SO → DEL → BD → JE  │   │  Conversation memory         │ │
│  │  Customer, Product,  │   │  Off-topic guardrails        │ │
│  │  Plant               │   └──────────┬───────────────────┘ │
│  └──────────────────────┘              │                    │
│                                        ▼                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  sql.js (SQLite WASM)  ·  sap_o2c.db  ·  ~21k rows │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────────┬───────────────────────────────┘
                               │  POST /api/chat
                      ┌────────▼────────┐
                      │  Express server  │
                      │  API key proxy   │
                      └────────┬─────────┘
                               │  x-api-key
                      ┌────────▼─────────┐
                      │  Anthropic API   │
                      │  claude-sonnet-4 │
                      └──────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Database** | SQLite via sql.js WASM | Entire DB runs in-browser — zero server-side state, no Postgres needed for a demo |
| **Graph library** | react-force-graph-2d | Force-directed layout naturally clusters related entities; canvas-based for smooth performance |
| **LLM** | Claude Sonnet 4 | Best-in-class SQL generation; system prompt enforces strict JSON response envelope |
| **Proxy** | Express `/api/chat` | API key never ships in the frontend bundle |
| **Data format** | JSONL → SQLite | Preserves all fields, supports ad-hoc SQL — far more flexible than a fixed graph schema |

---

## Graph Model

### Nodes

| Type | Source | Prefix | Color |
|---|---|---|---|
| Customer | `business_partners` | `C_` | Purple |
| Sales Order | `sales_order_headers` | `SO_` | Indigo |
| Delivery | `outbound_delivery_headers` | `DEL_` | Green |
| Billing Doc | `billing_document_headers` | `BD_` | Amber |
| Journal Entry | `journal_entries` | `JE_` | Pink |
| Payment | `payments` | `PAY_` | Teal |
| Product | `products` + `product_descriptions` | `PRD_` | Red |
| Plant | `plants` | `PLT_` | Orange |

### Edges (O2C chain)

```
Customer ──placed──► Sales Order ──delivered via──► Delivery ──billed via──► Billing Doc
                         │                                                         │
                     includes                                                  posted to
                         │                                                         │
                       Product                                               Journal Entry
                         │                                                         │
                     ships from                                               cleared by
                         │                                                         │
                       Plant                                                   Payment
```

---

## LLM Prompting Strategy

The system prompt is structured in layers:

1. **Role + guardrails** — Strictly restricts the model to O2C dataset questions only
2. **Full schema** — Every table, every key column, with FK relationships annotated
3. **O2C chain** — Explicit ASCII join-path from Customer → Payment
4. **Response contract** — Enforces raw JSON: `{"sql":"...","explanation":"...","isOffTopic":false}`

**Why raw JSON?** Deterministic parsing — the SQL is extracted and run directly against WASM SQLite. No regex on markdown prose.

**Conversation memory** — Last 10 turns are included in each request, enabling follow-up queries.

**Node highlighting** — After SQL execution, result values are matched against graph node IDs and highlighted for 10 seconds.

---

## Guardrails

Off-topic questions return `isOffTopic: true` and display a styled rejection:

```
"This system is designed to answer questions related to the SAP Order-to-Cash dataset only."
```

Tested rejections: general knowledge, coding help, creative writing, math problems.

---

## Example Queries

```
Which products appear in the most billing documents?
→ JOIN billing_document_items → product_descriptions, GROUP BY, ORDER BY COUNT DESC

Trace the full flow for billing document 90504248
→ Walks SO → DEL → BD → JE → PAY via chained SELECTs

Sales orders delivered but not billed
→ LEFT JOIN outbound_delivery_items → billing_document_items WHERE billing IS NULL

All cancelled billing documents
→ billingDocumentIsCancelled = 'true' on billing_document_cancellations

Total payment per customer
→ JOIN payments → business_partners, SUM(amountInTransactionCurrency) GROUP BY customer

Broken O2C flows — billed but no journal entry
→ LEFT JOIN billing_document_headers → journal_entries WHERE accountingDocument IS NULL
```

---

## Running Locally

```bash
# Prerequisites: Node.js 18+, Anthropic API key (sk-ant-...)

git clone <repo-url>
cd dodge-ai-sap-o2c
npm install
npm run build
npm start
# Open http://localhost:3000
# Enter your Anthropic API key when prompted
```

Your API key is stored in `sessionStorage` only — never persisted or logged.

---

## Project Structure

```
dodge-ai-sap-o2c/
├── src/
│   ├── App.jsx          # React app — graph + chat + API key modal (728 lines)
│   └── main.jsx         # Entry point
├── public/
│   ├── sap_o2c.db       # SQLite DB (944 KB, 19 tables, ~21k rows)
│   ├── sql-wasm.js      # sql.js browser runtime
│   ├── sql-wasm.wasm    # SQLite → WebAssembly
│   └── schema.json      # Table/column inventory
├── dist/                # Production build
├── server.js            # Express proxy (API key forwarding)
├── process_data.py      # JSONL → SQLite ingestion script
├── vite.config.js
└── package.json
```

---

## Bonus Features

- Natural language → SQL (full NL2SQL pipeline)
- Node highlighting — chat results light up related graph nodes
- Conversation memory (10-turn context window)
- Expandable SQL disclosure per response
- Paginated results table inline
- Off-topic guardrails with styled rejection
- Mobile-responsive tab layout
- Node inspector — click any node for full metadata

---

## Dataset

| Table | Rows |
|---|---|
| product_storage_locations | 16,723 |
| product_plants | 3,036 |
| billing_document_items | 245 |
| sales_order_items | 167 |
| billing_document_headers | 163 |
| outbound_delivery_items | 137 |
| journal_entries | 123 |
| payments | 120 |
| sales_order_headers | 100 |
| outbound_delivery_headers | 86 |
| billing_document_cancellations | 80 |
| products | 69 |
| plants | 44 |
| business_partners | 8 |
