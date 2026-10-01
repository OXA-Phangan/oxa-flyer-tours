"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";

/* ===================== Types ===================== */

type SpotType = "NORMAL" | "BREAK" | "SCOOTER_INFO";

type Spot = {
  name: string;
  type: SpotType;
  time: string;
  comment: string;
  mapsLink: string | null;
};

type FlyerRoute = {
  id: string;
  region: string;
  name: string;
  spots: Spot[];
};

type Volunteer = {
  name: string;
  checkInDate: string;
  checkOutDate: string;
  status: "active" | "departed";
  onBreak: boolean;
};

type SpotStatus = "open" | "completed" | "skipped";

type TourState = {
  currentIndex: number;
  statusMap: Record<number, SpotStatus>;
  skipReasons: Record<number, string>;
};

type Screen = "loading" | "invalid" | "picker" | "tour" | "completion";

const SKIP_REASONS = ["I don't have enough time", "The spot is closed", "Other reason"];

/* ===================== Shared styles (matches /register and /admin) ===================== */

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const primaryButton =
  "w-full rounded-2xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white disabled:opacity-40";
const secondaryButton =
  "w-full rounded-2xl border border-[#E2DFD6] bg-white px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

/* ===================== Helpers ===================== */

function isResolvable(sp: Spot) {
  return sp.type === "BREAK" || sp.type === "SCOOTER_INFO";
}

function sanitizeForId(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function progressDocId(token: string, route: FlyerRoute) {
  return `${token}_${sanitizeForId(route.region)}_${sanitizeForId(route.id)}`;
}

/** Midnight at the start of tomorrow, in the browser's local time. */
function tomorrowMidnight(): Timestamp {
  const now = new Date();
  return Timestamp.fromDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

function countOpenBetween(spots: Spot[], statusMap: Record<number, SpotStatus>, fromExclusive: number, toExclusive: number) {
  let count = 0;
  for (let i = fromExclusive + 1; i < toExclusive; i++) {
    const sp = spots[i];
    if (!sp || isResolvable(sp)) continue;
    if ((statusMap[i] ?? "open") === "open") count++;
  }
  return count;
}

/* ===================== Component ===================== */

export default function TourPortalClient({ token }: { token: string }) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [volunteer, setVolunteer] = useState<Volunteer | null>(null);
  const [routes, setRoutes] = useState<FlyerRoute[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeRoute, setActiveRoute] = useState<FlyerRoute | null>(null);
  const [tour, setTour] = useState<TourState>({ currentIndex: 0, statusMap: {}, skipReasons: {} });
  const [uploadState, setUploadState] = useState<Record<number, "uploading" | "success" | "failure">>({});

  const [regionSheetKey, setRegionSheetKey] = useState<string | null>(null);
  const [skipSheetOpen, setSkipSheetOpen] = useState(false);
  const [skipWarning, setSkipWarning] = useState<{ targetIndex: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tourRef = useRef(tour);
  tourRef.current = tour;

  // ---- Load volunteer + routes on mount ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const volSnap = await getDoc(doc(db, "flyerVolunteers", token));
        if (cancelled) return;
        if (!volSnap.exists()) {
          setScreen("invalid");
          return;
        }
        const v = volSnap.data() as Volunteer;
        setVolunteer(v);

        const routesSnap = await getDocs(collection(db, "flyerRoutes"));
        if (cancelled) return;
        const loadedRoutes: FlyerRoute[] = routesSnap.docs.map((d) => {
          const data = d.data() as { region: string; name: string; spots: Spot[] };
          return { id: d.id, region: data.region, name: data.name, spots: data.spots ?? [] };
        });
        setRoutes(loadedRoutes);
        setScreen(v.status === "active" ? "picker" : "invalid");
      } catch (err) {
        console.error("[tour] load failed:", err);
        if (!cancelled) setLoadError("Something went wrong loading your portal. Please check your connection and reload.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const regions = useMemo(() => {
    const map = new Map<string, FlyerRoute[]>();
    for (const r of routes ?? []) {
      const list = map.get(r.region) ?? [];
      list.push(r);
      map.set(r.region, list);
    }
    return Array.from(map.entries());
  }, [routes]);

  const persist = useCallback(
    (route: FlyerRoute, next: TourState) => {
      setDoc(
        doc(db, "flyerTourProgress", progressDocId(token, route)),
        {
          volunteerId: token,
          region: route.region,
          route: route.name,
          currentIndex: next.currentIndex,
          statusMap: next.statusMap,
          skipReasons: next.skipReasons,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      ).catch((err) => console.error("[tour] failed to save progress:", err));
    },
    [token]
  );

  async function selectRoute(route: FlyerRoute) {
    setRegionSheetKey(null);
    setActiveRoute(route);
    setUploadState({});

    let next: TourState = { currentIndex: 0, statusMap: {}, skipReasons: {} };
    try {
      const existing = await getDoc(doc(db, "flyerTourProgress", progressDocId(token, route)));
      if (existing.exists()) {
        const data = existing.data() as {
          currentIndex?: number;
          statusMap?: Record<string, SpotStatus>;
          skipReasons?: Record<string, string>;
        };
        const statusMap: Record<number, SpotStatus> = {};
        Object.entries(data.statusMap ?? {}).forEach(([k, v]) => (statusMap[Number(k)] = v));
        const skipReasons: Record<number, string> = {};
        Object.entries(data.skipReasons ?? {}).forEach(([k, v]) => (skipReasons[Number(k)] = v));
        next = { currentIndex: data.currentIndex ?? 0, statusMap, skipReasons };
      }
    } catch (err) {
      console.error("[tour] failed to load existing progress:", err);
    }

    // Any spot not yet in the map starts "open".
    route.spots.forEach((_, i) => {
      if (!(i in next.statusMap)) next.statusMap[i] = "open";
    });

    setTour(next);
    setScreen("tour");
    persist(route, next);
  }

  function backToPicker() {
    setActiveRoute(null);
    setScreen("picker");
  }

  function jumpToSpot(targetIndex: number) {
    if (!activeRoute || targetIndex === tour.currentIndex) return;
    if (targetIndex > tour.currentIndex) {
      const openCount = countOpenBetween(activeRoute.spots, tour.statusMap, tour.currentIndex, targetIndex);
      if (openCount > 0) {
        setSkipWarning({ targetIndex });
        return;
      }
    }
    const next = { ...tour, currentIndex: targetIndex };
    setTour(next);
    persist(activeRoute, next);
  }

  function confirmSkipAhead() {
    if (!activeRoute || !skipWarning) return;
    const next: TourState = {
      ...tour,
      currentIndex: skipWarning.targetIndex,
    };
    setSkipWarning(null);
    setTour(next);
    persist(activeRoute, next);
  }

  function goPrev() {
    if (tour.currentIndex <= 0 || !activeRoute) return;
    const next = { ...tour, currentIndex: tour.currentIndex - 1 };
    setTour(next);
    persist(activeRoute, next);
  }

  function finishRoute(finalTour?: TourState) {
    if (!activeRoute) return;
    const base = finalTour ?? tour;
    const sp = activeRoute.spots[base.currentIndex];
    let next = base;
    if (sp && isResolvable(sp)) {
      next = { ...base, statusMap: { ...base.statusMap, [base.currentIndex]: "completed" } };
      setTour(next);
    }
    persist(activeRoute, next);
    setScreen("completion");
  }

  function goNext() {
    if (!activeRoute) return;
    const sp = activeRoute.spots[tour.currentIndex];
    const resolved = isResolvable(sp) || tour.statusMap[tour.currentIndex] !== "open";
    if (!resolved) return;
    if (tour.currentIndex === activeRoute.spots.length - 1) {
      finishRoute();
      return;
    }
    const next = { ...tour, currentIndex: tour.currentIndex + 1 };
    setTour(next);
    persist(activeRoute, next);
  }

  function openSkipSheet() {
    setSkipSheetOpen(true);
  }

  function submitSkipReason(reason: string) {
    if (!activeRoute) return;
    const target = tour.currentIndex;
    const statusMap = { ...tour.statusMap };
    const skipReasons = { ...tour.skipReasons };
    statusMap[target] = "skipped";
    skipReasons[target] = reason;
    setSkipSheetOpen(false);

    const isLast = target === activeRoute.spots.length - 1;
    const next: TourState = {
      currentIndex: isLast ? target : target + 1,
      statusMap,
      skipReasons,
    };
    setTour(next);
    if (isLast) {
      finishRoute(next);
    } else {
      persist(activeRoute, next);
    }
  }

  function triggerCamera() {
    fileInputRef.current?.click();
  }

  async function handleCameraFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeRoute || !volunteer) return;

    const spotIndex = tour.currentIndex;
    const sp = activeRoute.spots[spotIndex];
    setUploadState((s) => ({ ...s, [spotIndex]: "uploading" }));

    try {
      const compressed = await compressImageFile(file);
      const storagePath = `flyerProofs/${token}/${spotIndex}-${Date.now()}.jpg`;
      await uploadBytes(ref(storage, storagePath), compressed, {
        contentType: compressed.type || "image/jpeg",
      });
      await addDoc(collection(db, "flyerProofs"), {
        volunteerId: token,
        volunteerName: volunteer.name,
        region: activeRoute.region,
        route: activeRoute.name,
        spotName: sp.name,
        spotIndex,
        storagePath,
        uploadedAt: serverTimestamp(),
        deleteAfter: tomorrowMidnight(),
      });

      setUploadState((s) => ({ ...s, [spotIndex]: "success" }));
      const skipReasons = { ...tourRef.current.skipReasons };
      delete skipReasons[spotIndex];
      const next: TourState = {
        ...tourRef.current,
        statusMap: { ...tourRef.current.statusMap, [spotIndex]: "completed" },
        skipReasons,
      };
      setTour(next);
      persist(activeRoute, next);

      // Small pause so the ✓ is visible before auto-advancing, same as the
      // prototype's behavior.
      setTimeout(() => {
        if (spotIndex === activeRoute.spots.length - 1) {
          finishRoute(next);
        } else {
          const advanced = { ...next, currentIndex: spotIndex + 1 };
          setTour(advanced);
          persist(activeRoute, advanced);
        }
      }, 500);
    } catch (err) {
      console.error("[tour] photo upload failed:", err);
      setUploadState((s) => ({ ...s, [spotIndex]: "failure" }));
    }
  }

  async function togglePause() {
    if (!volunteer) return;
    const nextOnBreak = !volunteer.onBreak;
    setVolunteer({ ...volunteer, onBreak: nextOnBreak });
    try {
      await updateDoc(doc(db, "flyerVolunteers", token), { onBreak: nextOnBreak });
    } catch (err) {
      console.error("[tour] failed to update break status:", err);
    }
  }

  /* ===================== Screens ===================== */

  if (screen === "loading") {
    return (
      <Shell>
        <p className="pt-20 text-center text-[#5C5850]">
          {loadError ?? "Loading…"}
        </p>
      </Shell>
    );
  }

  if (screen === "invalid") {
    return (
      <Shell>
        <div className={`${cardClass} p-6 text-center`}>
          <div className="mb-2 text-3xl">🔗</div>
          <h1 className="mb-2 text-lg font-semibold">This link isn&apos;t active.</h1>
          <p className="text-sm text-[#5C5850]">
            {volunteer?.status === "departed"
              ? "Your stay has ended. If this seems wrong, please contact the OXA team."
              : "Please check the link, or contact the OXA team."}
          </p>
        </div>
      </Shell>
    );
  }

  if (screen === "picker" || regionSheetKey) {
    return (
      <Shell>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Where to next?</h1>
          {volunteer && <p className="text-sm text-[#5C5850]">Hi {volunteer.name} 👋</p>}
        </div>

        {regions.length === 0 && (
          <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
            No routes have been set up yet. Check back soon.
          </div>
        )}

        <div className="space-y-3">
          {regions.map(([region]) => (
            <button
              key={region}
              type="button"
              onClick={() => setRegionSheetKey(region)}
              className={`${cardClass} block w-full p-4 text-left text-lg font-semibold active:bg-[#FBF9F4]`}
            >
              {region}
            </button>
          ))}
        </div>

        {regionSheetKey && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => setRegionSheetKey(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl"
            >
              <h2 className="mb-4 text-lg font-semibold">{regionSheetKey}</h2>
              <div className="space-y-3">
                {(regions.find(([r]) => r === regionSheetKey)?.[1] ?? []).map((route) => (
                  <button
                    key={route.id}
                    type="button"
                    onClick={() => selectRoute(route)}
                    className={`${cardClass} block w-full p-4 text-left font-medium active:bg-[#FBF9F4]`}
                  >
                    {route.name}
                    <span className="block text-sm font-normal text-[#5C5850]">
                      {route.spots.length} spot{route.spots.length === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setRegionSheetKey(null)} className={`${secondaryButton} mt-4`}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Shell>
    );
  }

  if ((screen === "tour" || screen === "completion") && activeRoute) {
    if (screen === "completion") {
      const total = activeRoute.spots.filter((sp) => !isResolvable(sp)).length;
      const skipped = activeRoute.spots.filter((sp, i) => !isResolvable(sp) && tour.statusMap[i] === "skipped").length;
      return (
        <Shell>
          <div className={`${cardClass} p-8 text-center`}>
            <div className="mb-3 text-4xl">🏁</div>
            <h1 className="mb-1 text-2xl font-semibold">Tour Completed!</h1>
            <p className="mb-4 text-sm text-[#5C5850]">
              {activeRoute.region} · {activeRoute.name}
            </p>
            <div className="mb-6 inline-block rounded-full bg-[#F3E4C2] px-4 py-2 text-sm font-semibold text-[#96742A]">
              Skipped: {skipped}/{total}
            </div>
            <p className="mb-6 text-base text-[#5C5850]">Thank you for flyering today 🙌</p>
            <button type="button" onClick={backToPicker} className={primaryButton}>
              Back
            </button>
          </div>
        </Shell>
      );
    }

    const isLast = tour.currentIndex === activeRoute.spots.length - 1;

    return (
      <main className="flex min-h-screen flex-1 flex-col bg-[#EFEDE7] text-[#201E1B]">
        <div className="mx-auto w-full max-w-md flex-1 px-4 pb-28 pt-8">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold">Flyer Tours</h1>
            <button type="button" onClick={backToPicker} className="rounded-full bg-[#201E1B] px-4 py-2 text-sm font-semibold text-white">
              Back
            </button>
          </div>
          <p className="mb-4 text-sm font-medium text-[#8A857A]">
            {activeRoute.region} · {activeRoute.name}
          </p>

          {volunteer?.onBreak && (
            <div className="mb-4 rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-3 text-sm">
              ☕ You&apos;re marked on a break. Tap Resume below when you&apos;re back on route.
            </div>
          )}

          {activeRoute.spots.length === 0 ? (
            <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
              No spots configured for this route yet. Check back once the route data has been added.
            </div>
          ) : (
            <div className="space-y-2">
              {activeRoute.spots.map((spot, i) =>
                i === tour.currentIndex ? (
                  <ActiveSpotCard
                    key={i}
                    index={i}
                    spot={spot}
                    isLast={isLast}
                    status={tour.statusMap[i] ?? "open"}
                    uploadState={uploadState[i]}
                    onCamera={triggerCamera}
                    onSkip={openSkipSheet}
                    onPrev={goPrev}
                    onNext={goNext}
                    canGoPrev={i > 0}
                  />
                ) : (
                  <CollapsedSpotRow
                    key={i}
                    index={i}
                    spot={spot}
                    status={tour.statusMap[i] ?? "open"}
                    onTap={() => jumpToSpot(i)}
                  />
                )
              )}
            </div>
          )}
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleCameraFile} className="hidden" />

        {/* Sticky Chat + Pause footer */}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#E2DFD6] bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-md gap-3">
            <button
              type="button"
              disabled
              title="Coming soon"
              className="flex-1 rounded-2xl border border-[#E2DFD6] bg-white px-4 py-3 text-base font-semibold text-[#201E1B] opacity-50"
            >
              💬 Chat
            </button>
            <button
              type="button"
              onClick={togglePause}
              className={
                volunteer?.onBreak
                  ? "flex-1 rounded-2xl bg-[#201E1B] px-4 py-3 text-base font-semibold text-white"
                  : "flex-1 rounded-2xl border border-[#E2DFD6] bg-white px-4 py-3 text-base font-semibold text-[#201E1B]"
              }
            >
              {volunteer?.onBreak ? "▶ Resume" : "☕ Pause"}
            </button>
          </div>
        </div>

        {skipSheetOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setSkipSheetOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-t-2xl bg-white p-6 sm:rounded-2xl">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Skip Spot</h2>
              <h3 className="mb-4 text-lg font-semibold">Why are you skipping this spot?</h3>
              <div className="space-y-2">
                {SKIP_REASONS.map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => submitSkipReason(reason)}
                    className={`${cardClass} block w-full p-3 text-left active:bg-[#FBF9F4]`}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setSkipSheetOpen(false)} className={`${secondaryButton} mt-4`}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {skipWarning && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setSkipWarning(null)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-t-2xl bg-white p-6 sm:rounded-2xl">
              <h3 className="mb-2 text-lg font-semibold">Skip ahead?</h3>
              <p className="mb-5 text-sm text-[#5C5850]">
                Jumping ahead will mark the spots in between as skipped. You can still come back to them later.
              </p>
              <div className="space-y-3">
                <button type="button" onClick={confirmSkipAhead} className={primaryButton}>
                  Yes, skip ahead
                </button>
                <button type="button" onClick={() => setSkipWarning(null)} className={secondaryButton}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  return null;
}

/* ===================== Spot cards ===================== */

function CollapsedSpotRow({
  index,
  spot,
  status,
  onTap,
}: {
  index: number;
  spot: Spot;
  status: SpotStatus;
  onTap: () => void;
}) {
  let suffix: React.ReactNode = null;
  let numClass = "bg-[#E9E4D8] text-[#201E1B]";
  if (status === "completed") {
    suffix = <span className="text-[#3E8E5A]">✓</span>;
    numClass = "bg-[#DCEEE1] text-[#3E8E5A]";
  }
  if (status === "skipped") {
    suffix = <span className="text-[#C0392B]">[Skipped]</span>;
    numClass = "bg-[#F3E0DC] text-[#C0392B]";
  }

  return (
    <button
      type="button"
      onClick={onTap}
      className={`${cardClass} flex w-full items-center gap-3 p-3 text-left active:bg-[#FBF9F4]`}
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${numClass}`}>
        {index + 1}
      </span>
      <span className="flex-1 truncate font-medium">{spot.name}</span>
      {suffix}
    </button>
  );
}

function ActiveSpotCard({
  index,
  spot,
  isLast,
  status,
  uploadState,
  onCamera,
  onSkip,
  onPrev,
  onNext,
  canGoPrev,
}: {
  index: number;
  spot: Spot;
  isLast: boolean;
  status: SpotStatus;
  uploadState: "uploading" | "success" | "failure" | undefined;
  onCamera: () => void;
  onSkip: () => void;
  onPrev: () => void;
  onNext: () => void;
  canGoPrev: boolean;
}) {
  const resolvable = isResolvable(spot);
  const resolved = resolvable || status !== "open";

  return (
    <div className={`${cardClass} p-4`}>
      {spot.type === "BREAK" && (
        <div className="mb-2 inline-block rounded-full bg-[#F3E4C2] px-3 py-1 text-xs font-semibold text-[#96742A]">Break</div>
      )}
      {spot.type === "SCOOTER_INFO" && (
        <div className="mb-2 inline-block rounded-full bg-[#F3E4C2] px-3 py-1 text-xs font-semibold text-[#96742A]">
          Scooter Info
        </div>
      )}
      <div className="mb-2 inline-block rounded-full bg-[#E9E4D8] px-3 py-1 text-xs font-semibold">{spot.time}</div>
      <h2 className="mb-3 text-lg font-semibold">
        {index + 1}. {spot.name}
      </h2>
      <div className="mb-4 rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-4 text-sm leading-relaxed">{spot.comment}</div>

      {!resolvable && (
        <>
          {uploadState === "uploading" ? (
            <button type="button" disabled className="mb-3 w-full rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] px-4 py-4 text-base font-semibold opacity-70">
              ⌛ Uploading…
            </button>
          ) : uploadState === "success" || status === "completed" ? (
            <button type="button" disabled className="mb-3 w-full rounded-xl border-2 border-[#3E8E5A] bg-[#EAF5EE] px-4 py-4 text-base font-semibold text-[#3E8E5A]">
              ✅ Picture Uploaded
            </button>
          ) : uploadState === "failure" ? (
            <button type="button" onClick={onCamera} className="mb-3 w-full rounded-xl border-2 border-[#C0392B] bg-[#F7E9E7] px-4 py-4 text-base font-semibold text-[#C0392B]">
              ❌ Failed. Try Again
            </button>
          ) : (
            <button type="button" onClick={onCamera} className="mb-3 w-full rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] px-4 py-4 text-base font-semibold">
              📸 Take a Picture
            </button>
          )}
        </>
      )}

      {!resolvable && status !== "completed" && (
        <button type="button" onClick={onSkip} className="mb-3 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold text-[#5C5850]">
          ⏭️ Skip Spot
        </button>
      )}

      {spot.mapsLink && (
        <a
          href={spot.mapsLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-3 block w-full rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-center text-base font-semibold"
        >
          📍 Navigate
        </a>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canGoPrev}
          className="flex-1 rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base font-semibold disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!resolved}
          className="flex-1 rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base font-semibold disabled:opacity-40"
        >
          {isLast ? "Finish Route" : "Next →"}
        </button>
      </div>
    </div>
  );
}
