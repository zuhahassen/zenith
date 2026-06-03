/**
 * D1 user-profile operations. Imported by worker/index.js once the
 * /api/profile routes land. Kept side-effect-free so it stays easy to unit
 * test with @cloudflare/vitest-pool-workers.
 */

export async function getProfile(db, userId) {
  const row = await db
    .prepare("SELECT * FROM user_profiles WHERE user_id = ?")
    .bind(userId)
    .first();
  return row ? hydrate(row) : null;
}

export async function upsertProfile(db, profile) {
  const { user_id, location_history = [], equipment = {}, mode = "observer" } = profile;
  await db
    .prepare(
      `INSERT INTO user_profiles (user_id, location_history, equipment, mode, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         location_history = excluded.location_history,
         equipment        = excluded.equipment,
         mode             = excluded.mode,
         updated_at       = CURRENT_TIMESTAMP`,
    )
    .bind(user_id, JSON.stringify(location_history), JSON.stringify(equipment), mode)
    .run();
}

export async function recordSession(db, { user_id, plan, conditions }) {
  await db
    .prepare(
      `INSERT INTO session_history (user_id, plan, conditions) VALUES (?, ?, ?)`,
    )
    .bind(user_id, JSON.stringify(plan), JSON.stringify(conditions))
    .run();
}

export async function recentSessions(db, userId, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT id, plan, conditions, timestamp
         FROM session_history
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT ?`,
    )
    .bind(userId, limit)
    .all();
  return (results || []).map((r) => ({
    ...r,
    plan: JSON.parse(r.plan),
    conditions: JSON.parse(r.conditions),
  }));
}

export async function logWeather(db, { location_hash, timestamp, features }) {
  await db
    .prepare(
      `INSERT INTO weather_logs (location_hash, timestamp, features) VALUES (?, ?, ?)`,
    )
    .bind(location_hash, timestamp, JSON.stringify(features))
    .run();
}

export async function insertFeedback(db, { user_id, target_name, rating, note }) {
  await db
    .prepare(
      `INSERT INTO target_feedback (user_id, target_name, rating, note)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(user_id, target_name, rating, note ?? null)
    .run();
}

/**
 * Latest rating per target for a user, split into liked/disliked name lists.
 * Only the most recent rating for each target counts (so a thumbs-down that
 * was later cleared/flipped doesn't linger).
 */
export async function getFeedback(db, userId, limit = 200) {
  const { results } = await db
    .prepare(
      `SELECT target_name, rating
         FROM target_feedback
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT ?`,
    )
    .bind(userId, limit)
    .all();

  const seen = new Set();
  const liked = [];
  const disliked = [];
  for (const row of results || []) {
    if (seen.has(row.target_name)) continue; // keep only the newest per target
    seen.add(row.target_name);
    if (row.rating > 0) liked.push(row.target_name);
    else if (row.rating < 0) disliked.push(row.target_name);
  }
  return { liked, disliked };
}

/**
 * Crowdsourced target quality: aggregate every user's latest rating per target
 * into a community leaderboard. Only the most recent rating from each user for
 * a given target counts, so repeated votes or flip-flops don't inflate totals.
 *
 * Returns targets ordered by net score (up - down) desc, then by total votes,
 * along with the total number of distinct targets that have any rating.
 */
export async function communityFavorites(db, { limit = 20, minVotes = 1 } = {}) {
  const { results } = await db
    .prepare(
      `WITH latest AS (
         SELECT user_id, target_name, rating,
                ROW_NUMBER() OVER (
                  PARTITION BY user_id, target_name
                  ORDER BY timestamp DESC, id DESC
                ) AS rn
           FROM target_feedback
       ),
       current AS (
         SELECT target_name, rating FROM latest WHERE rn = 1
       )
       SELECT
         target_name,
         SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS up_votes,
         SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS down_votes,
         COUNT(*) AS total_votes,
         SUM(CASE WHEN rating > 0 THEN 1 WHEN rating < 0 THEN -1 ELSE 0 END) AS net_score
       FROM current
       GROUP BY target_name
       HAVING total_votes >= ?
       ORDER BY net_score DESC, total_votes DESC, target_name ASC
       LIMIT ?`,
    )
    .bind(minVotes, limit)
    .all();

  const rows = results || [];
  const favorites = rows.map((r) => {
    const total = Number(r.total_votes) || 0;
    const up = Number(r.up_votes) || 0;
    return {
      target_name: r.target_name,
      net_score: Number(r.net_score) || 0,
      up_votes: up,
      down_votes: Number(r.down_votes) || 0,
      total_votes: total,
      approval: total > 0 ? up / total : 0,
    };
  });

  return { favorites, total_targets_rated: favorites.length };
}

function hydrate(row) {
  return {
    ...row,
    location_history: safeParse(row.location_history, []),
    equipment: safeParse(row.equipment, {}),
  };
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
