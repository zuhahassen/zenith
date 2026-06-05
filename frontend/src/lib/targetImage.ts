// Client-side reference-image resolver for the target detail panel.
//
// Priority waterfall across several real observatory/archive sources, with a
// CORS-safe DSS2 survey fallback (hips2fits) that always returns an image so
// every target with coordinates gets a photo. Results are cached per
// "ra,dec" so repeat clicks never re-fetch.
//
// NOTE on Promise.any semantics: it resolves on the first *fulfilled* promise.
// So each source REJECTS when it has no usable image (rather than resolving
// null), letting the fastest *valid* image win and only falling through to the
// Aladin fallback when every source rejects.

export interface TargetImage {
  url: string;
  credit: string;
  // Compact source tag used for the credit-strip badge styling.
  source: "LCO" | "ASTROPIX" | "APOD" | "DSS2";
}

const imageCache = new Map<string, TargetImage>();

const NASA_KEY = import.meta.env.VITE_NASA_API_KEY || "DEMO_KEY";

function warn(source: string, name: string, err: unknown) {
  console.warn(`[Zenith images] ${source} failed for "${name}"`, err);
}

/** Reject a promise if it doesn't settle within `ms` (also aborts via signal). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Verify a URL actually decodes as a displayable raster image. Filters out
 * FITS downloads, 404 HTML pages, and broken/empty responses that would
 * otherwise render as a broken <img>.
 */
function loadsAsImage(url: string, timeoutMs = 7000): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      clearTimeout(t);
      finish(img.naturalWidth > 1);
    };
    img.onerror = () => {
      clearTimeout(t);
      finish(false);
    };
    img.src = url;
  });
}

// --- Source 1: LCO Archive (recent robotic telescope frames) ---------------
async function fetchLCO(name: string): Promise<TargetImage> {
  try {
    const url =
      `https://archive-api.lco.global/frames/?limit=1&public=true` +
      `&target_name=${encodeURIComponent(name)}&ordering=-created`;
    const res = await withTimeout(fetch(url, { headers: { Accept: "application/json" } }), 6000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const frame = data.results?.[0];
    const candidate = frame?.url || frame?.thumbnail_url;
    if (!candidate || !(await loadsAsImage(candidate))) throw new Error("no usable image");
    return {
      url: candidate,
      source: "LCO",
      credit: `Las Cumbres Observatory · ${new Date(frame.created).toLocaleDateString()}`,
    };
  } catch (err) {
    warn("LCO", name, err);
    throw err;
  }
}

// --- Source 2: AstroPix (Hubble / JWST / Spitzer processed releases) --------
async function fetchAstroPix(name: string): Promise<TargetImage> {
  try {
    const url =
      `https://www.astropix.org/api/v1/images?search=${encodeURIComponent(name)}` +
      `&sort=releasedate&order=desc&limit=1&format=json`;
    const res = await withTimeout(fetch(url), 6000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const img = data.images?.[0];
    const candidate = img?.image_url || img?.resource_url;
    if (!candidate || !(await loadsAsImage(candidate))) throw new Error("no usable image");
    return {
      url: candidate,
      source: "ASTROPIX",
      credit: [img.publisher, img.release_date].filter(Boolean).join(" · ") || "AstroPix",
    };
  } catch (err) {
    warn("AstroPix", name, err);
    throw err;
  }
}

// --- Source 3: NASA APOD (only if the name matches the title/explanation) ---
async function fetchAPOD(name: string): Promise<TargetImage> {
  try {
    const end = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const url = `https://api.nasa.gov/planetary/apod?api_key=${NASA_KEY}&start_date=${start}&end_date=${end}`;
    const res = await withTimeout(fetch(url), 6000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const days = await res.json();
    const q = name.toLowerCase();
    const match = (Array.isArray(days) ? days : []).find(
      (d: any) =>
        d.media_type === "image" &&
        (d.title?.toLowerCase().includes(q) || d.explanation?.toLowerCase().includes(q)),
    );
    const candidate = match?.hdurl || match?.url;
    if (!candidate || !(await loadsAsImage(candidate))) throw new Error("no match");
    return {
      url: candidate,
      source: "APOD",
      credit: ["NASA APOD", match.date, match.copyright].filter(Boolean).join(" · "),
    };
  } catch (err) {
    warn("APOD", name, err);
    throw err;
  }
}

// --- Source 4: Aladin hips2fits DSS2 (CORS-safe, always returns an image) ---
function aladinFallback(ra: number, dec: number): TargetImage {
  const url =
    `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?` +
    `hips=CDS%2FP%2FDSS2%2Fcolor&width=400&height=400&fov=0.25` +
    `&projection=TAN&format=jpg&ra=${ra}&dec=${dec}`;
  return { url, source: "DSS2", credit: "DSS2 · STScI/ESO" };
}

/**
 * Resolve the best available reference image for a target. Fires the live
 * sources in parallel (fastest valid wins) and falls back to the DSS2 survey.
 * Always resolves — never rejects — so the UI can rely on getting an image.
 */
export async function getTargetImage(
  ra: number,
  dec: number,
  name: string,
): Promise<TargetImage> {
  const cacheKey = `${ra},${dec}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  let result: TargetImage;
  try {
    result = await Promise.any([fetchLCO(name), fetchAstroPix(name), fetchAPOD(name)]);
  } catch {
    result = aladinFallback(ra, dec);
  }
  imageCache.set(cacheKey, result);
  return result;
}
