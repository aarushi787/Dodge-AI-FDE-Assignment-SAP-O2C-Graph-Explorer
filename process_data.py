import json
import sqlite3
import os
import glob

DATA_DIR = "/home/claude/dataset/sap-o2c-data"
DB_PATH = "/home/claude/dodge-ai-app/public/sap_o2c.db"

def read_jsonl(folder):
    rows = []
    for f in glob.glob(f"{DATA_DIR}/{folder}/*.jsonl"):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows

def flatten(row):
    """Flatten nested dicts like creationTime"""
    result = {}
    for k, v in row.items():
        if isinstance(v, dict):
            for sk, sv in v.items():
                result[f"{k}_{sk}"] = sv
        else:
            result[k] = v
    return result

def create_table(conn, table_name, rows):
    if not rows:
        print(f"  [SKIP] {table_name} - no rows")
        return
    flat_rows = [flatten(r) for r in rows]
    # Get all keys
    all_keys = set()
    for r in flat_rows:
        all_keys.update(r.keys())
    all_keys = sorted(all_keys)
    # Drop and recreate
    conn.execute(f"DROP TABLE IF EXISTS {table_name}")
    cols = ", ".join(f'"{k}" TEXT' for k in all_keys)
    conn.execute(f"CREATE TABLE {table_name} ({cols})")
    for r in flat_rows:
        vals = [str(r.get(k, "")) if r.get(k) is not None else None for k in all_keys]
        placeholders = ", ".join("?" for _ in all_keys)
        conn.execute(f'INSERT INTO {table_name} VALUES ({placeholders})', vals)
    conn.commit()
    print(f"  [OK] {table_name}: {len(flat_rows)} rows, cols: {list(all_keys)[:8]}...")

conn = sqlite3.connect(DB_PATH)

tables = {
    "sales_order_headers": "sales_order_headers",
    "sales_order_items": "sales_order_items",
    "sales_order_schedule_lines": "sales_order_schedule_lines",
    "outbound_delivery_headers": "outbound_delivery_headers",
    "outbound_delivery_items": "outbound_delivery_items",
    "billing_document_headers": "billing_document_headers",
    "billing_document_items": "billing_document_items",
    "billing_document_cancellations": "billing_document_cancellations",
    "journal_entry_items_accounts_receivable": "journal_entries",
    "payments_accounts_receivable": "payments",
    "business_partners": "business_partners",
    "business_partner_addresses": "business_partner_addresses",
    "customer_company_assignments": "customer_company_assignments",
    "customer_sales_area_assignments": "customer_sales_area_assignments",
    "products": "products",
    "product_descriptions": "product_descriptions",
    "plants": "plants",
    "product_plants": "product_plants",
    "product_storage_locations": "product_storage_locations",
}

for folder, table in tables.items():
    rows = read_jsonl(folder)
    create_table(conn, table, rows)

# Create a schema summary for the LLM
schema_info = {}
for table in tables.values():
    try:
        cur = conn.execute(f"PRAGMA table_info({table})")
        cols = [row[1] for row in cur.fetchall()]
        cur2 = conn.execute(f"SELECT COUNT(*) FROM {table}")
        count = cur2.fetchone()[0]
        schema_info[table] = {"columns": cols, "row_count": count}
    except:
        pass

with open("/home/claude/dodge-ai-app/public/schema.json", "w") as f:
    json.dump(schema_info, f, indent=2)

print("\nSchema summary saved to schema.json")
print("\nAll done!")
conn.close()
