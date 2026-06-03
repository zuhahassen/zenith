#!/usr/bin/env bash
# Zenith — Part 1: harvest ERA5 for the expanded multi-site set and retrain the
# combined seeing model.
#
# Requires a configured ~/.cdsapirc (Copernicus CDS API key). The ERA5 download
# can take a long time (ECMWF queues multi-year pressure-level requests), so
# each harvest resumes if interrupted. Existing site caches (stanford, maunakea,
# lapalma) are reused if already present under api/ml/data/.
#
# Usage (from repo root, venv active):
#   bash scripts/harvest_train_multisite.sh
#
# Override the harvest years:
#   YEARS="2023 2024 2025" bash scripts/harvest_train_multisite.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PY="${PYTHON:-.venv/bin/python}"
YEARS="${YEARS:-2023 2024 2025}"
DATA_DIR="api/ml/data"
MODEL_OUT="api/ml/models/multisite_model.json"

log() { printf "\n\033[1;33m▸ %s\033[0m\n" "$*"; }

# New geographically diverse sites: slug | lat | lon | label
NEW_SITES=(
  "haute_provence 43.9308 5.7136 Observatoire-de-Haute-Provence"
  "paranal       -24.6275 -70.4044 ESO-Paranal"
  "sutherland    -32.3783 20.8105 SAAO-Sutherland"
  "kittpeak       31.9583 -111.5967 Kitt-Peak"
)

# Existing sites already harvested; included in the training combine.
EXISTING_SITES=(stanford maunakea lapalma)

log "Harvesting ${#NEW_SITES[@]} new sites for years: ${YEARS}"
for entry in "${NEW_SITES[@]}"; do
  read -r slug lat lon label <<<"$entry"
  if [[ -f "${DATA_DIR}/${slug}_era5.npz" ]]; then
    log "Skipping ${slug} (${label}) — cache already exists"
    continue
  fi
  log "Harvesting ${slug} (${label}) lat=${lat} lon=${lon}"
  "$PY" -m api.ml.harvest_generic --lat "$lat" --lon "$lon" --name "$slug" --years $YEARS
done

ALL_SITES=("${EXISTING_SITES[@]}")
for entry in "${NEW_SITES[@]}"; do
  read -r slug _ _ _ <<<"$entry"
  ALL_SITES+=("$slug")
done

log "Retraining combined model across: ${ALL_SITES[*]}"
"$PY" -m api.ml.train_multisite --sites "${ALL_SITES[@]}" --output "$MODEL_OUT" | tee "${REPO_DIR}/multisite_metrics.txt"

log "Done. Model -> ${MODEL_OUT}; metrics captured in multisite_metrics.txt"
echo "Set SEEING_MODEL_PATH=${MODEL_OUT} (or copy to api/ml/models/seeing_model.json) and restart the API."
