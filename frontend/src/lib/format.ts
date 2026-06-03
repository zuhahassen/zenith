// Shared formatting + classification helpers for the Zenith UI.
// Centralized so the table, timeline, and detail panel stay consistent.

import type { ObjectKind } from "../types/zenith";

// --- Object type classification -------------------------------------------
// Map SIMBAD-ish kinds to the compact 2–4 char codes used in the data table,
// plus a human label and a muted palette color (see index.css design system).

export interface TypeInfo {
  code: string; // Gx, EN, RN, PN, GlCl, OpCl, SNR, ...
  label: string; // full human label
  color: string; // muted hex matching the new palette
}

const STEEL = "#9db8d2"; // default data-blue
const TYPE_TABLE: Record<string, TypeInfo> = {
  Galaxy: { code: "Gx", label: "Galaxy", color: "#7fa8cc" },
  Nebula: { code: "EN", label: "Emission nebula", color: "#6fa8a6" },
  EmissionNebula: { code: "EN", label: "Emission nebula", color: "#6fa8a6" },
  ReflectionNebula: { code: "RN", label: "Reflection nebula", color: "#8f9fc0" },
  PlanetaryNebula: { code: "PN", label: "Planetary nebula", color: "#6fb0a0" },
  GlCl: { code: "GlCl", label: "Globular cluster", color: "#c9c2b4" },
  OpenCl: { code: "OpCl", label: "Open cluster", color: "#8a9cae" },
  SNR: { code: "SNR", label: "Supernova remnant", color: "#b08070" },
  Unknown: { code: "—", label: "Unknown", color: STEEL },
};

export function typeInfo(kind: ObjectKind | string | null | undefined): TypeInfo {
  if (!kind) return TYPE_TABLE.Unknown;
  return TYPE_TABLE[kind] ?? { code: String(kind).slice(0, 4), label: String(kind), color: STEEL };
}

// --- Seeing quality ---------------------------------------------------------

export interface SeeingQuality {
  color: string;
  label: string; // GOOD | AVERAGE | POOR
}

export function seeingQuality(value: number): SeeingQuality {
  if (value < 1.5) return { color: "var(--good)", label: "GOOD" };
  if (value <= 2.5) return { color: "var(--avg)", label: "AVERAGE" };
  return { color: "var(--poor)", label: "POOR" };
}

// Literal hex variants for SVG presentation attributes (var() doesn't resolve).
export function seeingHex(value: number): string {
  if (value < 1.5) return "#5a8a5a";
  if (value <= 2.5) return "#7a7850";
  return "#7a4a40";
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

// --- Time helpers (UTC HH:mm) ----------------------------------------------

export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
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
