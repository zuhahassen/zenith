// User settings persisted to localStorage. These pre-fill the setup form and
// the compare view so a returning observer doesn't re-enter their rig + site.

import type { CatalogFilter, Mode } from "../types/zenith";

const KEY = "zenith_settings_v1";

export interface ZenithSettings {
  locationLabel: string;
  lat: number | null;
  lon: number | null;
  aperture_mm: number;
  mode: Mode;
  focal_length_mm: number;
  sensor_width_mm: number;
  sensor_height_mm: number;
  bortle_class: number | null; // null = auto-estimate
  catalog: "all" | CatalogFilter;
  timezone: "utc" | "local";
}

export const DEFAULT_SETTINGS: ZenithSettings = {
  locationLabel: "",
  lat: null,
  lon: null,
  aperture_mm: 150,
  mode: "observer",
  focal_length_mm: 750,
  sensor_width_mm: 23.5,
  sensor_height_mm: 15.6,
  bortle_class: null,
  catalog: "all",
  timezone: "utc",
};

export function loadSettings(): ZenithSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ZenithSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: ZenithSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage disabled — non-fatal */
  }
}

export function resetSettings(): ZenithSettings {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}
