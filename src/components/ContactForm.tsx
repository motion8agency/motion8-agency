"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagneticButton } from "@/components/MagneticButton";
import { ServicePicker } from "@/components/contact/ServicePicker";
import { readLeadSource } from "@/components/contact/lead-source";
import {
  BUDGETS,
  CONTACT_PREFS,
  MESSAGE_MAX,
  MESSAGE_MIN,
  NOT_SURE_LABEL,
  NOT_SURE_SLUG,
  TIMELINES,
  type ContactPref,
  type ServiceGroup,
} from "@/content/contact-options";
import { gsap, prefersReducedMotion } from "@/lib/gsap";
import { trackLead } from "@/lib/track";

type Status = "idle" | "sending" | "sent" | "error";

type Values = {
  services: string[];
  url: string;
  budget: string;
  timeline: string;
  message: string;
  name: string;
  email: string;
  company: string;
  dial: string;
  phone: string;
  contactPref: ContactPref;
};

type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = {
  services: [],
  url: "",
  budget: "",
  timeline: "",
  message: "",
  name: "",
  email: "",
  company: "",
  dial: "US",
  phone: "",
  contactPref: "email",
};

const DRAFT_KEY = "m8-contact-draft-v1";
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const STEPS: { title: string; fields: (keyof Values)[] }[] = [
  { title: "What do you need?", fields: ["services", "url"] },
  { title: "Scope", fields: ["budget", "timeline", "message"] },
  { title: "How to reach you", fields: ["name", "email", "company", "contactPref", "phone"] },
];

/** Region → dialling code. Small on purpose: the markets we serve, plus neighbours. */
const COUNTRIES = [
  { code: "US", dial: "+1" },
  { code: "CA", dial: "+1" },
  { code: "GB", dial: "+44" },
  { code: "IE", dial: "+353" },
  { code: "AU", dial: "+61" },
  { code: "NZ", dial: "+64" },
  { code: "AE", dial: "+971" },
  { code: "SA", dial: "+966" },
  { code: "QA", dial: "+974" },
  { code: "IN", dial: "+91" },
  { code: "SG", dial: "+65" },
  { code: "DE", dial: "+49" },
  { code: "FR", dial: "+33" },
  { code: "NL", dial: "+31" },
  { code: "ES", dial: "+34" },
  { code: "ZA", dial: "+27" },
] as const;

/** Message prompts keyed by pillar slug (and the "not sure" option). */
const PROMPTS: Record<string, { hint: string; placeholder: string }> = {
  "digital-marketing": {
    hint: "What are you selling, to whom, and which channels are working (or not) today?",
    placeholder: "e.g. B2B SaaS, $20k/mo on Google Ads, cost per lead has doubled since spring…",
  },
  "software-development": {
    hint: "What are you building, who is it for, and is there existing code or design?",
    placeholder: "e.g. A customer portal for our logistics clients. Designs are done, no code yet…",
  },
  "ai-automation": {
    hint: "Which systems and data should it work with, and what task should it take off your team?",
    placeholder: "e.g. Draft replies to support tickets from our Zendesk history and Notion docs…",
  },
  [NOT_SURE_SLUG]: {
    hint: "Where is growth stuck? What have you tried, and what should be true in six months?",
    placeholder: "e.g. Plenty of traffic, few demos booked, and the site is slow to update…",
  },
  default: {
    hint: "What's the goal, and what's in the way today?",
    placeholder: "A few sentences is plenty.",
  },
};

const LABEL = "block text-[13.5px] font-bold text-dark-body";
const OPTIONAL = "font-normal text-dark-faint";
const HINT = "m-0 mt-1 text-[12.5px] leading-[1.6] text-dark-faint";
const ERROR = "mt-2 block text-[12.5px] text-terracotta-light";
const control = (invalid: boolean) =>
  `mt-2 min-h-[52px] w-full rounded-[10px] border bg-[rgba(240,233,223,.04)] px-4 py-3 text-[16px] text-white outline-none transition-colors placeholder:text-dark-faint focus:border-terracotta-light ${
    invalid ? "border-terracotta-light" : "border-edge-rule"
  }`;

function defaultCountry() {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const lang of langs) {
      const region = new Intl.Locale(lang).maximize().region;
      if (region && COUNTRIES.some((c) => c.code === region)) return region;
    }
  } catch {
    /* fall through */
  }
  return "US";
}

/** "07700 900123" + GB → "+447700900123". A number typed with a leading + wins over the select. */
function toE164(country: string, phone: string) {
  const raw = phone.trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return `+${raw.replace(/\D/g, "")}`;
  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? "+1";
  return `${dial}${raw.replace(/\D/g, "").replace(/^0+/, "")}`;
}

function validate(step: number, v: Values): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!v.services.length) e.services = "Choose at least one service, or “Not sure yet”.";
    if (v.url.length > 300) e.url = "That address is too long.";
  }
  if (step === 1) {
    if (!v.budget) e.budget = "Choose a budget range.";
    if (!v.timeline) e.timeline = "Choose a timeline.";
    const len = v.message.trim().length;
    if (len < MESSAGE_MIN) {
      e.message = `A sentence or two helps us reply usefully (${MESSAGE_MIN}+ characters).`;
    } else if (len > MESSAGE_MAX) e.message = "That's longer than we can accept.";
  }
  if (step === 2) {
    if (v.name.trim().length < 2) e.name = "Tell us your name.";
    if (!EMAIL.test(v.email.trim())) e.email = "That email doesn't look right.";
    if (v.phone.trim() && !/^\+?[\d\s\-().]+$/.test(v.phone.trim())) {
      e.phone = "Use digits, spaces, + and - only.";
    } else if (v.contactPref !== "email" && v.phone.replace(/\D/g, "").length < 6) {
      e.phone = `Add a number so we can ${v.contactPref === "call" ? "call" : "message"} you.`;
    }
  }
  return e;
}

export function ContactForm({
  groups,
  calendlyUrl,
  email: siteEmail,
}: {
  groups: ServiceGroup[];
  calendlyUrl: string;
  email: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const movedRef = useRef(false);

  const [values, setValues] = useState<Values>(EMPTY);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [formError, setFormError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [sentServices, setSentServices] = useState<string[]>([]);

  const names = useMemo(() => {
    const map = new Map<string, string>([[NOT_SURE_SLUG, NOT_SURE_LABEL]]);
    groups.forEach((g) => g.services.forEach((s) => map.set(s.slug, s.name)));
    return map;
  }, [groups]);
  const pillarOf = useMemo(() => {
    const map = new Map<string, string>([[NOT_SURE_SLUG, NOT_SURE_SLUG]]);
    groups.forEach((g) => g.services.forEach((s) => map.set(s.slug, g.pillar)));
    return map;
  }, [groups]);
  const nameOf = useCallback((slug: string) => names.get(slug) ?? slug, [names]);

  // Restore the draft, then apply ?service= prefill (the URL wins for services).
  useEffect(() => {
    let draft: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      const saved = parsed as { savedAt?: unknown; values?: unknown } | null;
      const fresh =
        saved && typeof saved.savedAt === "number" && Date.now() - saved.savedAt < DRAFT_MAX_AGE_MS;
      if (fresh && saved.values && typeof saved.values === "object") {
        draft = saved.values as Record<string, unknown>;
      } else if (raw) {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      /* ignore */
    }
    const str = (k: string) => (typeof draft[k] === "string" ? (draft[k] as string) : "");
    const oneOf = <T extends string>(val: string, list: readonly T[], fallback: T) =>
      (list as readonly string[]).includes(val) ? (val as T) : fallback;

    const draftServices = Array.isArray(draft.services)
      ? draft.services.filter((s): s is string => typeof s === "string" && names.has(s))
      : [];
    const fromUrl = (new URLSearchParams(window.location.search).get("service") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s, i, all) => s && names.has(s) && all.indexOf(s) === i);

    setValues({
      services: fromUrl.length ? fromUrl : [...new Set(draftServices)],
      url: str("url"),
      budget: oneOf(str("budget"), BUDGETS, "" as (typeof BUDGETS)[number]),
      timeline: oneOf(str("timeline"), TIMELINES, "" as (typeof TIMELINES)[number]),
      message: str("message"),
      name: str("name"),
      email: str("email"),
      company: str("company"),
      dial: oneOf(str("dial"), COUNTRIES.map((c) => c.code), "" as string) || defaultCountry(),
      phone: str("phone"),
      contactPref: oneOf(str("contactPref"), CONTACT_PREFS.map((p) => p.value), "email"),
    });
    setHydrated(true);
  }, [names]);

  // Persist the draft as the visitor types.
  useEffect(() => {
    if (!hydrated || status === "sent") return;
    const id = window.setTimeout(() => {
      try {
        // Contact details (email, phone) are never stored on the device.
        const { email: _email, phone: _phone, ...safe } = values;
        void _email;
        void _phone;
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), values: safe }));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [values, hydrated, status]);

  // Step change: move focus to the step heading, announce it, animate in.
  useEffect(() => {
    if (!movedRef.current) return;
    headingRef.current?.focus({ preventScroll: true });
    setAnnounce(`Step ${step + 1} of ${STEPS.length}: ${STEPS[step].title}`);
    const form = formRef.current;
    if (form && form.getBoundingClientRect().top < 72) {
      form.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    if (stepRef.current && !prefersReducedMotion()) {
      gsap.fromTo(
        stepRef.current,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" },
      );
    }
  }, [step]);

  useEffect(() => {
    if (status === "sent") successRef.current?.focus();
  }, [status]);

  const set = <K extends keyof Values>(key: K, val: Values[K]) => {
    setValues((v) => ({ ...v, [key]: val }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const focusFirstError = (errs: Errors) => {
    const first = STEPS.flatMap((s) => s.fields).find((k) => errs[k]);
    if (!first) return;
    window.setTimeout(() => {
      const selector =
        first === "contactPref" ? "input[name=contactPref]:checked" : `#cf-${first}`;
      formRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });
  };

  const goTo = (target: number) => {
    movedRef.current = true;
    setErrors({});
    setStep(target);
  };

  const next = () => {
    const errs = validate(step, values);
    if (Object.keys(errs).length) {
      setErrors(errs);
      focusFirstError(errs);
      return;
    }
    goTo(step + 1);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step < STEPS.length - 1) return next();
    if (status === "sending") return;

    const errs = validate(step, values);
    if (Object.keys(errs).length) {
      setErrors(errs);
      focusFirstError(errs);
      return;
    }

    setStatus("sending");
    setErrors({});
    setFormError("");

    const payload = {
      services: values.services,
      url: values.url.trim(),
      budget: values.budget,
      timeline: values.timeline,
      message: values.message.trim(),
      name: values.name.trim(),
      email: values.email.trim(),
      company: values.company.trim(),
      phone: toE164(values.dial, values.phone),
      contactPref: values.contactPref,
      source: readLeadSource(),
      website: honeypotRef.current?.value || undefined,
    };

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        ok: boolean;
        spam?: boolean;
        error?: string;
        errors?: Errors;
      };

      if (!response.ok || !result.ok) {
        const serverErrors = result.errors;
        if (serverErrors) {
          setErrors(serverErrors);
          const firstStep = STEPS.findIndex((s) => s.fields.some((f) => serverErrors[f]));
          if (firstStep >= 0 && firstStep !== step) {
            movedRef.current = true;
            setStep(firstStep);
          }
          focusFirstError(serverErrors);
        }
        setFormError(result.error ?? "Please check the highlighted fields.");
        setStatus("error");
        return;
      }

      if (!result.spam) {
        trackLead("contact", {
          services: values.services.join(","),
          service_count: values.services.length,
          budget: values.budget,
          timeline: values.timeline,
          contact_pref: values.contactPref,
        });
      }
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      setSentServices(values.services);
      setStatus("sent");
    } catch {
      setFormError(`Network error — please email ${siteEmail} instead.`);
      setStatus("error");
    }
  };

  if (status === "sent") {
    const bookingUrl = calendlyUrl
      ? `${calendlyUrl}${calendlyUrl.includes("?") ? "&" : "?"}hide_gdpr_banner=1`
      : "";
    return (
      <div className="w-full max-w-[640px] rounded-card border border-edge-rule bg-[rgba(240,233,223,.04)] p-6 md:p-8">
        <h3 ref={successRef} tabIndex={-1} className="text-[24px] text-white outline-none">
          Thanks — that reached us.
        </h3>
        <p className="m-0 mt-3 text-[14.5px] leading-[1.8] text-dark-muted">
          We reply within 24 hours, usually with a first read on what we would fix rather than a
          calendar link.
        </p>
        {sentServices.length > 0 && (
          <>
            <div className="mt-6 text-[11.5px] font-extrabold uppercase tracking-[.14em] text-terracotta-light">
              You asked about
            </div>
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
              {sentServices.map((slug) => (
                <li
                  key={slug}
                  className="rounded-pill border border-edge-rule px-4 py-2 text-[13.5px] font-bold text-dark-body"
                >
                  {nameOf(slug)}
                </li>
              ))}
            </ul>
          </>
        )}

        {bookingUrl && (
          <div className="mt-8 border-t border-edge-rule pt-7">
            <h4 className="text-[18px] text-white">Book a 30-minute call now</h4>
            <p className="m-0 mt-2 text-[13.5px] leading-[1.7] text-dark-muted">
              Skip the back-and-forth and pick a time that suits you.
            </p>
            <iframe
              src={bookingUrl}
              title="Book a 30-minute call with Motion 8"
              className="mt-5 h-[680px] w-full rounded-[10px] border-0 bg-white"
            />
            <a
              href={calendlyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex min-h-[44px] items-center text-[14px] font-bold text-dark-body underline decoration-edge-rule underline-offset-[6px] transition-colors hover:text-terracotta-light"
            >
              Open the booking page in a new tab
            </a>
          </div>
        )}
      </div>
    );
  }

  const prompt = PROMPTS[pillarOf.get(values.services[0] ?? "") ?? "default"] ?? PROMPTS.default;
  const errId = (k: keyof Values) => `cf-${k}-error`;
  const describedBy = (k: keyof Values, hint?: string) =>
    [hint, errors[k] ? errId(k) : ""].filter(Boolean).join(" ") || undefined;
  const fieldError = (k: keyof Values) =>
    errors[k] ? (
      <span id={errId(k)} className={ERROR}>
        {errors[k]}
      </span>
    ) : null;
  const phoneRequired = values.contactPref !== "email";
  const last = step === STEPS.length - 1;

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      aria-label="Project enquiry"
      className="relative w-full min-w-0 max-w-[640px] scroll-mt-28"
    >
      {/* Progress */}
      <div>
        <div className="flex items-baseline justify-between gap-4 text-[12px] font-bold uppercase tracking-[.14em]">
          <span className="text-terracotta-light">
            Step {step + 1} of {STEPS.length}
          </span>
          <span className="hidden text-dark-faint sm:inline">{STEPS[step].title}</span>
        </div>
        <div aria-hidden className="mt-3 grid grid-cols-3 gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`h-[3px] rounded-full transition-colors duration-500 ${
                i <= step ? "bg-terracotta-light" : "bg-edge-rule"
              }`}
            />
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div ref={stepRef} className="mt-8">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-[clamp(22px,3vw,28px)] leading-[1.2] tracking-[-0.02em] text-white outline-none"
        >
          <span className="sr-only">
            Step {step + 1} of {STEPS.length}:{" "}
          </span>
          {STEPS[step].title}
        </h3>

        {step === 0 && (
          <div className="mt-7 space-y-7">
            <div>
              <ServicePicker
                groups={groups}
                value={values.services}
                onChange={(list) => set("services", list)}
                nameOf={nameOf}
                error={errors.services}
                errorId={errId("services")}
                inputId="cf-services"
              />
              {fieldError("services")}
            </div>
            <div>
              <label htmlFor="cf-url" className={LABEL}>
                Website or product URL <span className={OPTIONAL}>(optional)</span>
              </label>
              <input
                id="cf-url"
                type="text"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={300}
                value={values.url}
                onChange={(e) => set("url", e.target.value)}
                aria-invalid={Boolean(errors.url)}
                aria-describedby={describedBy("url")}
                placeholder="yourcompany.com"
                className={control(Boolean(errors.url))}
              />
              {fieldError("url")}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="mt-7 space-y-7">
            <div className="grid grid-cols-1 gap-7 sm:grid-cols-2 sm:gap-5">
              <div>
                <label htmlFor="cf-budget" className={LABEL}>
                  Budget (USD)
                </label>
                <select
                  id="cf-budget"
                  required
                  value={values.budget}
                  onChange={(e) => set("budget", e.target.value)}
                  aria-invalid={Boolean(errors.budget)}
                  aria-describedby={describedBy("budget")}
                  className={`${control(Boolean(errors.budget))} select-chevron ${
                    values.budget ? "" : "text-dark-faint"
                  }`}
                >
                  <option value="" disabled>
                    Choose a range
                  </option>
                  {BUDGETS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                {fieldError("budget")}
              </div>
              <div>
                <label htmlFor="cf-timeline" className={LABEL}>
                  Timeline
                </label>
                <select
                  id="cf-timeline"
                  required
                  value={values.timeline}
                  onChange={(e) => set("timeline", e.target.value)}
                  aria-invalid={Boolean(errors.timeline)}
                  aria-describedby={describedBy("timeline")}
                  className={`${control(Boolean(errors.timeline))} select-chevron ${
                    values.timeline ? "" : "text-dark-faint"
                  }`}
                >
                  <option value="" disabled>
                    Choose a timeline
                  </option>
                  {TIMELINES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {fieldError("timeline")}
              </div>
            </div>
            <div>
              <label htmlFor="cf-message" className={LABEL}>
                Tell us about the project
              </label>
              <p id="cf-message-hint" className={HINT}>
                {prompt.hint}
              </p>
              <textarea
                id="cf-message"
                rows={5}
                required
                maxLength={MESSAGE_MAX}
                value={values.message}
                onChange={(e) => set("message", e.target.value)}
                aria-invalid={Boolean(errors.message)}
                aria-describedby={describedBy("message", "cf-message-hint")}
                placeholder={prompt.placeholder}
                className={`${control(Boolean(errors.message))} resize-y leading-[1.6]`}
              />
              {fieldError("message")}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-7 space-y-7">
            <div className="grid grid-cols-1 gap-7 sm:grid-cols-2 sm:gap-5">
              <div>
                <label htmlFor="cf-name" className={LABEL}>
                  Name
                </label>
                <input
                  id="cf-name"
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={200}
                  value={values.name}
                  onChange={(e) => set("name", e.target.value)}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={describedBy("name")}
                  className={control(Boolean(errors.name))}
                />
                {fieldError("name")}
              </div>
              <div>
                <label htmlFor="cf-email" className={LABEL}>
                  Work email
                </label>
                <input
                  id="cf-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  value={values.email}
                  onChange={(e) => set("email", e.target.value)}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={describedBy("email")}
                  className={control(Boolean(errors.email))}
                />
                {fieldError("email")}
              </div>
            </div>

            <div>
              <label htmlFor="cf-company" className={LABEL}>
                Company <span className={OPTIONAL}>(optional)</span>
              </label>
              <input
                id="cf-company"
                type="text"
                autoComplete="organization"
                maxLength={200}
                value={values.company}
                onChange={(e) => set("company", e.target.value)}
                className={control(false)}
              />
            </div>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className={LABEL}>Preferred contact</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {CONTACT_PREFS.map((p) => {
                  const checked = values.contactPref === p.value;
                  return (
                    <label
                      key={p.value}
                      className={`relative inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-pill border px-4 text-[14px] font-bold transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-terracotta-light ${
                        checked
                          ? "border-terracotta-light bg-[rgba(228,100,42,.12)] text-white"
                          : "border-edge-rule text-dark-muted hover:text-dark-body"
                      }`}
                    >
                      <input
                        type="radio"
                        name="contactPref"
                        value={p.value}
                        checked={checked}
                        onChange={() => set("contactPref", p.value)}
                        className="sr-only"
                      />
                      <span
                        aria-hidden
                        className={`h-3.5 w-3.5 rounded-full border-[1.5px] ${
                          checked
                            ? "border-terracotta-light bg-terracotta-light shadow-[inset_0_0_0_2px_#1B130D]"
                            : "border-edge-stone"
                        }`}
                      />
                      {p.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="cf-phone" className={LABEL}>
                Phone / WhatsApp{" "}
                <span className={OPTIONAL}>
                  {phoneRequired ? "(required for a call or WhatsApp)" : "(optional)"}
                </span>
              </label>
              <div className="flex gap-2">
                <div className="w-[112px] shrink-0">
                  <label htmlFor="cf-dial" className="sr-only">
                    Country code
                  </label>
                  <select
                    id="cf-dial"
                    value={values.dial}
                    onChange={(e) => set("dial", e.target.value)}
                    className={`${control(false)} select-chevron pl-3`}
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} {c.dial}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  id="cf-phone"
                  type="tel"
                  autoComplete="tel-national"
                  inputMode="tel"
                  required={phoneRequired}
                  maxLength={30}
                  value={values.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={describedBy("phone")}
                  className={`${control(Boolean(errors.phone))} min-w-0 flex-1`}
                />
              </div>
              {fieldError("phone")}
            </div>
          </div>
        )}
      </div>

      {/* Honeypot — hidden from people, irresistible to bots. */}
      <div aria-hidden className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input
          ref={honeypotRef}
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-4">
        {last ? (
          <MagneticButton type="submit" variant="primary" disabled={status === "sending"}>
            {status === "sending" ? "Sending…" : "Send enquiry"}
          </MagneticButton>
        ) : (
          <MagneticButton type="submit" variant="primary">
            Continue <span aria-hidden>→</span>
          </MagneticButton>
        )}
        {step > 0 && (
          <button
            type="button"
            onClick={() => goTo(step - 1)}
            className="inline-flex min-h-[44px] items-center px-2 text-[14px] font-bold text-dark-muted underline decoration-edge-rule underline-offset-[6px] transition-colors hover:text-terracotta-light"
          >
            <span aria-hidden>←&nbsp;</span>Back
          </button>
        )}
      </div>

      {last && (
        <p className="m-0 mt-5 text-[12.5px] leading-[1.7] text-dark-muted">
          Reply within 24 hours · NDA on request · You own the code and IP from the first commit
        </p>
      )}

      <div className="mt-4" role="alert">
        {status === "error" && formError && (
          <p className="m-0 text-[13.5px] text-terracotta-light">{formError}</p>
        )}
      </div>
    </form>
  );
}
