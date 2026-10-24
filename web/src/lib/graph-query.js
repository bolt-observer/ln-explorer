// Shared URL keys for graph selection, independent of table and profile filters.
export const GRAPH_FILTER_KEYS = ["network", "ip", "min_capacity", "min_channels", "feature"];
export const MAP_QUERY_KEYS = ["limit", ...GRAPH_FILTER_KEYS];

/** A stable graph request/cache key; absence of a filter always means unfiltered. */
export function graphQuery(params = new URLSearchParams()) {
  const query = new URLSearchParams();
  for (const key of MAP_QUERY_KEYS) {
    const value = params.get(key);
    if (value) query.set(key, value);
    else if (key === "limit") query.set(key, "400");
    else if (key === "min_channels") query.set(key, "auto");
  }
  return query;
}
