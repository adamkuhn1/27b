#!/usr/bin/env node
// Prepare a BLINDED comparison set from a finished bake-off run.
//
// The person scoring the frames is the same person who chose the variants, so
// "does 1600x1200 look better than 800x600" is exactly the question a scorer
// answers yes to by default. This removes the label from the pixels before the
// question is asked, and hides the answer key until a verdict is written down.
//
// TWO THINGS LEAK IF YOU ONLY RENAME THE FILES:
//
//   1. Image dimensions. A 1600-wide PNG is self-evidently the supersampled
//      one. Both are therefore resampled to the size they are ACTUALLY SHOWN
//      at — 1504 device px, the measured 752 CSS px hero at DPR 2 — which is
//      also the only comparison that means anything. The baseline is upscaled
//      exactly as the browser upscales it today; the variant is very slightly
//      downscaled, exactly as the browser would.
//   2. Total height, via the attribution bar. Two sessions of the same camera
//      load different tiles and therefore return different credit strings,
//      which wrap to a different number of lines and make the composited PNGs
//      different heights. A centred crop tall enough to include the bar then
//      shows it in one member of a pair and not the other — which is a tell,
//      and it was visible on the first attempt at this. The crop is therefore
//      1504x1050, comfortably inside the 1128 px image area of BOTH, so no
//      attribution appears in any comparison image and the only residual
//      difference is a vertical offset of a few pixels.
//
// The crop is an ANALYSIS artefact. The shipped frames on disk are untouched
// and still carry their full, uncropped attribution bar; nothing here changes
// what the product displays.
//
// Usage:
//   node apps/27b/proof/bakeoff/blind.mjs --run=e1-capture-resolution
//   ... score blind/NN.png, write blind/VERDICT.md ...
//   node apps/27b/proof/bakeoff/blind.mjs --run=e1-capture-resolution --reveal

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const run = argv.find((a) => a.startsWith("--run="))?.split("=")[1];
const reveal = argv.includes("--reveal");
if (!run) {
  console.error("usage: blind.mjs --run=<plan id> [--reveal]");
  process.exit(2);
}

const FRAMES = join(HERE, "results", "frames");
const BLIND = join(HERE, "results", `blind-${run}`);
const KEY = join(BLIND, "KEY.json");
const WIDTH = 1504;
const HEIGHT = 1050;

if (reveal) {
  if (!existsSync(KEY)) throw new Error(`no key at ${KEY}`);
  const key = JSON.parse(readFileSync(KEY, "utf8"));
  const verdict = join(BLIND, "VERDICT.md");
  if (!existsSync(verdict)) {
    console.error(
      "REFUSING TO REVEAL: write blind/VERDICT.md first. Revealing before " +
        "scoring makes the blinding decorative.",
    );
    process.exit(3);
  }
  for (const [blindName, source] of Object.entries(key.mapping)) {
    console.log(`${blindName}  <-  ${source}`);
  }
  process.exit(0);
}

rmSync(BLIND, { recursive: true, force: true });
mkdirSync(BLIND, { recursive: true });

const files = readdirSync(FRAMES).filter((f) => f.endsWith(".png"));
if (files.length === 0) throw new Error(`no frames in ${FRAMES}`);

// Fisher-Yates over a fresh order so position carries no information either.
const order = [...files];
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const mapping = {};
order.forEach((source, i) => {
  const name = `${String(i + 1).padStart(2, "0")}.png`;
  const out = join(BLIND, name);
  copyFileSync(join(FRAMES, source), out);
  // sips ships with macOS; resample to display size, then crop to a common box.
  execFileSync("sips", ["--resampleWidth", String(WIDTH), out], {
    stdio: "ignore",
  });
  execFileSync(
    "sips",
    ["--cropToHeightWidth", String(HEIGHT), String(WIDTH), out],
    { stdio: "ignore" },
  );
  mapping[name] = source;
});

writeFileSync(
  KEY,
  JSON.stringify(
    {
      run,
      note:
        "Answer key. Do not read before writing VERDICT.md — see blind.mjs. " +
        `Frames resampled to ${WIDTH}px (the measured hero size at DPR 2) and ` +
        `cropped to ${WIDTH}x${HEIGHT} so neither dimension identifies a variant.`,
      displayWidthPx: WIDTH,
      mapping,
    },
    null,
    2,
  ),
);

// Also emit the pairing WITHOUT variant labels, so a scorer knows which images
// show the same camera and can compare like with like.
const pairs = {};
for (const [blindName, source] of Object.entries(mapping)) {
  const slot = source.replace(/\.png$/, "").split("--")[1];
  const building = source.split("-f")[0];
  const floor = source.match(/-f(\d+)-/)?.[1];
  const groupKey = `${building}-f${floor}-${slot}`;
  (pairs[groupKey] ??= []).push(blindName);
}
// Strip the group labels: a scorer needs the grouping, not the building name.
const anonymousGroups = Object.values(pairs)
  .map((g) => g.sort())
  .sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(
  join(BLIND, "GROUPS.json"),
  JSON.stringify(
    {
      note:
        "Each array is one camera captured under both conditions, in unknown " +
        "order. Compare within a group; the group's identity is withheld.",
      groups: anonymousGroups,
    },
    null,
    2,
  ),
);

console.log(`${order.length} frames blinded into ${BLIND}`);
console.log(`${anonymousGroups.length} comparison groups`);
