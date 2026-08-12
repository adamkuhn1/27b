// The curated supported-building list, and why it exists.
//
// 27B does not promise "any NYC address." That promise was tried, at length,
// and the live evidence was unambiguous: Google's photorealistic mesh has a
// fixed resolution ceiling, and at 6 m from an ordinary mid-rise facade in a
// dense block — the typical real address — the render is a melted,
// artifact-heavy texture no application code can improve. A tall building, or
// a building facing open space (a park, a river, a wide avenue), renders
// genuinely photographically because the camera's subject is hundreds of
// meters away, where the mesh's meters-per-texel is flattering rather than
// fatal.
//
// So the product ships the honest subset: buildings and floor ranges where the
// technique was RENDERED AND LOOKED AT before being listed. Anything else gets
// a clear "we don't have a good view for this one yet" — a first-class state,
// not a caveat in body copy. This also keeps the app comfortably inside the
// Map Tiles free tier (~1,000 renders/month): renders only happen for
// addresses on this list.
//
// Every entry's `verifiedAt` is the date its floors were live-rendered and
// visually accepted (see README "How the list was verified"). An entry that
// has not been verified does not ship.
//
// Matching is by BIN — the building identifier the geocoder returns — so any
// spelling of a supported address ("350 5th Ave", "350 Fifth Avenue") matches,
// and no unsupported building can match by accident.

export interface CuratedBuilding {
  /** Display name (colloquial). */
  name: string;
  /** Canonical address used by the picker chips; geocodes cleanly. */
  address: string;
  /** NYC Building Identification Number — the match key. */
  bin: string;
  /**
   * Inclusive floor range verified to render well. Below `min` the camera
   * drops into street-level mesh (the provider's worst case); above `max` is
   * above the building (the pipeline would clamp to the roof anyway).
   */
  floors: { min: number; max: number };
  /** Floor the picker chip pre-fills — the one we verified most carefully. */
  suggestedFloor: number;
  /** Why this building renders well (shown in the picker). */
  note: string;
  /** ISO date the entry's renders were produced and visually accepted. */
  verifiedAt: string;
}

export const CURATED_BUILDINGS: readonly CuratedBuilding[] = [
  {
    name: "Empire State Building",
    address: "350 5th Ave, Manhattan, New York, NY 10118",
    bin: "1015862",
    floors: { min: 30, max: 102 },
    suggestedFloor: 80,
    note: "Tall enough that every direction clears the Midtown roofline.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "432 Park Avenue",
    address: "432 Park Ave, Manhattan, New York, NY 10022",
    bin: "1088817",
    floors: { min: 40, max: 85 },
    suggestedFloor: 70,
    note: "Supertall over Midtown; Central Park fills the north frame.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "The Dakota",
    address: "1 W 72nd St, Manhattan, New York, NY 10023",
    bin: "1028637",
    floors: { min: 5, max: 9 },
    suggestedFloor: 8,
    note: "A mid-rise that works because Central Park faces its east wall.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "Flatiron Building",
    address: "175 5th Ave, Manhattan, New York, NY 10010",
    bin: "1016278",
    floors: { min: 10, max: 20 },
    suggestedFloor: 18,
    note: "Madison Square Park opens the north view; wide avenues on both flanks.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "8 Spruce Street",
    address: "8 Spruce St, Manhattan, New York, NY 10038",
    bin: "1079057",
    floors: { min: 30, max: 75 },
    suggestedFloor: 60,
    note: "Gehry tower over the East River, the bridges, and low civic blocks.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "56 Leonard Street",
    address: "56 Leonard St, Manhattan, New York, NY 10013",
    bin: "1087629",
    floors: { min: 25, max: 57 },
    suggestedFloor: 45,
    note: "Tribeca supertall; low loft blocks leave every sightline open.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "The San Remo",
    address: "145 Central Park West, Manhattan, New York, NY 10023",
    bin: "1030710",
    floors: { min: 12, max: 27 },
    suggestedFloor: 20,
    note: "Twin-towered Central Park West classic; the park fills the east frame.",
    verifiedAt: "2026-08-11",
  },
] as const;

/** Look up the curated entry for a building, by its BIN. */
export function curatedByBin(bin: string): CuratedBuilding | undefined {
  return CURATED_BUILDINGS.find((b) => b.bin === bin);
}
