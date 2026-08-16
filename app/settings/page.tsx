"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Provider = "openai" | "anthropic";
type Status = {
  available: boolean;
  configured: boolean;
  provider: Provider | null;
  model: string | null;
  maskedApiKey: string | null;
  updatedAt: string | null;
};

const defaults: Record<Provider, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-5",
};

export default function SettingsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState(defaults.openai);
  const [apiKey, setApiKey] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadStatus() {
    const response = await fetch("/api/settings/ai");
    const payload = await response.json();
    setStatus(payload);
    if (payload.provider) setProvider(payload.provider);
    if (payload.model) setModel(payload.model);
  }

  useEffect(() => {
    fetch("/api/settings/ai")
      .then((response) => response.json())
      .then((payload) => {
        setStatus(payload);
        if (payload.provider) setProvider(payload.provider);
        if (payload.model) setModel(payload.model);
      })
      .catch(() => setError("Unable to load AI settings"));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPassword, provider, model, apiKey: apiKey || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setStatus(payload);
      setApiKey("");
      setMessage("AI settings saved. The key is encrypted and ready for inventory reviews.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save AI settings");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/settings/ai", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPassword }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      await loadStatus();
      setMessage("AI provider removed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to remove AI settings");
    } finally {
      setSaving(false);
    }
  }

  return <main className="settings-page"><Link className="back-link" href="/">← Back to load balancing</Link><div className="settings-card"><p className="eyebrow">Administrator settings</p><h1>AI analysis</h1><p className="settings-intro">Add one provider for an optional second opinion on the deterministic transfer plan. Product, demand, inventory, exclusion totals, and warehouse names are sent only when you click <strong>Analyze with AI</strong>. No customer addresses or order-level data are sent.</p>{status?.configured && <div className="configured-banner"><span className="status-dot" /><div><strong>{status.provider === "openai" ? "OpenAI" : "Anthropic"} connected</strong><small>{status.model} · {status.maskedApiKey}</small></div></div>}{status && !status.available && <div className="notice error">Server-side AI encryption or administrator settings are not configured.</div>}<div className="settings-form"><label>Provider<select value={provider} onChange={(event) => { const next = event.target.value as Provider; setProvider(next); setModel(defaults[next]); }}><option value="openai">OpenAI API</option><option value="anthropic">Anthropic API</option></select></label><label>Model ID<input value={model} onChange={(event) => setModel(event.target.value)} /></label><label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status?.configured ? `Leave blank to keep ${status.maskedApiKey}` : "Paste provider API key"} autoComplete="off" /></label><label>Settings administrator password<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="current-password" /></label></div>{error && <div className="notice error">{error}</div>}{message && <div className="notice success">{message}</div>}<div className="settings-actions"><button className="analyze" onClick={save} disabled={saving || !adminPassword || !model}>{saving ? "Saving…" : "Save AI settings"}</button>{status?.configured && <button className="danger-button" onClick={remove} disabled={saving || !adminPassword}>Remove provider</button>}</div><div className="security-note"><strong>Security</strong><p>The provider key is AES-256-GCM encrypted before storage in Redis. It is never returned to this page, written to logs, or included in browser code. AI calls require the settings administrator password and are rate-limited.</p></div></div></main>;
}
