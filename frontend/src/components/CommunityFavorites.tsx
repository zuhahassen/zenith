import { Users } from "lucide-react";
import { useCommunityFavorites } from "../hooks/useCommunityFavorites";

// Crowdsourced leaderboard of the targets observers have rated most highly.
// Rendered quietly on the setup screen; it self-hides when there's no data
// yet so a fresh deployment doesn't show an empty shell.
export function CommunityFavorites({ limit = 8 }: { limit?: number }) {
  const { data, isLoading, isError } = useCommunityFavorites(limit);

  if (isLoading || isError) return null;
  const favorites = data?.favorites ?? [];
  if (favorites.length === 0) return null;

  return (
    <section className="community setup__field">
      <div className="setup__label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Users size={13} /> Community favorites
      </div>
      <ul className="community__list">
        {favorites.map((f, i) => (
          <li key={f.target_name} className="community__row">
            <span className="community__rank mono">#{i + 1}</span>
            <span className="community__name">{f.target_name}</span>
            <span className="community__votes mono">
              +{f.up_votes}/-{f.down_votes}
            </span>
            <span className="community__approval mono">
              {Math.round(f.approval * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
