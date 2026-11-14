import type { SourceKey } from "@/content/contact-options";

const KEY = "m8-lead-source";
const PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

export type LeadSource = Partial<Record<SourceKey, string>>;

const cap = (value: string | null | undefined) => (value ?? "").slice(0, 300);

/**
 * Record where this session started — first page, referrer, UTMs and click
 * IDs. Runs once per tab session; later pages never overwrite it.
 */
export function captureLeadSource() {
  try {
    if (sessionStorage.getItem(KEY)) return;
    const params = new URLSearchParams(window.location.search);
    const source: LeadSource = {
      landingPage: cap(window.location.pathname + window.location.search),
      referrer: cap(document.referrer),
    };
    for (const key of PARAMS) {
      const value = params.get(key);
      if (value) source[key] = cap(value);
    }
    sessionStorage.setItem(KEY, JSON.stringify(source));
  } catch {
    /* storage blocked — attribution is best-effort */
  }
}

/** The captured session source plus the page the form is submitted from. */
export function readLeadSource(): LeadSource {
  let stored: LeadSource = {};
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as LeadSource;
  } catch {
    /* ignore */
  }
  return { ...stored, submittedFrom: cap(window.location.pathname + window.location.search) };
}
