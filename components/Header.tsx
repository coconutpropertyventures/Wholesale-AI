"use client";

import { useEffect, useState } from "react";
import { fetchGhlConfigured } from "@/components/api";

/**
 * Top bar: product name + live integration status.
 * HighLevel reflects the server's /api/ghl/contacts `configured` flag.
 * Gmail and Google Voice are NOT wired in this milestone — they say so.
 */
export default function Header() {
  const [ghl, setGhl] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGhlConfigured()
      .then((v) => {
        if (!cancelled) setGhl(v);
      })
      .catch(() => {
        if (!cancelled) setGhl(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <h1>Wholesale AI</h1>
        <span className="org">Coconut Property Ventures</span>
      </div>
      <div className="pills" aria-label="Integration status">
        <span className={`pill ${ghl === null ? "" : ghl ? "ok" : "warn"}`}>
          <span className="dot" />
          HighLevel
          <small>
            {ghl === null
              ? "checking…"
              : ghl
                ? "connected"
                : "not configured"}
          </small>
        </span>
        <span className="pill warn">
          <span className="dot" />
          Gmail <small>setup required</small>
        </span>
        <span className="pill warn">
          <span className="dot" />
          Google Voice <small>setup required</small>
        </span>
      </div>
    </header>
  );
}
