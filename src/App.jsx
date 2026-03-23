import { useState, useEffect, useRef, useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────────────────────
const NODE_STYLE = {
  Customer:        { fill:"#1D4ED8", stroke:"#1E40AF", size:12, ring:false },
  SalesOrder:      { fill:"#4A90D9", stroke:"#2563EB", size:9,  ring:false },
  Delivery:        { fill:"#fff",    stroke:"#34d399", size:6,  ring:true  },
  BillingDocument: { fill:"#fff",    stroke:"#f59e0b", size:6,  ring:true  },
  JournalEntry:    { fill:"#a78bfa", stroke:"#7c3aed", size:7,  ring:false },
  Payment:         { fill:"#fff",    stroke:"#fb923c", size:6,  ring:true  },
  Product:         { fill:"#fff",    stroke:"#f87171", size:5,  ring:true  },
  Plant:           { fill:"#BFDBFE", stroke:"#60A5FA", size:7,  ring:false },
};
const ENTITY_LABELS = {
  Customer:"Customer", SalesOrder:"Sales Order", Delivery:"Delivery",
  BillingDocument:"Billing Doc", JournalEntry:"Journal Entry",
  Payment:"Payment", Product:"Product", Plant:"Plant",
};

// Anomaly severity colours
const SEV = {
  critical: { bg:"#fff1f2", border:"#fecdd3", badge:"#fee2e2", text:"#be123c", dot:"#ef4444", icon:"🔴" },
  warning:  { bg:"#fffbeb", border:"#fde68a", badge:"#fef9c3", text:"#92400e", dot:"#f59e0b", icon:"🟡" },
  info:     { bg:"#f0f9ff", border:"#bae6fd", badge:"#e0f2fe", text:"#075985", dot:"#38bdf8", icon:"🔵" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Canned SQL queries
// ─────────────────────────────────────────────────────────────────────────────
const CANNED = [
  { label:"Top products by billing docs", sql:`SELECT pd.productDescription as product, COUNT(*) as billing_docs
FROM billing_document_items bi
LEFT JOIN product_descriptions pd ON bi.material=pd.product AND pd.language='EN'
GROUP BY bi.material ORDER BY billing_docs DESC LIMIT 10` },
  { label:"Delivered but not billed", sql:`SELECT di.referenceSdDocument as salesOrder, di.deliveryDocument
FROM outbound_delivery_items di
LEFT JOIN billing_document_items bi ON bi.referenceSdDocument=di.deliveryDocument
WHERE bi.billingDocument IS NULL
GROUP BY di.deliveryDocument LIMIT 20` },
  { label:"Trace billing doc 90504248", sql:`SELECT soh.salesOrder, soh.soldToParty,
  soh.totalNetAmount as orderAmount, di.deliveryDocument,
  bdh.billingDocument, bdh.totalNetAmount as invoiceAmount,
  je.accountingDocument as journalEntry,
  p.accountingDocument as payment, p.clearingDate
FROM billing_document_headers bdh
LEFT JOIN billing_document_items bdi ON bdi.billingDocument=bdh.billingDocument
LEFT JOIN outbound_delivery_items di ON di.deliveryDocument=bdi.referenceSdDocument
LEFT JOIN sales_order_headers soh ON soh.salesOrder=di.referenceSdDocument
LEFT JOIN journal_entries je ON je.referenceDocument=bdh.billingDocument
LEFT JOIN payments p ON p.accountingDocument=je.accountingDocument
WHERE bdh.billingDocument='90504248' LIMIT 5` },
  { label:"Cancelled billing docs", sql:`SELECT billingDocument, soldToParty,
  CAST(totalNetAmount AS REAL) as amount, transactionCurrency, creationDate
FROM billing_document_cancellations
ORDER BY CAST(totalNetAmount AS REAL) DESC LIMIT 20` },
  { label:"Billed without journal entry", sql:`SELECT bdh.billingDocument, bdh.soldToParty,
  bdh.totalNetAmount, bdh.creationDate
FROM billing_document_headers bdh
LEFT JOIN journal_entries je ON je.referenceDocument=bdh.billingDocument
WHERE je.accountingDocument IS NULL AND bdh.billingDocumentIsCancelled='false' LIMIT 20` },
  { label:"Payment totals by customer", sql:`SELECT bp.businessPartnerName as customer,
  COUNT(*) as payments,
  ROUND(SUM(CAST(p.amountInTransactionCurrency AS REAL)),2) as totalPaid
FROM payments p
LEFT JOIN business_partners bp ON bp.businessPartner=p.customer
GROUP BY p.customer ORDER BY totalPaid DESC` },
  { label:"Plants by delivery volume", sql:`SELECT pl.plantName, di.plant, COUNT(*) as deliveries
FROM outbound_delivery_items di
LEFT JOIN plants pl ON pl.plant=di.plant
GROUP BY di.plant ORDER BY deliveries DESC LIMIT 15` },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert SAP Order-to-Cash (O2C) data analyst in the Dodge AI platform.
RULES: 1) Only answer SAP O2C dataset questions — reject anything else with isOffTopic:true. 2) Always generate valid SQLite SQL. Booleans='true'/'false'. Use CAST(x AS REAL) for amounts. 3) Never invent data.
SCHEMA:
sales_order_headers: salesOrder(PK),soldToParty→business_partners,totalNetAmount,overallDeliveryStatus(C/A/B),creationDate,salesOrderType
sales_order_items: salesOrder,salesOrderItem,material→products,netAmount,requestedQuantity,productionPlant→plants
outbound_delivery_headers: deliveryDocument(PK),overallGoodsMovementStatus(C/A),overallPickingStatus(C),shippingPoint
outbound_delivery_items: deliveryDocument,referenceSdDocument→salesOrder,plant,actualDeliveryQuantity
billing_document_headers: billingDocument(PK),soldToParty,totalNetAmount,billingDocumentIsCancelled,accountingDocument,billingDocumentType(F2/S1),creationDate
billing_document_items: billingDocument,material,netAmount,referenceSdDocument→deliveryDocument,billingQuantity
billing_document_cancellations: billingDocument(PK),soldToParty,totalNetAmount,cancelledBillingDocument
journal_entries: accountingDocument(PK),referenceDocument→billingDocument,customer,amountInTransactionCurrency,clearingDate,postingDate
payments: accountingDocument→journal_entries,customer,amountInTransactionCurrency,clearingDate
business_partners: businessPartner(PK),businessPartnerName
products: product(PK),productType,productGroup
product_descriptions: product,productDescription,language
plants: plant(PK),plantName
O2C CHAIN: business_partners→sales_order_headers→sales_order_items→outbound_delivery_items→outbound_delivery_headers→billing_document_items→billing_document_headers→journal_entries→payments
RESPOND RAW JSON ONLY: {"sql":"...","explanation":"...","isOffTopic":false}
Off-topic: {"sql":null,"explanation":"This system only answers questions about the SAP O2C dataset.","isOffTopic":true}`;

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────
function queryDb(db, sql) {
  try {
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomaly detection — runs once on DB load
// ─────────────────────────────────────────────────────────────────────────────
function detectAnomalies(db) {
  const anomalies = [];

  // 1. Delivered but not billed
  const { rows: dnb } = queryDb(db, `
    SELECT COUNT(DISTINCT di.deliveryDocument) as cnt
    FROM outbound_delivery_items di
    LEFT JOIN billing_document_items bi ON bi.referenceSdDocument=di.deliveryDocument
    WHERE bi.billingDocument IS NULL`);
  if (dnb[0]?.cnt > 0) anomalies.push({
    id:"dnb", severity:"critical",
    title:"Deliveries Not Billed",
    count: dnb[0].cnt,
    description:`${dnb[0].cnt} delivery documents have no matching billing document. Revenue at risk.`,
    sql:`SELECT di.referenceSdDocument as salesOrder, di.deliveryDocument, di.plant
FROM outbound_delivery_items di
LEFT JOIN billing_document_items bi ON bi.referenceSdDocument=di.deliveryDocument
WHERE bi.billingDocument IS NULL
GROUP BY di.deliveryDocument LIMIT 25`,
    nodePrefix:["DEL_","SO_"],
  });

  // 2. Billed without journal entry
  const { rows: bnj } = queryDb(db, `
    SELECT COUNT(*) as cnt FROM billing_document_headers bdh
    LEFT JOIN journal_entries je ON je.referenceDocument=bdh.billingDocument
    WHERE je.accountingDocument IS NULL AND bdh.billingDocumentIsCancelled='false'`);
  if (bnj[0]?.cnt > 0) anomalies.push({
    id:"bnj", severity:"critical",
    title:"Billed, Not Posted to AR",
    count: bnj[0].cnt,
    description:`${bnj[0].cnt} billing documents have no journal entry. Accounting records may be incomplete.`,
    sql:`SELECT bdh.billingDocument, bdh.soldToParty, bdh.totalNetAmount, bdh.creationDate
FROM billing_document_headers bdh
LEFT JOIN journal_entries je ON je.referenceDocument=bdh.billingDocument
WHERE je.accountingDocument IS NULL AND bdh.billingDocumentIsCancelled='false' LIMIT 25`,
    nodePrefix:["BD_"],
  });

  // 3. Journal entries without payment (open AR)
  const { rows: openAR } = queryDb(db, `
    SELECT COUNT(*) as cnt FROM journal_entries je
    LEFT JOIN payments p ON p.accountingDocument=je.accountingDocument
    WHERE p.accountingDocument IS NULL AND je.clearingDate IS NULL OR je.clearingDate=''`);
  if (openAR[0]?.cnt > 0) anomalies.push({
    id:"openar", severity:"warning",
    title:"Open AR — Awaiting Payment",
    count: openAR[0].cnt,
    description:`${openAR[0].cnt} journal entries have no matching payment. Unpaid receivables outstanding.`,
    sql:`SELECT je.accountingDocument, je.referenceDocument as billingDoc,
  je.customer, je.amountInTransactionCurrency, je.postingDate
FROM journal_entries je
LEFT JOIN payments p ON p.accountingDocument=je.accountingDocument
WHERE p.accountingDocument IS NULL LIMIT 25`,
    nodePrefix:["JE_"],
  });

  // 4. Cancelled billing docs
  const { rows: canc } = queryDb(db, `SELECT COUNT(*) as cnt FROM billing_document_cancellations`);
  if (canc[0]?.cnt > 0) {
    const { rows: cancAmt } = queryDb(db, `
      SELECT ROUND(SUM(CAST(totalNetAmount AS REAL)),2) as total FROM billing_document_cancellations`);
    anomalies.push({
      id:"canc", severity:"warning",
      title:"Cancelled Billing Documents",
      count: canc[0].cnt,
      description:`${canc[0].cnt} billing docs cancelled. Total reversed: ₹${(cancAmt[0]?.total||0).toLocaleString()}.`,
      sql:`SELECT billingDocument, soldToParty, CAST(totalNetAmount AS REAL) as amount,
  transactionCurrency, creationDate
FROM billing_document_cancellations ORDER BY CAST(totalNetAmount AS REAL) DESC LIMIT 25`,
      nodePrefix:["BD_"],
    });
  }

  // 5. Orders with no delivery (stalled orders)
  const { rows: nodel } = queryDb(db, `
    SELECT COUNT(*) as cnt FROM sales_order_headers soh
    LEFT JOIN outbound_delivery_items di ON di.referenceSdDocument=soh.salesOrder
    WHERE di.deliveryDocument IS NULL`);
  if (nodel[0]?.cnt > 0) anomalies.push({
    id:"nodel", severity:"info",
    title:"Orders Without Delivery",
    count: nodel[0].cnt,
    description:`${nodel[0].cnt} sales orders have no associated delivery. May be pending or blocked.`,
    sql:`SELECT soh.salesOrder, soh.soldToParty, soh.totalNetAmount,
  soh.overallDeliveryStatus, soh.creationDate
FROM sales_order_headers soh
LEFT JOIN outbound_delivery_items di ON di.referenceSdDocument=soh.salesOrder
WHERE di.deliveryDocument IS NULL LIMIT 25`,
    nodePrefix:["SO_"],
  });

  return anomalies;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow trace — full O2C chain for one billing document
// ─────────────────────────────────────────────────────────────────────────────
function traceBillingDoc(db, billingDoc) {
  const { rows } = queryDb(db, `
    SELECT
      soh.salesOrder, soh.soldToParty, soh.totalNetAmount as orderAmount,
      soh.creationDate as orderDate, soh.overallDeliveryStatus,
      bp.businessPartnerName as customerName,
      di.deliveryDocument, dh.overallGoodsMovementStatus, dh.overallPickingStatus,
      bdh.billingDocument, bdh.totalNetAmount as billingAmount,
      bdh.billingDocumentDate, bdh.billingDocumentIsCancelled,
      je.accountingDocument as journalEntry, je.amountInTransactionCurrency as jeAmount,
      je.postingDate,
      p.accountingDocument as payment, p.amountInTransactionCurrency as paymentAmount,
      p.clearingDate
    FROM billing_document_headers bdh
    LEFT JOIN billing_document_items bdi ON bdi.billingDocument=bdh.billingDocument
    LEFT JOIN outbound_delivery_items di ON di.deliveryDocument=bdi.referenceSdDocument
    LEFT JOIN outbound_delivery_headers dh ON dh.deliveryDocument=di.deliveryDocument
    LEFT JOIN sales_order_headers soh ON soh.salesOrder=di.referenceSdDocument
    LEFT JOIN business_partners bp ON bp.businessPartner=soh.soldToParty
    LEFT JOIN journal_entries je ON je.referenceDocument=bdh.billingDocument
    LEFT JOIN payments p ON p.accountingDocument=je.accountingDocument
    WHERE bdh.billingDocument='${billingDoc}'
    LIMIT 1`);
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build graph
// ─────────────────────────────────────────────────────────────────────────────
function buildGraph(db) {
  const nodes = [], links = [], set = new Set();
  const add  = (id,type,label,meta={},broken=false) => { if(!set.has(id)){set.add(id);nodes.push({id,type,label,meta,broken});} };
  const link = (s,t,rel) => { if(set.has(s)&&set.has(t)) links.push({source:s,target:t,rel}); };

  queryDb(db,"SELECT businessPartner,businessPartnerName FROM business_partners LIMIT 20")
    .rows.forEach(c=>add(`C_${c.businessPartner}`,"Customer",c.businessPartnerName?.slice(0,22)||c.businessPartner,c));
  queryDb(db,"SELECT * FROM sales_order_headers LIMIT 50")
    .rows.forEach(o=>{add(`SO_${o.salesOrder}`,"SalesOrder",`SO ${o.salesOrder}`,o);if(set.has(`C_${o.soldToParty}`))link(`C_${o.soldToParty}`,`SO_${o.salesOrder}`,"placed");});
  const d2s={};
  queryDb(db,"SELECT DISTINCT deliveryDocument,referenceSdDocument FROM outbound_delivery_items LIMIT 120")
    .rows.forEach(d=>{d2s[d.deliveryDocument]=d.referenceSdDocument;});
  queryDb(db,"SELECT * FROM outbound_delivery_headers LIMIT 86")
    .rows.forEach(d=>{add(`DEL_${d.deliveryDocument}`,"Delivery",`DEL ${d.deliveryDocument}`,d);const so=d2s[d.deliveryDocument];if(so&&set.has(`SO_${so}`))link(`SO_${so}`,`DEL_${d.deliveryDocument}`,"delivery");});
  queryDb(db,"SELECT * FROM billing_document_headers WHERE billingDocumentIsCancelled='false' LIMIT 60")
    .rows.forEach(b=>add(`BD_${b.billingDocument}`,"BillingDocument",`INV ${b.billingDocument}`,b));
  queryDb(db,"SELECT DISTINCT billingDocument,referenceSdDocument FROM billing_document_items LIMIT 150")
    .rows.forEach(bi=>{if(set.has(`BD_${bi.billingDocument}`)&&set.has(`DEL_${bi.referenceSdDocument}`))link(`DEL_${bi.referenceSdDocument}`,`BD_${bi.billingDocument}`,"billing");});
  queryDb(db,"SELECT DISTINCT accountingDocument,referenceDocument FROM journal_entries LIMIT 60")
    .rows.forEach(j=>{add(`JE_${j.accountingDocument}`,"JournalEntry",`JE ${j.accountingDocument}`,j);if(set.has(`BD_${j.referenceDocument}`))link(`BD_${j.referenceDocument}`,`JE_${j.accountingDocument}`,"journal");});
  queryDb(db,"SELECT DISTINCT accountingDocument FROM payments LIMIT 50")
    .rows.forEach(p=>{add(`PAY_${p.accountingDocument}`,"Payment",`PAY ${p.accountingDocument}`,p);if(set.has(`JE_${p.accountingDocument}`))link(`JE_${p.accountingDocument}`,`PAY_${p.accountingDocument}`,"payment");});
  queryDb(db,`SELECT p.product,pd.productDescription FROM products p LEFT JOIN product_descriptions pd ON p.product=pd.product AND pd.language='EN' LIMIT 20`)
    .rows.forEach(p=>add(`PRD_${p.product}`,"Product",(p.productDescription||p.product).slice(0,18),p));
  queryDb(db,"SELECT plant,plantName FROM plants LIMIT 15")
    .rows.forEach(pl=>add(`PLT_${pl.plant}`,"Plant",(pl.plantName||pl.plant).slice(0,16),pl));
  queryDb(db,"SELECT salesOrder,material,productionPlant FROM sales_order_items LIMIT 100")
    .rows.forEach(i=>{
      if(set.has(`SO_${i.salesOrder}`)&&set.has(`PRD_${i.material}`))link(`SO_${i.salesOrder}`,`PRD_${i.material}`,"includes");
      if(set.has(`SO_${i.salesOrder}`)&&set.has(`PLT_${i.productionPlant}`))link(`SO_${i.salesOrder}`,`PLT_${i.productionPlant}`,"ships from");
    });
  return {nodes,links};
}

const pretty = k => k.replace(/([A-Z])/g," $1").replace(/^./,s=>s.toUpperCase()).trim();
const SKIP_KEYS = new Set(["__indexColor","__controlPoints","index","vx","vy","x","y","fx","fy","id","type","label","color","meta","broken"]);
const FIELD_GROUPS = {
  salesOrder:"Identifiers",billingDocument:"Identifiers",deliveryDocument:"Identifiers",
  accountingDocument:"Identifiers",businessPartner:"Identifiers",product:"Identifiers",plant:"Identifiers",
  totalNetAmount:"Financials",netAmount:"Financials",amountInTransactionCurrency:"Financials",
  amountInCompanyCodeCurrency:"Financials",transactionCurrency:"Financials",
  creationDate:"Dates",lastChangeDateTime:"Dates",billingDocumentDate:"Dates",
  postingDate:"Dates",clearingDate:"Dates",requestedDeliveryDate:"Dates",
  overallDeliveryStatus:"Status",overallGoodsMovementStatus:"Status",overallPickingStatus:"Status",
  billingDocumentIsCancelled:"Status",billingDocumentType:"Status",salesOrderType:"Status",
};

// ─────────────────────────────────────────────────────────────────────────────
// NodeInspectorPanel
// ─────────────────────────────────────────────────────────────────────────────
function NodeInspectorPanel({ node, onClose, onTrace }) {
  const s = NODE_STYLE[node.type]||{fill:"#93C5FD",stroke:"#60A5FA",ring:false};
  const dotColor = s.ring ? s.stroke : s.fill;
  const fields = Object.entries(node.meta||{})
    .filter(([k,v])=>!SKIP_KEYS.has(k)&&v!==null&&v!==undefined&&String(v)!==""&&String(v)!=="null");
  const groups={}, other=[];
  fields.forEach(([k,v])=>{ const g=FIELD_GROUPS[k]; g?(groups[g]=groups[g]||[]).push([k,v]):other.push([k,v]); });
  const isBilling = node.type==="BillingDocument";
  const billingId = node.meta?.billingDocument;
  return (
    <div style={{ position:"absolute",top:16,left:16,zIndex:20,width:300,maxHeight:"calc(100vh - 96px)",display:"flex",flexDirection:"column",background:"#fff",borderRadius:14,boxShadow:"0 8px 32px rgba(0,0,0,0.13)",border:"1px solid #e8edf3",fontFamily:"'DM Sans',sans-serif",overflow:"hidden" }}>
      <div style={{ padding:"14px 16px 12px",borderBottom:"1px solid #f1f5f9",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:9 }}>
          <span style={{ width:11,height:11,borderRadius:"50%",background:s.ring?"transparent":dotColor,border:`2px solid ${dotColor}`,display:"inline-block",flexShrink:0 }}/>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontWeight:700,fontSize:15,color:"#0f172a",lineHeight:1.2 }}>{ENTITY_LABELS[node.type]||node.type}</div>
            <div style={{ fontSize:11,color:"#94a3b8",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{node.label}</div>
          </div>
          <button onClick={onClose} style={{ width:26,height:26,border:"1px solid #e2e8f0",borderRadius:7,background:"#f8fafc",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:16,lineHeight:1,flexShrink:0 }}>×</button>
        </div>
        {/* Trace button for billing documents */}
        {isBilling && billingId && (
          <button onClick={()=>onTrace(billingId)}
            style={{ marginTop:10,width:"100%",padding:"7px 0",background:"#1D4ED8",border:"none",borderRadius:8,color:"#fff",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
            ⛓ Trace Full O2C Flow
          </button>
        )}
      </div>
      <div style={{ overflowY:"auto",padding:"10px 0 14px",flex:1 }}>
        {["Identifiers","Financials","Status","Dates"].map(g=>groups[g]&&(
          <div key={g} style={{ marginBottom:10 }}>
            <div style={{ padding:"4px 16px 5px",fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.8 }}>{g}</div>
            {groups[g].map(([k,v])=><FieldRow key={k} label={pretty(k)} value={String(v)}/>)}
          </div>
        ))}
        {other.length>0&&(
          <div>
            <div style={{ padding:"4px 16px 5px",fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.8 }}>Other</div>
            {other.map(([k,v])=><FieldRow key={k} label={pretty(k)} value={String(v)}/>)}
          </div>
        )}
        {fields.length===0&&<div style={{ padding:"12px 16px",fontSize:13,color:"#94a3b8" }}>No metadata available.</div>}
      </div>
    </div>
  );
}

function FieldRow({label,value}) {
  const isDate=/\d{4}-\d{2}-\d{2}T/.test(value);
  const display=isDate?value.slice(0,10):value.length>60?value.slice(0,60)+"…":value;
  return (
    <div style={{ display:"flex",gap:0,padding:"4px 16px",alignItems:"baseline" }}
      onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <span style={{ fontSize:12,color:"#94a3b8",minWidth:120,flexShrink:0,paddingRight:8 }}>{label}</span>
      <span style={{ fontSize:12,color:"#1e293b",wordBreak:"break-all",lineHeight:1.5 }}>{display}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowTracePanel — NEW: full O2C chain visualisation
// ─────────────────────────────────────────────────────────────────────────────
function FlowTracePanel({ db, billingId, onClose, onHighlight }) {
  const [trace, setTrace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState(billingId||"");

  const run = useCallback((id) => {
    if (!db||!id) return;
    setLoading(true);
    setTimeout(()=>{
      const t = traceBillingDoc(db, id.trim());
      setTrace(t);
      setLoading(false);
      if (t) {
        // Highlight all nodes in this flow
        const ids = new Set();
        if(t.salesOrder)   ids.add(`SO_${t.salesOrder}`);
        if(t.deliveryDocument) ids.add(`DEL_${t.deliveryDocument}`);
        if(t.billingDocument)  ids.add(`BD_${t.billingDocument}`);
        if(t.journalEntry) ids.add(`JE_${t.journalEntry}`);
        if(t.payment)      ids.add(`PAY_${t.payment}`);
        if(t.soldToParty)  ids.add(`C_${t.soldToParty}`);
        onHighlight(ids);
      }
    },50);
  },[db, onHighlight]);

  useEffect(()=>{ if(billingId) run(billingId); },[billingId]);

  // Flow step def
  const steps = trace ? [
    { key:"customer",    label:"Customer",         icon:"👤", value:trace.customerName||trace.soldToParty,   sub:trace.soldToParty,          ok:!!trace.soldToParty },
    { key:"order",       label:"Sales Order",       icon:"📋", value:trace.salesOrder,                        sub:`₹${Number(trace.orderAmount||0).toLocaleString()}`, ok:!!trace.salesOrder },
    { key:"delivery",    label:"Delivery",          icon:"🚚", value:trace.deliveryDocument,                  sub:`Goods: ${trace.overallGoodsMovementStatus||"—"}`,  ok:!!trace.deliveryDocument },
    { key:"billing",     label:"Billing Document",  icon:"🧾", value:trace.billingDocument,                   sub:`₹${Number(trace.billingAmount||0).toLocaleString()}`, ok:!!trace.billingDocument },
    { key:"journal",     label:"Journal Entry",     icon:"📒", value:trace.journalEntry,                      sub:trace.postingDate?.slice(0,10)||"—",               ok:!!trace.journalEntry },
    { key:"payment",     label:"Payment",           icon:"💳", value:trace.payment,                           sub:trace.clearingDate?.slice(0,10)||"Pending",        ok:!!trace.payment },
  ] : [];

  return (
    <div style={{ position:"absolute",top:16,right:0,bottom:0,zIndex:25,width:340,display:"flex",flexDirection:"column",background:"#fff",borderLeft:"1px solid #e2e8f0",boxShadow:"-4px 0 24px rgba(0,0,0,0.08)",fontFamily:"'DM Sans',sans-serif",overflow:"hidden" }}>
      {/* Header */}
      <div style={{ padding:"14px 16px",borderBottom:"1px solid #f1f5f9",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
          <div>
            <div style={{ fontWeight:700,fontSize:15,color:"#0f172a" }}>⛓ Flow Tracer</div>
            <div style={{ fontSize:11,color:"#94a3b8" }}>O2C end-to-end trace</div>
          </div>
          <button onClick={onClose} style={{ width:26,height:26,border:"1px solid #e2e8f0",borderRadius:7,background:"#f8fafc",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontSize:16 }}>×</button>
        </div>
        <div style={{ display:"flex",gap:6 }}>
          <input value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&run(input)}
            placeholder="Billing doc ID e.g. 90504248"
            style={{ flex:1,padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:7,fontSize:12,outline:"none",fontFamily:"inherit",color:"#0f172a" }}
            onFocus={e=>e.target.style.borderColor="#3B82F6"}
            onBlur={e=>e.target.style.borderColor="#e2e8f0"}
          />
          <button onClick={()=>run(input)}
            style={{ padding:"7px 14px",background:"#1D4ED8",border:"none",borderRadius:7,color:"#fff",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap" }}>
            Trace
          </button>
        </div>
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"14px 16px" }}>
        {loading && <div style={{ textAlign:"center",color:"#94a3b8",fontSize:13,paddingTop:20 }}>Loading trace…</div>}

        {!loading && !trace && (
          <div style={{ textAlign:"center",color:"#94a3b8",fontSize:13,paddingTop:20 }}>
            <div style={{ fontSize:28,marginBottom:8 }}>⛓</div>
            No data found for this billing document.
          </div>
        )}

        {!loading && trace && (
          <>
            {/* Completion summary */}
            <div style={{ background: steps.every(s=>s.ok)?"#f0fdf4":"#fff7ed", border:`1px solid ${steps.every(s=>s.ok)?"#bbf7d0":"#fed7aa"}`, borderRadius:10,padding:"10px 14px",marginBottom:16,display:"flex",alignItems:"center",gap:10 }}>
              <div style={{ fontSize:22 }}>{steps.every(s=>s.ok)?"✅":"⚠️"}</div>
              <div>
                <div style={{ fontWeight:700,fontSize:13,color:steps.every(s=>s.ok)?"#15803d":"#92400e" }}>
                  {steps.filter(s=>s.ok).length}/{steps.length} stages complete
                </div>
                <div style={{ fontSize:11,color:steps.every(s=>s.ok)?"#16a34a":"#b45309" }}>
                  {steps.every(s=>s.ok)?"Full O2C cycle completed":"Broken flow — see missing stages below"}
                </div>
              </div>
            </div>

            {/* Step chain */}
            <div style={{ display:"flex",flexDirection:"column",gap:0 }}>
              {steps.map((step,i)=>(
                <div key={step.key}>
                  <div style={{ display:"flex",alignItems:"flex-start",gap:12 }}>
                    {/* Icon + connector line */}
                    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0 }}>
                      <div style={{
                        width:36,height:36,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
                        fontSize:16,
                        background:step.ok?"#eff6ff":"#fef2f2",
                        border:`2px solid ${step.ok?"#bfdbfe":"#fecaca"}`,
                      }}>{step.ok?step.icon:"✕"}</div>
                      {i<steps.length-1&&<div style={{ width:2,height:28,background:step.ok?"#bfdbfe":"#fecaca",marginTop:2 }}/>}
                    </div>
                    {/* Content */}
                    <div style={{ paddingBottom:i<steps.length-1?0:0,paddingTop:4,flex:1 }}>
                      <div style={{ fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.5 }}>{step.label}</div>
                      {step.ok
                        ? <>
                            <div style={{ fontSize:13,fontWeight:600,color:"#0f172a",marginTop:1 }}>{step.value}</div>
                            <div style={{ fontSize:11,color:"#64748b" }}>{step.sub}</div>
                          </>
                        : <div style={{ fontSize:12,color:"#ef4444",marginTop:2 }}>Not found — broken flow</div>
                      }
                    </div>
                  </div>
                  {i<steps.length-1&&<div style={{ height:8 }}/>}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Quick billing doc picker */}
        {!loading && (
          <div style={{ marginTop:20 }}>
            <div style={{ fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.5,marginBottom:8 }}>Quick Trace</div>
            <QuickPicker db={db} onSelect={id=>{setInput(id);run(id);}}/>
          </div>
        )}
      </div>
    </div>
  );
}

function QuickPicker({db,onSelect}) {
  const {rows} = queryDb(db,"SELECT billingDocument FROM billing_document_headers WHERE billingDocumentIsCancelled='false' LIMIT 8");
  return (
    <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
      {rows.map(r=>(
        <button key={r.billingDocument} onClick={()=>onSelect(r.billingDocument)}
          style={{ fontSize:11,padding:"4px 9px",borderRadius:20,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#1D4ED8",cursor:"pointer",fontFamily:"inherit",fontWeight:500 }}>
          {r.billingDocument}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnomalyPanel — NEW: proactive issue detection
// ─────────────────────────────────────────────────────────────────────────────
function AnomalyPanel({ anomalies, onSelect, onHighlight, db }) {
  const [expanded, setExpanded] = useState(null);
  const [rows, setRows] = useState({});
  const [activeId, setActiveId] = useState(null);

  const handleExpand = (a) => {
    const next = expanded===a.id ? null : a.id;
    setExpanded(next);
    if (next && !rows[a.id]) {
      const {rows:r} = queryDb(db, a.sql);
      setRows(prev=>({...prev,[a.id]:r}));
      // Highlight affected nodes
      const ids=new Set();
      r.forEach(row=>Object.values(row).forEach(v=>{
        if(!v) return;
        a.nodePrefix.forEach(pfx=>{ const id=`${pfx}${v}`; ids.add(id); });
      }));
      onHighlight(ids);
    } else if (!next) {
      onHighlight(new Set());
    }
    setActiveId(next);
  };

  const total = anomalies.reduce((s,a)=>s+Number(a.count),0);
  const critical = anomalies.filter(a=>a.severity==="critical").length;

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:0 }}>
      {/* Summary bar */}
      <div style={{ padding:"10px 14px",background:"#fff7ed",borderBottom:"1px solid #fed7aa",display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
        <div style={{ width:32,height:32,borderRadius:8,background:"#ea580c",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0 }}>⚠️</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700,fontSize:13,color:"#9a3412" }}>{total} issues detected across {anomalies.length} checks</div>
          <div style={{ fontSize:11,color:"#c2410c" }}>{critical} critical · {anomalies.length-critical} warnings/info</div>
        </div>
      </div>

      {/* Anomaly list */}
      <div style={{ overflowY:"auto",flex:1 }}>
        {anomalies.map(a=>{
          const sev=SEV[a.severity];
          const isExp=expanded===a.id;
          return (
            <div key={a.id} style={{ borderBottom:"1px solid #f1f5f9" }}>
              {/* Row */}
              <div onClick={()=>handleExpand(a)}
                style={{ padding:"12px 14px",cursor:"pointer",background:isExp?sev.bg:"#fff",display:"flex",alignItems:"flex-start",gap:10,transition:"background 0.12s" }}
                onMouseEnter={e=>!isExp&&(e.currentTarget.style.background="#f8fafc")}
                onMouseLeave={e=>!isExp&&(e.currentTarget.style.background="#fff")}>
                <span style={{ fontSize:16,flexShrink:0,marginTop:1 }}>{sev.icon}</span>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:8 }}>
                    <div style={{ fontWeight:600,fontSize:13,color:"#0f172a" }}>{a.title}</div>
                    <span style={{ padding:"2px 7px",borderRadius:20,background:sev.badge,color:sev.text,fontSize:11,fontWeight:700,flexShrink:0 }}>{a.count}</span>
                  </div>
                  <div style={{ fontSize:12,color:"#64748b",marginTop:2,lineHeight:1.4 }}>{a.description}</div>
                </div>
                <span style={{ fontSize:12,color:"#94a3b8",flexShrink:0,marginTop:2 }}>{isExp?"▲":"▼"}</span>
              </div>

              {/* Expanded rows */}
              {isExp && (
                <div style={{ background:sev.bg,borderTop:`1px solid ${sev.border}`,padding:"0 0 10px" }}>
                  {rows[a.id]
                    ? rows[a.id].length>0
                      ? <div style={{ overflowX:"auto",margin:"10px 14px 0" }}>
                          <table style={{ borderCollapse:"collapse",fontSize:11,width:"100%" }}>
                            <thead><tr>{Object.keys(rows[a.id][0]).map(c=>(
                              <th key={c} style={{ padding:"5px 8px",background:"rgba(255,255,255,0.7)",color:"#64748b",borderBottom:`1px solid ${sev.border}`,textAlign:"left",whiteSpace:"nowrap",fontWeight:600 }}>{c}</th>
                            ))}</tr></thead>
                            <tbody>{rows[a.id].slice(0,8).map((row,ri)=>(
                              <tr key={ri} style={{ background:ri%2===0?"rgba(255,255,255,0.5)":"transparent" }}>
                                {Object.values(row).map((v,vi)=>(
                                  <td key={vi} style={{ padding:"4px 8px",color:sev.text,whiteSpace:"nowrap",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis" }}>
                                    {String(v??"—").slice(0,28)}
                                  </td>
                                ))}
                              </tr>
                            ))}</tbody>
                          </table>
                          {rows[a.id].length>8&&<div style={{ padding:"4px 14px",fontSize:11,color:sev.text,opacity:0.7 }}>+{rows[a.id].length-8} more</div>}
                        </div>
                      : <div style={{ padding:"10px 14px",fontSize:12,color:sev.text }}>No rows returned.</div>
                    : <div style={{ padding:"10px 14px",fontSize:12,color:sev.text }}>Loading…</div>
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphLegend
// ─────────────────────────────────────────────────────────────────────────────
function GraphLegend() {
  return (
    <div style={{ position:"absolute",bottom:16,left:16,zIndex:10,background:"rgba(255,255,255,0.96)",backdropFilter:"blur(8px)",border:"1px solid #e8edf3",borderRadius:10,padding:"10px 14px",boxShadow:"0 2px 12px rgba(0,0,0,0.07)",fontFamily:"'DM Sans',sans-serif" }}>
      <div style={{ fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.8,marginBottom:7 }}>Entity Types</div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 16px" }}>
        {Object.entries(NODE_STYLE).map(([type,s])=>(
          <div key={type} style={{ display:"flex",alignItems:"center",gap:6 }}>
            <span style={{ width:9,height:9,borderRadius:"50%",flexShrink:0,background:s.ring?"transparent":s.fill,border:`2px solid ${s.stroke}` }}/>
            <span style={{ fontSize:11,color:"#475569",whiteSpace:"nowrap" }}>{ENTITY_LABELS[type]}</span>
          </div>
        ))}
        <div style={{ display:"flex",alignItems:"center",gap:6,gridColumn:"span 2",marginTop:2,paddingTop:5,borderTop:"1px solid #f1f5f9" }}>
          <span style={{ width:9,height:9,borderRadius:"50%",flexShrink:0,background:"transparent",border:"2px solid #ef4444" }}/>
          <span style={{ fontSize:11,color:"#ef4444" }}>Broken flow</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphSearch
// ─────────────────────────────────────────────────────────────────────────────
function GraphSearch({nodes,onMatch,onClear}) {
  const [q,setQ]=useState("");
  const handleChange=v=>{
    setQ(v);
    if(!v.trim()){onClear();return;}
    const lower=v.toLowerCase();
    onMatch(nodes.filter(n=>n.label?.toLowerCase().includes(lower)||ENTITY_LABELS[n.type]?.toLowerCase().includes(lower)||n.id?.toLowerCase().includes(lower)));
  };
  const clear=()=>{setQ("");onClear();};
  return (
    <div style={{ position:"absolute",top:14,right:16,zIndex:10,display:"flex",alignItems:"center",background:"#fff",border:"1px solid #e2e8f0",borderRadius:9,boxShadow:"0 2px 10px rgba(0,0,0,0.07)",overflow:"hidden",fontFamily:"'DM Sans',sans-serif",width:220 }}>
      <span style={{ padding:"0 10px",color:"#94a3b8",fontSize:14,flexShrink:0,userSelect:"none" }}>⌕</span>
      <input value={q} onChange={e=>handleChange(e.target.value)} placeholder="Search nodes…"
        style={{ flex:1,border:"none",outline:"none",fontSize:12,color:"#0f172a",background:"transparent",padding:"8px 0",fontFamily:"inherit" }}/>
      {q&&<button onClick={clear} style={{ padding:"0 10px",border:"none",background:"transparent",cursor:"pointer",color:"#94a3b8",fontSize:14,flexShrink:0 }}>✕</button>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultsTable
// ─────────────────────────────────────────────────────────────────────────────
function ResultsTable({rows}) {
  if(!rows?.length) return <div style={{ padding:"20px 0",textAlign:"center",color:"#94a3b8",fontSize:13 }}>No rows returned.</div>;
  const cols=Object.keys(rows[0]);
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ borderCollapse:"collapse",fontSize:12,width:"100%",minWidth:200 }}>
        <thead><tr>{cols.map(c=><th key={c} style={{ padding:"7px 10px",background:"#f8fafc",color:"#64748b",borderBottom:"1px solid #e2e8f0",textAlign:"left",whiteSpace:"nowrap",fontWeight:600,fontSize:11 }}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((row,ri)=>(
          <tr key={ri} style={{ background:ri%2===0?"#fff":"#f8fafc" }}>
            {cols.map(c=><td key={c} style={{ padding:"6px 10px",color:"#334155",whiteSpace:"nowrap",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",borderBottom:"1px solid #f1f5f9" }}>{String(row[c]??"—").slice(0,40)}</td>)}
          </tr>
        ))}</tbody>
      </table>
      <div style={{ padding:"6px 10px",fontSize:11,color:"#94a3b8",borderTop:"1px solid #f1f5f9" }}>{rows.length} row{rows.length!==1?"s":""}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [db,setDb]               = useState(null);
  const [loading,setLoading]     = useState(true);
  const [graphData,setGraphData] = useState({nodes:[],links:[]});
  const [anomalies,setAnomalies] = useState([]);
  const [selectedNode,setSelectedNode] = useState(null);
  const [queryHighlighted,setQueryHighlighted] = useState(new Set());
  const [searchHighlighted,setSearchHighlighted] = useState(new Set());
  const [traceHighlighted,setTraceHighlighted]   = useState(new Set());
  const [anomalyHighlighted,setAnomalyHighlighted] = useState(new Set());

  // Sidebar tabs: "sql" | "chat" | "anomaly"
  const [tab,setTab]             = useState("anomaly");
  const [showTrace,setShowTrace] = useState(false);
  const [traceDoc,setTraceDoc]   = useState(null);

  const [sql,setSql]             = useState(CANNED[0].sql);
  const [results,setResults]     = useState(null);
  const [queryError,setQueryError] = useState(null);
  const [running,setRunning]     = useState(false);
  const [activePreset,setActivePreset] = useState(0);

  const [apiKey,setApiKey]       = useState(()=>sessionStorage.getItem("dodge_key")||"");
  const [keyInput,setKeyInput]   = useState("");
  const [keyError,setKeyError]   = useState("");
  const [messages,setMessages]   = useState([{role:"assistant",content:"Hi! I can help you analyze the **Order to Cash** process. Ask about sales orders, deliveries, billing, or payments."}]);
  const [chatInput,setChatInput] = useState("");
  const [thinking,setThinking]   = useState(false);

  const graphRef=useRef(), chatEndRef=useRef();
  const [dims,setDims]=useState({w:window.innerWidth,h:window.innerHeight});

  useEffect(()=>{const fn=()=>setDims({w:window.innerWidth,h:window.innerHeight});window.addEventListener("resize",fn);return()=>window.removeEventListener("resize",fn);},[]);

  useEffect(()=>{
    const s=document.createElement("script");s.src="/sql-wasm.js";
    s.onload=async()=>{
      const SQL=await window.initSqlJs({locateFile:()=>"/sql-wasm.wasm"});
      const res=await fetch("/sap_o2c.db");
      const buf=await res.arrayBuffer();
      const database=new SQL.Database(new Uint8Array(buf));
      setDb(database);
      setGraphData(buildGraph(database));
      setAnomalies(detectAnomalies(database));
      setLoading(false);
    };
    document.body.appendChild(s);
  },[]);

  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  const highlightFromRows=useCallback((rows)=>{
    const ids=new Set();
    rows.forEach(row=>Object.values(row).forEach(v=>{
      if(!v) return;
      [`SO_${v}`,`BD_${v}`,`DEL_${v}`,`JE_${v}`,`PAY_${v}`,`C_${v}`,`PRD_${v}`,`PLT_${v}`]
        .forEach(id=>{if(graphData.nodes.find(n=>n.id===id))ids.add(id);});
    }));
    if(ids.size>0){setQueryHighlighted(ids);setTimeout(()=>setQueryHighlighted(new Set()),12000);}
  },[graphData.nodes]);

  const runQuery=useCallback((sqlStr)=>{
    if(!db||!sqlStr.trim()) return;
    setRunning(true);setQueryError(null);
    setTimeout(()=>{
      const {rows,error}=queryDb(db,sqlStr);
      if(error){setQueryError(error);setResults(null);}
      else{setResults(rows);highlightFromRows(rows);}
      setRunning(false);
    },30);
  },[db,highlightFromRows]);

  const saveKey=()=>{
    if(!keyInput.startsWith("sk-ant-")){setKeyError("Must start with sk-ant-");return;}
    sessionStorage.setItem("dodge_key",keyInput);setApiKey(keyInput);setKeyInput("");setKeyError("");
  };

  const sendChat=async(override)=>{
    const msg=(override??chatInput).trim();
    if(!msg||thinking||!db||!apiKey) return;
    setChatInput("");
    setMessages(prev=>[...prev,{role:"user",content:msg}]);
    setThinking(true);
    try {
      const history=messages.filter((_,i)=>i>0).slice(-10).map(m=>({role:m.role,content:m.rawContent??m.content}));
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:SYSTEM_PROMPT,messages:[...history,{role:"user",content:msg}]}),
      });
      const data=await res.json();
      const raw=data.content?.[0]?.text??"{}";
      let parsed;
      try{parsed=JSON.parse(raw.replace(/^```json\n?|^```\n?|```$/gm,"").trim());}
      catch{parsed={sql:null,explanation:raw,isOffTopic:false};}
      let rows=null;
      if(parsed.sql&&!parsed.isOffTopic){
        const qr=queryDb(db,parsed.sql);
        if(!qr.error){rows=qr.rows;highlightFromRows(rows);}
        else parsed.explanation+=`\n\n⚠️ Query error: ${qr.error}`;
      }
      setMessages(prev=>[...prev,{role:"assistant",content:parsed.explanation??"",rawContent:parsed.explanation,sql:parsed.sql,results:rows,isOffTopic:parsed.isOffTopic}]);
    }catch(e){setMessages(prev=>[...prev,{role:"assistant",content:`⚠️ ${e.message}`}]);}
    setThinking(false);
  };

  const handleSearchMatch=useCallback((matched)=>{
    const ids=new Set(matched.map(n=>n.id));
    setSearchHighlighted(ids);
    if(matched.length===1){
      setSelectedNode(matched[0]);
      const n=matched[0];
      if(n.x!=null&&graphRef.current){graphRef.current.centerAt(n.x,n.y,500);graphRef.current.zoom(3,500);}
    }
  },[]);
  const handleSearchClear=useCallback(()=>{setSearchHighlighted(new Set());},[]);

  const openTrace=useCallback((billingId)=>{
    setTraceDoc(billingId);
    setShowTrace(true);
  },[]);

  // All highlights combined for canvas
  const allHighlighted = new Set([...queryHighlighted,...searchHighlighted,...traceHighlighted,...anomalyHighlighted]);
  const traceOrAnomalyIds = new Set([...traceHighlighted,...anomalyHighlighted]);

  const nodeCanvasObject=useCallback((node,ctx,scale)=>{
    const s=NODE_STYLE[node.type]||{fill:"#93C5FD",stroke:"#60A5FA",size:6,ring:false};
    const isHL   = allHighlighted.has(node.id);
    const isSrch = searchHighlighted.has(node.id);
    const isTrace= traceHighlighted.has(node.id);
    const isAnomaly=anomalyHighlighted.has(node.id);
    const isSel  = selectedNode?.id===node.id;
    const r = s.size*(isHL?1.9:isSel?1.5:1);

    // Glow
    if(isHL||isSel){
      ctx.beginPath();ctx.arc(node.x,node.y,r+6,0,2*Math.PI);
      ctx.fillStyle = isTrace?"rgba(99,102,241,0.18)":isSrch?"rgba(251,191,36,0.18)":isAnomaly?"rgba(239,68,68,0.15)":"rgba(59,130,246,0.13)";
      ctx.fill();
    }

    ctx.beginPath();ctx.arc(node.x,node.y,r,0,2*Math.PI);
    if(s.ring){
      ctx.fillStyle=isTrace?"#ede9fe":isSrch?"#fef9c3":isAnomaly?"#fee2e2":isHL?"#ecfdf5":"#fff";
      ctx.fill();
      ctx.strokeStyle=isTrace?"#6366f1":isSrch?"#f59e0b":isAnomaly?"#ef4444":isHL?"#22c55e":s.stroke;
      ctx.lineWidth=isSel?2.5:1.5;ctx.stroke();
    } else {
      ctx.fillStyle=isTrace?"#6366f1":isSrch?"#fbbf24":isAnomaly?"#ef4444":isHL?"#1D4ED8":s.fill;
      ctx.fill();
      if(isSel){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke();}
    }

    if(scale>=1.6||isSel||isHL){
      const lbl=(node.label??node.id).slice(0,22),fs=Math.max(7,9/scale);
      ctx.font=`500 ${fs}px DM Sans,sans-serif`;ctx.textAlign="center";ctx.textBaseline="top";
      ctx.shadowColor="#fff";ctx.shadowBlur=3;
      ctx.fillStyle=isSel?"#1D4ED8":"#475569";
      ctx.fillText(lbl,node.x,node.y+r+2);ctx.shadowBlur=0;
    }
  },[allHighlighted,searchHighlighted,traceHighlighted,anomalyHighlighted,selectedNode]);

  const SIDEBAR_W=390;
  const graphW=dims.w-SIDEBAR_W;
  const graphH=dims.h-48;

  if(loading) return(
    <div style={{ height:"100vh",background:"#f8fafc",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`@keyframes bar{0%,100%{left:-40%}50%{left:100%}}`}</style>
      <div style={{ width:44,height:44,borderRadius:12,background:"#111",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:20 }}>D</div>
      <div style={{ fontSize:16,fontWeight:600,color:"#0f172a" }}>Loading O2C Graph</div>
      <div style={{ fontSize:13,color:"#94a3b8" }}>Detecting anomalies &amp; building knowledge graph…</div>
      <div style={{ width:180,height:3,background:"#e2e8f0",borderRadius:2,position:"relative",overflow:"hidden",marginTop:4 }}>
        <div style={{ position:"absolute",top:0,height:"100%",width:"40%",background:"#3B82F6",borderRadius:2,animation:"bar 1.4s ease-in-out infinite" }}/>
      </div>
    </div>
  );

  return (
    <div style={{ height:"100vh",display:"flex",flexDirection:"column",background:"#f8fafc",fontFamily:"'DM Sans',system-ui,sans-serif",color:"#0f172a",overflow:"hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet"/>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:2px}input::placeholder,textarea::placeholder{color:#cbd5e1}button:focus{outline:none}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}`}</style>

      {/* Header */}
      <div style={{ height:48,borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",paddingLeft:16,gap:10,background:"#fff",flexShrink:0,zIndex:5 }}>
        <div style={{ width:30,height:30,borderRadius:8,background:"#111",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:14,flexShrink:0 }}>D</div>
        <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:14 }}>
          <span style={{ color:"#94a3b8" }}>Mapping</span>
          <span style={{ color:"#cbd5e1" }}>/</span>
          <span style={{ fontWeight:600,color:"#0f172a" }}>Order to Cash</span>
        </div>
        {/* Anomaly badge in header */}
        {anomalies.length>0&&(
          <button onClick={()=>setTab("anomaly")}
            style={{ display:"flex",alignItems:"center",gap:5,padding:"4px 10px",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:20,fontSize:11,color:"#92400e",cursor:"pointer",fontWeight:600,fontFamily:"inherit" }}>
            ⚠️ {anomalies.reduce((s,a)=>s+Number(a.count),0)} issues
          </button>
        )}
        <div style={{ marginLeft:"auto",display:"flex",gap:8,paddingRight:16 }}>
          <button onClick={()=>{setShowTrace(true);setTraceDoc(null);}}
            style={{ display:"flex",alignItems:"center",gap:5,padding:"5px 12px",border:"1px solid #e2e8f0",borderRadius:8,background:"#fff",fontSize:12,color:"#1D4ED8",cursor:"pointer",fontWeight:600,fontFamily:"inherit" }}>
            ⛓ Flow Tracer
          </button>
          <button style={{ display:"flex",alignItems:"center",gap:5,padding:"5px 12px",border:"none",borderRadius:8,background:"#111",fontSize:12,color:"#fff",cursor:"pointer",fontWeight:500,fontFamily:"inherit" }}>
            ◧ Hide Granular Overlay
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex:1,display:"flex",overflow:"hidden" }}>

        {/* Graph */}
        <div style={{ position:"relative",flex:1,overflow:"hidden",background:"#f5f8fc" }}>
          <ForceGraph2D
            ref={graphRef} graphData={graphData} width={graphW} height={graphH}
            nodeCanvasObject={nodeCanvasObject} nodeCanvasObjectMode={()=>"replace"}
            linkColor={()=>"rgba(147,197,253,0.38)"} linkWidth={0.9}
            linkDirectionalArrowLength={4} linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={()=>"rgba(147,197,253,0.55)"}
            onNodeClick={n=>setSelectedNode(prev=>prev?.id===n.id?null:n)}
            backgroundColor="#f5f8fc"
            cooldownTicks={200} onEngineStop={()=>graphRef.current?.zoomToFit(700,80)}
            d3AlphaDecay={0.015} d3VelocityDecay={0.25} linkDistance={80}
          />

          {/* Node inspector */}
          {selectedNode&&!showTrace&&(
            <NodeInspectorPanel node={selectedNode} onClose={()=>setSelectedNode(null)} onTrace={openTrace}/>
          )}

          {/* Flow tracer panel */}
          {showTrace&&(
            <div style={{ animation:"slideIn 0.2s ease" }}>
              <FlowTracePanel
                db={db} billingId={traceDoc}
                onClose={()=>{setShowTrace(false);setTraceHighlighted(new Set());}}
                onHighlight={setTraceHighlighted}
              />
            </div>
          )}

          <GraphLegend/>
          <GraphSearch nodes={graphData.nodes} onMatch={handleSearchMatch} onClear={handleSearchClear}/>
          {searchHighlighted.size>0&&(
            <div style={{ position:"absolute",top:54,right:16,zIndex:10,background:"#fef9c3",border:"1px solid #f59e0b",borderRadius:7,padding:"3px 10px",fontSize:11,color:"#92400e",fontWeight:600,fontFamily:"'DM Sans',sans-serif" }}>
              {searchHighlighted.size} match{searchHighlighted.size!==1?"es":""}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={{ width:SIDEBAR_W,borderLeft:"1px solid #e2e8f0",background:"#fff",display:"flex",flexDirection:"column",flexShrink:0,overflow:"hidden" }}>

          {/* Tabs */}
          <div style={{ padding:"14px 20px 0",borderBottom:"1px solid #f1f5f9",flexShrink:0 }}>
            <div style={{ fontWeight:700,fontSize:15,color:"#0f172a",marginBottom:10 }}>
              {tab==="sql"?"Query Graph":tab==="chat"?"Chat with Graph":"Anomaly Detection"}
            </div>
            <div style={{ display:"flex" }}>
              {[["anomaly","🔍 Anomalies"],["sql","SQL"],["chat","AI Chat"]].map(([t,lbl])=>(
                <button key={t} onClick={()=>setTab(t)} style={{ flex:1,padding:"7px 0",border:"none",background:"transparent",fontFamily:"inherit",fontWeight:600,fontSize:12,cursor:"pointer",color:tab===t?"#1D4ED8":"#94a3b8",borderBottom:`2px solid ${tab===t?"#3B82F6":"transparent"}`,transition:"all 0.15s",position:"relative" }}>
                  {lbl}
                  {t==="anomaly"&&anomalies.length>0&&(
                    <span style={{ position:"absolute",top:2,right:4,width:8,height:8,borderRadius:"50%",background:"#ef4444",display:"inline-block" }}/>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* ══ Anomaly tab ══ */}
          {tab==="anomaly"&&(
            <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden" }}>
              {anomalies.length===0
                ? <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,color:"#94a3b8" }}>
                    <div style={{ fontSize:32 }}>✅</div>
                    <div style={{ fontSize:14,fontWeight:600,color:"#15803d" }}>No anomalies detected</div>
                    <div style={{ fontSize:12 }}>All O2C flows look healthy</div>
                  </div>
                : <AnomalyPanel anomalies={anomalies} db={db}
                    onHighlight={ids=>{setAnomalyHighlighted(ids);setTimeout(()=>setAnomalyHighlighted(new Set()),15000);}}
                    onSelect={()=>{}}
                  />
              }
            </div>
          )}

          {/* ══ SQL tab ══ */}
          {tab==="sql"&&(
            <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden" }}>
              <div style={{ padding:"12px 14px 0",flexShrink:0 }}>
                <div style={{ fontSize:11,fontWeight:600,color:"#94a3b8",textTransform:"uppercase",letterSpacing:0.5,marginBottom:7 }}>Preset Queries</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:5,marginBottom:12 }}>
                  {CANNED.map((c,i)=>(
                    <button key={i} onClick={()=>{setActivePreset(i);setSql(c.sql);setResults(null);setQueryError(null);}}
                      style={{ fontSize:11,padding:"4px 9px",borderRadius:20,border:`1px solid ${activePreset===i?"#3B82F6":"#e2e8f0"}`,background:activePreset===i?"#EFF6FF":"#f8fafc",color:activePreset===i?"#1D4ED8":"#64748b",cursor:"pointer",fontFamily:"inherit",fontWeight:activePreset===i?600:400,whiteSpace:"nowrap" }}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <textarea value={sql} onChange={e=>{setSql(e.target.value);setActivePreset(-1);}}
                  onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();runQuery(sql);}}}
                  spellCheck={false}
                  style={{ width:"100%",height:118,padding:"10px 12px",border:"1px solid #e2e8f0",borderRadius:8,resize:"none",fontSize:12,lineHeight:1.6,color:"#1e293b",background:"#f8fafc",fontFamily:"'Fira Code',monospace",outline:"none" }}
                  onFocus={e=>e.target.style.borderColor="#3B82F6"} onBlur={e=>e.target.style.borderColor="#e2e8f0"}
                />
                <button onClick={()=>runQuery(sql)} disabled={running||!sql.trim()}
                  style={{ marginTop:8,width:"100%",padding:"9px 0",background:running||!sql.trim()?"#f1f5f9":"#111",color:running||!sql.trim()?"#94a3b8":"#fff",border:"none",borderRadius:8,fontWeight:600,fontSize:13,cursor:running||!sql.trim()?"not-allowed":"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8 }}>
                  {running?<><div style={{ width:13,height:13,border:"2px solid #cbd5e1",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.7s linear infinite" }}/>Running…</>:"▶  Run Query"}
                </button>
                <div style={{ fontSize:11,color:"#cbd5e1",textAlign:"right",marginTop:4 }}>⌘ Enter to run</div>
              </div>
              <div style={{ flex:1,overflowY:"auto",padding:"10px 14px 14px",display:"flex",flexDirection:"column",gap:8 }}>
                {queryError&&<div style={{ background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#be123c" }}><strong>SQL Error:</strong> {queryError}</div>}
                {results&&!queryError&&(
                  <div style={{ background:"#fff",border:"1px solid #f1f5f9",borderRadius:8,overflow:"hidden",animation:"fadeIn 0.2s ease" }}>
                    <div style={{ padding:"8px 10px",borderBottom:"1px solid #f1f5f9",fontSize:11,color:"#94a3b8",fontWeight:600,display:"flex",justifyContent:"space-between" }}>
                      <span>Results</span>
                      {queryHighlighted.size>0&&<span style={{ color:"#3B82F6" }}>✦ {queryHighlighted.size} nodes highlighted</span>}
                    </div>
                    <ResultsTable rows={results}/>
                  </div>
                )}
                {results===null&&!queryError&&(
                  <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,color:"#cbd5e1",paddingTop:20 }}>
                    <div style={{ fontSize:28 }}>⬡</div>
                    <div style={{ fontSize:13,textAlign:"center" }}>Select a preset or write a query,<br/>then click Run</div>
                  </div>
                )}
              </div>
              <div style={{ padding:"8px 14px",borderTop:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:6,flexShrink:0 }}>
                <span style={{ width:7,height:7,borderRadius:"50%",background:"#22c55e",display:"inline-block" }}/>
                <span style={{ fontSize:11,color:"#94a3b8" }}>{graphData.nodes.length} nodes · {graphData.links.length} edges · {results?`${results.length} row${results.length!==1?"s":""} returned`:"ready"}</span>
              </div>
            </div>
          )}

          {/* ══ Chat tab ══ */}
          {tab==="chat"&&(
            <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden" }}>
              {!apiKey&&(
                <div style={{ margin:"12px 14px 0",padding:"12px 14px",background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:10,flexShrink:0 }}>
                  <div style={{ fontSize:12,fontWeight:600,color:"#0369a1",marginBottom:8 }}>Enter Anthropic API key to enable AI chat</div>
                  <div style={{ display:"flex",gap:6 }}>
                    <input type="password" value={keyInput} onChange={e=>setKeyInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveKey()} placeholder="sk-ant-api03-..."
                      style={{ flex:1,padding:"7px 10px",border:`1px solid ${keyError?"#fca5a5":"#bae6fd"}`,borderRadius:7,fontSize:12,fontFamily:"monospace",outline:"none",background:"#fff",color:"#0f172a" }}/>
                    <button onClick={saveKey} style={{ padding:"7px 12px",background:"#0ea5e9",border:"none",borderRadius:7,color:"#fff",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit" }}>Save</button>
                  </div>
                  {keyError&&<div style={{ fontSize:11,color:"#ef4444",marginTop:4 }}>{keyError}</div>}
                  <div style={{ fontSize:11,color:"#7dd3fc",marginTop:6 }}>Free key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color:"#0ea5e9" }}>console.anthropic.com</a></div>
                </div>
              )}
              <div style={{ flex:1,overflowY:"auto",padding:"14px 14px 8px",display:"flex",flexDirection:"column",gap:14 }}>
                {messages.map((msg,i)=>(
                  <div key={i} style={{ display:"flex",gap:10,animation:"fadeIn 0.2s ease",flexDirection:msg.role==="user"?"row-reverse":"row",alignItems:"flex-start" }}>
                    {msg.role==="assistant"
                      ?<div style={{ width:32,height:32,borderRadius:"50%",background:"#111",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:13,flexShrink:0 }}>D</div>
                      :<div style={{ width:32,height:32,borderRadius:"50%",background:"#e2e8f0",display:"flex",alignItems:"center",justifyContent:"center",color:"#64748b",fontWeight:700,fontSize:11,flexShrink:0 }}>You</div>
                    }
                    <div style={{ maxWidth:"80%",display:"flex",flexDirection:"column",gap:4 }}>
                      {msg.role==="assistant"&&<div><div style={{ fontWeight:700,fontSize:13,color:"#0f172a" }}>Dodge AI</div><div style={{ fontSize:11,color:"#94a3b8" }}>Graph Agent</div></div>}
                      <div style={{ padding:msg.role==="user"?"9px 13px":"0",background:msg.role==="user"?"#111":"transparent",borderRadius:12,fontSize:13,lineHeight:1.6,color:msg.role==="user"?"#fff":msg.isOffTopic?"#991b1b":"#334155",fontWeight:msg.role==="user"?500:400 }}>
                        {msg.content.split(/(\*\*[^*]+\*\*)/).map((p,pi)=>p.startsWith("**")&&p.endsWith("**")?<strong key={pi} style={{ color:msg.role==="user"?"#fff":"#0f172a" }}>{p.slice(2,-2)}</strong>:p)}
                      </div>
                      {msg.sql&&(<details style={{ marginTop:2 }}><summary style={{ fontSize:11,color:"#cbd5e1",cursor:"pointer" }}>View SQL</summary><pre style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:6,padding:"8px 10px",fontSize:11,color:"#3B82F6",overflowX:"auto",marginTop:4,lineHeight:1.6,whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:"'Fira Code',monospace" }}>{msg.sql}</pre></details>)}
                      {msg.results?.length>0&&<div style={{ overflowX:"auto",borderRadius:8,border:"1px solid #f1f5f9",marginTop:4 }}><ResultsTable rows={msg.results}/></div>}
                      {msg.results?.length===0&&msg.sql&&<div style={{ fontSize:11,color:"#94a3b8" }}>No records matched.</div>}
                    </div>
                  </div>
                ))}
                {thinking&&(
                  <div style={{ display:"flex",gap:10,alignItems:"flex-start" }}>
                    <div style={{ width:32,height:32,borderRadius:"50%",background:"#111",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:13,flexShrink:0 }}>D</div>
                    <div style={{ display:"flex",flexDirection:"column",gap:2 }}>
                      <div style={{ fontWeight:700,fontSize:13 }}>Dodge AI</div>
                      <div style={{ fontSize:11,color:"#94a3b8" }}>Graph Agent</div>
                      <div style={{ fontSize:13,color:"#94a3b8",display:"flex",alignItems:"center",gap:8,marginTop:4 }}>
                        <div style={{ width:13,height:13,border:"2px solid #3B82F6",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.7s linear infinite" }}/>Analyzing…
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef}/>
              </div>
              <div style={{ padding:"6px 12px",borderTop:"1px solid #f1f5f9",display:"flex",gap:5,flexWrap:"wrap",flexShrink:0 }}>
                {CANNED.slice(0,4).map(c=>(
                  <button key={c.label} onClick={()=>sendChat(c.label)}
                    style={{ fontSize:11,padding:"3px 8px",borderRadius:20,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#64748b",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit" }}
                    onMouseEnter={e=>{e.target.style.background="#f1f5f9";e.target.style.borderColor="#cbd5e1";}}
                    onMouseLeave={e=>{e.target.style.background="#f8fafc";e.target.style.borderColor="#e2e8f0";}}>
                    {c.label.length>30?c.label.slice(0,30)+"…":c.label}
                  </button>
                ))}
              </div>
              <div style={{ padding:"10px 14px",borderTop:"1px solid #e2e8f0",background:"#fff",flexShrink:0 }}>
                <div style={{ display:"flex",alignItems:"center",gap:4,marginBottom:8 }}>
                  <span style={{ width:7,height:7,borderRadius:"50%",background:apiKey?"#22c55e":"#f59e0b",display:"inline-block" }}/>
                  <span style={{ fontSize:12,color:"#64748b" }}>{apiKey?"Dodge AI is awaiting instructions":"Add API key above to enable chat"}</span>
                </div>
                <div style={{ display:"flex",gap:8 }}>
                  <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat()} placeholder="Analyze anything" disabled={!apiKey}
                    style={{ flex:1,padding:"9px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:13,outline:"none",fontFamily:"inherit",color:"#0f172a",background:apiKey?"#f8fafc":"#f1f5f9",cursor:apiKey?"text":"not-allowed" }}
                    onFocus={e=>e.target.style.borderColor="#3B82F6"} onBlur={e=>e.target.style.borderColor="#e2e8f0"}/>
                  <button onClick={()=>sendChat()} disabled={thinking||!chatInput.trim()||!apiKey}
                    style={{ padding:"9px 16px",borderRadius:8,border:"none",background:thinking||!chatInput.trim()||!apiKey?"#f1f5f9":"#111",color:thinking||!chatInput.trim()||!apiKey?"#94a3b8":"#fff",fontWeight:600,fontSize:13,cursor:thinking||!chatInput.trim()||!apiKey?"not-allowed":"pointer",fontFamily:"inherit" }}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
