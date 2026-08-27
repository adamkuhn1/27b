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
   * Inclusive floor range offered. `min` is a floor that was live-rendered
   * and visually accepted in all four directions — in the 2026-08-11 bake-off
   * a LOWER probe floor was also rendered for every building, and where it
   * failed (432 Park at 45, San Remo at 15, 1 CPW at 25, Brooklyn Tower at
   * 45) `min` stays at the verified floor. Floors above `min` up to `max` are
   * allowed on a geometric argument, not a render: raising the camera over
   * the same neighbours only lengthens every sightline. `max` is the
   * building's real top floor, and always keeps the estimated eye below the
   * dataset roof height, so the roof clamp in lib/geometry.ts never engages
   * silently for a curated request.
   */
  floors: { min: number; max: number };
  /** Floor the picker chip pre-fills — the one verified most carefully. */
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
    floors: { min: 50, max: 102 },
    suggestedFloor: 80,
    note: "Tall enough that every direction clears the Midtown roofline.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "432 Park Avenue",
    address: "432 Park Ave, Manhattan, New York, NY 10022",
    bin: "1088817",
    floors: { min: 70, max: 85 },
    suggestedFloor: 70,
    note: "Supertall over Midtown; Central Park fills the northwest frame.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "The San Remo",
    address: "145 Central Park West, Manhattan, New York, NY 10023",
    bin: "1028714",
    floors: { min: 20, max: 27 },
    suggestedFloor: 20,
    note: "Central Park West classic; the park and its lake fill the east frame.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "1 Central Park West",
    address: "1 Central Park West, Manhattan, New York, NY 10023",
    bin: "1027191",
    floors: { min: 35, max: 44 },
    suggestedFloor: 35,
    note: "Columbus Circle tower; park east, open circle south.",
    verifiedAt: "2026-08-11",
  },
  {
    name: "The Brooklyn Tower",
    address: "9 DeKalb Ave, Brooklyn, NY 11201",
    bin: "3000370",
    floors: { min: 70, max: 73 },
    suggestedFloor: 70,
    note: "Brooklyn's tallest; the harbor, the bridges, and brownstone Brooklyn below.",
    verifiedAt: "2026-08-11",
  },
] as const;

/** Look up the curated entry for a building, by its BIN. */
export function curatedByBin(bin: string): CuratedBuilding | undefined {
  return CURATED_BUILDINGS.find((b) => b.bin === bin);
}
