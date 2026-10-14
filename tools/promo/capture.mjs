// Drives tools/promo/index.html to capture the frames of 27B's promotional
// video: a slow pan across one view per building, one settled frame at a
// time, so the result is smooth however long the tiles take to stream.
//
// Run with the planning API on :8000 and `npm run dev` on :5174, then:
//   npx -p playwright@1.55.0 node tools/promo/capture.mjs <outDir>
// and join the frames with tools/promo/encode.sh.
//
// Uses the installed Google Chrome (GPU) in a visible window; headless Chrome
// never finishes a render.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "promo-frames";
const FPS = 30;
const SECONDS_PER_SHOT = 7;
const PAN_DEG = 44; // total sweep, centred on the planned bearing
const W = 1600;
const H = 900;

export const SHOTS = [
  { name: "The San Remo", address: "145 Central Park West, Manhattan", floor: 20, slot: "V2" },
  { name: "432 Park Avenue", address: "432 Park Ave, Manhattan", floor: 85, slot: "V1" },
  { name: "Empire State Building", address: "350 5th Ave, Manhattan", floor: 80, slot: "V3" },
  { name: "The Brooklyn Tower", address: "9 DeKalb Ave, Brooklyn", floor: 73, slot: "V1" },
];

const only = process.env.SHOT ? Number(process.env.SHOT) : null;
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t); // ease in and out

const browser = await chromium.launch({ channel: "chrome", headless: false });

for (const [i, shot] of SHOTS.entries()) {
  if (only !== null && i !== only) continue;
  // A fresh page per shot: one root-tileset session each, and no tile
  // memory carried over from the previous building.
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(`http://localhost:5174/tools/promo/index.html?w=${W}&h=${H}&sse=8&cacheMb=4096`);
  await page.waitForFunction(() => window.promo);
  await page.evaluate(() => window.promo.ready);
  const views = await page.evaluate(([n, a, f]) => window.promo.open(n, a, f), [shot.name, shot.address, shot.floor]);
  const base = views.find((v) => v.slot === shot.slot).headingDeg;

  // Warm the whole sweep: both ends and the middle, each fully settled.
  for (const off of [0, -PAN_DEG / 2, PAN_DEG / 2, 0]) {
    const s = await page.evaluate(([slot, o]) => window.promo.aim(slot, o, 120000, 1500), [shot.slot, off]);
    console.log(`${shot.name}: warm ${off}° ${JSON.stringify(s)}`);
  }

  const dir = path.join(OUT, String(i));
  fs.mkdirSync(dir, { recursive: true });
  const frames = FPS * SECONDS_PER_SHOT;
  let unsettled = 0;
  for (let f = 0; f < frames; f++) {
    const off = -PAN_DEG / 2 + PAN_DEG * ease(f / (frames - 1));
    const s = await page.evaluate(([slot, o]) => window.promo.aim(slot, o, 8000, 120), [shot.slot, off]);
    if (!s.settled) unsettled++;
    await page.evaluate((deg) => window.promo.caption(true, deg), (((base + off) % 360) + 360) % 360);
    await page.locator("#stage").screenshot({ path: path.join(dir, `${String(f).padStart(4, "0")}.png`) });
    if (f % 30 === 0) console.log(`${shot.name}: frame ${f}/${frames} ${JSON.stringify(s)}`);
  }
  console.log(`${shot.name}: done, ${unsettled} frames captured before fully settling`);
  await page.close();
}
await browser.close();
