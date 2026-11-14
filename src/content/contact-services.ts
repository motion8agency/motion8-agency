import { NOT_SURE_LABEL, NOT_SURE_SLUG, type ServiceGroup } from "./contact-options";
import { PILLARS } from "./pillars";

/** Server-side: service picker groups derived from PILLARS (pillar shortName as label). */
export const SERVICE_GROUPS: ServiceGroup[] = PILLARS.map((pillar) => ({
  pillar: pillar.slug,
  label: pillar.shortName,
  services: pillar.services.map((s) => ({ slug: s.slug, name: s.name })),
}));

/** slug → display name, including the "not sure" option. */
export const SERVICE_NAMES: Map<string, string> = new Map([
  ...SERVICE_GROUPS.flatMap((g) => g.services.map((s) => [s.slug, s.name] as const)),
  [NOT_SURE_SLUG, NOT_SURE_LABEL] as const,
]);
