# E1 blinded scoring — written before the key was read

Four of the eight comparison groups were scored. Each group is one camera
captured twice; which member is 800x600 and which is 1600x1200 was unknown at
the time of writing. Both members are shown at 1504 px, the measured hero size
at DPR 2, so this is the on-screen comparison rather than a pixel-peep.

Scoring question: **at the size the frame is actually displayed, is one member
visibly better, and does the difference change whether the frame is worth
showing?**

| Group | Better | Confidence | What decided it | Material? |
|---|---|---|---|---|
| 01 / 05 | **05**, marginally | low | Slightly crisper edges on the few bright highlights and on the mesh seams. Both frames are the same melted, unreadable dark mass. | **No.** Neither is presentable. Nothing about the resolution changes that. |
| 03 / 04 | **03**, clearly | high | Window mullions on the near arcaded facade; crosswalk stripes; the shopfront sign reads as text in 03 and as a smear in 04; tree canopy has structure rather than blur. | **Yes.** Both are usable photographs and 03 is the better one. |
| 07 / 11 | **07**, moderately | medium | Window reveals and sills on the near facade; the small distant tower's window grid is resolved in 07, mushy in 11. | Partly. Both are mediocre close-range frames; 07 is the less bad one. |
| 12 / 13 | **12**, clearly | high | Rooftop signage is legible in 12 and illegible in 13; the green tower's window grid holds together; distant spires are clean rather than fringed. | **Yes.** The most obvious difference in the set. |

## Prediction, recorded before reveal

The sharper member of every pair is the 1600x1200 capture. If the key
contradicts that in any group, the group is evidence that the difference I
scored was noise and the whole result needs discounting.

## The pattern I expect the key to confirm

The gain tracks **how much real scene detail the provider's mesh contains**, not
how enclosed the direction is:

- Long-range vistas with a lot of small structure (12, 03) gain the most.
- Close-range facade frames (07) gain a little.
- Frames whose mesh has already collapsed (01/05) gain effectively nothing,
  because there is nothing there to resolve. Sampling mush more finely returns
  a slightly sharper picture of mush.

That is the provider being the limiting factor in exactly the cases the earlier
bake-off identified, and our capture resolution being the limiting factor in the
cases it is not.

## Residual imperfection in the blinding, disclosed

A first attempt at this cropped to 1504x1100 and was thrown away: two sessions
of the same camera return different attribution strings, which wrap to a
different number of lines, which makes the composited PNGs different heights,
which made the baked credit bar visible in one member of some pairs and not the
other. That is a tell. The crop is now 1504x1050, inside the 1128 px image area
of both, so no attribution appears in any comparison image.

What remains: because the crop is centred and the total heights still differ
slightly, paired images can be offset vertically by a few pixels. That offset
carries no information about which variant is which, and none of the four
verdicts above turned on framing.
