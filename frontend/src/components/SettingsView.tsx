import { useState } from "react";
import { getUserId } from "../lib/feedback";
import { DEFAULT_SETTINGS, type ZenithSettings } from "../lib/settings";
import type { Mode } from "../types/zenith";

interface Props {
  settings: ZenithSettings;
  onSave: (s: ZenithSettings) => void;
  onReset: () => void;
}

export function SettingsView({ settings, onSave, onReset }: Props) {
  const [draft, setDraft] = useState<ZenithSettings>(settings);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof ZenithSettings>(key: K, value: ZenithSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  function save() {
    onSave(draft);
    setSaved(true);
  }

  return (
    <div className="settings">
      <div className="fieldset">
        <div className="fieldset__legend">Location defaults</div>
        <div className="form-grid">
          <div className="form-row">
            <span className="form-row__label">Label</span>
            <div className="form-row__control">
              <input
                type="text"
                className="grow"
                value={draft.locationLabel}
                onChange={(e) => set("locationLabel", e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <span className="form-row__label">Lat / Lon</span>
            <div className="form-row__control">
              <input
                type="number"
                step="0.0001"
                style={{ width: 110 }}
                value={draft.lat ?? ""}
                onChange={(e) => set("lat", e.target.value === "" ? null : Number(e.target.value))}
              />
              <input
                type="number"
                step="0.0001"
                style={{ width: 110 }}
                value={draft.lon ?? ""}
                onChange={(e) => set("lon", e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="fieldset">
        <div className="fieldset__legend">Equipment defaults</div>
        <div className="form-grid">
          <div className="form-row">
            <span className="form-row__label">Mode</span>
            <div className="form-row__control">
              <div className="segmented">
                <button className={draft.mode === "observer" ? "active" : ""} onClick={() => set("mode", "observer" as Mode)}>
                  Observer
                </button>
                <button className={draft.mode === "astrophotographer" ? "active" : ""} onClick={() => set("mode", "astrophotographer" as Mode)}>
                  Astrophoto
                </button>
              </div>
            </div>
          </div>
          <div className="form-row">
            <span className="form-row__label">Aperture</span>
            <div className="form-row__control">
              <input type="number" style={{ width: 90 }} value={draft.aperture_mm} onChange={(e) => set("aperture_mm", Number(e.target.value))} />
              <span className="field-hint">mm</span>
            </div>
          </div>
          <div className="form-row">
            <span className="form-row__label">Focal</span>
            <div className="form-row__control">
              <input type="number" style={{ width: 90 }} value={draft.focal_length_mm} onChange={(e) => set("focal_length_mm", Number(e.target.value))} />
              <span className="field-hint">mm</span>
            </div>
          </div>
          <div className="form-row">
            <span className="form-row__label">Sensor</span>
            <div className="form-row__control">
              <input type="number" step="0.1" style={{ width: 80 }} value={draft.sensor_width_mm} onChange={(e) => set("sensor_width_mm", Number(e.target.value))} />
              <span className="field-hint">×</span>
              <input type="number" step="0.1" style={{ width: 80 }} value={draft.sensor_height_mm} onChange={(e) => set("sensor_height_mm", Number(e.target.value))} />
              <span className="field-hint">mm</span>
            </div>
          </div>
        </div>
      </div>

      <div className="fieldset">
        <div className="fieldset__legend">Display preferences</div>
        <div className="form-grid">
          <div className="form-row">
            <span className="form-row__label">Timezone</span>
            <div className="form-row__control">
              <div className="segmented">
                <button className={draft.timezone === "utc" ? "active" : ""} onClick={() => set("timezone", "utc")}>
                  UTC
                </button>
                <button className={draft.timezone === "local" ? "active" : ""} onClick={() => set("timezone", "local")}>
                  Local
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="fieldset">
        <div className="fieldset__legend">Account</div>
        <div className="form-grid">
          <div className="form-row">
            <span className="form-row__label">User ID</span>
            <div className="form-row__control">
              <span className="settings__account">{getUserId()}</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="primary" onClick={save}>Save</button>
        <button
          onClick={() => {
            setDraft({ ...DEFAULT_SETTINGS });
            onReset();
            setSaved(false);
          }}
        >
          Reset to defaults
        </button>
        {saved && <span className="settings__saved">Saved ✓</span>}
      </div>
    </div>
  );
}
