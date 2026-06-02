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
values are propagated as NaN and handled natively by the trees.

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
  into the same feature contract used at inference.

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
  degrades to the deterministic result when unavailable; `/api/explain` answers
  follow-up questions; `/api/feedback` persists per-target ratings.

Production runs on Cloudflare's edge plus a DigitalOcean droplet:

- **Cloudflare Pages** serves the built React app.
- **Cloudflare Workers** proxies `/api/*`, caches catalog queries in **KV**,
  persists ratings and history in **D1**, and reserves **R2** for binary
  artifacts.
- **DigitalOcean droplet** runs `uvicorn` behind nginx.

## Stack

| Layer    | Tools                                                          |
|----------|----------------------------------------------------------------|
| Backend  | FastAPI, Astropy, Astroquery, XGBoost, NumPy, httpx            |
| Training | ERA5 (cdsapi), xarray, netCDF4 (offline data prep only)        |
| Frontend | React 18, Vite, TypeScript, recharts, @tanstack/react-query    |
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

# ERA5 reanalysis (requires a configured ~/.cdsapirc from the Copernicus CDS)
.venv/bin/python -m api.ml.era5 download --lat 31.96 --lon -111.6 \
    --start 2023-01-01 --end 2023-03-31 --out data/era5.nc
.venv/bin/python -m api.ml.era5 build --nc data/era5.nc --out data/era5.npz
.venv/bin/python -m api.ml.train_xgb --source era5 --era5-cache data/era5.npz
```

The ERA5 dependencies (`cdsapi`, `xarray`, `netCDF4`) are imported lazily and are only needed for this offline step, not by the API server.

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
│   │   ├── features.py      # 24-feature vector
│   │   ├── train_xgb.py     # synthetic + ERA5 training entrypoint
│   │   └── era5.py          # ERA5 Cn^2 -> seeing label derivation
│   └── integrations/weather.py
├── worker/                  # Cloudflare Worker + D1 schema
├── frontend/                # React + Vite + TS
│   └── src/
│       ├── components/      # SetupForm, SessionTimeline, TargetCard, …
│       ├── hooks/           # usePlan, useExplainer
│       └── types/zenith.ts
├── tests/
├── scripts/                 # deploy_backend.sh, update_backend.sh, setup_nginx.conf
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
| Edge (Workers/Pages/KV/D1)    | Deployed    | Proxy, cache, and rating storage                             |
| Reference imagery (MAST)      | Partial     | Fetch path scaffolded                                        |
| Multi-night target calendar   | Planned     | Forward scan of observability for a chosen target            |

## References
- Ni, B. et al. (2022). *Data-driven seeing prediction for the LAMOST telescope.* — the 
24-feature vector and tree-model approach in `api/ml/features.py` and `api/pipeline/seeing.
py` follow this paper.
- Tatarski, V. I. (1961). *Wave Propagation in a Turbulent Medium.* — the Cn^2 structure-constant formulation.
- Dewan, E. M. et al. (1993). *A model for C_n^2 (optical turbulence) profiles using radiosonde data.* — the wind-shear outer-scale model.
- Fried, D. L. (1966). *Optical resolution through a randomly inhomogeneous medium.* — the Fried parameter and seeing relation.
- [Astropy](https://www.astropy.org/) — positional astronomy.
- [Astroquery](https://astroquery.readthedocs.io/) — SIMBAD TAP queries.
- [Open-Meteo](https://open-meteo.com/) — hourly weather.
- [ECMWF ERA5](https://www.ecmwf.int/en/forecasts/dataset/ecmwf-reanalysis-v5) — reanalysis for seeing-label derivation.
