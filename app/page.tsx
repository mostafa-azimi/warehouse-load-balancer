"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalysisResult, ClientAccount, Recommendation } from "@/lib/types";

type Approval = {
  batchId: string;
  message: string;
  documents: Array<{ route: string; salesOrder: string; purchaseOrder: string; lineItems: unknown[] }>;
};

const number = new Intl.NumberFormat("en-US");

async function requestAnalysis(
  clientId: string,
  lookbackDays: 60 | 90 | 120,
  onProgress: (message: string) => void,
) {
  while (true) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, lookbackDays }),
    });
    const payload = await response.json();
    if (response.status === 202) {
      const progress = payload.progress;
      onProgress(
        progress
          ? `${payload.message} Saved ${progress.shipments} shipments, ${progress.inventory} inventory rows, and ${progress.kits} kits.`
          : payload.message,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, payload.retryAfterMs ?? 2_500),
      );
      continue;
    }
    if (!response.ok) throw new Error(payload.error);
    return payload as AnalysisResult;
  }
}

function Logo() {
  return <div className="logo-mark"><span /><span /><span /></div>;
}

export default function Home() {
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [clientId, setClientId] = useState("");
  const [lookbackDays, setLookbackDays] = useState<60 | 90 | 120>(90);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [activePage, setActivePage] = useState("Recommendations");

  useEffect(() => {
    fetch("/api/clients")
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        return payload;
      })
      .then((payload) => {
        setClients(payload.clients);
        setMode(payload.mode);
        const firstClientId = payload.clients[0]?.id ?? "";
        setClientId(firstClientId);
      })
      .catch((reason) => setError(reason.message));
  }, []);

  async function analyze() {
    setLoading(true);
    setAnalysisLoading(true);
    setAnalysisProgress("Starting the ShipHero data pull…");
    setError("");
    setApproval(null);
    try {
      const payload = await requestAnalysis(
        clientId,
        lookbackDays,
        setAnalysisProgress,
      );
      setAnalysis(payload);
      setSelected(new Set(payload.recommendations.map((item) => item.id)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed");
    } finally {
      setLoading(false);
      setAnalysisLoading(false);
    }
  }

  const selectedRecommendations = useMemo(
    () => analysis?.recommendations.filter((item) => selected.has(item.id)) ?? [],
    [analysis, selected],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approve() {
    if (!analysis || !selectedRecommendations.length) return;
    setLoading(true);
    try {
      const response = await fetch("/api/transfers/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: analysis.client.id, recommendations: selectedRecommendations }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setApproval(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><span>balance</span></div>
        <nav>
          {["Overview", "Recommendations", "Transfer history", "Clients"].map((item) => (
            <button key={item} className={activePage === item ? "active" : ""} onClick={() => setActivePage(item)}>
              <span className="nav-icon">{item === "Overview" ? "⌂" : item === "Recommendations" ? "⇄" : item === "Transfer history" ? "↻" : "◫"}</span>{item}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection"><span className="status-dot" /><div><strong>ShipHero connected</strong><small>{mode === "demo" ? "Demo data mode" : "Live API mode"}</small></div></div>
          <button className="settings">⚙ <span>Settings</span></button>
          <div className="profile"><div className="avatar">MA</div><div><strong>Mostafa Azimi</strong><small>3PL administrator</small></div><span>⋮</span></div>
        </div>
      </aside>

      <main>
        <header>
          <div><p className="eyebrow">Inventory intelligence</p><h1>Load balancing</h1><p>Put the right inventory in the right warehouse, before it becomes a problem.</p></div>
          <div className="header-actions"><button className="icon-button">?</button><button className="icon-button">♟</button></div>
        </header>

        <section className="control-panel">
          <div className="field client-field"><label>Client account</label><div className="select-wrap"><select value={clientId} onChange={(event) => { setClientId(event.target.value); setAnalysis(null); }}>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.accountNumber} · {client.name}</option>)}
          </select></div></div>
          <div className="field"><label>Shipment history</label><div className="segment">
            {[60, 90, 120].map((days) => <button key={days} className={lookbackDays === days ? "active" : ""} onClick={() => setLookbackDays(days as 60 | 90 | 120)}>{days} days</button>)}
          </div></div>
          <button className="analyze" onClick={analyze} disabled={!clientId || loading}><span>↻</span>{loading ? "Working…" : "Run analysis"}</button>
        </section>

        {error && <div className="notice error">{error}</div>}
        {analysisLoading && <div className="notice" style={{ background: "#edf5f0", color: "#285f47", border: "1px solid #cfe2d7" }}><strong>Analysis in progress.</strong> {analysisProgress} Keep this page open.</div>}
        {analysis && <>
          <div className="run-meta"><span className={`mode-pill ${analysis.mode}`}>{analysis.mode === "demo" ? "Demo analysis" : "Live analysis"}</span><span>Generated {new Date(analysis.generatedAt).toLocaleString()}</span><span>·</span><span>Kits expanded to physical components</span></div>
          <section className="metrics">
            <Metric label="Units shipped" value={number.format(analysis.metrics.shippedUnits)} detail={`${analysis.lookbackDays}-day history`} />
            <Metric label="Physical demand" value={number.format(analysis.metrics.componentUnits)} detail="After kit expansion" accent />
            <Metric label="SKUs analyzed" value={number.format(analysis.metrics.activeSkus)} detail={`${analysis.warehouses.length} warehouses`} />
            <Metric label="Units to rebalance" value={number.format(analysis.metrics.recommendedUnits)} detail={`${analysis.recommendations.length} recommendations`} accent />
          </section>

          <section className="recommendations">
            <div className="section-heading"><div><h2>Transfer recommendations</h2><p>Prioritized by demand imbalance and available inventory.</p></div><div className="selection-count"><strong>{selected.size}</strong> selected</div></div>
            <div className="table-wrap"><table><thead><tr><th className="check-col"><input type="checkbox" checked={selected.size === analysis.recommendations.length && selected.size > 0} onChange={() => setSelected(selected.size === analysis.recommendations.length ? new Set() : new Set(analysis.recommendations.map((item) => item.id)))} /></th><th>Product</th><th>Move inventory</th><th>Available now</th><th>Recent demand</th><th>After transfer</th><th>Signal</th></tr></thead>
              <tbody>{analysis.recommendations.map((item) => <RecommendationRow key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => toggle(item.id)} />)}</tbody>
            </table>{!analysis.recommendations.length && <div className="empty">Inventory already matches the selected demand window. No transfer is recommended.</div>}</div>
          </section>

          <section className="approval-bar"><div><span className="approval-icon">✓</span><div><strong>Ready to create transfer documents</strong><p>Approval creates paired sales order and purchase order drafts for each warehouse route.</p></div></div><button onClick={approve} disabled={!selectedRecommendations.length || loading}>Approve {selectedRecommendations.length} transfer{selectedRecommendations.length === 1 ? "" : "s"} <span>→</span></button></section>
        </>}
        {approval && <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={() => setApproval(null)}>×</button><div className="success-mark">✓</div><p className="eyebrow">Approval complete</p><h2>{approval.batchId}</h2><p>{approval.message}</p><div className="documents">{approval.documents.map((doc) => <div key={doc.salesOrder}><strong>{doc.route}</strong><span>{doc.salesOrder}</span><span>{doc.purchaseOrder}</span><small>{doc.lineItems.length} line items · Preview</small></div>)}</div><button className="done" onClick={() => setApproval(null)}>Done</button></div></div>}
      </main>
    </div>
  );
}

function Metric({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <article><div className={accent ? "metric-icon accent" : "metric-icon"}>{accent ? "↗" : "◈"}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function RecommendationRow({ item, checked, onToggle }: { item: Recommendation; checked: boolean; onToggle: () => void }) {
  const totalDemand = item.fromDemand + item.toDemand;
  const fromShare = totalDemand ? Math.round((item.fromDemand / totalDemand) * 100) : 0;
  const toShare = 100 - fromShare;
  return <tr className={checked ? "selected-row" : ""}><td className="check-col"><input type="checkbox" checked={checked} onChange={onToggle} /></td><td><div className="product-cell"><div className="product-thumb">{item.sku.slice(0, 2)}</div><div><strong>{item.productName}</strong><span>{item.sku}</span>{item.kitSources.length > 0 && <small className="kit-pill">Component of {item.kitSources.join(", ")}</small>}</div></div></td><td><div className="route"><span>{item.fromWarehouse.code}</span><b>→</b><span>{item.toWarehouse.code}</span><strong>{number.format(item.quantity)} units</strong></div></td><td><div className="two-line"><span><i>{item.fromWarehouse.code}</i>{number.format(item.fromAvailable)}</span><span><i>{item.toWarehouse.code}</i>{number.format(item.toAvailable)}</span></div></td><td><div className="demand-bars"><span><i>{item.fromWarehouse.code}</i><b><em style={{ width: `${fromShare}%` }} /></b><small>{fromShare}%</small></span><span><i>{item.toWarehouse.code}</i><b><em style={{ width: `${toShare}%` }} /></b><small>{toShare}%</small></span></div></td><td><div className="two-line coverage"><span><i>{item.fromWarehouse.code}</i>{item.projectedFromDays === null ? "No demand" : `${item.projectedFromDays} days`}</span><span><i>{item.toWarehouse.code}</i>{item.projectedToDays === null ? "No demand" : `${item.projectedToDays} days`}</span></div></td><td><span className={`confidence ${item.confidence.toLowerCase()}`}>{item.confidence}</span><button className="reason" title={item.reason}>Why?</button></td></tr>;
}
