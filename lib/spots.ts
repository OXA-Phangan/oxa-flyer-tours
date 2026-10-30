// Shared spot library: flyerSpots/{id} holds what is the same in every tour (name, Google Maps,
// default instruction text). A tour (flyerRoutes/{id}.spots[]) references a library spot by
// `spotId` and only adds what is specific to that tour (time, type, earliest start, optional
// instruction override). Entries without a spotId are old embedded spots and keep working.

export type SpotType = "NORMAL" | "BREAK" | "SCOOTER_INFO";

export type LibrarySpot = {
  id: string;
  name: string;
  mapsLink: string | null;
  /** What Google Maps is searched for, so the volunteer sees the named place. */
  mapsQuery: string | null;
  /** Default instruction text shown to volunteers. */
  comment: string;
};

/** One entry of flyerRoutes/{id}.spots[] as stored. */
export type StoredRouteSpot = {
  spotId?: string | null;
  /** Library spot only: name shown in THIS tour instead of the library name ("" / missing = library name). */
  nameOverride?: string | null;
  name: string;
  type: SpotType;
  time: string;
  /** Embedded spot: the instruction text. Library spot: per-tour OVERRIDE ("" = use the library text). */
  comment: string;
  mapsLink: string | null;
  mapsQuery?: string | null;
  /** Sunset spot in this tour (2026-10-30): from SUNSET_CUTOFF on, open spots before it are greyed out. */
  sunset?: boolean;
  /** "HH:MM" (Bangkok): the volunteer can't take a picture / skip this spot before this time. */
  notBefore?: string | null;
};

/** What the volunteer portal works with: library data merged into the tour entry. */
export type ResolvedSpot = StoredRouteSpot & { fromLibrary: boolean };

export function resolveRouteSpot(entry: StoredRouteSpot, library: Map<string, LibrarySpot>): ResolvedSpot {
  const lib = entry.spotId ? library.get(entry.spotId) : undefined;
  if (!lib) return { ...entry, comment: entry.comment ?? "", time: entry.time ?? "", fromLibrary: false };
  return {
    ...entry,
    name: entry.nameOverride?.trim() ? entry.nameOverride.trim() : lib.name,
    mapsLink: lib.mapsLink,
    mapsQuery: lib.mapsQuery,
    comment: entry.comment?.trim() ? entry.comment : lib.comment,
    time: entry.time ?? "",
    fromLibrary: true,
  };
}

export function libraryFromDoc(id: string, data: Record<string, unknown>): LibrarySpot {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id,
    name: str(data.name),
    mapsLink: str(data.mapsLink).trim() || null,
    mapsQuery: str(data.mapsQuery).trim() || null,
    comment: str(data.comment),
  };
}
