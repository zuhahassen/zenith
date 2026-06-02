// Client-side mirror of api/pipeline/light_pollution.py so the setup form can
// show an estimated Bortle class before the plan request is sent. Keep the
// CITY_ZONES table in sync with the Python module.

type Ring = [radiusKm: number, bortle: number];
type Zone = [name: string, lat: number, lon: number, rings: Ring[]];

const CITY_ZONES: Zone[] = [
  ["New York", 40.7128, -74.006, [[25, 9], [60, 7], [110, 5]]],
  ["Los Angeles", 34.0522, -118.2437, [[35, 9], [75, 7], [130, 5]]],
  ["Chicago", 41.8781, -87.6298, [[25, 9], [55, 7], [100, 5]]],
  ["London", 51.5074, -0.1278, [[25, 9], [55, 7], [100, 5]]],
  ["Tokyo", 35.6762, 139.6503, [[40, 9], [90, 7], [150, 5]]],
  ["Paris", 48.8566, 2.3522, [[20, 9], [50, 7], [95, 5]]],
  ["Beijing", 39.9042, 116.4074, [[35, 9], [80, 7], [140, 5]]],
  ["Mumbai", 19.076, 72.8777, [[25, 9], [55, 7], [100, 5]]],
  ["Sao Paulo", -23.5505, -46.6333, [[35, 9], [75, 7], [130, 5]]],
  ["San Francisco", 37.7749, -122.4194, [[25, 8], [60, 6], [110, 5]]],
  ["Washington DC", 38.9072, -77.0369, [[25, 8], [55, 6], [100, 5]]],
  ["Delhi", 28.7041, 77.1025, [[30, 9], [70, 7], [120, 5]]],
  ["Shanghai", 31.2304, 121.4737, [[35, 9], [80, 7], [140, 5]]],
];

const DEFAULT_BORTLE = 6;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlmb = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function estimateBortle(lat: number, lon: number): number {
  let best: number | null = null;
  for (const [, clat, clon, rings] of CITY_ZONES) {
    const dist = haversineKm(lat, lon, clat, clon);
    for (const [radiusKm, bortle] of [...rings].sort((a, b) => a[0] - b[0])) {
      if (dist <= radiusKm) {
        best = best === null ? bortle : Math.max(best, bortle);
        break;
      }
    }
  }
  return best ?? DEFAULT_BORTLE;
}
