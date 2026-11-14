/**
 * Fixed option lists shared by the contact form (client) and /api/contact
 * (server). Kept free of the PILLARS import so the client bundle stays small —
 * service options are derived from PILLARS on the server and passed down.
 */

export const NOT_SURE_SLUG = "not-sure";
export const NOT_SURE_LABEL = "Not sure yet — help me decide";

export const BUDGETS = [
  "Under $5k",
  "$5k–$15k",
  "$15k–$25k",
  "$25k–$50k",
  "$50k–$100k",
  "$100k+",
  "Not sure yet",
] as const;

export const TIMELINES = [
  "As soon as possible",
  "Within 1 month",
  "1–3 months",
  "3+ months",
  "Just exploring",
] as const;

export const CONTACT_PREFS = [
  { value: "email", label: "Email" },
  { value: "call", label: "Phone call" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

export type ContactPref = (typeof CONTACT_PREFS)[number]["value"];

/** Lead-source keys captured client-side and accepted by the API. */
export const SOURCE_KEYS = [
  "landingPage",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "submittedFrom",
] as const;

export type SourceKey = (typeof SOURCE_KEYS)[number];

export type ServiceOption = { slug: string; name: string };
export type ServiceGroup = { pillar: string; label: string; services: ServiceOption[] };

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 5000;
