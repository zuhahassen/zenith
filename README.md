# Zenith

An observation-planning engine for deep-sky astronomy. Given an observer
location, aperture, and date, it ranks catalog targets by their observability
for that night using positional astronomy, a light-pollution model, and a
data-driven atmospheric-seeing forecast.

## Overview

The system resolves a catalog of deep-sky objects, propagates each to the
horizontal coordinate frame for the requested site and night, discards objects
that never clear the horizon during astronomical darkness, and scores the
remainder on a weighted combination of peak altitude, lunar interference,
surface brightness against the local sky background, and a per-slot seeing
forecast. For astrophotography it additionally computes per-filter acquisition
windows from wavelength-dependent extinction and a sensor field-of-view match.
The deterministic pipeline is pure and reproducible: identical inputs yield
identical output, independent of any external service.

## Backend pipeline and the math

**Visibility.** Each target is transformed from equatorial (RA, Dec) to the
local horizontal frame. Altitude follows the standard relation

    sin(alt) = sin(phi) sin(dec) + cos(phi) cos(dec) cos(H)

where `phi` is the observer latitude and `H` the local hour angle. The
observing window is bounded by astronomical twilight, defined as solar
altitude below -18 degrees. Lunar interference uses the great-circle
separation between target and Moon (via the dot product of their unit
vectors) weighted by the illuminated fraction.

**Surface brightness and light pollution.** Mean surface brightness is
estimated from integrated magnitude `m` and angular area `A` (arcsec^2) as

    mu = m + 2.5 log10(A)

A target is penalized when its surface brightness approaches the sky-background
brightness implied by the site Bortle class, so diffuse low-contrast objects
are demoted under bright skies and high-surface-brightness objects (globular
clusters, planetary nebulae) are not. The Bortle class is taken from the user
or estimated from coordinates via a coarse population-center model.

**Field of view (astrophotography).** The angular field for focal length `f`
and sensor dimension `s` is `2 arctan(s / 2f)`, approximated for small angles
by `(s / f) * 57.3` degrees. A framing score compares this to the target's
angular size and flags objects that need a mosaic or under-fill the frame.

**Filter scheduling.** Atmospheric extinction scales with airmass `X = sec(z)`
and increases toward shorter wavelengths, so blue acquisition is restricted to
windows near transit (low airmass) while red and narrowband bands are allowed
across the wider window.

## Atmospheric-seeing model

Seeing (FWHM, arcseconds) is forecast for sixteen 30-minute slots by a gradient
-boosted regression tree ensemble (XGBoost). Inputs are a 24-feature vector
(`api/ml/features.py`) built from a trailing weather history: instantaneous
state, rolling temperature/humidity statistics over 30 min / 1 h / 3 h, a wind
-shear delta, and cyclic encodings of hour-of-night and day-of-year. Missing
values are propagated as NaN and handled natively by the trees. Each slot
selects the weather sample nearest its timestamp from a window spanning the
recent past (for the rolling statistics) and the upcoming forecast hours, so
the forecast genuinely varies across the night rather than repeating a single
latest observation.

**Quantile regression and confidence.** A single booster is trained with the
pinball loss (`reg:quantileerror`) to predict the 10th, 50th, and 90th
percentiles simultaneously. The median (P50) is the point estimate; the P10-P90
interval width drives a per-slot confidence. Because the model's empirical
spread is narrow (Stanford 3-year ERA5: P10-P90 width clusters around
0.23-0.50 arcsec), confidence is a linear map anchored to that distribution

    t          = (spread - s_tight) / (s_wide - s_tight)
    confidence  = clip(c_max - t (c_max - c_min), c_min, c_max)

with `s_tight = 0.23"`, `s_wide = 0.50"`, `c_min = 0.40`, `c_max = 0.95`. A
narrow interval yields high confidence and a wide one low; a naive `1/spread`
map saturates here and is not used. Legacy single-output models remain
supported via a flat confidence.

Two training paths are supported (`api/ml/train_xgb.py`):

- **Synthetic** (default): physically-motivated weather histories with labels
  drawn from a log-normal seeing distribution modulated by wind, thermal
  variability, humidity, and cloud.
- **ERA5 reanalysis** (`api/ml/era5.py`): labels are derived from the optical
  -turbulence profile implied by ECMWF ERA5 pressure levels. Per layer,

      theta = T (P0 / P)^kappa                      (potential temperature)
      M     = -80e-6 (P / T) d(ln theta)/dz         (refractive-index gradient)
      Cn2   = 2.8 * M^2 * L0^(4/3)                   (Tatarski)

  with the outer scale `L0` from the Dewan (1993) wind-shear model. The profile
  is integrated to the turbulence integral `J = integral Cn2 dh`, converted to
  the Fried parameter `r0 = (0.423 k^2 sec(z) J)^(-3/5)` with `k = 2 pi / lambda`,
  and finally to seeing `eps = 0.98 lambda / r0`. The surface fields are mapped
  into the same feature contract used at inference. `api/ml/harvest_stanford.py`
  orchestrates a resumable, cost-aware ERA5 pull (hourly single-level fields as
  per-year timeseries plus pressure-level profiles in quarterly synoptic chunks)
  and `api/ml/check_distribution.py` validates that the derived labels are
  log-normal with a physically plausible median before training.

When no trained model is present, the predictor returns a climatological
constant so the pipeline degrades gracefully.

## Architecture

- **Data ingestion.** SIMBAD (Astroquery) for the catalog, Open-Meteo for
  hourly weather, Nominatim or browser geolocation for the observer site.
- **Deterministic pipeline** (`api/pipeline/`). Astropy-backed positional
  astronomy, the weighted scorer, the light-pollution and field-of-view models,
  and XGBoost seeing inference.
- **HTTP API** (FastAPI). `/api/plan` returns the deterministic plan;
  `/api/plan-ai` augments it with an optional narrative ordering layer that
  degrades to the deterministic result when unavailable, attaching a one-line
  rationale and a jargon-free `observer_note` (what a visual observer actually
  sees in the eyepiece) per target; `/api/explain` answers follow-up questions;
  `/api/compare-sites` scores 2–5 candidate sites for the same night on a
  transparent weighted composite; `/api/feedback`, `/api/community-favorites`,
  and `/api/history` persist and surface per-user ratings, crowd-sourced target
  quality, and past sessions through the Worker's D1 store.

Production runs on Cloudflare's edge plus a DigitalOcean droplet:

- **Cloudflare Pages** serves the built React app.
- **Cloudflare Workers** proxies `/api/*`, caches catalog queries in **KV**,
  persists ratings and history in **D1**, and reserves **R2** for binary
  artifacts.
- **DigitalOcean droplet** runs `uvicorn` behind nginx.

## Frontend interface

The React app is a single persistent three-panel workspace styled after
professional observatory software (dense data tables, 1px rules, monospaced
figures, a muted warm-neutral dark theme):

- **Left rail** — view navigation (Tonight, Compare Sites, History, Settings),
  a nearby community-favorites block, and a live session status readout (seeing
  model, Bortle, mean seeing, dark window).
- **Centre** — the active view. *Tonight* shows a session facts strip, a thin
  seeing-forecast sparkline, a sortable/filterable/paginated target data table,
  and a rank-ordered visibility timeline with a live "now" marker; the table
  and timeline share selection state.
- **Right rail** — the selected target's detail (coordinates, visibility math,
  Claude's rationale, the plain-English `observer_note`, astrophotography filter
  schedule, and a reference image) plus an inline terminal-style Q&A panel.

Returning observers' equipment and site defaults persist to `localStorage` and
pre-fill the setup form. Reference images are preloaded for the top targets so
they are ready before a card is opened.

## Stack

| Layer    | Tools                                                          |
|----------|----------------------------------------------------------------|
| Backend  | FastAPI, Astropy, Astroquery, XGBoost, NumPy, httpx            |
| Training | ERA5 (cdsapi), xarray, netCDF4 (offline data prep only)        |
| Frontend | React 18, Vite, TypeScript, recharts, @tanstack/react-query, lucide-react, date-fns |
| Edge     | Cloudflare Workers, Pages, KV, D1, R2                          |

## Local development

You need Python 3.11+ and Node 18+.

**Backend:**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/uvicorn api.main:app --reload --port 8000
```

**Frontend (separate terminal):**

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

The Vite dev server proxies `/api/*` to `localhost:8000`, so no CORS setup is needed locally. The Worker only matters once you deploy.

Run the test suite with `.venv/bin/python -m pytest -q`. Coverage spans the visibility pipeline, the deterministic scorer, the light-pollution and field-of-view models, and the optical-turbulence physics.

## Environment variables

| Variable             | Required?  | What happens without it                                       |
|----------------------|------------|---------------------------------------------------------------|
| `OPENROUTER_API_KEY` | optional   | `/api/plan-ai` returns the deterministic plan; `/api/explain` returns 503 |
| `SEEING_MODEL_PATH`  | optional   | Seeing predictor falls back to a climatological constant      |
| `CF_ACCOUNT_ID`      | for deploy | Used by `wrangler` when deploying the Worker / Pages          |
| `CF_API_TOKEN`       | for deploy | Same                                                          |

The Worker also takes a `BACKEND_URL` secret (the droplet's public URL): `wrangler secret put BACKEND_URL --config=worker/wrangler.toml`.

## Training the seeing model

The predictor ships with the synthetic path enabled. To train:

```bash
# Synthetic (no external data required)
.venv/bin/python -m api.ml.train_xgb --output api/ml/models/seeing_model.json

# ERA5 reanalysis (requires a configured ~/.cdsapirc from the Copernicus CDS).
# Harvest builds a site-specific multi-year dataset (resumable, cost-aware);
# the example below targets Stanford, CA.
.venv/bin/python -m api.ml.harvest_stanford
.venv/bin/python -m api.ml.check_distribution
.venv/bin/python -m api.ml.train_xgb --source era5 \
    --era5-cache api/ml/data/stanford_3yr.npz
```

The quantile booster is regularized (depth 4, L2, min-child-weight) with early
stopping. On the Stanford 3-year dataset (2192 nightly samples) it reaches
MAE 0.12 arcsec on the median with an out-of-season chronological holdout, and
the distribution check confirms log-normal labels with a ~1.3 arcsec median.

### Multi-site model

The seeing model generalizes across observatories rather than overfitting a
single location. The combined trainer ingests several geographically diverse
sites, splits each chronologically (so no site's future leaks into another's
past), and fits one quantile booster on the union:

| Site                    | Slug             | Lat       | Lon        |
|-------------------------|------------------|-----------|------------|
| Stanford, CA            | `stanford`       | +37.428   | -122.170   |
| Maunakea, HI            | `maunakea`       | +19.820   | -155.470   |
| La Palma, ES            | `lapalma`        | +28.760   | -17.890    |
| Haute-Provence, FR      | `haute_provence` | +43.931   | +5.714     |
| ESO Paranal, CL         | `paranal`        | -24.628   | -70.404    |
| SAAO Sutherland, ZA     | `sutherland`     | -32.378   | +20.811    |
| Kitt Peak, AZ           | `kittpeak`       | +31.958   | -111.597   |

```bash
# Harvest the four new sites and retrain across all seven in one step.
# Requires ~/.cdsapirc; reuses any existing api/ml/data/{slug}_era5.npz caches.
bash scripts/harvest_train_multisite.sh

# Or run the pieces manually:
.venv/bin/python -m api.ml.harvest_generic --lat 43.9308 --lon 5.7136 \
    --name haute_provence --years 2023 2024 2025
.venv/bin/python -m api.ml.train_multisite \
    --sites stanford maunakea lapalma haute_provence paranal sutherland kittpeak \
    --output api/ml/models/multisite_model.json
```

The trainer prints per-site and overall validation metrics (MAE, R², 80%
interval coverage); the run script tees them to `multisite_metrics.txt`. Point
`SEEING_MODEL_PATH` at the resulting `multisite_model.json` to serve it.

The ERA5 dependencies (`cdsapi`, `xarray`, `netCDF4`) are imported lazily and are only needed for this offline step, not by the API server. Harvested datasets live under `api/ml/data/` (gitignored); only the trained `seeing_model.json` is committed and shipped.

## Deployment

**Worker:**

```bash
wrangler deploy --config=worker/wrangler.toml
wrangler secret put BACKEND_URL --config=worker/wrangler.toml
```

**Pages:** before deploying, edit `frontend/public/_redirects` and replace `YOUR_WORKER_URL` with the URL printed by `wrangler deploy`. Then:

```bash
cd frontend
npm run build
wrangler pages deploy dist --project-name=zenith
```

**Backend (DigitalOcean):** SSH into the droplet, clone the repo, and run `scripts/deploy_backend.sh` (writes a systemd unit and nginx config). Subsequent updates use `scripts/update_backend.sh`, which resets to `origin/main`, reinstalls requirements, restarts the service, and polls the health endpoint.

## Project structure

```
zenith/
├── api/
│   ├── main.py              # /api/plan, /api/plan-ai, /api/explain, /api/health
│   ├── agent/               # narrative ordering + Q&A layer (optional)
│   ├── pipeline/
│   │   ├── visibility.py    # twilight, transit, altitude, moon math
│   │   ├── scorer.py        # weighted scoring, SB penalty, filters, FoV
│   │   ├── light_pollution.py # Bortle estimate from coordinates
│   │   ├── catalog.py       # live SIMBAD + Messier seed fallback
│   │   └── seeing.py        # XGBoost inference + climatological fallback
│   ├── ml/
│   │   ├── features.py          # 24-feature vector
│   │   ├── train_xgb.py         # synthetic + ERA5 quantile training entrypoint
│   │   ├── era5.py              # ERA5 Cn^2 -> seeing label derivation
│   │   ├── harvest_stanford.py  # resumable, cost-aware ERA5 dataset builder
│   │   └── check_distribution.py # seeing-label distribution validation
│   └── integrations/weather.py
├── worker/                  # Cloudflare Worker + D1 schema
├── frontend/                # React + Vite + TS
│   └── src/
│       ├── components/      # Sidebar, SetupForm, TonightView, TargetTable,
│       │                    #   Timeline, SeeingStrip, TargetDetail, QAPanel,
│       │                    #   CompareView, HistoryView, SettingsView
│       ├── hooks/           # usePlan, useExplainer, useCompareSites, …
│       ├── lib/             # format, settings, feedback, lightPollution
│       └── types/zenith.ts
├── tests/
├── scripts/                 # deploy_backend.sh, update_backend.sh,
│                            #   smoke_test.py, setup_nginx.conf
├── requirements.txt
├── pytest.ini
└── .env.example
```

## Status

| Component                     | State       | Notes                                                        |
|-------------------------------|-------------|--------------------------------------------------------------|
| SIMBAD catalog ingestion      | Implemented | TAP query with latitude-aware declination filter, KV-cached  |
| Visibility pipeline           | Implemented | Astropy positional astronomy, twilight-bounded windows       |
| Deterministic scorer          | Implemented | Weighted score with SB penalty, filter windows, FoV match    |
| Light-pollution model         | Implemented | Bortle from coordinates or user override                     |
| Seeing features + inference    | Implemented | 24-feature vector, XGBoost quantile model + climatological fallback |
| Synthetic training path       | Implemented | `train_xgb.py` default                                       |
| ERA5 training path            | Implemented | Cn^2 -> Fried -> FWHM label derivation (`era5.py`)           |
| Feedback persistence          | Implemented | Per-target ratings to D1 via the Worker                      |
| Community favorites           | Implemented | Crowd-sourced target votes aggregated in D1, surfaced in the rail |
| Site comparison               | Implemented | `/api/compare-sites`, weighted composite over 2–5 sites      |
| Session history               | Implemented | Plans summarised to D1, browsable in the History view        |
| Edge (Workers/Pages/KV/D1)    | Deployed    | Proxy, cache, rating/history storage                         |
| Reference imagery (MAST)      | Implemented | HLA HST cutout with SkyView DSS2 fallback, LRU-cached        |
| Smoke test                    | Implemented | `scripts/smoke_test.py` covers every endpoint, CI exit codes |
| Multi-night target calendar   | Planned     | Forward scan of observability for a chosen target            |

## References
- Ni, B., Jia, P., et al. (2022). *Data-driven seeing prediction for the LAMOST telescope.* MNRAS. — The 24-feature vector, trailing weather windows, and tree-model approach in `api/ml/features.py` and `api/pipeline/seeing.py`.
- Osborn, J., et al. (2018). *Forecasting atmospheric optical turbulence conditions for astronomy.* MNRAS. — Using macro-meteorological forecasts to infer local boundary-layer seeing.
- Tatarski, V. I. (1961). *Wave Propagation in a Turbulent Medium.* McGraw-Hill. — The `Cn^2` refractive-index structure-constant formulation used in `api/ml/era5.py`.
- Dewan, E. M., et al. (1993). *A model for `Cn^2` profiles using radiosonde data.* Air Force Phillips Laboratory. — Outer-scale (`L0`) parameterization from vertical wind-shear deltas.
- Fried, D. L. (1966). *Optical resolution through a randomly inhomogeneous medium.* JOSA. — The `r0` coherence-diameter to FWHM relation (`eps = 0.98 lambda / r0`).
- Meeus, J. (1998). *Astronomical Algorithms* (2nd ed.). Willmann-Bell. — Horizontal coordinate transforms and angular-separation math in `api/pipeline/visibility.py`.
- Cinzano, P., Falchi, F., & Elvidge, C. D. (2001). *The first World Atlas of the artificial night sky brightness.* MNRAS. — Coordinates to night-sky luminance, seeding the Bortle-class metric.
- Crumey, A. D. B. (2014). *Human Contrast Threshold and Visibility of Deep-Sky Objects.* MNRAS. — Magnitude/area-vs-background contrast driving the surface-brightness penalty in `api/pipeline/scorer.py`.
- [Astropy](https://www.astropy.org/) — coordinate frames, time grids, and horizontal ephemeris transforms.
- [Astroquery](https://astroquery.readthedocs.io/) — live latitude-filtered TAP queries to CDS SIMBAD.
- [Open-Meteo](https://open-meteo.com/) — hourly surface + multi-level pressure weather at runtime.
- [ECMWF ERA5](https://www.ecmwf.int/en/forecasts/dataset/ecmwf-reanalysis-v5) — reanalysis profiles for offline multi-site training.
