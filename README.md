# Zenith 

## Milestone 1

Zenith is a telescope planning tool — give it your location, aperture, and date and it ranks deep-sky targets by how worth observing they actually are that night. The engine builds a UTC time grid anchored to astronomical twilight, then computes altitude and airmass curves for every object across that window. Anything that fails a hard filter — below the minimum horizon angle, within the moon exclusion radius, or past the surface-brightness limit for your aperture — gets dropped before scoring. What remains gets a 0–1 score built from five weighted components: visibility window length, darkness-weighted altitude, moon separation, gear fit, and novelty. The currenttly works with a list of 13 Messier/NGC objects, a FastAPI `/plan` endpoint, and the web UI, are tested against known nights — M13 dominates summer evenings, M42 wins the late-winter transit window, etc. Still to implement: live catalog queries via SIMBAD/Vizier or astroquery or MASTS (still deciding which one to use), real-time weather and observer conditions (such as things like observing or primarily looking at to image), an LLM layer that works to deliver personalized recommendations and future observation planning, MAST reference lookups for top results, and  a "best nights" calendar that scans forward several days for a chosen target.

## Install

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run 

```bash
# start
.venv/bin/uvicorn api:app --reload --port 8000
```

The website is available at `http://127.0.0.1:8000`