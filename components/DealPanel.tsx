"use client";

import { useRef, useState } from "react";
import type { DealMode, UnderwritingResult } from "@/lib/underwriting/model";
import type { DealPrefill } from "@/lib/deals/prefill";
import {
  firstMessageTemplate,
  offerMessage,
  personalize,
} from "@/lib/comms/scripts";
import {
  createBlastRun,
  createDraft,
  createOutcome,
  draftOfferAi,
  fetchCachedPhotos,
  fetchComps,
  fetchPropertyDetail,
  fmtMoney,
  fmtPct,
  lookupListing,
  searchRedfinListings,
  verifyRentcast,
  type BlastRunDetailData,
  type CompsResult,
  type SearchFilters,
  type VerifyResult,
} from "@/components/api";
import { fillMissingPrefill } from "@/lib/deals/prefill";

/**
 * Property Workbench — the top of the page.
 * 1. Listing data: paste a Zillow/Redfin link (Apify, cache-first) or run
 *    a Redfin search and load a result card — both prefill the form.
 *    "Run underwriting" completes the record first (cache merge + one
 *    detail pull, cached as "apify-detail") so every field the data can
 *    supply lands in the form, then underwrites. In Turnkey mode it
 *    also pulls auto-comps (sold + rentals within 0.5 mi, past 12
 *    months) whose suggested rent / MV prefill the inputs (editable).
 *    All expense assumptions (taxes, insurance, HOA, vacancy,
 *    management, maintenance, capex) are editable inputs.
 * 2. Underwriting for the page-level mode (Turnkey / Traditional
 *    Wholesale / Land), full transparent result with UNVERIFIED flags.
 * 3. Realtor messages: "Draft first message" (approved opener template,
 *    NO offer number) and "Draft offer message" (after intake; template
 *    or AI-personalized). Saving creates a Draft + a learning-loop
 *    outcome row.
 * 4. Results toolbar (above the Zillow/Redfin result cards): "Send to
 *    all" builds a blast run from the whole result list with the
 *    turnkey opener and auto-approves it — the click is Bradley's
 *    explicit send instruction for that list; the blast engine's
 *    exclusions and pacing rails still apply. "Select properties"
 *    toggles the per-card blast checkboxes; the selected set builds a
 *    review-path run (draft, approved in the Blast panel).
 *    A filter bar (min/max price, min DOM, min beds/baths) narrows
 *    results server-side on the pulled rows — no extra pull. Result
 *    cards preview listing photos on hover: cache-first, with at most
 *    ONE on-demand detail pull per property per session — never a
 *    bulk prefetch.
 * 5. RentCast verification — visible only when the deal is marked under
 *    contract; the server enforces the gate regardless.
 */

const INPUT_LABELS: Record<string, string> = {
  monthlyRent: "Monthly rent",
  annualTaxes: "Annual taxes",
  annualInsurance: "Annual insurance",
  marketValue: "Market value (MV, reference only)",
  arv: "ARV",
  repairEstimate: "Repair estimate",
  landCompValue: "Land comp value",
};

const ASSUMPTION_LABELS: Record<string, string> = {
  vacancy: "Vacancy",
  management: "Management",
  maintenance: "Maintenance",
  capex: "Capex reserve",
  targetCapRate: "Target cap rate",
  targetFee: "Target fee",
  annualTaxes: "Annual taxes used",
  annualInsurance: "Annual insurance used",
  arvRule: "ARV rule",
  repairs: "Repairs",
  landFactor: "Land factor",
  wholesalePercent: "Wholesale % of ARV",
  arv: "ARV",
};

type Fields = {
  address: string;
  agentFirstName: string;
  street: string;
  listPrice: string;
  monthlyRent: string;
  annualTaxes: string;
  annualInsurance: string;
  monthlyHoa: string;
  vacancyPct: string;
  managementPct: string;
  maintenancePct: string;
  capexPct: string;
  marketValue: string;
  dom: string;
  priceCuts: string;
  arv: string;
  repairEstimate: string;
  wholesalePct: string;
  landCompValue: string;
};

const EMPTY: Fields = {
  address: "",
  agentFirstName: "",
  street: "",
  listPrice: "",
  monthlyRent: "",
  annualTaxes: "",
  annualInsurance: "",
  monthlyHoa: "",
  vacancyPct: "8",
  managementPct: "10",
  maintenancePct: "8",
  capexPct: "8",
  marketValue: "",
  dom: "",
  priceCuts: "",
  arv: "",
  repairEstimate: "",
  wholesalePct: "70",
  landCompValue: "",
};

interface ListingFacts {
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  sourceLabel: string;
}

function num(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

function assumptionValue(v: number | string): string {
  if (typeof v === "string") return v;
  if (v > 0 && v < 1) return fmtPct(v);
  return fmtMoney(v);
}

const MODE_TITLES: Record<string, string> = {
  turnkey: "Turnkey rental",
  traditional: "Traditional wholesale",
  land: "Vacant land",
  flip: "Fix & flip",
};

export default function DealPanel({
  mode,
  selectedListings = [],
  onToggleListing,
  onBlastRunCreated,
}: {
  mode: DealMode;
  /** Workbench properties checked for a blast run (page-level state,
   *  shared with the Blast panel). Identity is the property address. */
  selectedListings?: DealPrefill[];
  onToggleListing?: (property: DealPrefill, checked: boolean) => void;
  /** A blast run was just built from the results (either path) — the
   *  page scrolls to / focuses the Blast panel on it. */
  onBlastRunCreated?: (detail: BlastRunDetailData) => void;
}) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [result, setResult] = useState<UnderwritingResult | null>(null);
  const [uwError, setUwError] = useState<string | null>(null);
  const [uwBusy, setUwBusy] = useState(false);

  // Listing data state
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [facts, setFacts] = useState<ListingFacts | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<DealPrefill[]>([]);

  // Search filters (price / DOM / beds / baths), applied server-side
  // to the pulled rows before the display slice — they never cost an
  // extra pull, and they take effect on the next Search click (each
  // search is a fresh, 500-capped pull by design). Deliberately NO
  // price-reduced filter: the search rows carry no reduction signal
  // (verified across 315 real rows), and faking one is not an option.
  const [fltMinPrice, setFltMinPrice] = useState("");
  const [fltMaxPrice, setFltMaxPrice] = useState("");
  const [fltMinDom, setFltMinDom] = useState("");
  const [fltMinBeds, setFltMinBeds] = useState("");
  const [fltMinBaths, setFltMinBaths] = useState("");

  // Hover photo previews, keyed by property address. A property is
  // asked about at most once per session (photoAskedRef): cache read
  // first, then — only on real hover intent — the ONE on-demand
  // detail pull behind POST /api/deals/detail. Nothing is ever
  // bulk-prefetched.
  type PhotoState =
    | { status: "loading" }
    | { status: "ready"; photos: string[]; index: number }
    | { status: "empty" };
  const [photoByAddr, setPhotoByAddr] = useState<Record<string, PhotoState>>({});
  const [photoVisibleFor, setPhotoVisibleFor] = useState<string | null>(null);
  const photoAskedRef = useRef<Set<string>>(new Set());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Results toolbar (blast) state
  const [selectionMode, setSelectionMode] = useState(false);
  const [blastBusy, setBlastBusy] = useState<"all" | "selected" | null>(null);
  const [blastNote, setBlastNote] = useState<string | null>(null);
  const [blastError, setBlastError] = useState<string | null>(null);

  // Auto-comps state (turnkey mode only): fetched once per loaded
  // property; suggestions prefill the rent / MV inputs (still editable).
  const [comps, setComps] = useState<CompsResult | null>(null);
  const [compsBusy, setCompsBusy] = useState(false);
  const [compsError, setCompsError] = useState<string | null>(null);
  const compsForRef = useRef<string | null>(null);
  const fRef = useRef(f);
  fRef.current = f;
  const resultRef = useRef(result);
  resultRef.current = result;

  // Fullest-record state: Run Underwriting first completes the
  // property record (cache merge + one detail pull) so every field
  // the data can supply lands in the form.
  const [prepareBusy, setPrepareBusy] = useState(false);
  const detailForRef = useRef<Set<string>>(new Set());
  const loadedRef = useRef<DealPrefill | null>(null);

  // Message drafting state
  const [offerOverride, setOfferOverride] = useState("");
  const [offerText, setOfferText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [intakeReceived, setIntakeReceived] = useState(false);
  const [pendingVariant, setPendingVariant] = useState<"first" | "offer" | null>(null);
  const [pendingOffer, setPendingOffer] = useState<number | undefined>(undefined);
  const [savedSignature, setSavedSignature] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  // RentCast verification state
  const [underContract, setUnderContract] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  function set<K extends keyof Fields>(key: K, value: string) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  function onAddressBlur() {
    if (!f.street.trim() && f.address.includes(",")) {
      set("street", f.address.split(",")[0].trim());
    } else if (!f.street.trim()) {
      set("street", f.address.trim());
    }
  }

  // ---------- Results toolbar: blast from the result list ----------

  /**
   * "Send to all" — build a blast run from EVERY property in the
   * current result list with the turnkey opener and auto-approve it.
   * This click is Bradley's explicit send instruction for the list;
   * the engine's exclusions (no phone, DND, suppressed, recently
   * contacted) and pacing rails apply unchanged.
   */
  async function sendToAll() {
    if (searchResults.length === 0) return;
    setBlastBusy("all");
    setBlastNote(null);
    setBlastError(null);
    try {
      const detail = await createBlastRun({
        source: "search",
        properties: searchResults as unknown[],
        scriptKey: "turnkey_opener",
        autoApprove: true,
      });
      const excluded = detail.counts.total - detail.counts.queued;
      setBlastNote(
        `Blast approved — ${detail.counts.queued} ready of ${detail.counts.total} in this list (${excluded} excluded by safety checks). It sends in the background from the Blast panel below; you can close this tab.`,
      );
      onBlastRunCreated?.(detail);
    } catch (err) {
      setBlastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBlastBusy(null);
    }
  }

  /** "Create blast from selected (N)" — review path: the run stays a
   *  draft until Bradley approves it in the Blast panel. */
  async function createFromSelected() {
    if (selectedListings.length === 0) return;
    setBlastBusy("selected");
    setBlastNote(null);
    setBlastError(null);
    try {
      const detail = await createBlastRun({
        source: "search",
        properties: selectedListings as unknown[],
        scriptKey: "turnkey_opener",
      });
      setBlastNote(
        `Draft blast built from ${selectedListings.length} selected ${selectedListings.length === 1 ? "property" : "properties"} — review it in the Blast panel below and click Approve there to send.`,
      );
      onBlastRunCreated?.(detail);
    } catch (err) {
      setBlastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBlastBusy(null);
    }
  }

  // ---------- Underwriting ----------

  function buildBody(fields: Fields): Record<string, unknown> | null {
    const listPrice = num(fields.listPrice);
    if (listPrice === undefined || listPrice <= 0) return null;
    const body: Record<string, unknown> = { mode, listPrice };
    const put = (key: string, v: number | undefined) => {
      if (v !== undefined) body[key] = v;
    };
    put("dom", num(fields.dom));
    put("priceCuts", num(fields.priceCuts));
    if (mode === "turnkey") {
      put("monthlyRent", num(fields.monthlyRent));
      put("annualTaxes", num(fields.annualTaxes));
      put("annualInsurance", num(fields.annualInsurance));
      put("monthlyHoa", num(fields.monthlyHoa));
      put("marketValue", num(fields.marketValue));
      // Editable expense rates: the form holds percents, the model
      // takes fractions of gross rent (absent → standing defaults).
      const putRate = (key: string, v: string) => {
        const n = num(v);
        if (n !== undefined) body[key] = n / 100;
      };
      putRate("vacancyRate", fields.vacancyPct);
      putRate("managementRate", fields.managementPct);
      putRate("maintenanceRate", fields.maintenancePct);
      putRate("capexRate", fields.capexPct);
    } else if (mode === "traditional" || mode === "flip") {
      put("arv", num(fields.arv));
      put("repairEstimate", num(fields.repairEstimate));
      if (mode === "traditional") {
        const pct = num(fields.wholesalePct);
        if (pct !== undefined) body.wholesalePercent = pct / 100;
      }
    } else if (mode === "land") {
      put("landCompValue", num(fields.landCompValue));
    }
    return body;
  }

  async function runWith(fields: Fields) {
    setUwError(null);
    const body = buildBody(fields);
    if (!body) {
      setUwError("List price is required and must be a positive number.");
      return;
    }
    setUwBusy(true);
    try {
      const res = await fetch("/api/underwrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          (data as { error?: string })?.error ??
          `Underwriting failed (${res.status})`;
        throw new Error(msg);
      }
      setResult(data as UnderwritingResult);
      setOfferOverride("");
    } catch (err) {
      setResult(null);
      setUwError(err instanceof Error ? err.message : String(err));
    } finally {
      setUwBusy(false);
    }
  }

  // ---------- Listing data ----------

  function applyPrefill(p: DealPrefill, sourceLabel: string) {
    const next: Fields = {
      ...f,
      address: p.address ?? f.address,
      street:
        f.street.trim() ||
        (p.address ? p.address.split(",")[0].trim() : f.street),
      listPrice: p.listPrice !== undefined ? str(p.listPrice) : f.listPrice,
      monthlyRent:
        p.rentEstimate !== undefined ? str(p.rentEstimate) : f.monthlyRent,
      annualTaxes:
        p.annualTaxes !== undefined ? str(p.annualTaxes) : f.annualTaxes,
      annualInsurance:
        p.annualInsurance !== undefined
          ? str(p.annualInsurance)
          : f.annualInsurance,
      monthlyHoa:
        p.hoaMonthly !== undefined ? str(p.hoaMonthly) : f.monthlyHoa,
      marketValue:
        p.valueEstimate !== undefined ? str(p.valueEstimate) : f.marketValue,
      arv:
        mode === "traditional" && p.valueEstimate !== undefined
          ? str(p.valueEstimate)
          : f.arv,
      dom: p.daysOnMarket !== undefined ? str(p.daysOnMarket) : f.dom,
    };
    setF(next);
    setFacts({
      beds: p.beds,
      baths: p.baths,
      sqft: p.sqft,
      yearBuilt: p.yearBuilt,
      sourceLabel,
    });
    // Loading a property into the turnkey workbench kicks off the
    // auto-comps pull (once per property; the strip has a re-run).
    if (mode === "turnkey" && p.address) {
      void fetchCompsFor(p.address);
    }
    return next;
  }

  /**
   * Pull auto-comps for a loaded turnkey property and prefill the rent
   * and MV inputs from the suggestions. Values stay fully editable;
   * when a result is already on screen it is re-run against the
   * comped inputs so the displayed numbers match the form.
   */
  async function fetchCompsFor(address: string, force = false) {
    const addr = address.trim();
    if (!addr) return;
    if (!force && compsForRef.current === addr) return;
    compsForRef.current = addr;
    setCompsBusy(true);
    setCompsError(null);
    setComps(null);
    try {
      const res = await fetchComps(addr);
      if (!res.ok) throw new Error(res.reason ?? "Comps pull failed.");
      setComps(res);
      if (res.suggestedRent !== null || res.suggestedMV !== null) {
        const next: Fields = {
          ...fRef.current,
          monthlyRent:
            res.suggestedRent !== null
              ? str(res.suggestedRent)
              : fRef.current.monthlyRent,
          marketValue:
            res.suggestedMV !== null
              ? str(res.suggestedMV)
              : fRef.current.marketValue,
        };
        setF(next);
        if (resultRef.current) await runWith(next);
      }
    } catch (err) {
      compsForRef.current = null; // a failed pull may be retried
      setCompsError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompsBusy(false);
    }
  }

  async function runLinkLookup() {
    const value = linkUrl.trim();
    if (!value) return;
    // A place typed into the link box is the common mix-up — point at
    // the search box instead of surfacing a parser error.
    const looksLikeUrl =
      /^https?:\/\//i.test(value) || /(zillow|redfin)\.com/i.test(value);
    if (!looksLikeUrl) {
      setLinkError(
        "That looks like a place, not a listing link — use “Search by city or ZIP” instead.",
      );
      return;
    }
    setLinkBusy(true);
    setLinkNote(null);
    setLinkError(null);
    try {
      const res = await lookupListing(linkUrl.trim());
      if (!res.ok || !res.prefill) {
        throw new Error(res.reason ?? "Lookup failed.");
      }
      loadedRef.current = res.prefill;
      applyPrefill(
        res.prefill,
        res.prefill.source === "redfin" ? "Redfin listing data" : "Zillow listing data",
      );
      if (res.configured === false) {
        setLinkNote(
          "Listing data is not configured on the server (no Apify token) — only the address from the link was prefilled. Everything else is UNVERIFIED.",
        );
      } else if (res.found === false) {
        setLinkNote(
          "No listing match found — only the address from the link was prefilled.",
        );
      } else {
        setLinkNote(
          res.cached
            ? "Prefilled from cached listing data (pulled once, not re-billed)."
            : "Prefilled from listing data.",
        );
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkBusy(false);
    }
  }

  function currentFilters(): SearchFilters {
    const out: SearchFilters = {};
    const put = (key: keyof SearchFilters, v: string) => {
      const n = num(v);
      if (n !== undefined && n >= 0) out[key] = n;
    };
    put("minPrice", fltMinPrice);
    put("maxPrice", fltMaxPrice);
    put("minDom", fltMinDom);
    put("minBeds", fltMinBeds);
    put("minBaths", fltMinBaths);
    return out;
  }

  const anyFilterSet =
    [fltMinPrice, fltMaxPrice, fltMinDom, fltMinBeds, fltMinBaths].some(
      (v) => v.trim() !== "",
    );

  function clearFilters() {
    setFltMinPrice("");
    setFltMaxPrice("");
    setFltMinDom("");
    setFltMinBeds("");
    setFltMinBaths("");
  }

  async function runSearch() {
    if (!searchQuery.trim() || searchBusy) return;
    setSearchBusy(true);
    setSearchNote(null);
    setSearchError(null);
    setSearchResults([]);
    setPhotoVisibleFor(null);
    const filters = currentFilters();
    const filtersActive = Object.keys(filters).length > 0;
    try {
      const res = await searchRedfinListings(searchQuery.trim(), filters);
      if (!res.ok) throw new Error(res.reason ?? "Search failed.");
      if (res.configured === false) {
        setSearchNote(
          "Redfin search is not configured on the server (no Apify token). No results are shown rather than invented ones.",
        );
        return;
      }
      setSearchResults(res.results);
      const pulled = res.totalReturned ?? res.results.length;
      const matched = res.totalMatched ?? res.results.length;
      if (res.results.length === 0) {
        setSearchNote(
          pulled > 0 && filtersActive
            ? `No listings matched those filters (${pulled} pulled, cap 500). Loosen a filter and search again.`
            : "No listings returned for that search.",
        );
      } else {
        setSearchNote(
          `${res.results.length} shown of ${matched} matching (${pulled} pulled, cap 500) — “Run underwriting” loads one into the calculator from the cache.`,
        );
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchBusy(false);
    }
  }

  // ---------- Hover photo previews ----------

  /**
   * Resolve a card's photos, at most once per property per session:
   * the cache read first (free), then — when the cache has none — the
   * single on-demand detail pull (POST /api/deals/detail), whose
   * merged record carries the photos from that pull. A property whose
   * detail has no photos is remembered as "empty" and never re-asked.
   */
  async function ensurePhotos(p: DealPrefill) {
    const addr = p.address;
    if (!addr || photoAskedRef.current.has(addr)) return;
    photoAskedRef.current.add(addr);
    setPhotoByAddr((prev) => ({ ...prev, [addr]: { status: "loading" } }));
    try {
      const cached = await fetchCachedPhotos(addr);
      if (cached.photos.length > 0) {
        setPhotoByAddr((prev) => ({
          ...prev,
          [addr]: { status: "ready", photos: cached.photos, index: 0 },
        }));
        return;
      }
      const res = await fetchPropertyDetail({
        address: addr,
        sourceUrl: p.sourceUrl,
        prefill: p,
      });
      const photos = res.ok ? (res.prefill?.photos ?? []) : [];
      setPhotoByAddr((prev) => ({
        ...prev,
        [addr]:
          photos.length > 0
            ? { status: "ready", photos, index: 0 }
            : { status: "empty" },
      }));
    } catch {
      setPhotoByAddr((prev) => ({ ...prev, [addr]: { status: "empty" } }));
    }
  }

  function onCardEnter(p: DealPrefill) {
    if (!p.address) return;
    const addr = p.address;
    // Photos already resolved this session show instantly; otherwise
    // the preview (and its one allowed pull) waits for ~600ms of real
    // hover intent so a mouse skimming the grid pulls nothing.
    if (photoByAddr[addr]?.status === "ready" || photoByAddr[addr]?.status === "empty") {
      setPhotoVisibleFor(addr);
      return;
    }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setPhotoVisibleFor(addr);
      void ensurePhotos(p);
    }, 600);
  }

  function onCardLeave(p: DealPrefill) {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (p.address && photoVisibleFor === p.address) setPhotoVisibleFor(null);
  }

  /** Touch path: the Photos button is an explicit tap — no intent
   *  delay, and tapping again hides the preview. */
  function togglePhotos(p: DealPrefill) {
    if (!p.address) return;
    if (photoVisibleFor === p.address) {
      setPhotoVisibleFor(null);
      return;
    }
    setPhotoVisibleFor(p.address);
    void ensurePhotos(p);
  }

  function stepPhoto(addr: string, delta: number) {
    setPhotoByAddr((prev) => {
      const st = prev[addr];
      if (!st || st.status !== "ready") return prev;
      const index =
        (st.index + delta + st.photos.length) % st.photos.length;
      return { ...prev, [addr]: { ...st, index } };
    });
  }

  /**
   * The fullest record for a property: the server merges the passed
   * record with the cached record and — when key fields are still
   * missing — pulls the listing DETAIL record once (cached server-side
   * as "apify-detail"). Any failure falls back to the record in hand;
   * completing the details never blocks underwriting.
   */
  async function ensureFullDetails(p: DealPrefill): Promise<DealPrefill> {
    if (!p.address) return p;
    if (detailForRef.current.has(p.address)) return p;
    detailForRef.current.add(p.address);
    try {
      const res = await fetchPropertyDetail({
        address: p.address,
        sourceUrl: p.sourceUrl,
        prefill: p,
      });
      if (res.ok && res.prefill) {
        return fillMissingPrefill(p, res.prefill);
      }
    } catch {
      // fall through with the record we have
    }
    return p;
  }

  /** applyPrefill's value mapping, but only into fields still blank —
   *  used when Run Underwriting completes the record for a property
   *  whose form the operator may already have edited by hand. */
  function fillBlankFields(current: Fields, p: DealPrefill): Fields {
    const blank = (cur: string, v: number | undefined) =>
      cur.trim() !== "" ? cur : str(v);
    return {
      ...current,
      listPrice: blank(current.listPrice, p.listPrice),
      monthlyRent: blank(current.monthlyRent, p.rentEstimate),
      annualTaxes: blank(current.annualTaxes, p.annualTaxes),
      annualInsurance: blank(current.annualInsurance, p.annualInsurance),
      monthlyHoa: blank(current.monthlyHoa, p.hoaMonthly),
      marketValue: blank(current.marketValue, p.valueEstimate),
      arv:
        mode === "traditional"
          ? blank(current.arv, p.valueEstimate)
          : current.arv,
      dom: blank(current.dom, p.daysOnMarket),
    };
  }

  async function loadAndUnderwrite(p: DealPrefill) {
    loadedRef.current = p;
    setPrepareBusy(true);
    try {
      const full = await ensureFullDetails(p);
      loadedRef.current = full;
      const next = applyPrefill(
        full,
        p.source === "redfin" ? "Redfin search result" : "Zillow listing data",
      );
      await runWith(next);
    } finally {
      setPrepareBusy(false);
    }
  }

  /**
   * The form's Run underwriting button: when the form still shows the
   * loaded property, complete its record first (detail merge into the
   * blank fields only) so the run has everything the data can supply;
   * comps run for the address as well (deduped per property).
   */
  async function runFormUnderwriting() {
    const addr = f.address.trim();
    const loaded = loadedRef.current;
    if (loaded && addr && loaded.address === addr) {
      setPrepareBusy(true);
      try {
        const full = await ensureFullDetails(loaded);
        if (full !== loaded) {
          loadedRef.current = full;
          const filled = fillBlankFields(f, full);
          setF(filled);
          if (facts === null || facts.sqft === undefined) {
            setFacts({
              beds: full.beds,
              baths: full.baths,
              sqft: full.sqft,
              yearBuilt: full.yearBuilt,
              sourceLabel:
                full.source === "redfin"
                  ? "Redfin listing data"
                  : "Zillow listing data",
            });
          }
          await runWith(filled);
          return;
        }
      } finally {
        setPrepareBusy(false);
      }
    }
    await runWith(f);
    if (mode === "turnkey" && addr) void fetchCompsFor(addr);
  }

  // ---------- Messages ----------

  const pencils =
    result !== null && result.assignmentFee > 0 && result.mao > 0;

  function currentOffer(): number | undefined {
    if (!result) return undefined;
    const override = num(offerOverride);
    return override ?? result.initialOffer ?? result.suggestedContract;
  }

  function requireAgentFields(): boolean {
    if (!f.agentFirstName.trim() || !f.street.trim()) {
      setOfferError("Agent first name and street are required to draft a message.");
      return false;
    }
    return true;
  }

  function draftFirstMessage() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    const text = personalize(firstMessageTemplate(mode), {
      first: f.agentFirstName.trim(),
      street: f.street.trim(),
    });
    setOfferText(text);
    setPendingVariant("first");
    setPendingOffer(undefined);
  }

  function fillOfferTemplate() {
    const offer = currentOffer();
    if (offer === undefined) return;
    const text = offerMessage(
      f.agentFirstName.trim(),
      f.street.trim(),
      fmtMoney(offer),
    );
    setOfferText(text);
    setPendingVariant("offer");
    setPendingOffer(offer);
  }

  function draftOfferTemplate() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    if (!intakeReceived) {
      setOfferError("Offer messages go out after intake — tick “Intake answers received” first.");
      return;
    }
    setOfferBusy(true);
    try {
      fillOfferTemplate();
    } finally {
      setOfferBusy(false);
    }
  }

  async function draftOfferAiFlow() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    if (!intakeReceived) {
      setOfferError("Offer messages go out after intake — tick “Intake answers received” first.");
      return;
    }
    if (!recipient.trim()) {
      setOfferError("Recipient (phone or email) is required for the AI draft — it saves straight into the drafts queue.");
      return;
    }
    const offer = currentOffer();
    if (offer === undefined || !result) return;
    setAiBusy(true);
    try {
      const res = await draftOfferAi({
        address: f.address.trim() || f.street.trim(),
        street: f.street.trim(),
        first: f.agentFirstName.trim(),
        offer,
        mode,
        fee: result.assignmentFee,
        to: recipient.trim(),
      });
      if (res.ok && res.text) {
        setOfferText(res.text);
        setPendingVariant(null);
        setSavedSignature(res.text);
        const cost = res.usage?.estCostUsd;
        setSaveNote(
          `AI draft saved to the queue${res.model ? ` (${res.model}${cost !== undefined ? ` · est. $${cost.toFixed(4)}` : ""})` : ""}. It will NOT send — approve it in the Drafts list.`,
        );
        window.dispatchEvent(new Event("drafts:refresh"));
      } else if (res.configured === false) {
        setSaveNote("AI drafting is not configured on the server (no Anthropic key) — filled the approved template instead.");
        fillOfferTemplate();
      } else if (res.reason === "budget") {
        setSaveNote("This month's AI drafting budget is used up — filled the approved template instead.");
        fillOfferTemplate();
      } else {
        setSaveNote("AI drafting failed — filled the approved template instead.");
        fillOfferTemplate();
      }
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  }

  async function saveDraft() {
    setOfferError(null);
    setSaveNote(null);
    if (!offerText.trim()) {
      setOfferError("Draft or write a message before saving.");
      return;
    }
    if (offerText === savedSignature) {
      setOfferError("This exact text is already saved as a draft.");
      return;
    }
    if (!recipient.trim()) {
      setOfferError("Recipient (phone or email) is required to save a draft.");
      return;
    }
    setSaveBusy(true);
    try {
      const draft = await createDraft({
        feed: "ghl",
        to: recipient.trim(),
        body: offerText,
      });
      // Learning-loop seed: log workbench drafts with their deal context.
      if (pendingVariant) {
        try {
          await createOutcome({
            draftId: draft.id,
            address: f.address.trim() || f.street.trim(),
            mode,
            variant: pendingVariant,
            body: offerText,
            offerAmount: pendingVariant === "offer" ? pendingOffer : undefined,
          });
        } catch {
          // logging must never block the draft itself
        }
      }
      setSavedSignature(offerText);
      setPendingVariant(null);
      setSaveNote(
        "Draft saved. It will NOT send from here — approve it in the Drafts list below to queue it for the sending flow.",
      );
      window.dispatchEvent(new Event("drafts:refresh"));
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  }

  // ---------- RentCast verification ----------

  async function runVerify() {
    if (!f.address.trim()) {
      setVerifyError("Enter the property address first.");
      return;
    }
    setVerifyBusy(true);
    setVerify(null);
    setVerifyError(null);
    try {
      const res = await verifyRentcast(f.address.trim());
      setVerify(res);
      if (!res.ok && res.reason && res.reason !== "not_under_contract") {
        setVerifyError(res.reason);
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  }

  function applyVerification() {
    if (!verify?.data) return;
    if (verify.data.valueEstimate !== undefined) {
      set("marketValue", str(verify.data.valueEstimate));
    }
    if (verify.data.rentEstimate !== undefined) {
      set("monthlyRent", str(verify.data.rentEstimate));
    }
  }

  const isHouseArv = mode === "traditional" || mode === "flip";

  return (
    <section className="card workbench" aria-label="Property workbench">
      <h2>
        Property Workbench — {MODE_TITLES[mode] ?? mode}
      </h2>

      <h3>Listing data</h3>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="dp-link">Paste a Zillow/Redfin listing link</label>
          <div className="inline-row">
            <input
              id="dp-link"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://www.zillow.com/homedetails/…"
            />
            <button
              className="btn secondary"
              onClick={() => void runLinkLookup()}
              disabled={linkBusy || !linkUrl.trim()}
            >
              {linkBusy ? "Pulling…" : "Autopopulate"}
            </button>
          </div>
        </div>
        <div className="field full">
          <label htmlFor="dp-search">Search by city or ZIP</label>
          <div className="inline-row">
            <input
              id="dp-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Indianapolis, IN 46225"
            />
            <button
              className="btn secondary"
              onClick={() => void runSearch()}
              disabled={searchBusy || !searchQuery.trim()}
            >
              {searchBusy
                ? "Searching Redfin — city searches can take up to a minute…"
                : "Search Redfin"}
            </button>
          </div>
        </div>
      </div>
      {linkNote && <p className="small">{linkNote}</p>}
      {linkError && <div className="error">{linkError}</div>}
      {searchNote && <p className="small">{searchNote}</p>}
      {searchError && <div className="error">{searchError}</div>}

      <div className="filter-bar" aria-label="Search filters">
        <span className="filter-title">Filters</span>
        <label className="filter-field">
          Min price $
          <input
            id="fp-min-price"
            inputMode="numeric"
            value={fltMinPrice}
            onChange={(e) => setFltMinPrice(e.target.value)}
            placeholder="50000"
          />
        </label>
        <label className="filter-field">
          Max price $
          <input
            id="fp-max-price"
            inputMode="numeric"
            value={fltMaxPrice}
            onChange={(e) => setFltMaxPrice(e.target.value)}
            placeholder="200000"
          />
        </label>
        <label className="filter-field">
          Min DOM
          <input
            id="fp-min-dom"
            inputMode="numeric"
            value={fltMinDom}
            onChange={(e) => setFltMinDom(e.target.value)}
            placeholder="90"
          />
        </label>
        <label className="filter-field">
          Min beds
          <input
            id="fp-min-beds"
            inputMode="numeric"
            value={fltMinBeds}
            onChange={(e) => setFltMinBeds(e.target.value)}
            placeholder="3"
          />
        </label>
        <label className="filter-field">
          Min baths
          <input
            id="fp-min-baths"
            inputMode="decimal"
            value={fltMinBaths}
            onChange={(e) => setFltMinBaths(e.target.value)}
            placeholder="2"
          />
        </label>
        <button
          className="btn secondary"
          onClick={clearFilters}
          disabled={!anyFilterSet}
        >
          Clear filters
        </button>
        <span className="small">
          Filters apply on Search — each search is a fresh pull (capped
          at 500 listings), filtering itself is free.
        </span>
      </div>

      {searchResults.length > 0 && (
        <div className="results-toolbar">
          <span className="small">
            Zillow/Redfin results — {searchResults.length}{" "}
            {searchResults.length === 1 ? "listing" : "listings"}
          </span>
          <div className="inline-actions">
            <button
              className="btn primary"
              disabled={blastBusy !== null}
              onClick={() => void sendToAll()}
            >
              {blastBusy === "all" ? "Building blast…" : "Send to all"}
            </button>
            <button
              className="btn"
              aria-pressed={selectionMode}
              onClick={() => setSelectionMode((v) => !v)}
            >
              Select properties
            </button>
            {selectionMode && selectedListings.length > 0 && (
              <button
                className="btn"
                disabled={blastBusy !== null}
                onClick={() => void createFromSelected()}
              >
                {blastBusy === "selected"
                  ? "Building…"
                  : `Create blast from selected (${selectedListings.length})`}
              </button>
            )}
          </div>
          <p className="small">
            Sends the initial message to every realtor in this list
            (safety exclusions still apply).
          </p>
          {blastNote && <p className="small">{blastNote}</p>}
          {blastError && <div className="error">{blastError}</div>}
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="search-cards">
          {searchResults.map((p, i) => {
            const photoState = p.address ? photoByAddr[p.address] : undefined;
            const photosVisible =
              p.address !== undefined && photoVisibleFor === p.address;
            return (
            <div
              className="search-card"
              key={`${p.address ?? i}-${i}`}
              onMouseEnter={() => onCardEnter(p)}
              onMouseLeave={() => onCardLeave(p)}
            >
              <div className="search-card-addr">{p.address ?? "Unknown address"}</div>
              <div className="search-card-meta">
                {p.listPrice !== undefined && <span>{fmtMoney(p.listPrice)}</span>}
                {p.beds !== undefined && <span>{p.beds} bd</span>}
                {p.baths !== undefined && <span>{p.baths} ba</span>}
                {p.sqft !== undefined && <span>{p.sqft.toLocaleString()} sqft</span>}
                {p.daysOnMarket !== undefined && <span>{p.daysOnMarket} DOM</span>}
                {p.valueEstimate !== undefined && (
                  <span>Est. {fmtMoney(p.valueEstimate)}</span>
                )}
                {p.agentName && <span>Agent: {p.agentName}</span>}
              </div>
              <div className="inline-actions">
                <button
                  className="btn"
                  onClick={() => void loadAndUnderwrite(p)}
                  disabled={uwBusy || prepareBusy}
                >
                  {prepareBusy
                    ? "Loading full property details + comps…"
                    : "Run underwriting"}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => togglePhotos(p)}
                  disabled={!p.address}
                  aria-expanded={photosVisible}
                >
                  Photos
                </button>
                {selectionMode && onToggleListing && (
                  <label className="blast-pick">
                    <input
                      type="checkbox"
                      checked={selectedListings.some(
                        (s) => s.address === p.address,
                      )}
                      onChange={(e) => onToggleListing(p, e.target.checked)}
                    />
                    Add to blast
                  </label>
                )}
              </div>
              {photosVisible && photoState && (
                <div className="photo-pop">
                  {photoState.status === "loading" && (
                    <p className="small">Loading photos…</p>
                  )}
                  {photoState.status === "empty" && (
                    <p className="small">No photos available</p>
                  )}
                  {photoState.status === "ready" && (
                    <>
                      {/* Plain <img>: remote Redfin CDN URLs, no
                          next/image domain config to maintain. */}
                      <img
                        src={photoState.photos[photoState.index]}
                        alt={`Photo of ${p.address ?? "listing"}`}
                        loading="lazy"
                      />
                      {photoState.photos.length > 1 && p.address && (
                        <div className="photo-nav">
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => stepPhoto(p.address as string, -1)}
                            aria-label="Previous photo"
                          >
                            ‹
                          </button>
                          <span className="small">
                            {photoState.index + 1} / {photoState.photos.length}
                          </span>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => stepPhoto(p.address as string, 1)}
                            aria-label="Next photo"
                          >
                            ›
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      <h3>Underwriting</h3>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="dp-address">Property address</label>
          <input
            id="dp-address"
            value={f.address}
            onChange={(e) => set("address", e.target.value)}
            onBlur={onAddressBlur}
            placeholder="2309 S Meridian St, Indianapolis, IN 46225"
          />
        </div>
        <div className="field">
          <label htmlFor="dp-list">List price ($)</label>
          <input
            id="dp-list"
            inputMode="decimal"
            value={f.listPrice}
            onChange={(e) => set("listPrice", e.target.value)}
            placeholder="154900"
          />
        </div>
        {mode === "turnkey" && (
          <>
            <div className="field">
              <label htmlFor="dp-rent">Monthly rent ($)</label>
              <input id="dp-rent" inputMode="decimal" value={f.monthlyRent} onChange={(e) => set("monthlyRent", e.target.value)} placeholder="2150" />
            </div>
            <div className="field">
              <label htmlFor="dp-mv">Market value / MV ($, reference only)</label>
              <input id="dp-mv" inputMode="decimal" value={f.marketValue} onChange={(e) => set("marketValue", e.target.value)} placeholder="215000" />
            </div>
            <div className="field">
              <label htmlFor="dp-taxes">Annual taxes ($)</label>
              <input id="dp-taxes" inputMode="decimal" value={f.annualTaxes} onChange={(e) => set("annualTaxes", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-ins">Annual insurance ($)</label>
              <input id="dp-ins" inputMode="decimal" value={f.annualInsurance} onChange={(e) => set("annualInsurance", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-hoa">Monthly HOA ($)</label>
              <input id="dp-hoa" inputMode="decimal" value={f.monthlyHoa} onChange={(e) => set("monthlyHoa", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-vacancy">Vacancy (%)</label>
              <input id="dp-vacancy" inputMode="decimal" value={f.vacancyPct} onChange={(e) => set("vacancyPct", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-mgmt">Management (%)</label>
              <input id="dp-mgmt" inputMode="decimal" value={f.managementPct} onChange={(e) => set("managementPct", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-maint">Maintenance (%)</label>
              <input id="dp-maint" inputMode="decimal" value={f.maintenancePct} onChange={(e) => set("maintenancePct", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-capex">Capex reserve (%)</label>
              <input id="dp-capex" inputMode="decimal" value={f.capexPct} onChange={(e) => set("capexPct", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-dom">Days on market</label>
              <input id="dp-dom" inputMode="numeric" value={f.dom} onChange={(e) => set("dom", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-cuts">Price cuts</label>
              <input id="dp-cuts" inputMode="numeric" value={f.priceCuts} onChange={(e) => set("priceCuts", e.target.value)} />
            </div>
          </>
        )}
        {isHouseArv && (
          <>
            <div className="field">
              <label htmlFor="dp-arv">ARV ($)</label>
              <input id="dp-arv" inputMode="decimal" value={f.arv} onChange={(e) => set("arv", e.target.value)} placeholder="215000" />
            </div>
            <div className="field">
              <label htmlFor="dp-repairs">Repair estimate ($)</label>
              <input id="dp-repairs" inputMode="decimal" value={f.repairEstimate} onChange={(e) => set("repairEstimate", e.target.value)} />
            </div>
            {mode === "traditional" && (
              <div className="field">
                <label htmlFor="dp-pct">Buyer all-in % of ARV</label>
                <input id="dp-pct" inputMode="decimal" value={f.wholesalePct} onChange={(e) => set("wholesalePct", e.target.value)} placeholder="70" />
              </div>
            )}
            <div className="field">
              <label htmlFor="dp-dom">Days on market</label>
              <input id="dp-dom" inputMode="numeric" value={f.dom} onChange={(e) => set("dom", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-cuts">Price cuts</label>
              <input id="dp-cuts" inputMode="numeric" value={f.priceCuts} onChange={(e) => set("priceCuts", e.target.value)} />
            </div>
          </>
        )}
        {mode === "land" && (
          <div className="field">
            <label htmlFor="dp-land">Land comp value ($)</label>
            <input id="dp-land" inputMode="decimal" value={f.landCompValue} onChange={(e) => set("landCompValue", e.target.value)} />
          </div>
        )}
      </div>
      {facts && (
        <p className="small facts-line">
          <span className="badge ok">via {facts.sourceLabel}</span>{" "}
          {facts.beds !== undefined && <>{facts.beds} bd · </>}
          {facts.baths !== undefined && <>{facts.baths} ba · </>}
          {facts.sqft !== undefined && <>{facts.sqft.toLocaleString()} sqft · </>}
          {facts.yearBuilt !== undefined && <>built {facts.yearBuilt}</>}
        </p>
      )}
      <div className="btn-row">
        <button
          className="btn"
          onClick={() => void runFormUnderwriting()}
          disabled={uwBusy || prepareBusy}
        >
          {prepareBusy
            ? "Loading full property details + comps…"
            : uwBusy
              ? "Running…"
              : "Run underwriting"}
        </button>
      </div>
      {uwError && <div className="error">{uwError}</div>}

      {result && (
        <div>
          <h3>
            Result — {result.mode}{" "}
            <span className="badge grade">Grade {result.grade}</span>
          </h3>
          <div className="kpis">
            {result.noi !== undefined && (
              <div className="kpi">
                <div className="k">NOI / yr</div>
                <div className="v">{fmtMoney(result.noi)}</div>
              </div>
            )}
            {result.buyerCeiling !== undefined && (
              <div className="kpi">
                <div className="k">
                  {result.mode === "traditional" ? "Buyer ceiling (all-in)" : "Buyer ceiling"}
                </div>
                <div className="v">{fmtMoney(result.buyerCeiling)}</div>
                {result.ceilingBinding && (
                  <div className="small">Bound by: {result.ceilingBinding}</div>
                )}
              </div>
            )}
            <div className="kpi">
              <div className="k">MAO (max contract)</div>
              <div className="v">{fmtMoney(result.mao)}</div>
            </div>
            <div className="kpi hero">
              <div className="k">
                {result.mode === "turnkey"
                  ? "Initial offer (list − 10%, after intake)"
                  : result.mode === "traditional"
                    ? "Initial offer (= MAO)"
                    : "Suggested offer"}
              </div>
              <div className="v">
                {fmtMoney(result.initialOffer ?? result.suggestedContract)}
              </div>
            </div>
            <div className="kpi">
              <div className="k">Assignment fee / spread</div>
              <div className="v">{fmtMoney(result.assignmentFee)}</div>
            </div>
            {result.capRateAtContract !== undefined && (
              <div className="kpi">
                <div className="k">Cap rate at offer</div>
                <div className="v">{fmtPct(result.capRateAtContract, 2)}</div>
              </div>
            )}
          </div>
          {result.mode === "turnkey" && result.buyerCeiling !== undefined && (
            <div className="offer-override">
              <label>
                Offer to make (override the calculator any time)
                <input
                  inputMode="numeric"
                  placeholder={String(result.initialOffer ?? result.suggestedContract)}
                  value={offerOverride}
                  onChange={(e) => setOfferOverride(e.target.value)}
                />
              </label>
              <button type="button" onClick={() => setOfferOverride(String(result.mao))}>
                Use MAO
              </button>
              {result.modeledContract !== undefined && (
                <button
                  type="button"
                  onClick={() => setOfferOverride(String(result.modeledContract))}
                >
                  Use modeled contract
                </button>
              )}
              <span className="fee-at-offer">
                Fee at your offer:{" "}
                {fmtMoney(
                  result.buyerCeiling -
                    (offerOverride.trim() !== "" && Number.isFinite(Number(offerOverride))
                      ? Number(offerOverride)
                      : result.initialOffer ?? result.suggestedContract),
                )}
              </span>
            </div>
          )}
          <table className="kv">
            <tbody>
              {result.modeledContract !== undefined && result.mode === "turnkey" && (
                <tr>
                  <td>Modeled contract (motivation-based)</td>
                  <td>{fmtMoney(result.modeledContract)}</td>
                </tr>
              )}
              <tr>
                <td>Motivation discount</td>
                <td>{fmtPct(result.discountRate)}</td>
              </tr>
              {Object.entries(result.assumptions).map(([k, v]) => (
                <tr key={k}>
                  <td>{ASSUMPTION_LABELS[k] ?? k}</td>
                  <td>{assumptionValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="explain">
            {result.explanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {result.unverified.length > 0 && (
            <div className="unverified-box">
              <strong>Unverified inputs</strong> — estimated or not sourced;
              verify before relying on this case:
              <ul>
                {result.unverified.map((name) => (
                  <li key={name}>
                    {INPUT_LABELS[name] ?? name}{" "}
                    <span className="badge unverified">UNVERIFIED</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {mode === "turnkey" && (compsBusy || comps || compsError) && (
        <div className="comps-strip">
          <div className="comps-head">
            <h4>
              Auto-comps{" "}
              {comps?.cached && <span className="badge ok">cached</span>}
            </h4>
            <button
              className="btn secondary"
              onClick={() => void fetchCompsFor(f.address, true)}
              disabled={compsBusy || !f.address.trim()}
            >
              {compsBusy ? "Pulling comps…" : "Re-run comps"}
            </button>
          </div>
          {compsBusy && (
            <p className="small">
              Pulling sold + rental comps within 0.5 mi of this property…
            </p>
          )}
          {compsError && <div className="error">{compsError}</div>}
          {comps && (
            <>
              <p className="small">
                Auto-comped from {comps.soldComps.length} sold /{" "}
                {comps.rentComps.length} rental
                {comps.rentComps.length === 1 ? "" : "s"} within 0.5 mi,
                past 12 months
                {comps.suggestedMV !== null && (
                  <> · suggested MV {fmtMoney(comps.suggestedMV)}</>
                )}
                {comps.suggestedRent !== null && (
                  <> · suggested rent {fmtMoney(comps.suggestedRent)}/mo</>
                )}{" "}
                — prefilled above, still editable.
              </p>
              {comps.soldComps.length > 0 && (
                <ul className="comps-list">
                  {comps.soldComps.map((c, i) => (
                    <li key={`sold-${i}`}>
                      <strong>Sold</strong> {c.address} —{" "}
                      {fmtMoney(c.soldPrice)} ·{" "}
                      {new Date(c.soldDate).toLocaleDateString()} ·{" "}
                      {c.distanceMi.toFixed(2)} mi
                      {c.beds !== undefined && <> · {c.beds} bd</>}
                      {c.baths !== undefined && <> · {c.baths} ba</>}
                      {c.sqft !== undefined && (
                        <> · {c.sqft.toLocaleString()} sqft</>
                      )}
                      {c.neighborhood && <> · {c.neighborhood}</>}
                    </li>
                  ))}
                </ul>
              )}
              {comps.rentComps.length > 0 && (
                <ul className="comps-list">
                  {comps.rentComps.map((c, i) => (
                    <li key={`rent-${i}`}>
                      <strong>For rent</strong> {c.address} —{" "}
                      {fmtMoney(c.rent)}/mo · {c.distanceMi.toFixed(2)} mi
                      {c.beds !== undefined && <> · {c.beds} bd</>}
                      {c.baths !== undefined && <> · {c.baths} ba</>}
                      {c.sqft !== undefined && (
                        <> · {c.sqft.toLocaleString()} sqft</>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {comps.notes.map((n, i) => (
                <p className="small" key={`note-${i}`}>
                  {n}
                </p>
              ))}
            </>
          )}
        </div>
      )}

      <h3>Realtor message</h3>
      {!result && (
        <p className="muted">Run underwriting first — message drafts unlock when the deal pencils.</p>
      )}
      {result && !pencils && (
        <p className="muted">
          Doesn&apos;t pencil at these numbers (fee {fmtMoney(result.assignmentFee)}, MAO{" "}
          {fmtMoney(result.mao)}) — no first message generated.
        </p>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="dp-first">Listing agent first name</label>
          <input id="dp-first" value={f.agentFirstName} onChange={(e) => set("agentFirstName", e.target.value)} placeholder="Debra" />
        </div>
        <div className="field">
          <label htmlFor="dp-street">Street (for outreach)</label>
          <input id="dp-street" value={f.street} onChange={(e) => set("street", e.target.value)} placeholder="2309 S Meridian St" />
        </div>
        <div className="field full">
          <label htmlFor="dp-recipient">Recipient (phone or email)</label>
          <input id="dp-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="+1 317-555-0100" />
        </div>
      </div>
      <label className="check intake-check">
        <input
          type="checkbox"
          checked={intakeReceived}
          onChange={(e) => setIntakeReceived(e.target.checked)}
        />
        Intake answers received (offer messages unlock)
      </label>
      <div className="btn-row">
        <button className="btn secondary" onClick={draftFirstMessage} disabled={!pencils}>
          Draft first message
        </button>
        <button
          className="btn secondary"
          onClick={draftOfferTemplate}
          disabled={!pencils || !intakeReceived || offerBusy}
        >
          Draft offer message
        </button>
        <button
          className="btn"
          onClick={() => void draftOfferAiFlow()}
          disabled={!pencils || !intakeReceived || aiBusy}
        >
          {aiBusy ? "Drafting…" : "Draft offer message (AI)"}
        </button>
      </div>
      <div className="field full" style={{ marginTop: 10 }}>
        <label htmlFor="dp-offer">Message (editable)</label>
        <textarea
          id="dp-offer"
          className="ta"
          value={offerText}
          onChange={(e) => setOfferText(e.target.value)}
          placeholder="Draft a first or offer message, then edit freely before saving."
        />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => void saveDraft()} disabled={saveBusy}>
          {saveBusy ? "Saving…" : "Save draft"}
        </button>
      </div>
      {saveNote && (
        <p className="small" style={{ color: "var(--accent)" }}>
          {saveNote}
        </p>
      )}
      {offerError && <div className="error">{offerError}</div>}
      <p className="muted">
        Saving stores the draft only. Sending requires approval in the
        Drafts list — nothing sends from this panel. First messages never
        carry an offer number; offer messages go out only after intake.
      </p>

      <h3>Under-contract verification (RentCast)</h3>
      <label className="check intake-check">
        <input
          type="checkbox"
          checked={underContract}
          onChange={(e) => {
            setUnderContract(e.target.checked);
            setVerify(null);
            setVerifyError(null);
          }}
        />
        This deal is under contract
      </label>
      {underContract && (
        <div>
          <div className="btn-row">
            <button
              className="btn secondary"
              onClick={() => void runVerify()}
              disabled={verifyBusy}
            >
              {verifyBusy ? "Verifying…" : "Verify with RentCast"}
            </button>
          </div>
          {verifyError && <div className="error">{verifyError}</div>}
          {verify && !verify.ok && verify.reason === "not_under_contract" && (
            <p className="small">
              No under-contract opportunity in HighLevel matches this
              address, so RentCast was not called. RentCast is reserved for
              deals under contract.
            </p>
          )}
          {verify?.ok && verify.configured === false && (
            <p className="small">
              This deal matches an under-contract opportunity, but RentCast
              is not configured on the server (no RENTCAST_API_KEY) — no
              verification was pulled.
            </p>
          )}
          {verify?.ok && verify.data && (
            <div className="verify-box">
              <span className="badge ok">
                RentCast (under-contract verification){verify.cached ? " · cached" : ""}
              </span>
              <div className="kpis" style={{ marginTop: 8 }}>
                {verify.data.valueEstimate !== undefined && (
                  <div className="kpi">
                    <div className="k">Value estimate</div>
                    <div className="v">{fmtMoney(verify.data.valueEstimate)}</div>
                  </div>
                )}
                {verify.data.rentEstimate !== undefined && (
                  <div className="kpi">
                    <div className="k">Rent estimate / mo</div>
                    <div className="v">{fmtMoney(verify.data.rentEstimate)}</div>
                  </div>
                )}
              </div>
              <div className="btn-row">
                <button className="btn secondary" onClick={applyVerification}>
                  Apply to calculator
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
