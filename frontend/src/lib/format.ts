// Shared formatting + classification helpers for the Zenith UI.
// Centralized so the table, timeline, and detail panel stay consistent.

import type { ObjectKind } from "../types/zenith";

// --- Object type classification -------------------------------------------
// Map SIMBAD-ish kinds to the compact 2–4 char codes used in the data table,
// plus a human label and a muted palette color (see index.css design system).

export interface TypeInfo {
  code: string; // Gx, EN, RN, PN, GlCl, OpCl, SNR, ... (compact, used in filters)
  short: string; // friendly compact label for table rows
  label: string; // full human label
  color: string; // palette hex used to accent the type in the list + timeline
}

// Object-type palette — colorful accents that help scan the target list and
// timeline at a glance (galaxies blue, nebulae teal, clusters pale, etc.).
// Literal hexes (not var()) so they also work as SVG presentation attributes.
const STEEL = "#3d5080"; // --color-other
const TYPE_TABLE: Record<string, TypeInfo> = {
  Galaxy: { code: "Gx", short: "Galaxy", label: "Galaxy", color: "#6b9fd4" },
  Nebula: { code: "EN", short: "Nebula", label: "Emission nebula", color: "#6bc4c4" },
  EmissionNebula: { code: "EN", short: "Nebula", label: "Emission nebula", color: "#6bc4c4" },
  ReflectionNebula: { code: "RN", short: "Nebula", label: "Reflection nebula", color: "#8aabad" },
  PlanetaryNebula: { code: "PN", short: "Plan. Neb.", label: "Planetary nebula", color: "#6bc4c4" },
  GlCl: { code: "GlCl", short: "Globular", label: "Globular cluster", color: "#d4d4f0" },
  OpenCl: { code: "OpCl", short: "Open Cluster", label: "Open cluster", color: "#8aabad" },
  SNR: { code: "SNR", short: "SN Remnant", label: "Supernova remnant", color: "#b08a8a" },
  Unknown: { code: "—", short: "—", label: "Unknown", color: STEEL },
};

export function typeInfo(kind: ObjectKind | string | null | undefined): TypeInfo {
  if (!kind) return TYPE_TABLE.Unknown;
  const s = String(kind);
  return TYPE_TABLE[kind] ?? { code: s.slice(0, 4), short: s, label: s, color: STEEL };
}

// Friendly, plain-language labels for the object-type filter buttons. The
// `code` is what the table filter actually matches against (see typeInfo).
export const TYPE_FILTERS: { code: string; label: string }[] = [
  { code: "Gx", label: "Galaxies" },
  { code: "EN", label: "Nebulae" },
  { code: "PN", label: "Planetary Nebulae" },
  { code: "GlCl", label: "Globular Clusters" },
  { code: "OpCl", label: "Open Clusters" },
];

// Popular common names for well-known deep-sky objects, shown as a subtle
// secondary label when the catalog doesn't already supply one. Each entry maps
// a friendly name to every designation it's commonly catalogued under (Messier,
// NGC, IC) so a target named "NGC 224" or "M 31" both resolve to "Andromeda
// Galaxy". Keys are normalized (spaces removed, uppercased) at build time.
const POPULAR_NAMES: [name: string, designations: string[]][] = [
  // Galaxies
  ["Andromeda Galaxy", ["M31", "NGC224"]],
  ["Triangulum Galaxy", ["M33", "NGC598"]],
  ["Whirlpool Galaxy", ["M51", "NGC5194"]],
  ["Bode's Galaxy", ["M81", "NGC3031"]],
  ["Cigar Galaxy", ["M82", "NGC3034"]],
  ["Sunflower Galaxy", ["M63", "NGC5055"]],
  ["Black Eye Galaxy", ["M64", "NGC4826"]],
  ["Pinwheel Galaxy", ["M101", "NGC5457"]],
  ["Sombrero Galaxy", ["M104", "NGC4594"]],
  ["Southern Pinwheel Galaxy", ["M83", "NGC5236"]],
  ["Surfboard Galaxy", ["M108", "NGC3556"]],
  ["Virgo A", ["M87", "NGC4486"]],
  ["Sculptor Galaxy", ["NGC253"]],
  ["Centaurus A", ["NGC5128"]],
  ["Needle Galaxy", ["NGC4565"]],
  ["Whale Galaxy", ["NGC4631"]],
  ["Hockey Stick Galaxy", ["NGC4656"]],
  ["Splinter Galaxy", ["NGC5907"]],
  ["Barnard's Galaxy", ["NGC6822"]],
  ["Bear Paw Galaxy", ["NGC2537"]],

  // Nebulae
  ["Orion Nebula", ["M42", "NGC1976"]],
  ["De Mairan's Nebula", ["M43", "NGC1982"]],
  ["Lagoon Nebula", ["M8", "NGC6523"]],
  ["Eagle Nebula", ["M16", "NGC6611"]],
  ["Omega Nebula", ["M17", "NGC6618"]],
  ["Trifid Nebula", ["M20", "NGC6514"]],
  ["Ring Nebula", ["M57", "NGC6720"]],
  ["Dumbbell Nebula", ["M27", "NGC6853"]],
  ["Little Dumbbell Nebula", ["M76", "NGC650"]],
  ["Owl Nebula", ["M97", "NGC3587"]],
  ["Crab Nebula", ["M1", "NGC1952"]],
  ["North America Nebula", ["NGC7000"]],
  ["Pelican Nebula", ["IC5070"]],
  ["Veil Nebula", ["NGC6960", "NGC6992", "NGC6995"]],
  ["Helix Nebula", ["NGC7293"]],
  ["Rosette Nebula", ["NGC2237", "NGC2244"]],
  ["Eskimo Nebula", ["NGC2392"]],
  ["Ghost of Jupiter", ["NGC3242"]],
  ["Cat's Eye Nebula", ["NGC6543"]],
  ["Blinking Planetary", ["NGC6826"]],
  ["Saturn Nebula", ["NGC7009"]],
  ["Bubble Nebula", ["NGC7635"]],
  ["Pacman Nebula", ["NGC281"]],
  ["California Nebula", ["NGC1499"]],
  ["Flame Nebula", ["NGC2024"]],
  ["Horsehead Nebula", ["IC434"]],
  ["Crescent Nebula", ["NGC6888"]],
  ["Bug Nebula", ["NGC6302"]],
  ["Elephant's Trunk Nebula", ["IC1396"]],
  ["Flaming Star Nebula", ["IC405"]],
  ["Cocoon Nebula", ["IC5146"]],

  // Star clusters
  ["Pleiades", ["M45"]],
  ["Beehive Cluster", ["M44", "NGC2632"]],
  ["Hercules Cluster", ["M13", "NGC6205"]],
  ["Great Pegasus Cluster", ["M15", "NGC7078"]],
  ["Sagittarius Cluster", ["M22", "NGC6656"]],
  ["Wild Duck Cluster", ["M11", "NGC6705"]],
  ["Butterfly Cluster", ["M6", "NGC6405"]],
  ["Ptolemy Cluster", ["M7", "NGC6475"]],
  ["Rose Cluster", ["M5", "NGC5904"]],
  ["Sagittarius Star Cloud", ["M24"]],
  ["Double Cluster", ["NGC869", "NGC884"]],
  ["Owl Cluster", ["NGC457"]],
  ["Christmas Tree Cluster", ["NGC2264"]],
];

// Flatten into a normalized designation -> name lookup.
const NICKNAMES: Record<string, string> = {};
for (const [name, designations] of POPULAR_NAMES) {
  for (const d of designations) NICKNAMES[d.replace(/\s+/g, "").toUpperCase()] = name;
}

export function popularName(designation: string | null | undefined): string | null {
  if (!designation) return null;
  return NICKNAMES[designation.replace(/\s+/g, "").toUpperCase()] ?? null;
}

// --- Seeing quality ---------------------------------------------------------

export interface SeeingQuality {
  color: string;
  label: string; // GOOD | AVERAGE | POOR
}

export function seeingQuality(value: number): SeeingQuality {
  // Color-coded so a good night reads green at a glance.
  if (value < 1.5) return { color: "var(--good)", label: "GOOD" };
  if (value <= 2.5) return { color: "var(--avg)", label: "AVERAGE" };
  return { color: "var(--poor)", label: "POOR" };
}

// Literal hex variants for SVG presentation attributes (var() doesn't resolve).
export function seeingHex(value: number): string {
  if (value < 1.5) return "#4a9e6a"; // GOOD — --good (green)
  if (value <= 2.5) return "#7a8e5a"; // AVERAGE — --avg
  return "#8e4a4a"; // POOR — --poor
}

// --- Coordinates ------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatRA(deg: number): string {
  let h = (deg / 15) % 24;
  if (h < 0) h += 24;
  const hh = Math.floor(h);
  const mFloat = (h - hh) * 60;
  const mm = Math.floor(mFloat);
  const ss = Math.round((mFloat - mm) * 60);
  return `${pad(hh)}h ${pad(mm)}m ${pad(ss)}s`;
}

export function formatDec(deg: number): string {
  const sign = deg < 0 ? "−" : "+";
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const mFloat = (a - dd) * 60;
  const mm = Math.floor(mFloat);
  const ss = Math.round((mFloat - mm) * 60);
  return `${sign}${pad(dd)}° ${pad(mm)}′ ${pad(ss)}″`;
}

// --- Time helpers -----------------------------------------------------------
// Display timezone is a user preference (Settings → Display preferences). We
// keep a tiny module-level flag so every formatter stays consistent without
// threading the setting through every component. App sets it on load and
// whenever the preference changes, then re-renders the tree.

let tzMode: "utc" | "local" = "utc";

export function setTimeZoneMode(mode: "utc" | "local"): void {
  tzMode = mode;
}

// Short label to append after times, e.g. "UTC" or the local abbreviation.
export function tzLabel(): string {
  if (tzMode === "utc") return "UTC";
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  if (tzMode === "local") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function durationLabel(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

export function airmassLabel(airmass: number): string {
  if (airmass <= 1.1) return "excellent";
  if (airmass <= 1.5) return "good";
  if (airmass <= 2.0) return "fair";
  return "poor";
}
