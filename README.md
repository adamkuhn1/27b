# 27b

NYC apartment-view app. Owned by the `build-27b` agent in Phase 2.

**v1 (see `PLAN.md` §5):** NYC only, address + floor input → real satellite/aerial
imagery + AI compositing into building-relative N/S/E/W views (height-only vertical
framing). Graceful "not available for this address yet" state. Copy always says
"approximately what you'd see."

**Hard constraint:** real imagery only. AI *on top of* real data is fine; a
fabricated/simulated scene is never acceptable, including in error/fallback paths.

Not yet initialized. Follow `/research/27b-imagery.md` + `/research/synthesis.md`.
