"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  NOT_SURE_LABEL,
  NOT_SURE_SLUG,
  type ServiceGroup,
} from "@/content/contact-options";

type Option = { slug: string; name: string; group: string };

/**
 * Multi-select combobox (WAI-ARIA 1.2 combobox + listbox). Focus stays on the
 * input; the active option is conveyed with aria-activedescendant.
 * ↑/↓ move, Enter toggles, Escape closes, Backspace on an empty input removes
 * the last chip. Chips' × buttons also remove on Backspace/Delete.
 */
export function ServicePicker({
  groups,
  value,
  onChange,
  nameOf,
  error,
  errorId,
  inputId,
}: {
  groups: ServiceGroup[];
  value: string[];
  onChange: (next: string[]) => void;
  nameOf: (slug: string) => string;
  error?: string;
  errorId: string;
  inputId: string;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const labelId = `${uid}-label`;
  const hintId = `${uid}-hint`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const q = query.trim().toLowerCase();

  const sections = useMemo(() => {
    const notSure: Option = { slug: NOT_SURE_SLUG, name: NOT_SURE_LABEL, group: "" };
    const match = (o: { name: string }) => !q || o.name.toLowerCase().includes(q);
    const result: { label: string; options: Option[] }[] = [];
    if (match(notSure) || !q) result.push({ label: "", options: [notSure] });
    for (const g of groups) {
      const options = g.services
        .filter((s) => match(s) || g.label.toLowerCase().includes(q))
        .map((s) => ({ ...s, group: g.label }));
      if (options.length) result.push({ label: g.label, options });
    }
    return result;
  }, [groups, q]);

  const flat = useMemo(() => sections.flatMap((s) => s.options), [sections]);

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  // Keep the active option in view while arrowing.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Close on outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggle = (slug: string) => {
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  };

  const remove = (index: number) => {
    const next = value.filter((_, i) => i !== index);
    onChange(next);
    // Move focus to the neighbouring chip, or back to the input.
    window.setTimeout(() => {
      const target = chipRefs.current[Math.min(index, next.length - 1)];
      if (next.length && target) target.focus();
      else inputRef.current?.focus();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(Math.max(0, flat.length - 1));
        }
        break;
      case "Enter":
        if (open && flat[active]) {
          e.preventDefault();
          toggle(flat[active].slug);
        } else if (!open) {
          e.preventDefault();
          setOpen(true);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        } else if (query) {
          e.preventDefault();
          setQuery("");
        }
        break;
      case "Backspace":
        if (!query && value.length) {
          e.preventDefault();
          onChange(value.slice(0, -1));
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const activeId = open && flat[active] ? `${uid}-opt-${flat[active].slug}` : undefined;
  let index = -1;

  return (
    <div ref={wrapRef} className="relative">
      <label id={labelId} htmlFor={inputId} className="block text-[13.5px] font-bold text-dark-body">
        Services <span className="font-normal text-dark-faint">(choose one or more)</span>
      </label>
      <p id={hintId} className="m-0 mt-1 text-[12.5px] leading-[1.6] text-dark-faint">
        Type to search, use the arrow keys and Enter to select.
      </p>

      {value.length > 0 && (
        <ul aria-label="Selected services" className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
          {value.map((slug, i) => (
            <li
              key={slug}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-pill border border-[rgba(228,100,42,.45)] bg-[rgba(228,100,42,.12)] py-1 pl-4 pr-1 text-[13.5px] font-bold text-dark-body"
            >
              <span>{nameOf(slug)}</span>
              <button
                ref={(el) => {
                  chipRefs.current[i] = el;
                }}
                type="button"
                aria-label={`Remove ${nameOf(slug)}`}
                onClick={() => remove(i)}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" || e.key === "Delete") {
                    e.preventDefault();
                    remove(i);
                  }
                }}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[18px] leading-none text-dark-muted transition-colors hover:bg-[rgba(240,233,223,.1)] hover:text-white"
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative mt-3">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={Boolean(error)}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          value={query}
          placeholder={value.length ? "Add another service…" : "e.g. SEO, AI agents, mobile app"}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={`min-h-[52px] w-full rounded-[10px] border bg-[rgba(240,233,223,.04)] py-3 pl-4 pr-12 text-[16px] text-white outline-none transition-colors placeholder:text-dark-faint focus:border-terracotta-light ${
            error ? "border-terracotta-light" : "border-edge-rule"
          }`}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => {
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-dark-muted"
        >
          <svg width="12" height="8" viewBox="0 0 12 8" className={`transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M1 1.5 6 6.5l5-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={labelId}
          data-lenis-prevent
          hidden={!open}
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-[min(360px,55vh)] overflow-y-auto overscroll-contain rounded-[12px] border border-edge-rule bg-[#231910] p-1.5 shadow-nav"
        >
          {flat.length === 0 && (
            <div className="px-3 py-3 text-[13.5px] text-dark-muted">
              No match — choose “{NOT_SURE_LABEL}” or describe it in step 2.
            </div>
          )}
          {sections.map((section) => (
            <div
              key={section.label || "not-sure"}
              role="group"
              aria-label={section.label || "Help me decide"}
              className={section.label ? "mt-1 border-t border-edge-nav pt-1 first:mt-0 first:border-0 first:pt-0" : ""}
            >
              {section.label && (
                <div
                  aria-hidden
                  className="px-3 pb-1 pt-2.5 text-[11px] font-extrabold uppercase tracking-[.14em] text-terracotta-light"
                >
                  {section.label}
                </div>
              )}
              {section.options.map((option) => {
                index += 1;
                const i = index;
                const selected = value.includes(option.slug);
                return (
                  <div
                    key={option.slug}
                    id={`${uid}-opt-${option.slug}`}
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setActive(i);
                      toggle(option.slug);
                    }}
                    onPointerMove={() => setActive(i)}
                    className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2 text-[14.5px] ${
                      i === active ? "bg-[rgba(240,233,223,.08)] text-white" : "text-dark-body"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border ${
                        selected ? "border-terracotta bg-terracotta" : "border-edge-stone"
                      }`}
                    >
                      {selected && (
                        <svg width="10" height="8" viewBox="0 0 10 8">
                          <path d="M1 4l2.6 2.6L9 1.2" fill="none" stroke="#fff" strokeWidth="1.8" />
                        </svg>
                      )}
                    </span>
                    <span className={option.slug === NOT_SURE_SLUG ? "font-bold" : ""}>{option.name}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {value.length === 0
          ? "No services selected."
          : `${value.length} selected: ${value.map(nameOf).join(", ")}.`}
      </p>
    </div>
  );
}
