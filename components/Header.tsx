"use client";

import { useEffect, useState } from "react";
import {
  fetchGhlConfigured,
  fetchGmailStatus,
  type GmailStatus,
} from "@/components/api";

/**
 * Top bar: product name + live integration status.
 * HighLevel reflects the server's /api/ghl/contacts `configured` flag.
 * Gmail reflects /api/gmail/status: connected (with the account email)
 * once the user has run the OAuth connect flow; "connect" — a link into
 * that flow — when the server has Google credentials but no session yet;
 * "setup required" when no Google client is configured server-side.
 * Google Voice is not wired (no official API) and says so.
 */
export default function Header() {
  const [ghl, setGhl] = useState<boolean | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGhlConfigured()
      .then((v) => {
        if (!cancelled) setGhl(v);
      })
      .catch(() => {
        if (!cancelled) setGhl(false);
      });
    fetchGmailStatus()
      .then((v) => {
        if (!cancelled) setGmail(v);
      })
      .catch(() => {
        if (!cancelled) setGmail({ configured: false, connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gmailPill = (() => {
    if (gmail === null) {
      return (
        <span className="pill">
          <span className="dot" />
          Gmail <small>checking…</small>
        </span>
      );
    }
    if (gmail.connected) {
      return (
        <span className="pill ok">
          <span className="dot" />
          Gmail <small>connected{gmail.email ? ` ${gmail.email}` : ""}</small>
        </span>
      );
    }
    if (gmail.configured) {
      return (
        <a className="pill warn" href="/api/gmail/connect">
          <span className="dot" />
          Gmail <small>connect</small>
        </a>
      );
    }
    return (
      <span className="pill warn">
        <span className="dot" />
        Gmail <small>setup required</small>
      </span>
    );
  })();

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
        {gmailPill}
        <span className="pill warn">
          <span className="dot" />
          Google Voice <small>setup required</small>
        </span>
      </div>
    </header>
  );
}
