# 27B — billing, quota and abuse-control architecture

**Status: DOCUMENTED, NOT IMPLEMENTED.** Nothing in this file is built. It is the
control set that must exist *before* 27B is exposed on a public origin, written
down now so the decision to deploy is a decision about a known list rather than
an improvisation later.

Written 2026-08-04 against provider documentation re-verified the same day
(sources at the bottom). Every number here is a **recommended default to
review**, not a measured production figure.

---

## 1. What is actually metered

| Resource | Metered? | Unit | Price |
| --- | --- | --- | --- |
| Google Photorealistic 3D Tiles | **Yes** | one **root tileset request** (`/v1/3dtiles/root.json`) | 1,000 free/month, then $6.00/1,000 (SKU `C6E1-98B2-DBD0`) |
| Renderer tile requests inside an open session | No | — | "Tile requests for Photorealistic 3D Tiles don't impact your daily quota" |
| NYC Planning GeoSearch (geocoding) | No | — | free, keyless |
| NYC OpenData Building Footprints (Socrata) | No | — | free, keyless |
| GEOID18 undulation | No | — | baked lattice, no runtime call |

One 27B lookup = one Cesium session = **one billable request**, covering all
four views. A root tileset request buys up to three hours of renderer tile
requests, but 27B tears the session down after four captures, so the practical
mapping is 1 lookup → 1 request.

**A per-direction retry inside a still-open session is free** — it is a
renderer tile request, not a new root tileset request. That is why the app
retries a failed direction automatically before the session closes, and why it
offers a per-direction retry button *only while the session is open*. Once the
session is gone, re-capturing one direction costs exactly as much as
re-capturing four, so the UI switches to a whole-result "Render all four
again" rather than offering a cheap-looking button that quietly costs a full
render.

Holding the session open idle for a bounded window (~120 s) after the last
capture would make a later per-direction retry free as well. It was
**considered and declined** for this sprint: it costs a live WebGL context and
its GPU memory for two minutes after every result. So there is no idle hold,
and `renderSession.ts` closes the moment its queue drains.

**Count sessions, not frames.** Under the streaming design one session yields
up to four frames and a retry may yield more, all on one root tileset request.
`lib/metrics.ts` therefore keeps `sessionsOpened` (the cost meter) separate
from `capturesCompleted` (not a cost figure).

**The load-bearing consequence:** imagery caching is contractually prohibited
(§4), so there is no way to make a repeat visit to the same address cheaper. A
public 27B is an open meter: 1,000 free lookups/month, then $0.006 each. Every
control below exists because of that sentence.

Provider-side hard ceilings that already apply (not substitutes for our own
controls, because they sit far above any sane spend): **10,000 root tileset
queries per project per day**, renderer rate limit 12,000 queries/minute.

---

## 2. Credential handling

`VITE_GOOGLE_MAPS_KEY` is inlined into the client bundle by Vite. **This is
unavoidable, not a defect**: Cesium streams tiles directly from the browser to
`tile.googleapis.com`, so the key must be present client-side. Treat it as
public and control it at the provider, not by hiding it.

| Control | Recommended setting |
| --- | --- |
| Application restriction | **HTTP referrer**, allow-list only the exact deploy origins (e.g. `https://27b.<domain>/*` and the portfolio origin). No wildcard TLDs, no `*` entry. |
| API restriction | Restrict the key to the **Map Tiles API only**. It must not also carry Geocoding, Places, Directions, or Static Maps — 27B uses none of them, and an unrestricted key turns a referrer bypass into a much larger bill. |
| Key separation | A **different key** for local development (referrer `http://localhost:*`) than for production, so revoking one never takes the other down. |
| Rotation | Rotate on any suspected exposure; rotation is a config change plus a redeploy, with no data migration. |
| Repo hygiene | `.env.local` is gitignored (`.gitignore:17`); only `.env.example` with an empty value is tracked. Verified again this sprint. |
| Error paths | Query strings are stripped from any provider error text before it is stored or displayed (`useTileCaptures.tsx`), so a tile-load failure cannot paint `key=…` onto the page. Verified this sprint. |

**Server-side alternative, if the referrer restriction is ever judged
insufficient.** Referrer headers are trivially forged by a non-browser client, so
an HTTP-referrer restriction deters casual abuse but does not stop a determined
scripted one. The only structural fix is to stop shipping the key: proxy
`tile.googleapis.com` through a small server that holds the key, authenticates
the session, and counts requests. That is a real architecture change (it puts a
server in the imagery path, adds latency, and needs its own caching-compliance
review since the proxy would be handling Google Maps Content). **Recommendation:
do not build it for a private portfolio behind an access gate. Revisit only if
27B is ever made openly public.**

---

## 3. Request limits — recommended defaults

Four layers, cheapest first. None of these exist today.

1. **Per-session limit — 10 renders per browser session.** Enforced client-side
   by counting **sessions opened**, not frames captured (see §1). Stops
   accidental loops and ordinary curiosity, not a determined attacker. Cheap
   and honest about its own weakness.
2. **Per-user/day limit — 25 renders per day per client.** Same unit, same
   enforcement caveat.
3. **Global daily cap — 25 root tileset requests/day.** 25 × 30 = 750/month, a
   hard fit inside the 1,000 free allotment with headroom. (An earlier draft of
   this file said 30–40/day; 40 × 30 = 1,200 exceeds the free allotment, which
   made the cap depend on a budget *alert* to catch it — and an alert is not a
   cap.) Enforce at the provider: Google Cloud Console → APIs & Services → Map
   Tiles API → Quotas → *requests per day*. **This is the only limit in this
   document that an attacker cannot bypass**, because it is enforced by Google,
   not by us.
4. **Global cost kill-switch.** Two mechanisms, both needed:
   - *Provider-side*: set the daily quota (above) to **0** to stop all billable
     traffic immediately. Takes effect without a redeploy.
   - *App-side*: a build/runtime flag (e.g. `VITE_27B_IMAGERY_ENABLED=false`)
     that routes every request to the existing honest "imagery source not
     configured" state. This path already exists and is already proven to make
     **zero** tile requests — the kill-switch would reuse it rather than
     introduce a new code path. Crucially it must *not* introduce a fallback
     scene; the whole point is that turning imagery off shows a message.

A Cloud Billing **budget alert** at, say, $1/month is a notification, not a cap —
it must not be mistaken for a kill-switch. The daily quota is the cap.

---

## 4. Caching policy — what may and may not be stored

**Prohibited: any caching of provider imagery.** ToS §3.2.3(b): *"Customer will
not cache Google Maps Content except as expressly permitted under the Maps
Service Specific Terms."* The Service Specific Terms (last modified 2026-06-10)
enumerate 21 services under "B. Core Service Terms" — Address Validation, Air
Quality, Android Geocoder SDK, Directions, Distance Matrix, Geocoding,
Geolocation, Google Earth, Maps Datasets, Maps Grounding Lite, Navigation
Connect, Navigation SDK, Places Aggregate, Places, Places UI Kit, Pollen, Roads,
Route Optimization, Routes, Solar, Weather — and **Map Tiles is not among them**.
Independently re-verified this sprint: the string "Tile" occurs **zero** times in
that document. No allowance exists, so none can be relied on. The Map Tiles
policies page repeats it directly: *"you must not pre-fetch, index, store, or
cache any Content except under the limited conditions stated in the terms"*, and
separately excludes "Offline uses".

*Narrow exception, for completeness:* the same policies page requires clients to
**respect** `Cache-Control` headers Google sends (`max-age`,
`stale-while-revalidate`, `must-revalidate`, `private`). Ordinary browser HTTP
caching performed by the browser according to Google's own headers is therefore
expected behaviour, not a violation. That is the browser obeying the provider —
categorically different from the application copying imagery into its own store.

**Verified in code this sprint (not asserted):**

- `cache.ts` persists `ViewPlan` only — geocode result, footprint geometry,
  elevations, camera parameters. All of it derived from NYC open data and our own
  arithmetic. No image bytes.
- Rendered frames exist only in React state (`useTileCaptures.tsx`) and are gone
  on reload.
- `purgeRetiredCaptureCache()` deletes the `27b:captures:*` keys written by
  pre-2026-08-04 builds, so imagery cached by an older build is removed rather
  than orphaned.
- No download/save-image affordance exists.
- The proof harnesses assert this: every run records the full list of persisted
  `27b:*` localStorage keys.

**Permitted and retained:** geometry/non-image metadata caching. NYC Building
Footprints and GeoSearch are NYC open data, not Google Maps Content, and carry no
such restriction.

---

## 5. Usage logging — minimum necessary

27B's existing metrics (`metrics.ts`) are in-memory counters: addresses
processed, geometry latency, imagery-pipeline latency, cache hit rate. For a
deployed instance:

| Log | Keep | Reason |
| --- | --- | --- |
| Count of renders per day | Yes | the only number that predicts the bill |
| Render latency distribution | Yes | the known UX problem is latency |
| Cache hit rate (geometry) | Yes | shows the metered path is being avoided where legal |
| Failure-state counts by kind | Yes | tells you if the honest states are firing correctly |
| **Typed address strings** | **No** | an address a person typed is close to a home address; there is no product reason to retain it |
| **IP addresses** | **No** beyond whatever the host logs by default, with short retention | not needed for any of the above |
| **Any user identifier** | **No** | 27B has no accounts and needs none |

Aggregate counters answer every operational question here. Per-user request
limits (§3) need a client-local counter, not a server-side identity.

---

## 6. No unmetered public rendering endpoint

Verified this sprint by reading the code:

- 27B is a static Vite SPA. There is **no server, no API route, no serverless
  function** — nothing that could be called to trigger a render on someone
  else's behalf.
- The only way to cause a billable request is to load the page in a browser and
  submit a valid, *exactly matched* NYC address with an imagery key present. The
  key gate (`config.ts` → `useTileCaptures.tsx`) and the address-match gate
  (`addressMatch.ts`) both sit in front of the renderer.
- Every failure path reaches the renderer **zero** times — proven by request
  counts, not by inspection alone (see the mismatch and failure-path harnesses).

**The one real exposure, and it is not closed.** There is no
`Content-Security-Policy: frame-ancestors` header configured anywhere in the
repo, so once deployed, any third-party page could iframe 27B and drive renders
against Adam's key. This was raised as C-6 in the prior sprint's
correctness/security review and is still open — correctly, since nothing is
deployed. **Before any public deploy:** set `frame-ancestors` to the portfolio
origin, and set the HTTP-referrer restriction (§2) to match. The referrer
restriction alone does not close it, because a framed page sends its own origin
as the referrer.

The host, the header file and the pre-deploy checklist are worked out in
[`DEPLOYMENT.md`](DEPLOYMENT.md). The proposed `_headers` file is deliberately
**not** in the repo: it carries an unresolved origin placeholder and has never
been loaded in a browser, and a CSP nobody has tested is worse than none
because it looks like a control.

---

## 7. Pre-deploy checklist

- [ ] Production key restricted by HTTP referrer to deploy origins only
- [ ] Production key restricted to the Map Tiles API only
- [ ] Separate development key, localhost-restricted
- [ ] Map Tiles API daily quota set (recommend 30–40/day; 0 to kill)
- [ ] Cloud Billing budget alert set (recommend $1/month) — a notification, not a cap
- [ ] `Content-Security-Policy: frame-ancestors <portfolio-origin>` on the 27B origin
- [ ] Kill-switch flag wired to the existing "imagery not configured" state (and *only* to it)
- [ ] Confirmed billing is enabled on the Cloud project (the Map Tiles API requires it)
- [ ] Confirmed no address strings or user identifiers are logged
- [ ] Re-verified no imagery caching after any change to `cache.ts` or `useTileCaptures.tsx`

---

**Sources, all read 2026-08-04:**
[Map Tiles usage & billing](https://developers.google.com/maps/documentation/tile/usage-and-billing) (updated 2026-07-31) ·
[Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) (updated 2026-07-31) ·
[Map Tiles API Policies](https://developers.google.com/maps/documentation/tile/policies) (updated 2026-07-31) ·
[Maps Platform ToS](https://cloud.google.com/maps-platform/terms) (last modified 2026-06-23) ·
[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) (last modified 2026-06-10)
