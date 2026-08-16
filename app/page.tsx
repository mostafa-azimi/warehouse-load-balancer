"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AnalysisResult, ClientAccount, Recommendation } from "@/lib/types";
import type { AiAnalysis } from "@/lib/ai-analysis";

type Approval = {
  batchId: string;
  message: string;
  documents: Array<{ route: string; salesOrder: string; purchaseOrder: string; lineItems: unknown[] }>;
};

type AiStatus = {
  available: boolean;
  configured: boolean;
  provider: "openai" | "anthropic" | null;
  model: string | null;
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
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [aiAdminPassword, setAiAdminPassword] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);

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

  useEffect(() => {
    fetch("/api/settings/ai")
      .then((response) => response.json())
      .then((payload) => setAiStatus(payload))
      .catch(() => setAiStatus(null));
  }, []);

  async function analyze() {
    setLoading(true);
    setAnalysisLoading(true);
    setAnalysisProgress("Starting the data export analysis…");
    setError("");
    setApproval(null);
    try {
      const payload = await requestAnalysis(
        clientId,
        lookbackDays,
        setAnalysisProgress,
      );
      setAnalysis(payload);
      setSelected(new Set(payload.recommendations.filter((item) => item.recencyStatus !== "inactive").map((item) => item.id)));
      setAiAnalysis(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed");
    } finally {
      setLoading(false);
      setAnalysisLoading(false);
    }
  }

  async function analyzeWithAi() {
    if (!analysis) return;
    setAiLoading(true);
    setError("");
    try {
      const response = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminPassword: aiAdminPassword,
          clientId: analysis.client.id,
          lookbackDays: analysis.lookbackDays,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setAiAnalysis(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI analysis failed");
    } finally {
      setAiLoading(false);
    }
  }

  const selectedRecommendations = useMemo(
    () => analysis?.recommendations.filter((item) => selected.has(item.id)) ?? [],
    [analysis, selected],
  );
  const eligibleRecommendationIds = useMemo(
    () => analysis?.recommendations.filter((item) => item.recencyStatus !== "inactive").map((item) => item.id) ?? [],
    [analysis],
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
          <div className="connection"><span className="status-dot" /><div><strong>ShipHero connected</strong><small>{mode === "demo" ? "Demo data mode" : "SQL export mode"}</small></div></div>
          <Link className="settings" href="/settings">⚙ <span>Settings</span></Link>
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
          <div className="run-meta"><span className={`mode-pill ${analysis.mode}`}>{analysis.mode === "demo" ? "Demo analysis" : analysis.dataSource === "shipbots-export" ? "ShipHero data export" : "Live analysis"}</span><span>Generated {new Date(analysis.generatedAt).toLocaleString()}</span>{analysis.dataAsOf && <><span>·</span><span>Export updated {new Date(analysis.dataAsOf).toLocaleString()}</span></>}<span>·</span><span>Kits expanded to physical components</span></div>
          {(analysis.exclusions?.length ?? 0) > 0 && <div className="exclusion-notice"><strong>Removed from demand:</strong>{analysis.exclusions?.map((item) => <span key={item.category} title={item.signals.join(", ")}>{item.category.replace("-", " ")}: {number.format(item.orders)} order{item.orders === 1 ? "" : "s"} / {number.format(item.units)} units · {item.signals.join(", ")}</span>)}</div>}
          <section className="metrics">
            <Metric label="Units shipped" value={number.format(analysis.metrics.shippedUnits)} detail={`${analysis.lookbackDays}-day history`} />
            <Metric label="Physical demand" value={number.format(analysis.metrics.componentUnits)} detail="After kit expansion" accent />
            {analysis.metrics.recentUnits14Days !== null && <Metric label="Last 14 days" value={number.format(analysis.metrics.recentUnits14Days)} detail="Confirms current SKU use" />}
            <Metric label="SKUs analyzed" value={number.format(analysis.metrics.activeSkus)} detail={`${analysis.warehouses.length} warehouses`} />
            <Metric label="Units to rebalance" value={number.format(analysis.metrics.recommendedUnits)} detail={`${analysis.recommendations.length} recommendations`} accent />
          </section>

          <section className="recommendations">
            <div className="section-heading"><div><h2>Transfer recommendations</h2><p>Prioritized by demand imbalance and available inventory.</p></div><div className="selection-count"><strong>{selected.size}</strong> selected</div></div>
            <div className="table-wrap"><table><thead><tr><th className="check-col"><input type="checkbox" checked={eligibleRecommendationIds.length > 0 && eligibleRecommendationIds.every((id) => selected.has(id))} onChange={() => setSelected(eligibleRecommendationIds.every((id) => selected.has(id)) ? new Set() : new Set(eligibleRecommendationIds))} /></th><th>Product</th><th>Move inventory</th><th>Available now</th><th>Recent demand</th><th>After transfer</th><th>Signal</th></tr></thead>
              <tbody>{analysis.recommendations.map((item) => <RecommendationRow key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => toggle(item.id)} />)}</tbody>
            </table>{!analysis.recommendations.length && <div className="empty">Inventory already matches the selected demand window. No transfer is recommended.</div>}</div>
          </section>

          <section className="ai-panel">
            <div><p className="eyebrow">Optional second opinion</p><h2>AI inventory review</h2><p>{aiStatus?.configured ? `Use ${aiStatus.provider === "openai" ? "OpenAI" : "Anthropic"} (${aiStatus.model}) to challenge the deterministic recommendations, highlight risks, and suggest questions.` : "Add an OpenAI or Anthropic key in Settings to enable an AI review."}</p></div>
            {aiStatus?.configured ? <div className="ai-actions"><input type="password" value={aiAdminPassword} onChange={(event) => setAiAdminPassword(event.target.value)} placeholder="Settings admin password" autoComplete="current-password" /><button onClick={analyzeWithAi} disabled={aiLoading || !aiAdminPassword}>{aiLoading ? "Reviewing…" : "Analyze with AI"}</button></div> : <Link href="/settings">Configure AI →</Link>}
          </section>
          {aiAnalysis && <section className="ai-results"><div className="section-heading"><div><p className="eyebrow">{aiAnalysis.provider} · {aiAnalysis.model}</p><h2>AI review</h2><p>{aiAnalysis.summary}</p></div></div><div className="ai-result-grid"><div><h3>Priorities</h3>{aiAnalysis.priorities.map((item, index) => <article key={`${item.sku}-${index}`}><span className={`risk ${item.risk}`}>{item.risk}</span><strong>{item.sku}: {item.action}</strong><p>{item.reason}</p></article>)}</div><div><h3>Questions to confirm</h3><ul>{aiAnalysis.questions.map((item) => <li key={item}>{item}</li>)}</ul><h3>Cautions</h3><ul>{aiAnalysis.cautions.map((item) => <li key={item}>{item}</li>)}</ul></div></div></section>}

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
  return <tr className={checked ? "selected-row" : ""}><td className="check-col"><input type="checkbox" checked={checked} onChange={onToggle} /></td><td><div className="product-cell"><div className="product-thumb">{item.sku.slice(0, 2)}</div><div><strong>{item.productName}</strong><span>{item.sku}</span>{item.kitSources.length > 0 && <small className="kit-pill">Component of {item.kitSources.join(", ")}</small>}</div></div></td><td><div className="route"><span>{item.fromWarehouse.code}</span><b>→</b><span>{item.toWarehouse.code}</span><strong>{number.format(item.quantity)} units</strong></div></td><td><div className="two-line"><span><i>{item.fromWarehouse.code}</i><b>{number.format(item.fromAvailable)}</b></span><span><i>{item.toWarehouse.code}</i><b>{number.format(item.toAvailable)}</b></span></div></td><td><div className="demand-bars"><span><i>{item.fromWarehouse.code}</i><b><em style={{ width: `${fromShare}%` }} /></b><small>{fromShare}%</small></span><span><i>{item.toWarehouse.code}</i><b><em style={{ width: `${toShare}%` }} /></b><small>{toShare}%</small></span></div></td><td><div className="two-line coverage"><span><i>{item.fromWarehouse.code}</i><b>{item.projectedFromDays === null ? "No demand" : `${item.projectedFromDays} days`}</b></span><span><i>{item.toWarehouse.code}</i><b>{item.projectedToDays === null ? "No demand" : `${item.projectedToDays} days`}</b></span></div></td><td><span className={`confidence ${item.confidence.toLowerCase()}`}>{item.confidence}</span><span className={`recency ${item.recencyStatus}`}>{item.recencyStatus === "inactive" ? "No 14-day demand" : item.recencyStatus === "slowing" ? "Demand slowing" : item.recencyStatus === "active" ? "Recently active" : "Recency unknown"}</span><details className="reason-details"><summary>Why?</summary><div><strong>Balance signal</strong><p>{item.reason}</p><strong>14-day check</strong><p>{item.recencyReason}</p>{item.kitSources.length > 0 && <><strong>Kit impact</strong><p>Physical component used by {item.kitSources.join(", ")}.</p></>}</div></details></td></tr>;
}
