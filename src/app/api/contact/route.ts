import { NextResponse } from "next/server";
import {
  BUDGETS,
  CONTACT_PREFS,
  MESSAGE_MAX,
  MESSAGE_MIN,
  NOT_SURE_SLUG,
  SOURCE_KEYS,
  TIMELINES,
  type ContactPref,
} from "@/content/contact-options";
import { SERVICE_NAMES } from "@/content/contact-services";
import { SITE } from "@/content/site";

export const runtime = "nodejs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+\d][\d\s-]*$/;
const FAIL_MESSAGE = `We couldn't send that just now. Please email us at ${SITE.email}.`;
const FROM = () =>
  process.env.CONTACT_FROM_EMAIL ?? "Motion 8 Website <noreply@mail.motion8agency.co>";
const MAX_SERVICES = 30;

/* Best-effort in-memory throttle. Resets on deploy and isn't shared across
   instances — it slows down casual abuse, it is not a security boundary. */
type Bucket = Map<string, { count: number; first: number }>;

/* Two fixed-window buckets: per client IP (slows a single sender) and per
   submitted email address (stops rotating IPs from flooding one inbox). */
const ipHits: Bucket = new Map();
const IP_WINDOW_MS = 60_000;
const IP_MAX = 5;

const emailHits: Bucket = new Map();
const EMAIL_WINDOW_MS = 10 * 60_000;
const EMAIL_MAX = 3;

const MAX_KEYS = 5_000;

function limited(bucket: Bucket, key: string, windowMs: number, max: number) {
  const now = Date.now();
  if (bucket.size > MAX_KEYS) {
    for (const [k, record] of bucket) if (now - record.first > windowMs) bucket.delete(k);
    // Still over the cap (sustained flood of unique keys): drop oldest entries.
    // Maps iterate in insertion order, so the first keys are the oldest windows.
    for (const k of bucket.keys()) {
      if (bucket.size <= MAX_KEYS) break;
      bucket.delete(k);
    }
  }
  const record = bucket.get(key);
  if (!record || now - record.first > windowMs) {
    bucket.delete(key);
    bucket.set(key, { count: 1, first: now });
    return false;
  }
  record.count += 1;
  return record.count > max;
}

const TOO_MANY = (when: string) =>
  NextResponse.json(
    {
      ok: false,
      error: `Thanks — we've already received a few messages from you. Please try again ${when}, or email us at ${SITE.email}.`,
    },
    { status: 429 },
  );

/** Coerce an unknown field to a trimmed string capped at `max` chars. */
function field(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Single-line field: control characters (incl. newlines) collapsed to spaces. */
function line(value: unknown, max = 200) {
  return field(value, max * 2)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

function sendEmail(apiKey: string, payload: Record<string, unknown>) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), ...payload }),
  });
}

/**
 * Deliver the lead to us. Returns null on success, otherwise the response to
 * send. The full lead is logged on every failure path so it can be recovered.
 */
async function deliverLead(lead: object, subject: string, text: string, replyTo: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL ?? SITE.email;

  if (!apiKey) {
    // Full submission goes to the server log so it can be recovered from Vercel logs.
    console.error("[contact] RESEND_API_KEY unset — lead NOT emailed:", JSON.stringify(lead));
    // In development, accept so the form can be tested without a provider.
    // In production, never tell a visitor their message arrived when it didn't.
    if (process.env.NODE_ENV !== "production") {
      return NextResponse.json({ ok: true, delivered: false });
    }
    return NextResponse.json({ ok: false, error: FAIL_MESSAGE }, { status: 503 });
  }

  try {
    const response = await sendEmail(apiKey, { to: [to], reply_to: replyTo, subject, text });
    if (!response.ok) {
      console.error(
        "[contact] provider rejected:",
        response.status,
        await response.text(),
        "lead:",
        JSON.stringify(lead),
      );
      return NextResponse.json({ ok: false, error: FAIL_MESSAGE }, { status: 502 });
    }
  } catch (error) {
    console.error("[contact] provider unreachable:", error, "lead:", JSON.stringify(lead));
    return NextResponse.json({ ok: false, error: FAIL_MESSAGE }, { status: 502 });
  }
  return null;
}

/**
 * Confirmation to the visitor. Deliberately contains ONLY fixed copy plus
 * labels picked from fixed lists — never the visitor's free text, name,
 * company, URL or phone — so the form can't be used to relay arbitrary
 * content to a third-party address. Failure is logged, never surfaced.
 */
async function sendAutoReply(to: string, serviceNames: string[], budget: string, timeline: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const text = [
    "Hi,",
    "",
    `Thanks for getting in touch with ${SITE.name}. Your enquiry has reached our team, and we'll reply within 24 hours.`,
    "",
    "What you selected:",
    `- Services: ${serviceNames.join(", ")}`,
    `- Budget: ${budget}`,
    `- Timeline: ${timeline}`,
    "",
    `Want to add anything, or need an NDA signed first? Reply to this email or write to us at ${SITE.email}.`,
    "",
    `— The ${SITE.name} team`,
    SITE.url,
    "",
    "You're receiving this because this address was entered in the contact form on our website. If that wasn't you, you can safely ignore this email.",
  ].join("\n");

  try {
    const response = await sendEmail(apiKey, {
      to: [to],
      reply_to: SITE.email,
      subject: "We’ve got your enquiry — Motion 8 Agency",
      text,
    });
    if (!response.ok) {
      console.error("[contact] auto-reply rejected:", response.status, await response.text());
    }
  } catch (error) {
    console.error("[contact] auto-reply unreachable:", error);
  }
}

/**
 * Also hand the lead to Founder OS (Motion 8's CRM), so it becomes a contact and deal there and the
 * team is alerted. Best effort: the visitor's message is already safely emailed, so a hiccup here is
 * only logged and never shown to them. Switched on by OS_FORM_URL (the form address from
 * Founder OS → CRM → Website forms); without it nothing changes.
 */
async function forwardToOS(fields: Record<string, string | undefined>) {
  const url = process.env.OS_FORM_URL;
  if (!url) return;
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v && v.trim()));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Origin: SITE.url.replace(/\/$/, "") },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.error("[contact] Founder OS refused the lead:", response.status, await response.text());
  } catch (error) {
    console.error("[contact] Founder OS unreachable:", error);
  }
}

/** One key per real inbox: lowercased, with any "+tag" removed from the local part. */
function inboxKey(email: string) {
  const [local, domain = ""] = email.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export async function POST(request: Request) {
  // Vercel sets x-real-ip; the first x-forwarded-for hop is client-controlled.
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ??
    "unknown";

  if (limited(ipHits, ip, IP_WINDOW_MS, IP_MAX)) return TOO_MANY("in a minute");

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: silently accept bot submissions so they don't learn to retry.
  if (field(body.website)) return NextResponse.json({ ok: true, spam: true });

  // No `services` key → the original payload shape (still used by the $399 bundle form).
  return body.services === undefined ? legacy(body) : enquiry(body);
}

async function legacy(body: Record<string, unknown>) {
  const name = line(body.name);
  const email = line(body.email, 254);
  const company = line(body.company);
  const budget = line(body.budget);
  const socialOrWebsite = line(body.socialOrWebsite) || line(body.handle);
  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const message = rawMessage.slice(0, 5000);

  const errors: Record<string, string> = {};
  if (name.length < 2) errors.name = "Tell us your name.";
  if (!EMAIL.test(email)) errors.email = "That email doesn't look right.";
  if (message.length < 5) errors.message = "Please share what's the goal or what you need help with.";
  if (rawMessage.length > 5000) errors.message = "That's longer than we can accept.";

  if (Object.keys(errors).length) {
    return NextResponse.json({ ok: false, errors }, { status: 422 });
  }

  // Per-recipient cap, checked only once the address is valid so typos don't burn quota.
  if (limited(emailHits, inboxKey(email), EMAIL_WINDOW_MS, EMAIL_MAX)) {
    return TOO_MANY("in a few minutes");
  }

  const lead = { name, email, company, socialOrWebsite, budget, message };
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    company && `Company / Business: ${company}`,
    socialOrWebsite && `Instagram / Website: ${socialOrWebsite}`,
    budget && `Budget / Package: ${budget}`,
    "",
    message,
  ]
    .filter(Boolean)
    .join("\n");

  const failed = await deliverLead(
    lead,
    `New project enquiry — ${name}${company ? ` (${company})` : ""}`,
    text,
    email,
  );
  if (failed) return failed;
  await forwardToOS({
    name,
    email,
    company,
    website: socialOrWebsite,
    "Price range": budget,
    message,
    source: "Website contact form",
  });
  return NextResponse.json({ ok: true, delivered: true });
}

/** The multi-step contact form. */
async function enquiry(body: Record<string, unknown>) {
  const errors: Record<string, string> = {};

  // Services: real slugs or "not-sure", de-duplicated, capped.
  let services: string[] = [];
  if (!Array.isArray(body.services)) {
    errors.services = "Choose at least one service.";
  } else if (body.services.length > MAX_SERVICES) {
    errors.services = `Choose up to ${MAX_SERVICES} services.`;
  } else if (!body.services.every((s) => typeof s === "string" && SERVICE_NAMES.has(s))) {
    errors.services = "One of those services isn't one we recognise.";
  } else {
    services = [...new Set(body.services as string[])];
    if (!services.length) errors.services = "Choose at least one service.";
  }

  const budget = field(body.budget, 40);
  if (!(BUDGETS as readonly string[]).includes(budget)) errors.budget = "Choose a budget range.";

  const timeline = field(body.timeline, 40);
  if (!(TIMELINES as readonly string[]).includes(timeline)) errors.timeline = "Choose a timeline.";

  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const message = rawMessage.slice(0, MESSAGE_MAX);
  if (rawMessage.length < MESSAGE_MIN) errors.message = "A sentence or two helps us reply usefully.";
  if (rawMessage.length > MESSAGE_MAX) errors.message = "That's longer than we can accept.";

  const name = line(body.name);
  if (name.length < 2) errors.name = "Tell us your name.";

  const email = line(body.email, 254);
  if (!EMAIL.test(email)) errors.email = "That email doesn't look right.";

  const company = line(body.company);

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const url = line(rawUrl, 300);
  if (rawUrl.length > 300) errors.url = "That address is too long.";

  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  const phone = line(rawPhone, 40);
  if (rawPhone.length > 40 || (phone && !PHONE.test(phone))) {
    errors.phone = "Use digits, spaces, + and - only.";
  }

  const contactPref = (field(body.contactPref, 20) || "email") as ContactPref;
  if (!CONTACT_PREFS.some((p) => p.value === contactPref)) {
    errors.contactPref = "Choose how we should reach you.";
  } else if (contactPref !== "email" && phone.replace(/\D/g, "").length < 6) {
    errors.phone = "Add a phone number so we can call or message you.";
  }

  // Source: only known keys, each ≤300 chars. Unknown keys are dropped.
  const source: Partial<Record<(typeof SOURCE_KEYS)[number], string>> = {};
  if (body.source && typeof body.source === "object" && !Array.isArray(body.source)) {
    const raw = body.source as Record<string, unknown>;
    for (const key of SOURCE_KEYS) {
      const value = line(raw[key], 300);
      if (value) source[key] = value;
    }
  }

  if (Object.keys(errors).length) {
    return NextResponse.json({ ok: false, errors }, { status: 422 });
  }

  // Per-recipient cap, checked only once the address is valid so typos don't burn quota.
  if (limited(emailHits, inboxKey(email), EMAIL_WINDOW_MS, EMAIL_MAX)) {
    return TOO_MANY("in a few minutes");
  }

  const serviceNames = services.map((s) => SERVICE_NAMES.get(s)!);
  const prefLabel = CONTACT_PREFS.find((p) => p.value === contactPref)!.label;
  const lead = {
    services,
    budget,
    timeline,
    name,
    email,
    company,
    phone,
    contactPref,
    url,
    message,
    source,
  };

  const head = serviceNames.slice(0, 2).join(", ");
  const extra = serviceNames.length > 2 ? ` +${serviceNames.length - 2}` : "";
  const subject = `New enquiry — ${head}${extra} — ${name}${company ? ` (${company})` : ""}`;

  const section = (title: string, rows: (string | false | undefined)[]) =>
    [title.toUpperCase(), ...rows.filter(Boolean), ""].join("\n");

  const text = [
    section("Services", serviceNames.map((n) => `- ${n}`)),
    section("Budget", [budget]),
    section("Timeline", [timeline]),
    section("Contact", [
      `Name: ${name}`,
      company && `Company: ${company}`,
      `Email: ${email}`,
      `Phone: ${phone || "—"}`,
      `Preferred contact: ${prefLabel}`,
    ]),
    section("Website", [url || "—"]),
    section("Message", [message]),
    section("Source", [
      `Landing page: ${source.landingPage || "—"}`,
      `Referrer: ${source.referrer || "—"}`,
      `UTM source / medium: ${source.utm_source || "—"} / ${source.utm_medium || "—"}`,
      `UTM campaign: ${source.utm_campaign || "—"}`,
      (source.utm_term || source.utm_content) &&
        `UTM term / content: ${source.utm_term || "—"} / ${source.utm_content || "—"}`,
      source.gclid && `gclid: ${source.gclid}`,
      source.fbclid && `fbclid: ${source.fbclid}`,
      `Submitted from: ${source.submittedFrom || "—"}`,
    ]),
  ].join("\n");

  const failed = await deliverLead(lead, subject, text, email);
  if (failed) return failed;

  await forwardToOS({
    name,
    email,
    company,
    phone,
    website: url,
    service: serviceNames.join(", "),
    "Price range": budget,
    Timeline: timeline,
    "Preferred contact": prefLabel,
    message,
    source: source.utm_source ? `Website · ${source.utm_source}${source.utm_campaign ? ` / ${source.utm_campaign}` : ""}` : "Website contact form",
    "Landing page": source.landingPage,
    Referrer: source.referrer,
  });

  // Only after the lead is safely with us; never for spam (returned earlier).
  await sendAutoReply(
    email,
    services.map((s) => (s === NOT_SURE_SLUG ? "Not sure yet" : SERVICE_NAMES.get(s)!)),
    budget,
    timeline,
  );

  return NextResponse.json({ ok: true, delivered: true });
}
