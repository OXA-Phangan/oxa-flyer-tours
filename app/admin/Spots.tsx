"use client";

import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { extractLatLng, extractPlaceName, isShortMapsLink, searchUrl, searchUrlByName } from "@/lib/maps-link";
import { libraryFromDoc, type LibrarySpot } from "@/lib/spots";

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const primaryButton =
  "w-full rounded-2xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";
const secondaryButton =
  "w-full rounded-2xl border border-[#E2DFD6] bg-white px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";
const inputClass =
  "block w-full rounded-lg border border-[#E2DFD6] bg-white px-3 py-2 text-sm text-[#201E1B] focus:border-[#201E1B] focus:outline-none";

/** The shared spot library, live. spots === null while loading. */
export function useSpotLibrary(): { spots: LibrarySpot[] | null; error: string | null } {
  const [spots, setSpots] = useState<LibrarySpot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerSpots"),
      (snap) => {
        const rows = snap.docs.map((d) => libraryFromDoc(d.id, d.data()));
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setSpots(rows);
        setError(null);
      },
      (err) => {
        console.error("[admin] spot library listener failed:", err);
        setError(
          err.code === "permission-denied"
            ? "Permission denied loading the spot library (the flyerSpots rules are not deployed yet)."
            : err.message
        );
      }
    );
  }, []);
  return { spots, error };
}

export type RouteUsage = { id: string; region: string; name: string; spotIds: string[] };

/** Place name Google shows for a stored link (long links locally, short links via the server). */
export async function detectMapsName(link: string): Promise<string | null> {
  const direct = extractPlaceName(link);
  if (direct) return direct;
  if (!isShortMapsLink(link)) return null;
  try {
    const r = await fetch(`/api/maps-resolve?u=${encodeURIComponent(link)}`);
    if (!r.ok) return null;
    const c = (await r.json()) as { name?: string | null };
    return typeof c.name === "string" && c.name ? c.name : null;
  } catch {
    return null;
  }
}

export function SpotsSection({
  routes,
  editingId,
  hrefFor,
  navigate,
  Link,
}: {
  routes: RouteUsage[];
  /** null = list, "new" = create, otherwise the spot being edited. */
  editingId: string | null;
  hrefFor: (spotId?: string | null) => string;
  navigate: (href: string) => void;
  Link: (p: { href: string; className?: string; children: React.ReactNode }) => React.ReactElement;
}) {
  const { spots, error } = useSpotLibrary();
  const [q, setQ] = useState("");

  const usage = useMemo(() => {
    const m = new Map<string, RouteUsage[]>();
    for (const r of routes) {
      for (const id of new Set(r.spotIds)) m.set(id, [...(m.get(id) ?? []), r]);
    }
    return m;
  }, [routes]);

  if (editingId !== null) {
    const existing = editingId === "new" ? null : (spots?.find((s) => s.id === editingId) ?? null);
    if (editingId !== "new" && !existing) {
      return spots === null && !error ? (
        <p className="text-[#5C5850]">Loading…</p>
      ) : (
        <>
          <Link href={hrefFor(null)} className="mb-4 inline-block text-sm text-[#5C5850] underline">
            ← Back to spots
          </Link>
          <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
            {error ?? "This spot doesn't exist (it may have been deleted)."}
          </div>
        </>
      );
    }
    return (
      <SpotEditor
        key={editingId}
        spot={existing}
        others={(spots ?? []).filter((x) => x.id !== existing?.id)}
        usedIn={existing ? (usage.get(existing.id) ?? []) : []}
        onBack={() => navigate(hrefFor(null))}
        routeHref={(id) => `/admin?tab=routes&route=${encodeURIComponent(id)}`}
        Link={Link}
        backHref={hrefFor(null)}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const shown = (spots ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle));

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-[#5C5850]">One list for all tours. Change a spot once, it changes everywhere.</p>
        <Link
          href={hrefFor("new")}
          className="shrink-0 rounded-full border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-2 text-sm font-semibold text-[#201E1B]"
        >
          + New Spot
        </Link>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search spots…"
        className={`${inputClass} mb-4`}
      />

      {spots === null && !error && <p className="text-[#5C5850]">Loading…</p>}
      {spots?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No spots yet. Create the first one.</div>
      )}

      <ul className="space-y-2">
        {shown.map((s) => {
          const n = usage.get(s.id)?.length ?? 0;
          return (
            <li key={s.id}>
              <Link
                href={hrefFor(s.id)}
                className={`${cardClass} flex w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-[#FBF9F4]`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold">{s.name}</span>
                  <span className="block truncate text-xs text-[#5C5850]">
                    {s.mapsLink ? `Google: “${s.mapsQuery ?? s.name}”` : "No map link"} · in {n} tour{n === 1 ? "" : "s"}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                    s.mapsLink
                      ? "border-[#A9D1B8] bg-[#E6F2EA] text-[#2F6E48]"
                      : "border-[#E2C27A] bg-[#FFF3D6] text-[#96742A]"
                  }`}
                >
                  {s.mapsLink ? "Map ✓" : "No map"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SpotEditor({
  spot,
  others,
  usedIn,
  onBack,
  backHref,
  routeHref,
  Link,
}: {
  spot: LibrarySpot | null;
  /** Other library spots (merge targets). */
  others: LibrarySpot[];
  usedIn: RouteUsage[];
  onBack: () => void;
  backHref: string;
  routeHref: (routeId: string) => string;
  Link: (p: { href: string; className?: string; children: React.ReactNode }) => React.ReactElement;
}) {
  const [name, setName] = useState(spot?.name ?? "");
  const [mapsLink, setMapsLink] = useState(spot?.mapsLink ?? "");
  const [mapsQuery, setMapsQuery] = useState(spot?.mapsQuery ?? "");
  const [comment, setComment] = useState(spot?.comment ?? "");
  const [detected, setDetected] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [confirmMerge, setConfirmMerge] = useState(false);

  async function detect(link: string) {
    const l = link.trim();
    if (!l) {
      setDetected(null);
      return;
    }
    setDetecting(true);
    const found = await detectMapsName(l);
    setDetecting(false);
    setDetected(found);
    // Fill the search name automatically as long as nobody typed one yet.
    if (found) setMapsQuery((prev) => (prev.trim() ? prev : found));
  }

  const link = mapsLink.trim();
  const testUrl = (() => {
    const q = mapsQuery.trim() || detected || name.trim();
    if (q) return searchUrlByName(q);
    const ll = link ? extractLatLng(link) : null;
    return ll ? searchUrl(ll) : link || null;
  })();

  async function save() {
    if (!name.trim()) {
      setError("Spot name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    const data = {
      name: name.trim(),
      mapsLink: link || null,
      mapsQuery: mapsQuery.trim() || null,
      comment: comment.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (spot) await updateDoc(doc(db, "flyerSpots", spot.id), data);
      else await addDoc(collection(db, "flyerSpots"), { ...data, createdAt: serverTimestamp() });
      onBack();
    } catch (err) {
      console.error("[admin] spot save failed:", err);
      setError("Saving failed. Please try again.");
      setSaving(false);
    }
  }

  async function merge() {
    if (!spot) return;
    const target = others.find((o) => o.id === mergeTargetId);
    if (!target) return;
    if (!confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Every tour entry that points at this spot now points at the target. A name used only in
      // that tour is dropped (the tour shows the target's name); per-tour instruction texts stay.
      for (const r of usedIn) {
        const snap = await getDoc(doc(db, "flyerRoutes", r.id));
        const list = (snap.data()?.spots ?? []) as Record<string, unknown>[];
        const next = list.map((sp) =>
          sp.spotId === spot.id
            ? {
                ...sp,
                spotId: target.id,
                nameOverride: null,
                name: target.name,
                mapsLink: target.mapsLink,
                mapsQuery: target.mapsQuery,
              }
            : sp
        );
        await updateDoc(doc(db, "flyerRoutes", r.id), { spots: next, updatedAt: serverTimestamp() });
      }
      await deleteDoc(doc(db, "flyerSpots", spot.id));
      onBack();
    } catch (err) {
      console.error("[admin] spot merge failed:", err);
      setError("Merging failed. Please try again.");
      setSaving(false);
    }
  }

  async function remove() {
    if (!spot) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Take the spot out of every tour that uses it first, then delete it from the library.
      for (const r of usedIn) {
        const snap = await getDoc(doc(db, "flyerRoutes", r.id));
        const list = (snap.data()?.spots ?? []) as { spotId?: string | null }[];
        const next = list.filter((sp) => sp.spotId !== spot.id);
        if (next.length !== list.length) {
          await updateDoc(doc(db, "flyerRoutes", r.id), { spots: next, updatedAt: serverTimestamp() });
        }
      }
      await deleteDoc(doc(db, "flyerSpots", spot.id));
      onBack();
    } catch (err) {
      console.error("[admin] spot delete failed:", err);
      setError("Deleting failed. Please try again.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-[#E2DFD6] bg-[#EFEDE7]/95 px-4 py-3 backdrop-blur">
        <Link href={backHref} className="text-sm text-[#5C5850] underline">
          ← Back to spots
        </Link>
        <p className="mt-0.5 truncate text-base font-semibold">{name.trim() || (spot ? "Spot" : "New spot")}</p>
      </div>

      <div className={`${cardClass} mb-4 space-y-4 p-4`}>
        <div>
          <label htmlFor="spot-name" className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input
            id="spot-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mama Market"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="spot-link" className="mb-1 block text-sm font-medium">
            Google Maps link
          </label>
          <input
            id="spot-link"
            type="text"
            value={mapsLink}
            onChange={(e) => setMapsLink(e.target.value)}
            onBlur={(e) => void detect(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              window.setTimeout(() => void detect(pasted), 0);
            }}
            placeholder="https://maps.app.goo.gl/…"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-[#8A857A]">
            {detecting
              ? "Reading the place name…"
              : link
                ? detected
                  ? `Place name found: ${detected}`
                  : "No place name found in this link. Enter the search name below."
                : "Optional."}
          </p>
        </div>

        <div>
          <label htmlFor="spot-query" className="mb-1 block text-sm font-medium">
            Search name in Google Maps
          </label>
          <input
            id="spot-query"
            type="text"
            value={mapsQuery}
            onChange={(e) => setMapsQuery(e.target.value)}
            placeholder={detected ?? "Name Google Maps should show"}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-[#8A857A]">
            This is what volunteers see when they open the map. Filled in from the link, change it if needed.
          </p>
          {testUrl && (
            <a
              href={testUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block rounded-xl border border-[#E2DFD6] bg-white px-3 py-2 text-sm font-semibold"
            >
              📍 Test in Google Maps
            </a>
          )}
        </div>

        <div>
          <label htmlFor="spot-comment" className="mb-1 block text-sm font-medium">
            Instructions for volunteers (default)
          </label>
          <textarea
            id="spot-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            placeholder="What the volunteer should do at this spot"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-[#8A857A]">A tour can override this text for itself.</p>
        </div>
      </div>

      {spot && (
        <div className={`${cardClass} mb-4 p-4`}>
          <p className="mb-2 text-sm font-medium">
            Used in {usedIn.length} tour{usedIn.length === 1 ? "" : "s"}
          </p>
          {usedIn.length === 0 ? (
            <p className="text-xs text-[#8A857A]">Not in any tour yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {usedIn.map((r) => (
                <Link
                  key={r.id}
                  href={routeHref(r.id)}
                  className="rounded-full border border-[#E2DFD6] bg-[#FBF9F4] px-3 py-1 text-xs font-semibold text-[#5C5850]"
                >
                  {r.region} · {r.name}
                </Link>
              ))}
            </div>
          )}
          {usedIn.length > 0 && (
            <p className="mt-2 text-xs text-[#8A857A]">Changes here apply to all of these tours as soon as you save.</p>
          )}
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#E2DFD6] bg-[#EFEDE7]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          {error && (
            <div role="alert" className="mb-2 rounded-xl border border-red-300 bg-red-50 p-2.5 text-sm text-red-800">
              {error}
            </div>
          )}
          <button type="button" onClick={save} disabled={saving} className={primaryButton}>
            {saving ? "Saving…" : spot ? "Save Changes" : "Create Spot"}
          </button>
        </div>
      </div>

      {spot && others.length > 0 && (
        <div className={`${cardClass} mb-4 space-y-3 p-4`}>
          <p className="text-sm font-medium">Same place as another spot?</p>
          <p className="text-xs text-[#8A857A]">
            Replace this spot with the other one in all tours, then delete this spot.
          </p>
          <select
            value={mergeTargetId}
            onChange={(e) => {
              setMergeTargetId(e.target.value);
              setConfirmMerge(false);
            }}
            className={inputClass}
          >
            <option value="">Choose the spot to keep…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {mergeTargetId && (
            <button
              type="button"
              onClick={merge}
              disabled={saving}
              className={
                confirmMerge
                  ? "w-full rounded-2xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-3 text-sm font-semibold text-[#201E1B] disabled:opacity-40"
                  : secondaryButton
              }
            >
              {saving
                ? "Merging…"
                : confirmMerge
                  ? `Tap again: ${usedIn.length} tour${usedIn.length === 1 ? "" : "s"} will use “${others.find((o) => o.id === mergeTargetId)?.name}”, this spot is deleted`
                  : "Replace with this spot…"}
            </button>
          )}
        </div>
      )}

      {spot && (
        <div className="space-y-3 pb-28">
          <button
            type="button"
            onClick={remove}
            disabled={saving}
            className={
              confirmDelete
                ? "w-full rounded-2xl border border-red-600 bg-red-50 px-4 py-4 text-base font-semibold text-red-800 disabled:opacity-40"
                : secondaryButton
            }
          >
            {saving
              ? "Deleting…"
              : confirmDelete
                ? usedIn.length > 0
                  ? `Tap again: delete and remove from ${usedIn.length} tour${usedIn.length === 1 ? "" : "s"}`
                  : "Tap again to confirm delete"
                : "Delete Spot"}
          </button>
          {usedIn.length > 0 && (
            <p className="text-center text-xs text-[#8A857A]">
              This spot is used in {usedIn.length} tour{usedIn.length === 1 ? "" : "s"}. Deleting it also removes it from
              them. Don&apos;t do this while a volunteer is on one of these tours.
            </p>
          )}
        </div>
      )}
    </>
  );
}
