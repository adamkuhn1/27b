# How to review this folder

This is the visual half of the decision package described in
`docs/repair/release-candidate/27b/REPORT.md` (§7–§12 — that file has the
full compliance and provider analysis; this file does not repeat it).

**The PNGs are not in git.** They contain Google Maps Content, and the Map
Tiles API terms say not to store or re-share it — so they live only on the
machine that captured them (2026-08-04). If you're reading this from a fresh
clone, the images won't be here; the JSON files (camera parameters, request
counts, timings, attribution strings) are committed and travel with the repo.
This file is a map for whoever has the PNGs open locally.

## Look at these six first, in this order

This is the report's own "what to look at" list (§11), named in plain terms:

1. **`comparison-esb-floor6-vs-floor80.png`** — the whole question in one
   picture. Same building, same four directions, floor 6 on top and floor 80
   on the bottom. If you only look at one image, look at this one.
2. **`flatiron-175fifth-floor18-view-1.png`** — the best result the technique
   produces anywhere in the package (looking up 5th Ave/Broadway with the
   Empire State Building legible in the distance).
3. **`floor-6-view-4.png`** — the worst result in the package (a low floor in
   a dense canyon; buildings smear together).
4. **`residential-425e79-floor10-view-2.png`** — the *typical* result: an
   ordinary Upper East Side apartment building, not a landmark. This one
   matters more than either extreme, since most NYC addresses look like this,
   not like the Empire State Building.
5. **`floor-80-page.png`** — the full product page in its best-case state,
   for a sense of the whole thing together (form, presets, framing copy,
   result).
6. **`mismatch-transposed-house-number.png`** — the honest failure state: an
   address the geocoder could only fuzzy-match, and 27B refusing to guess.

## Everything else, grouped

**Empire State Building, floor 6 vs. floor 80** (same building, two heights —
the core contrast):
- `floor-6-page.png` / `floor-80-page.png` — full page at each floor
- `floor-6-view-1.png` … `floor-6-view-4.png` — the four facing directions at
  floor 6 (low, dense canyon)
- `floor-80-view-1.png` … `floor-80-view-4.png` — the same four directions at
  floor 80 (high, open sightlines)
- `comparison-esb-floor6-vs-floor80.png` + `comparison-sheet.txt` — the two
  floors arranged side by side; the `.txt` records how it was made (local
  frames only, no new provider requests, no pixel changes)

**The Flatiron Building, floor 18** (a non-rectangular footprint — tests
whether the facade-direction math holds up on an irregular shape):
- `flatiron-175fifth-floor18-page.png` — full page
- `flatiron-175fifth-floor18-view-1.png` … `-view-4.png` — the four
  directions; `-view-1` is the best frame in the whole package

**425 E 79th St, floor 10** (an ordinary residential building, deliberately
not a landmark — the realistic case):
- `residential-425e79-floor10-page.png` — full page
- `residential-425e79-floor10-view-1.png` … `-view-4.png` — the four
  directions; `-view-2` is the one cited in the report as most representative

**Address-mismatch / honest-failure states** (what 27B does when the address
service can only offer a substitute, not the address typed):
- `mismatch-foreign-address.png`
- `mismatch-nonexistent-brooklyn-street.png`
- `mismatch-nonexistent-queens-address.png`
- `mismatch-out-of-state-street-name.png`
- `mismatch-transposed-house-number.png` — the one real bug this harness
  found and the report documents fixing (see REPORT.md §8.1)
- `mismatch-proof.json` — what each case returns machine-readable

**Committed alongside the PNGs (safe to keep — no imagery, just numbers):**
- `summary.json`, `summary-esb-floors-6-80.json`,
  `summary-flatiron-175fifth-floor18.json`,
  `summary-residential-425e79-floor10.json` — camera parameters, request
  counts, render times, attribution strings for each run
- `failure-paths.json` — the non-NYC / unresolvable-address / no-key paths,
  each confirmed at 0 tile requests

## The decision itself

The three options (accept this provider direction / reject it / request one
bounded change) are laid out in full in
`docs/repair/release-candidate/27b/REPORT.md` §12. Nothing above changes that
analysis — this file only makes the images easier to find and name.
