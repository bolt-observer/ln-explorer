# bolt.observer: UX and visual audit

Reviewed on the live instance (https://bolt-explorer.exe.xyz) on 2026-10-24 at 1440×900 and 390×844. Every page was checked: graph, nodes, node detail, channel, rankings, stats, and search. Code references point to the pre-Atlas frontend (`web/src/main.js` and `web/style.css` at commit `9e6c8e1`).

Severity: **H** = blocks or misleads the main task, **M** = friction or confusion, **L** = polish.

## 1. Information architecture

| # | Sev | Finding |
|---|-----|---------|
| 1.1 | H | Search is the main job of an explorer (look up a pubkey, alias, or SCID), but it is a small field in the top-right corner with no typeahead. A query goes to a results page even when there is only one match (`renderSearch`). The ACINQ search returns one row, and you have to click it again to see the node. |
| 1.2 | M | The home page is the graph. It looks good, but it doesn't help you get anything done. You see 346 of 5,110 nodes as one dense cluster, and the only control is a "Min channels" number box plus an Apply button. |
| 1.3 | M | Clicking a node in the graph opens the node page and throws away the graph view (`renderer.on("clickNode", … go(...))`). The graph can't be used to browse neighbours or compare nodes. |
| 1.4 | M | The most interesting rankings (climbers and fallers) are at the bottom of a ~5,000px page, below 100 rows. Today those 100 rows say "new / new / new" and the 90-day column is empty. |
| 1.5 | L | Channels have no index page, so you can only reach them through node tables. The footer jargon ("rgs") and data-source notes are written for the operator, not the visitor. |

## 2. Page-level findings

### Graph (`/`)
- **H** Labels overlap heavily: `ACINQ`/`bfx-lnd0`/`block-iad-1` and `LNT.Thailand`/`Kraken` sit on top of each other (`labelDensity: 1`, 18 forced labels, `labelSize: 16`). The floating toolbar also covers labels at the bottom edge.
- **M** In the side list "Largest nodes in view", the rows are sorted by channel count but show capacity. The numbers look shuffled (363 → 264 → 177 → 52.53M → 17.66 BTC), and the units change mid-list (`52.53M` sats next to `BTC`).
- **M** No legend. Colour (`colorFor`) and size have no explanation.
- **L** The canvas sits in a bordered card with 1rem of padding, which wastes the edge of the screen and stops the graph from feeling immersive.

### Nodes (`/nodes`)
- **H** The filter UI is a form-builder: a Field/Relation/Value row with one condition, a "Match: all conditions" dropdown that does nothing with one condition, a separate reference-pubkey box, a checkbox, and an Apply button. On mobile it fills the whole first screen.
- **M** The table has 11 columns at the same visual weight. The pubkey chips (dark pills in monospace) are the loudest element in every row. Every alias is mint, so mint stops meaning anything.
- **M** Capacity is a column of digits. A capacity bar or relative scale would make it scannable.

### Node detail (`/node/<pk>`)
- **H** The headline number is `36,308,097,802 sats`. The same value is `363.25 BTC` everywhere else. Units aren't consistent across the site (sats, M, BTC).
- **M** Eight KPI tiles with equal weight, and four of them are centrality ranks. On a node like ACINQ they all read "1".
- **M** The metadata line runs on: source, first seen, and full IPv4 plus onion addresses in one sentence. The "Shortest path from" tool floats between the header and the table with no explanation.
- **M** The channel table runs to 76 pages with no summary: no peer distribution, fee distribution, or neighbourhood view.
- **L** The empty "History" card sits at the bottom and is the only place time-series data could appear.

### Channel (`/channel/<scid>`)
- **M** The title is the bare SCID. "bfx-lnd0 ↔ ACINQ" is what a person recognises.
- **M** Each direction's policy is a list of text lines. Direction (who charges whom) is the core concept here and it isn't shown visually. About 70% of the viewport is empty.

### Stats (`/stats`)
- **M** Methodology text appears above and below the main chart (≈120 words before you see data). The caveats are correct, but they belong in an info popover.
- **M** The KPI label "Network capacity (mempool.space, 2026-08-30)" wraps to two lines and carries a source caveat in the label.
- **M** Empty states take full-width space ("Opens 7d 0 / Closes 7d 0 / Net 0", "No closes recorded…").
- **L** The fee table prints raw extremes (`2,147,483,647`, std-dev `151,919,643.9`). A fee histogram would answer "what do people charge?" better.

### Rankings (`/rankings`)
- **M** See 1.4. Change columns should be arrows or sparklines, and empty columns should be hidden until there is data.

### Mobile
- **H** The top bar takes ~200px (logo row, nav row, search row) before any content.
- **M** Graph labels run off the right edge. The toolbar wraps onto two lines.
- **M** Tables only scroll horizontally. There's no column priority or card layout.

## 3. Visual system

| Area | Today | Problem |
|------|-------|---------|
| Type | `Segoe UI, Roboto, Helvetica, Arial`, uppercase micro-labels everywhere | Generic. Uppercase labels at 0.72–0.8rem are noisy and hard to read. Numbers aren't tabular, apart from `.chg`. |
| Colour | Mint `#1dfebb` for links, primary buttons, active nav, chart series, graph nodes, edges, status tags, and "up" deltas | One colour carries six meanings. Yellow means both "close/down" and "channels series", and it's also the logo. |
| Surfaces | Cards with a border **and** a 40px shadow on near-black, often nested (card → `.kv div` → value) | Shadows are invisible on `#121212` and only add muddiness. Nesting creates boxes inside boxes. |
| Shape | Pill radius on nav, buttons, inputs, chips, tags, and segmented controls | Nothing stands out because everything is a pill. |
| Density | Same padding everywhere | Data tables want to be dense, and summaries want to breathe. There's no rhythm. |
| States | No skeletons. Empty states are full-size cards. | The layout jumps when data loads, and empty space dominates on a fresh install. |

## 4. Fixes that apply to any direction

1. **Global typeahead search** (⌘K or `/`) that resolves alias, pubkey, SCID, or `NxNxN` inline, and goes straight to the result when there's a single exact match.
2. **One unit policy**: BTC with two decimals in UI text, exact sats in a tooltip or on copy. Tabular numerals everywhere.
3. **Colour semantics**: one brand accent for interaction or selection, one positive/negative pair for deltas, a neutral ramp for everything else. Chart series use their own palette.
4. **Preview before navigating**: clicking a graph node or table row opens an inspector or preview, and the full page is one click further.
5. **Progressive disclosure for methodology**: ⓘ popovers and a /methodology page instead of inline paragraphs.
6. **Empty states collapse** into one line until data exists. Columns with no data are hidden.
7. **Filter chips** replace the form-builder ("Channels > 100 ×", "+ Filter").
8. **Mobile**: a compact header with a search icon, bottom navigation or a sheet, and card rows for tables.
9. **Channel page centred on direction**: A ⇄ B diagram with each side's policy next to its arrow.
10. **Flat surfaces**: hairline borders or tonal steps instead of shadows, and no nested cards.
