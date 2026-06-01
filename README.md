# Zenith

AI-powered astronomy observation planner. Give it a location, aperture, and date and it tells you what's worth observing tonight — scored by an atmospheric seeing model, filtered through a real visibility pipeline.

## What it does

You tell Zenith where you are and what you're pointing at the sky with. It pulls a fresh catalog of deep-sky objects from SIMBAD, computes which ones are actually above the horizon during astronomical night, scores them on altitude × moon separation × surface brightness × novelty, runs a seeing forecast against an XGBoost model trained on local weather, and finally asks Claude (Sonnet) to curate the top 30 into an ordered plan with reasoning. A Haiku-backed chat pane answers follow-ups against that plan as context.

## Architecture

Three layers:

1. **Data ingestion.** SIMBAD via Astroquery for the catalog, Open-Meteo for hourly weather, browser geolocation or Nominatim for the observer's location.
2. **Deterministic pipeline.** Astropy for sun/moon/transit math, a flat visibility scorer (`api/pipeline/`), and an XGBoost seeing predictor (24 features, Ni et al. 2022). Everything in this layer is reproducible — same inputs, same outputs, no model.
3. **AI orchestration.** A FastAPI endpoint hands the scored list to Claude over OpenRouter. The planner returns a JSON ordering plus markdown notes. The explainer answers questions against that JSON.

Production runs on Cloudflare's edge for everything cacheable and a DigitalOcean droplet for the Python compute:

- **Cloudflare Pages** serves the React app
- **Cloudflare Workers** routes `/api/*`, caches catalog queries in **KV** (24h), persists per-user history in **D1**, and uses **R2** for any heavy artifacts (eventually MAST images)
- **DigitalOcean droplet** runs `uvicorn` behind nginx

## Stack

| Layer       | Tools                                                                  |
|-------------|------------------------------------------------------------------------|
| Backend     | FastAPI, Astropy, Astroquery, XGBoost, httpx                           |
| AI          | Claude Sonnet 4.5 (planning) + Claude Haiku 4.5 (Q&A) via OpenRouter   |
| Frontend    | React 18, Vite, TypeScript, recharts, @tanstack/react-query, axios     |
| Edge        | Cloudflare Workers, Pages, KV, D1, R2                                  |

## Local development

You need Python 3.11+ and Node 18+.

**Backend:**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# fill in OPENROUTER_API_KEY in .env (without it the AI routes degrade gracefully)
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

Run the test suite with `.venv/bin/python -m pytest tests/ -q`. There are 16 tests covering the visibility pipeline and the Claude integration (mocked — no network calls).

## Environment variables

| Variable             | Required? | What happens without it                                              |
|----------------------|-----------|----------------------------------------------------------------------|
| `OPENROUTER_API_KEY` | for AI    | `/api/plan-ai` returns the deterministic plan with `ai_plan.error`; `/api/explain` returns 503 |
| `SEEING_MODEL_PATH`  | optional  | Seeing predictor falls back to a 2.0″ climatological constant        |
| `ANTHROPIC_API_KEY`  | optional  | Reserved as a fallback; not used yet                                 |
| `CF_ACCOUNT_ID`      | for deploy | Needed only by `wrangler` when deploying the Worker / Pages         |
| `CF_API_TOKEN`       | for deploy | Same                                                                |

The Worker also takes a `BACKEND_URL` secret (your droplet's public URL). Set it with `wrangler secret put BACKEND_URL --config=worker/wrangler.toml`.

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

**Backend (DigitalOcean):** SSH into the droplet, clone the repo, and run `scripts/deploy_backend.sh`. The script writes a systemd unit, sets up nginx, and prints where to drop your `OPENROUTER_API_KEY`.

## Project structure

```
zenith/
├── api/
│   ├── main.py              # /api/plan, /api/plan-ai, /api/explain, /api/health
│   ├── agent/
│   │   ├── planner.py       # SessionPlanner + PlanResult (Sonnet)
│   │   └── explainer.py     # Explainer (Haiku)
│   ├── pipeline/
│   │   ├── visibility.py    # twilight, transit, altitude, moon math
│   │   ├── scorer.py        # deterministic 0–1 scoring
│   │   ├── catalog.py       # live SIMBAD + Messier seed fallback
│   │   └── seeing.py        # XGBoost inference + climatological fallback
│   ├── ml/features.py       # 24-feature vector (Ni et al. 2022)
│   └── integrations/weather.py
├── worker/                  # Cloudflare Worker + D1 schema
├── frontend/                # React + Vite + TS
│   └── src/
│       ├── components/      # SetupForm, SessionTimeline, TargetCard, …
│       ├── hooks/           # usePlan, useExplainer
│       └── types/zenith.ts
├── tests/                   # 16 passing
├── scripts/                 # deploy_backend.sh, setup_nginx.conf
├── requirements.txt
├── pytest.ini
└── .env.example
```

## Status

What's actually working vs. what's still a stub. Trying to be honest here.

| Feature                          | Status | Notes                                                   |
|----------------------------------|--------|---------------------------------------------------------|
| Live SIMBAD catalog              | ✅     | TAP query with lat-aware declination filter, 24h KV cache |
| Visibility pipeline              | ✅     | Astropy-backed; 8 tests pinning known summer/winter nights |
| Deterministic scorer             | ✅     | 5-component weighted score, surface-brightness aware    |
| Claude session planner           | ✅     | Sonnet 4.5 over OpenRouter; parsed into JSON + markdown |
| Claude Q&A explainer             | ✅     | Haiku 4.5 over OpenRouter; 6-turn history cap           |
| Open-Meteo hourly history        | ✅     | Past 6h pulled for the seeing rolling-window features   |
| City geocoding                   | ✅     | Nominatim, with browser-geolocation fallback             |
| Seeing predictor (XGBoost)       | ⚠️     | Inference path wired; **model not trained yet** — falls back to 2.0″ |
| MAST reference images            | ⚠️     | UI placeholder only; MAST integration not started       |
| Cloudflare Worker scaffolding    | ✅     | KV cache, D1 schema, R2 bindings declared               |
| Cloudflare Pages frontend        | ✅     | `npm run build` clean, `_redirects` ready (with placeholder) |
| DigitalOcean deploy script       | ✅     | `scripts/deploy_backend.sh` writes systemd + nginx      |
| Worker / Pages deployed          | 🔲     | Manual step, see Deployment above                       |
| Seeing model training pipeline   | 🔲     | Needs labeled FWHM data — TODO                          |
| "Best nights" calendar           | 🔲     | Multi-day forward scan for a chosen target              |

## References

- Ni, B. et al. (2022). *Data-driven seeing prediction for the LAMOST telescope.* — the 24-feature vector and tree-model approach in `api/ml/features.py` and `api/pipeline/seeing.py` follow this paper.
- [Astropy](https://www.astropy.org/) — sun/moon/altitude math.
- [Astroquery](https://astroquery.readthedocs.io/) — SIMBAD TAP queries.
- [Open-Meteo](https://open-meteo.com/) — free hourly weather (no key required).
- [MAST](https://mast.stsci.edu/) — reference imagery, planned.
- [OpenRouter](https://openrouter.ai/) — Anthropic gateway.
