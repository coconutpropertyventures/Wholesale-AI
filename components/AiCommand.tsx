"use client";

import { useState } from "react";

/**
 * AI command box. POSTs to /api/ai/command. With a provider key configured
 * server-side (Anthropic / OpenAI / Gemini) the answer comes from that
 * model; otherwise the API answers from Bradley's approved templates and
 * the result is badged "rule-based (no AI key configured)". Drafts only —
 * the AI never sends.
 */
interface AiResponse {
  text: string;
  provider: string;
  ruleBased: boolean;
  note?: string;
}

export default function AiCommand() {
  const [command, setCommand] = useState("");
  const [response, setResponse] = useState<AiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!command.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command.trim() }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          (data as { error?: string })?.error ??
          `AI command failed (${res.status})`;
        throw new Error(msg);
      }
      setResponse(data as AiResponse);
    } catch (err) {
      setResponse(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="AI command">
      <h2>AI Command</h2>
      <div className="field">
        <label htmlFor="ai-command">Ask for a draft</label>
        <textarea
          id="ai-command"
          className="ta"
          style={{ minHeight: 64 }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder='e.g. "Draft an opener for Debra at 2309 S Meridian St"'
        />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => void run()} disabled={busy}>
          {busy ? "Working…" : "Run command"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {response && (
        <div>
          <div className="ai-out">{response.text}</div>
          <p className="muted" style={{ marginTop: 6 }}>
            {response.ruleBased ? (
              <span className="badge unverified">
                rule-based (no AI key configured)
              </span>
            ) : (
              <span className="badge ok">via {response.provider}</span>
            )}{" "}
            Draft only — nothing is sent from here.
            {response.note && !response.ruleBased ? ` ${response.note}` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
