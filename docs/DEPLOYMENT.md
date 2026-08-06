# 27B — deployment plan

**Status: PLAN ONLY. Nothing here has been deployed, no account has been
created, and no service has been signed up for.** Written 2026-08-05 so that
the decision to deploy becomes a decision about a known list rather than an
improvisation. Read alongside [`BILLING_AND_QUOTA.md`](BILLING_AND_QUOTA.md),
which covers the meter itself; this file covers where the thing would live.

Three items in here are **Adam's call and are not made**: the host account,
the daily quota number, and whether to deploy at all while the repo is
private.

---

## 1. Host

| Requirement | Cloudflare Pages | Netlify | GitHub Pages |
| --- | --- | --- | --- |
| Free | yes | yes | yes |
| Private repo on the free tier | yes | yes | **no** — Pages from a private repo needs a paid plan |
| Custom response headers (CSP, `frame-ancestors`) | yes — `_headers` | yes — `_headers` | **no** |
| Real access control on the free tier | yes — Cloudflare Access, free for up to 50 users | **no** — password protection is paid | no |
| Static bandwidth, free tier | unlimited | 100 GB/mo | 100 GB/mo soft |

**Cloudflare Pages is the only one of the three that satisfies both hard
requirements**: custom headers, which `frame-ancestors` needs, and real access
control, which the private phase needs. Netlify covers headers but puts
password protection behind a paid plan, which would trip the free-tier
constraint. GitHub Pages can do neither.

`noindex` is not access control. It asks crawlers not to list the page; it
does not stop anyone who has the URL. During the private phase, access control
is the requirement, not indexing hygiene.

> **Blocked on Adam.** A Cloudflare account does not exist and must not be
> created without his say-so. Everything below assumes one; none of it has
> been exercised.

At the current build a cold visit fetches about **187 kB** — `dist/` totals
12 MB, but almost all of that is the lazy renderer chunk and Cesium's assets,
which a visitor who never runs a lookup does not request (traced: 7 requests,
none of them `tileRenderer-*`, `cesium/`, or a provider host). So Netlify's
100 GB/month is on the order of hundreds of thousands of cold loads, not
thousands. Bandwidth is not the deciding factor;
access control is.

## 2. Response headers

This is the file that would go at `public/_headers`. **It is deliberately not
in the repo.** It contains an unresolved origin placeholder, and a CSP that
has never been loaded in a browser is worse than no CSP, because it looks like
a control while being either broken or quietly permissive.

```
/*
  Content-Security-Policy: default-src 'self'; frame-ancestors 'self' https://<portfolio-origin>; connect-src 'self' https://tile.googleapis.com https://geosearch.planninglabs.nyc https://data.cityofnewyork.us; img-src 'self' data: blob: https://tile.googleapis.com; worker-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: geolocation=(), camera=(), microphone=()
```

`X-Frame-Options` is deliberately absent: `frame-ancestors` supersedes it and
`X-Frame-Options` cannot express an allow-list, so shipping both would mean the
weaker one silently wins in some browsers.

Three directives are present because of specific Cesium behaviour, and each
must be **removed and re-tested** before deploy to confirm it is genuinely
required rather than copied in defensively:

- `'wasm-unsafe-eval'` — Draco, KTX2 and Basis decoders instantiate WASM.
- `worker-src 'self' blob:` — Cesium creates workers from blob URLs.
- `style-src 'unsafe-inline'` — the widgets CSS and credit container inject
  inline styles.

`connect-src` includes `tile.googleapis.com` only because the renderer talks to
it directly from the browser. The two NYC hosts are the free, keyless
open-data services; `data.cityofnewyork.us` is needed twice — once for the
subject footprint and once for the neighbour query.

**Pre-deploy gate: none of this may be claimed to work without a real browser
load against the deployed origin, with the console clean.** The same standard
the rest of this project holds itself to.

## 3. The framing exposure

`BILLING_AND_QUOTA.md` §6 identifies the one real hole and is right: with no
`frame-ancestors`, any third-party page could iframe a deployed 27B and drive
renders against Adam's key. **The HTTP-referrer key restriction does not close
it**, because a framing page sends its own origin as the referrer, so a
referrer allow-list that includes the portfolio origin is satisfied by any page
that frames the portfolio too. `frame-ancestors` is the control; the referrer
restriction is defence in depth behind it.

The portfolio embeds 27B by iframe, so `frame-ancestors` must name the exact
portfolio origin. Getting it wrong in either direction is visible immediately:
too strict and the embed goes blank, too loose and the exposure stays open.

## 4. Key, quota, kill switch

Carried from `BILLING_AND_QUOTA.md` with the numbers this sprint would change:

| Control | Setting |
| --- | --- |
| Application restriction | HTTP referrer, allow-listing only the 27B origin and the portfolio origin. No wildcard TLDs. |
| API restriction | Map Tiles API only. 27B uses no other Google API. |
| Key separation | A different, localhost-restricted key for development. |
| **Map Tiles daily quota** | **25/day.** 25 x 30 = 750/month, a hard fit inside the 1,000 free allotment with headroom. `BILLING_AND_QUOTA.md`'s earlier 30-40/day can exceed it. **This is the only limit an attacker cannot bypass**, because Google enforces it, not us. |
| Budget alert | $1/month. **A notification, not a cap.** Never describe it as a kill switch. |
| Kill switch | Provider-side: set the daily quota to 0, effective without a redeploy. App-side: `VITE_27B_IMAGERY_ENABLED=false` routing to the *existing* "imagery source not configured" state, which is already proven to make zero tile requests. It must not introduce a new code path and must not introduce a fallback scene — the whole point is that turning imagery off shows a message. |

**The client-side counters in `BILLING_AND_QUOTA.md` §3 must be scoped to
sessions opened, not frames captured.** Under the streaming design one session
yields up to four frames and a retry may yield more, all on one root tileset
request. A frame counter would produce a number that does not correspond to
the bill. `lib/metrics.ts` already counts both, separately and by those names.

## 5. Privacy

Unchanged and already correct: no address strings logged, no user identifiers,
no accounts, no analytics.

One thing this sprint adds, worth stating: the enclosure notes send a **bounding
box around the building** — not the typed address — to
`data.cityofnewyork.us`, a New York City government open-data endpoint. It is
the same service and the same kind of request the footprint lookup already
made. No new personal-data exposure.

## 6. Failure behaviour on a deployed origin

The requirement that every new code path is checked against: **a pane with no
imagery stays empty.** Verified in a real browser this sprint across the
landing state, a partial failure and a whole-session failure
(`docs/repair/personal-authorship-sprint/evidence/27b-browser-trace.json`):
zero `<img>` and zero `<canvas>` anywhere in the result when nothing loaded.

With no key and no host at all, the app still resolves real geometry and shows
the honest "imagery source not configured" state, with zero tile requests on
every path.

## 7. Pre-deploy checklist

- [ ] Host chosen and account created — **Adam**
- [ ] Access control enabled (Cloudflare Access, or equivalent) before the origin is reachable
- [ ] Production key restricted by HTTP referrer to the 27B and portfolio origins
- [ ] Production key restricted to the Map Tiles API only
- [ ] Separate localhost-restricted development key
- [ ] Map Tiles daily quota set to 25 (0 to kill)
- [ ] Budget alert at $1/month, understood as a notification
- [ ] `_headers` written with the real portfolio origin, deployed, and **verified in a browser with a clean console**
- [ ] Each of the three permissive CSP directives re-tested by removal
- [ ] Embed in the portfolio loads with `frame-ancestors` in force
- [ ] Kill-switch flag wired to the existing honest state and to nothing else
- [ ] Billing confirmed enabled on the Cloud project (Map Tiles requires it even inside the free tier)
- [ ] Confirmed no address strings or user identifiers are logged
- [ ] Re-verified no imagery caching after any change to `cache.ts` or `useTileCaptures.tsx`
