"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";
import { readSeen, writeSeen } from "@/lib/chat-seen";
import { messagePreview, uploadChatMedia, type ChatMediaType, type PreparedMedia } from "@/lib/chat-media";
import ChatComposer from "@/components/ChatComposer";
import ChatMessageBody from "@/components/ChatMessageBody";
import BikeRental from "@/components/BikeRental";
import { bikeLabel, parseRental, type BikeRental as BikeRentalDoc } from "@/lib/bike";
import { bangkokToday, compareShifts, dayLabel, tourLabel, type FlyerShift } from "@/lib/shifts";

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
  completionMessage: string | null;
};

type PendingStayEdit = {
  checkInDate: string;
  checkInTime: string | null;
  checkOutDate: string;
  checkOutTime: string | null;
};

type Volunteer = {
  name: string;
  checkInDate: string;
  checkInTime: string | null;
  checkOutDate: string;
  checkOutTime: string | null;
  status: "active" | "departed";
  onBreak: boolean;
  hasPendingStayEdit: boolean;
  pendingStayEdit: PendingStayEdit | null;
};

type ChatMessage = {
  id: string;
  senderRole: "volunteer" | "admin";
  senderName: string;
  text: string;
  mediaType?: ChatMediaType | null;
  mediaPath?: string | null;
};

type SpotStatus = "open" | "completed" | "skipped";

type TourState = {
  currentIndex: number;
  statusMap: Record<number, SpotStatus>;
  skipReasons: Record<number, string>;
};

type Screen = "loading" | "invalid" | "picker" | "shifts" | "tour" | "completion";

const SKIP_REASONS = ["I don't have enough time", "The spot is closed", "Other reason"];

/* ===================== Shared styles (matches /register and /admin) ===================== */

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const primaryButton =
  "w-full rounded-2xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white disabled:opacity-40";
const secondaryButton =
  "w-full rounded-2xl border border-[#E2DFD6] bg-white px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";
const fieldInput =
  "block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base text-[#201E1B] min-h-[50px] focus:border-[#201E1B] focus:outline-none";
const fieldLabel = "mb-1.5 block text-sm font-medium text-[#201E1B]";

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

/**
 * Tour proof photos are deleted 48h after upload by the Cloud Function
 * cleanupExpiredFlyerProofs (which goes by uploadedAt / the file's age, not
 * this field — informational only).
 */
function proofDeleteAfter(): Timestamp {
  return Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
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

/* ===================== Tour event log ===================== */

type TourEventType =
  | "tour_start"
  | "spot_completed"
  | "spot_skipped"
  | "spot_passed"
  | "break_start"
  | "break_end"
  | "tour_finished";

type TourEventExtra = {
  spotIndex?: number;
  spot?: Spot;
  reason?: string;
  proofStoragePath?: string;
};

/**
 * Append-only log in flyerTourEvents (never updated or deleted) — read by the
 * management dashboard for the tour timeline. Fire-and-forget: a failed log
 * write must never block or break the tour.
 */
function logTourEvent(
  volunteerId: string,
  volunteerName: string,
  type: TourEventType,
  route: FlyerRoute | null,
  extra: TourEventExtra = {}
) {
  try {
    addDoc(collection(db, "flyerTourEvents"), {
      volunteerId,
      volunteerName,
      day: bangkokToday(),
      region: route?.region ?? null,
      routeId: route?.id ?? null,
      routeName: route?.name ?? null,
      type,
      spotIndex: extra.spotIndex ?? null,
      spotName: extra.spot?.name ?? null,
      spotType: extra.spot?.type ?? null,
      reason: extra.reason ?? null,
      proofStoragePath: extra.proofStoragePath ?? null,
      at: serverTimestamp(),
    }).catch((err) => console.error("[tour] event log failed:", err));
  } catch (err) {
    console.error("[tour] event log failed:", err);
  }
}

/* ===================== Component ===================== */

export default function TourPortalClient({ token }: { token: string }) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [volunteer, setVolunteer] = useState<Volunteer | null>(null);
  const [routes, setRoutes] = useState<FlyerRoute[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shifts, setShifts] = useState<FlyerShift[] | null>(null);

  const [activeRoute, setActiveRoute] = useState<FlyerRoute | null>(null);
  const [tour, setTour] = useState<TourState>({ currentIndex: 0, statusMap: {}, skipReasons: {} });
  const [uploadState, setUploadState] = useState<Record<number, "uploading" | "success" | "failure">>({});

  const [toursOpen, setToursOpen] = useState(false);
  const [bikeOpen, setBikeOpen] = useState(false);
  // Today's (non-cancelled) bike rental, for the line under the "Rent a bike" button.
  const [todayBike, setTodayBike] = useState<BikeRentalDoc | null>(null);
  // Today's shift the volunteer tapped, awaiting "Start today's tour?" confirmation.
  const [startConfirmId, setStartConfirmId] = useState<string | null>(null);
  const [skipSheetOpen, setSkipSheetOpen] = useState(false);
  const [skipWarning, setSkipWarning] = useState<{ targetIndex: number } | null>(null);

  const [stayEditOpen, setStayEditOpen] = useState(false);
  const [stayEditForm, setStayEditForm] = useState({
    checkInDate: "",
    checkInTime: "",
    checkOutDate: "",
    checkOutTime: "",
  });
  const [stayEditBusy, setStayEditBusy] = useState(false);
  const [stayEditError, setStayEditError] = useState<string | null>(null);

  const [chatOpen, setChatOpen] = useState<"direct" | "group" | null>(null);
  const [directMessages, setDirectMessages] = useState<ChatMessage[] | null>(null);
  const [groupMessages, setGroupMessages] = useState<ChatMessage[] | null>(null);
  const [directUnread, setDirectUnread] = useState(false);
  const [groupLatest, setGroupLatest] = useState<{ ms: number; mine: boolean } | null>(null);
  const [groupSeenMs, setGroupSeenMs] = useState<number | null>(null);

  const [supplySheetOpen, setSupplySheetOpen] = useState(false);
  const [supplyForm, setSupplyForm] = useState({ item: "", note: "" });
  const [supplyBusy, setSupplyBusy] = useState(false);
  const [supplyError, setSupplyError] = useState<string | null>(null);
  const [supplySent, setSupplySent] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tourRef = useRef(tour);
  tourRef.current = tour;
  const volunteerNameRef = useRef("");
  volunteerNameRef.current = volunteer?.name ?? "";
  const logEvent = (type: TourEventType, route: FlyerRoute | null, extra?: TourEventExtra) =>
    logTourEvent(token, volunteerNameRef.current, type, route, extra);

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
          const data = d.data() as { region: string; name: string; spots: Spot[]; completionMessage?: string | null };
          return {
            id: d.id,
            region: data.region,
            name: data.name,
            spots: data.spots ?? [],
            completionMessage: data.completionMessage ?? null,
          };
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

  // ---- My shifts (planned by the admin; read-only here) ----
  const volunteerActive = volunteer?.status === "active";
  useEffect(() => {
    if (!volunteerActive) return;
    return onSnapshot(
      collection(db, "flyerVolunteers", token, "shifts"),
      (snap) => setShifts(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FlyerShift)),
      (err) => {
        console.error("[tour] shifts listener failed:", err);
        setShifts([]);
      }
    );
  }, [token, volunteerActive]);

  // ---- Today's bike rental (line under "Rent a bike") ----
  useEffect(() => {
    if (!volunteerActive) return;
    return onSnapshot(
      collection(db, "flyerVolunteers", token, "bikeRentals"),
      (snap) => {
        const today = bangkokToday();
        const mine = snap.docs
          .map((d) => parseRental(d.id, d.data()))
          .find((r) => r.kind === "rental" && r.day === today && r.status !== "cancelled");
        setTodayBike(mine ?? null);
      },
      (err) => console.error("[tour] bike rentals listener failed:", err)
    );
  }, [token, volunteerActive]);

  const todayStr = bangkokToday();
  const upcomingShifts = useMemo(
    () => (shifts ?? []).filter((s) => s.date >= todayStr).sort(compareShifts),
    [shifts, todayStr]
  );

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
          // Bangkok calendar day this progress belongs to — a tour opened on a
          // later day starts fresh (see selectRoute).
          day: bangkokToday(),
          updatedAt: serverTimestamp(),
        }
      ).catch((err) => console.error("[tour] failed to save progress:", err));
    },
    [token]
  );

  async function selectRoute(route: FlyerRoute) {
    setToursOpen(false);
    setStartConfirmId(null);
    setActiveRoute(route);
    setUploadState({});

    let next: TourState = { currentIndex: 0, statusMap: {}, skipReasons: {} };
    let resumed = false;
    try {
      const existing = await getDoc(doc(db, "flyerTourProgress", progressDocId(token, route)));
      if (existing.exists()) {
        const data = existing.data() as {
          day?: string;
          updatedAt?: Timestamp;
          currentIndex?: number;
          statusMap?: Record<string, SpotStatus>;
          skipReasons?: Record<string, string>;
        };
        // Progress only counts on the day it was made. Older docs have no `day`,
        // so fall back to their last update time.
        const savedDay =
          data.day ??
          (data.updatedAt ? new Date(data.updatedAt.toMillis() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) : null);
        if (savedDay === bangkokToday()) {
          const statusMap: Record<number, SpotStatus> = {};
          Object.entries(data.statusMap ?? {}).forEach(([k, v]) => (statusMap[Number(k)] = v));
          const skipReasons: Record<number, string> = {};
          Object.entries(data.skipReasons ?? {}).forEach(([k, v]) => (skipReasons[Number(k)] = v));
          next = { currentIndex: data.currentIndex ?? 0, statusMap, skipReasons };
          resumed = true;
        }
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
    // Only a fresh start for today counts — resuming a tour from the same day doesn't.
    if (!resumed) logEvent("tour_start", route);
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
    logEvent("tour_finished", activeRoute);
    setScreen("completion");
  }

  function goNext() {
    if (!activeRoute) return;
    const sp = activeRoute.spots[tour.currentIndex];
    const resolved = isResolvable(sp) || tour.statusMap[tour.currentIndex] !== "open";
    if (!resolved) return;
    if (isResolvable(sp)) logEvent("spot_passed", activeRoute, { spotIndex: tour.currentIndex, spot: sp });
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
    logEvent("spot_skipped", activeRoute, { spotIndex: target, spot: activeRoute.spots[target], reason });

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
        deleteAfter: proofDeleteAfter(),
      });

      logEvent("spot_completed", activeRoute, { spotIndex, spot: sp, proofStoragePath: storagePath });
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
    logEvent(nextOnBreak ? "break_start" : "break_end", screen === "tour" ? activeRoute : null);
    try {
      await updateDoc(doc(db, "flyerVolunteers", token), { onBreak: nextOnBreak });
    } catch (err) {
      console.error("[tour] failed to update break status:", err);
    }
  }

  function openStayEdit() {
    if (!volunteer) return;
    setStayEditForm({
      checkInDate: volunteer.checkInDate,
      checkInTime: volunteer.checkInTime ?? "",
      checkOutDate: volunteer.checkOutDate,
      checkOutTime: volunteer.checkOutTime ?? "",
    });
    setStayEditError(null);
    setStayEditOpen(true);
  }

  async function submitStayEdit() {
    if (!volunteer) return;
    if (!stayEditForm.checkInDate || !stayEditForm.checkOutDate) {
      setStayEditError("Please fill in both dates.");
      return;
    }
    if (stayEditForm.checkOutDate < stayEditForm.checkInDate) {
      setStayEditError("Check-out can't be before check-in.");
      return;
    }
    setStayEditBusy(true);
    setStayEditError(null);
    const pendingStayEdit: PendingStayEdit = {
      checkInDate: stayEditForm.checkInDate,
      checkInTime: stayEditForm.checkInTime || null,
      checkOutDate: stayEditForm.checkOutDate,
      checkOutTime: stayEditForm.checkOutTime || null,
    };
    try {
      await updateDoc(doc(db, "flyerVolunteers", token), {
        pendingStayEdit,
        hasPendingStayEdit: true,
      });
      setVolunteer({ ...volunteer, pendingStayEdit, hasPendingStayEdit: true });
      setStayEditOpen(false);
    } catch (err) {
      console.error("[tour] failed to submit stay edit request:", err);
      setStayEditError("Something went wrong. Please try again.");
    } finally {
      setStayEditBusy(false);
    }
  }

  async function cancelStayEdit() {
    if (!volunteer) return;
    setStayEditBusy(true);
    try {
      await updateDoc(doc(db, "flyerVolunteers", token), {
        pendingStayEdit: null,
        hasPendingStayEdit: false,
      });
      setVolunteer({ ...volunteer, pendingStayEdit: null, hasPendingStayEdit: false });
    } catch (err) {
      console.error("[tour] failed to cancel stay edit request:", err);
    } finally {
      setStayEditBusy(false);
    }
  }

  // ---- Chat ----
  useEffect(() => {
    if (chatOpen === "direct") {
      // Best-effort: the thread may not exist yet for volunteers approved
      // before chat shipped — only an admin can create it (see
      // firestore.rules), so a volunteer-side miss here is harmless.
      updateDoc(doc(db, "flyerChatThreads", token), { unreadByVolunteer: false }).catch(() => {});
      const q = query(collection(db, "flyerChatThreads", token, "messages"), orderBy("createdAt", "asc"));
      return onSnapshot(
        q,
        (snap) =>
          setDirectMessages(
            snap.docs.map((d) => {
              const data = d.data() as Omit<ChatMessage, "id">;
              return {
                id: d.id,
                senderRole: data.senderRole,
                senderName: data.senderName,
                text: data.text ?? "",
                mediaType: data.mediaType ?? null,
                mediaPath: data.mediaPath ?? null,
              };
            })
          ),
        (err) => console.error("[tour] direct chat listener failed:", err)
      );
    }
    if (chatOpen === "group") {
      const q = query(collection(db, "flyerGroupMessages"), orderBy("createdAt", "asc"));
      return onSnapshot(
        q,
        (snap) =>
          setGroupMessages(
            snap.docs.map((d) => {
              const data = d.data() as Omit<ChatMessage, "id">;
              return {
                id: d.id,
                senderRole: data.senderRole,
                senderName: data.senderName,
                text: data.text ?? "",
                mediaType: data.mediaType ?? null,
                mediaPath: data.mediaPath ?? null,
              };
            })
          ),
        (err) => console.error("[tour] group chat listener failed:", err)
      );
    }
  }, [chatOpen, token]);

  // ---- Unread markers (green dots on the chat buttons) ----
  const volunteerName = volunteer?.name ?? "";
  const groupSeenKey = `flyerGroupSeen:${token}`;

  useEffect(() => {
    if (!volunteerActive) return;
    return onSnapshot(
      doc(db, "flyerChatThreads", token),
      (snap) => setDirectUnread(snap.exists() && snap.data().unreadByVolunteer === true),
      () => {}
    );
  }, [token, volunteerActive]);

  // New admin replies while the direct chat is open count as read.
  useEffect(() => {
    if (chatOpen === "direct" && directUnread) {
      updateDoc(doc(db, "flyerChatThreads", token), { unreadByVolunteer: false }).catch(() => {});
    }
  }, [chatOpen, directUnread, token]);

  useEffect(() => {
    if (!volunteerActive) return;
    const q = query(collection(db, "flyerGroupMessages"), orderBy("createdAt", "desc"), limit(1));
    return onSnapshot(
      q,
      (snap) => {
        const d = snap.docs[0];
        if (!d) {
          setGroupLatest(null);
          return;
        }
        const data = d.data() as { senderRole?: string; senderName?: string; createdAt?: Timestamp | null };
        setGroupLatest({
          ms: data.createdAt?.toMillis() ?? Date.now(),
          mine: data.senderRole === "volunteer" && data.senderName === volunteerName,
        });
      },
      () => {}
    );
  }, [token, volunteerActive, volunteerName]);

  useEffect(() => {
    setGroupSeenMs(readSeen(groupSeenKey));
  }, [groupSeenKey]);

  // First visit on this device (or the group chat is open): everything so far counts as seen.
  useEffect(() => {
    if (groupLatest && (groupSeenMs === null || chatOpen === "group")) {
      writeSeen(groupSeenKey, groupLatest.ms);
      setGroupSeenMs(groupLatest.ms);
    }
  }, [groupLatest, groupSeenMs, chatOpen, groupSeenKey]);

  const groupUnread = !!groupLatest && !groupLatest.mine && groupSeenMs !== null && groupLatest.ms > groupSeenMs;

  // Throws on failure — ChatComposer shows the error.
  async function postChat(text: string, mediaType: ChatMediaType | null, mediaPath: string | null) {
    if (!volunteer) return;
    const preview = messagePreview(text, mediaType);
    if (chatOpen === "direct") {
      await addDoc(collection(db, "flyerChatThreads", token, "messages"), {
        senderRole: "volunteer",
        senderName: volunteer.name,
        text,
        mediaType,
        mediaPath,
        createdAt: serverTimestamp(),
      });
      // Thread doc may not exist for legacy volunteers — ignore if so,
      // the message itself still went through.
      await updateDoc(doc(db, "flyerChatThreads", token), {
        lastMessage: preview,
        lastMessageAt: serverTimestamp(),
        lastSenderRole: "volunteer",
        unreadByAdmin: true,
        unreadByVolunteer: false,
      }).catch(() => {});
    } else if (chatOpen === "group") {
      await addDoc(collection(db, "flyerGroupMessages"), {
        senderRole: "volunteer",
        senderName: volunteer.name,
        text,
        mediaType,
        mediaPath,
        createdAt: serverTimestamp(),
      });
    }
  }

  async function sendChatText(text: string) {
    await postChat(text, null, null);
  }

  async function sendChatMedia(media: PreparedMedia) {
    const folder = chatOpen === "group" ? `group/${token}` : token;
    const path = await uploadChatMedia(folder, media);
    await postChat("", media.type, path);
  }

  // ---- Supply reports ----
  function openSupplySheet() {
    setSupplyForm({ item: "", note: "" });
    setSupplyError(null);
    setSupplySent(false);
    setSupplySheetOpen(true);
  }

  async function submitSupplyReport() {
    if (!volunteer) return;
    const item = supplyForm.item.trim();
    if (!item) {
      setSupplyError("Please say what's missing.");
      return;
    }
    setSupplyBusy(true);
    setSupplyError(null);
    try {
      await addDoc(collection(db, "flyerSupplyReports"), {
        volunteerId: token,
        volunteerName: volunteer.name,
        item,
        note: supplyForm.note.trim() || null,
        status: "open",
        createdAt: serverTimestamp(),
      });
      setSupplySent(true);
    } catch (err) {
      console.error("[tour] failed to submit supply report:", err);
      setSupplyError("Something went wrong. Please try again.");
    } finally {
      setSupplyBusy(false);
    }
  }

  /* ===================== Screens ===================== */

  const chatSheet = chatOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => setChatOpen(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl"
            >
              <div className="p-6 pb-4">
                <h2 className="text-lg font-semibold">{chatOpen === "direct" ? "Message OXA" : "Group Chat"}</h2>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto px-6">
                {(() => {
                  const list = chatOpen === "direct" ? directMessages : groupMessages;
                  if (list === null) return <p className="text-sm text-[#5C5850]">Loading…</p>;
                  if (list.length === 0) return <p className="text-sm text-[#5C5850]">No messages yet.</p>;
                  return list.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                        m.senderRole === "volunteer" ? "ml-auto bg-[#201E1B] text-white" : "bg-[#FBF9F4] text-[#201E1B]"
                      }`}
                    >
                      {chatOpen === "group" && m.senderRole !== "volunteer" && (
                        <div className="mb-0.5 text-xs font-semibold text-[#8A857A]">OXA Team</div>
                      )}
                      {chatOpen === "group" && m.senderRole === "volunteer" && (
                        <div className="mb-0.5 text-xs font-semibold text-white/70">{m.senderName}</div>
                      )}
                      <ChatMessageBody text={m.text} mediaType={m.mediaType} mediaPath={m.mediaPath} />
                    </div>
                  ));
                })()}
              </div>

              <div className="p-6 pt-4">
                <ChatComposer inputClassName={fieldInput} onSendText={sendChatText} onSendMedia={sendChatMedia} />
              </div>
            </div>
          </div>) : null;

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

  if (screen === "shifts") {
    const todays = upcomingShifts.filter((s) => s.date === todayStr);
    const later = upcomingShifts.filter((s) => s.date > todayStr);
    return (
      <Shell>
        <button type="button" onClick={() => setScreen("picker")} className="mb-4 text-sm font-semibold underline">
          ← Back
        </button>
        <h1 className="mb-6 text-2xl font-semibold">My shifts</h1>

        {shifts === null && <p className="text-[#5C5850]">Loading…</p>}
        {shifts !== null && upcomingShifts.length === 0 && (
          <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
            No shifts planned yet. OXA will add them here.
          </div>
        )}

        {todays.length > 0 && (
          <div className="mb-6 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Today · {dayLabel(todayStr)}</p>
            {todays.map((s) => {
              const label = tourLabel(s);
              const route = s.tourId ? routes?.find((r) => r.id === s.tourId) ?? null : null;
              const confirming = startConfirmId === s.id;
              const body = (
                <>
                  <p className="text-2xl font-semibold">
                    {s.startTime}–{s.endTime}
                  </p>
                  <p className="mt-1 text-base font-medium">{label ?? "No tour planned"}</p>
                  {s.note && <p className="mt-2 text-sm text-[#44403A]">{s.note}</p>}
                  {route && !confirming && (
                    <p className="mt-2 text-sm font-semibold text-[#5C5850]">Tap to start today&apos;s tour →</p>
                  )}
                </>
              );
              if (!route) {
                return (
                  <div key={s.id} className="rounded-2xl border border-[#E2C27A] bg-[#FFF3D6] p-4">
                    {body}
                  </div>
                );
              }
              return (
                <div key={s.id} className="rounded-2xl border border-[#E2C27A] bg-[#FFF3D6]">
                  <button
                    type="button"
                    onClick={() => setStartConfirmId(confirming ? null : s.id)}
                    className="block w-full rounded-2xl p-4 text-left"
                  >
                    {body}
                  </button>
                  {confirming && (
                    <div className="border-t border-[#E2C27A] p-4">
                      <p className="mb-3 text-base font-semibold">Start today&apos;s tour?</p>
                      <div className="flex gap-3">
                        <button type="button" onClick={() => setStartConfirmId(null)} className={secondaryButton}>
                          Not now
                        </button>
                        <button type="button" onClick={() => selectRoute(route)} className={primaryButton}>
                          Start tour
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {later.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Upcoming</p>
            {later.map((s) => {
              const label = tourLabel(s);
              return (
                <div key={s.id} className={`${cardClass} p-4`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold">{dayLabel(s.date)}</span>
                    <span className="text-sm font-semibold">
                      {s.startTime}–{s.endTime}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[#5C5850]">{label ?? "Tour to be announced"}</p>
                  {s.note && <p className="mt-2 text-sm text-[#44403A]">{s.note}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Shell>
    );
  }

  if (screen === "picker") {
    return (
      <Shell>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Where to next?</h1>
          {volunteer && <p className="text-sm text-[#5C5850]">Hi {volunteer.name} 👋</p>}
        </div>

        {volunteer && (
          <div className={`${cardClass} mb-6 p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">My stay</p>
                <p className="text-sm">
                  {volunteer.checkInDate} → {volunteer.checkOutDate}
                </p>
              </div>
              {!volunteer.hasPendingStayEdit && (
                <button type="button" onClick={openStayEdit} className="shrink-0 text-sm font-semibold underline">
                  Request change
                </button>
              )}
            </div>
            {volunteer.hasPendingStayEdit && volunteer.pendingStayEdit && (
              <div className="mt-3 rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-3 text-sm">
                <p className="mb-2">
                  ⏳ Requested: {volunteer.pendingStayEdit.checkInDate} → {volunteer.pendingStayEdit.checkOutDate}.
                  Waiting for OXA to approve.
                </p>
                <button type="button" onClick={cancelStayEdit} disabled={stayEditBusy} className="font-semibold underline disabled:opacity-40">
                  {stayEditBusy ? "Cancelling…" : "Cancel request"}
                </button>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setScreen("shifts")}
          className={`${cardClass} mb-6 block w-full p-4 text-left active:bg-[#FBF9F4]`}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">📅 My shifts</p>
          <p className="mt-1 font-semibold">
            {shifts === null
              ? "Loading…"
              : upcomingShifts.length === 0
                ? "No shifts planned yet"
                : `${upcomingShifts[0].date === todayStr ? "Today" : dayLabel(upcomingShifts[0].date)} · ${upcomingShifts[0].startTime}–${upcomingShifts[0].endTime}${
                    tourLabel(upcomingShifts[0]) ? ` · ${tourLabel(upcomingShifts[0])}` : ""
                  }`}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setToursOpen(true)}
          className={`${cardClass} mb-6 block w-full p-4 text-left active:bg-[#FBF9F4]`}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">🛵 Flyer Tours</p>
          <p className="mt-1 font-semibold">
            {routes === null
              ? "Loading…"
              : regions.length === 0
                ? "No routes set up yet"
                : `${regions.length} area${regions.length === 1 ? "" : "s"} · ${routes.length} tours`}
          </p>
        </button>

        <div className="mb-3 flex gap-3">
          <button
            type="button"
            onClick={() => setChatOpen("direct")}
            className={`${cardClass} relative flex-1 p-4 text-left font-semibold active:bg-[#FBF9F4]`}
          >
            {directUnread && (
              <span
                role="img"
                aria-label="New message"
                className="absolute left-2 top-2 h-3 w-3 rounded-full bg-green-500 ring-2 ring-white"
              />
            )}
            💬 Message OXA
          </button>
          <button
            type="button"
            onClick={() => setChatOpen("group")}
            className={`${cardClass} relative flex-1 p-4 text-left font-semibold active:bg-[#FBF9F4]`}
          >
            {groupUnread && (
              <span
                role="img"
                aria-label="New messages"
                className="absolute left-2 top-2 h-3 w-3 rounded-full bg-green-500 ring-2 ring-white"
              />
            )}
            👥 Group Chat
          </button>
        </div>

        <div className="mb-6 flex gap-3">
          <button
            type="button"
            onClick={openSupplySheet}
            className={`${cardClass} relative flex-1 p-4 text-left font-semibold active:bg-[#FBF9F4]`}
          >
            📦 Report missing supplies
          </button>
          <button
            type="button"
            onClick={() => setBikeOpen(true)}
            className={`relative flex-1 p-4 text-left font-semibold active:bg-[#FBF9F4] ${
              todayBike ? "rounded-2xl border-2 border-[#BDB6A2] bg-[#E9E4D6]" : cardClass
            }`}
          >
            🏍️ Rent a bike
            {todayBike && (
              <span className="mt-1 block text-[13px] font-medium text-[#96742A]">
                Today: {bikeLabel(todayBike.bike)} · {todayBike.status}
              </span>
            )}
          </button>
        </div>

        {toursOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => setToursOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl"
            >
              <h2 className="mb-4 text-lg font-semibold">Flyer Tours</h2>
              {regions.length === 0 && (
                <p className="text-sm text-[#5C5850]">No routes have been set up yet. Check back soon.</p>
              )}
              <div className="space-y-5">
                {regions.map(([region, list]) => (
                  <div key={region}>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">{region}</p>
                    <div className="space-y-3">
                      {list.map((route) => (
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
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setToursOpen(false)} className={`${secondaryButton} mt-4`}>
                Close
              </button>
            </div>
          </div>
        )}

        {bikeOpen && volunteer && (
          <BikeRental
            token={token}
            volunteerName={volunteer.name}
            checkOutDate={volunteer.checkOutDate}
            onClose={() => setBikeOpen(false)}
          />
        )}

        {stayEditOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => !stayEditBusy && setStayEditOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl"
            >
              <h2 className="mb-4 text-lg font-semibold">Request a stay change</h2>
              <div className="space-y-4">
                <div>
                  <label htmlFor="stayCheckInDate" className={fieldLabel}>
                    Check-in date
                  </label>
                  <input
                    id="stayCheckInDate"
                    type="date"
                    value={stayEditForm.checkInDate}
                    onChange={(e) => setStayEditForm((f) => ({ ...f, checkInDate: e.target.value }))}
                    className={fieldInput}
                  />
                </div>
                <div>
                  <label htmlFor="stayCheckInTime" className={fieldLabel}>
                    Check-in time <span className="font-normal text-[#8A857A]">(optional)</span>
                  </label>
                  <input
                    id="stayCheckInTime"
                    type="time"
                    value={stayEditForm.checkInTime}
                    onChange={(e) => setStayEditForm((f) => ({ ...f, checkInTime: e.target.value }))}
                    className={fieldInput}
                  />
                </div>
                <div>
                  <label htmlFor="stayCheckOutDate" className={fieldLabel}>
                    Check-out date
                  </label>
                  <input
                    id="stayCheckOutDate"
                    type="date"
                    min={stayEditForm.checkInDate || undefined}
                    value={stayEditForm.checkOutDate}
                    onChange={(e) => setStayEditForm((f) => ({ ...f, checkOutDate: e.target.value }))}
                    className={fieldInput}
                  />
                </div>
                <div>
                  <label htmlFor="stayCheckOutTime" className={fieldLabel}>
                    Check-out time <span className="font-normal text-[#8A857A]">(optional)</span>
                  </label>
                  <input
                    id="stayCheckOutTime"
                    type="time"
                    value={stayEditForm.checkOutTime}
                    onChange={(e) => setStayEditForm((f) => ({ ...f, checkOutTime: e.target.value }))}
                    className={fieldInput}
                  />
                </div>
              </div>

              {stayEditError && (
                <div role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                  {stayEditError}
                </div>
              )}

              <div className="mt-5 space-y-3">
                <button type="button" onClick={submitStayEdit} disabled={stayEditBusy} className={primaryButton}>
                  {stayEditBusy ? "Sending…" : "Send request"}
                </button>
                <button
                  type="button"
                  onClick={() => setStayEditOpen(false)}
                  disabled={stayEditBusy}
                  className={secondaryButton}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {chatSheet}

        {supplySheetOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => !supplyBusy && setSupplySheetOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl"
            >
              {supplySent ? (
                <>
                  <h2 className="mb-2 text-lg font-semibold">Thanks! 🙌</h2>
                  <p className="mb-5 text-sm text-[#5C5850]">
                    We&apos;ve let the OXA team know what&apos;s missing.
                  </p>
                  <button type="button" onClick={() => setSupplySheetOpen(false)} className={primaryButton}>
                    Done
                  </button>
                </>
              ) : (
                <>
                  <h2 className="mb-4 text-lg font-semibold">Report missing supplies</h2>
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="supplyItem" className={fieldLabel}>
                        What&apos;s missing?
                      </label>
                      <input
                        id="supplyItem"
                        type="text"
                        value={supplyForm.item}
                        onChange={(e) => setSupplyForm((f) => ({ ...f, item: e.target.value }))}
                        placeholder="e.g. Flyers, scooter helmet…"
                        className={fieldInput}
                      />
                    </div>
                    <div>
                      <label htmlFor="supplyNote" className={fieldLabel}>
                        Note <span className="font-normal text-[#8A857A]">(optional)</span>
                      </label>
                      <input
                        id="supplyNote"
                        type="text"
                        value={supplyForm.note}
                        onChange={(e) => setSupplyForm((f) => ({ ...f, note: e.target.value }))}
                        placeholder="Any extra details"
                        className={fieldInput}
                      />
                    </div>
                  </div>

                  {supplyError && (
                    <div role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                      {supplyError}
                    </div>
                  )}

                  <div className="mt-5 space-y-3">
                    <button type="button" onClick={submitSupplyReport} disabled={supplyBusy} className={primaryButton}>
                      {supplyBusy ? "Sending…" : "Send report"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSupplySheetOpen(false)}
                      disabled={supplyBusy}
                      className={secondaryButton}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
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
            <p className="mb-6 whitespace-pre-line text-base text-[#5C5850]">
              {activeRoute.completionMessage?.trim() || "Thank you for flyering today 🙌"}
            </p>
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
                    onNext={goNext}
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
              onClick={() => setChatOpen("direct")}
              className="relative flex-1 rounded-2xl border border-[#E2DFD6] bg-white px-4 py-3 text-base font-semibold text-[#201E1B]"
            >
              {directUnread && (
                <span
                  role="img"
                  aria-label="New message"
                  className="absolute left-2 top-2 h-3 w-3 rounded-full bg-green-500 ring-2 ring-white"
                />
              )}
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

        {chatSheet}

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
  onNext,
}: {
  index: number;
  spot: Spot;
  isLast: boolean;
  status: SpotStatus;
  uploadState: "uploading" | "success" | "failure" | undefined;
  onCamera: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const resolvable = isResolvable(spot);

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
      <div className="mb-2 inline-block rounded-full bg-[#E9E4D8] px-4 py-1.5 text-base font-normal">{spot.time}</div>
      <h2 className="mb-3 text-lg font-semibold">
        {index + 1}. {spot.name}
      </h2>
      {spot.mapsLink && (
        <a
          href={spot.mapsLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 block w-full rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-center text-base font-semibold"
        >
          📍 Google Maps Location
        </a>
      )}
      {spot.comment && (
        <div className="mb-4 whitespace-pre-line rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-4 text-base font-semibold leading-relaxed">
          {spot.comment}
        </div>
      )}

      {!resolvable && (
        <div className="flex gap-3">
          {uploadState === "uploading" ? (
            <button type="button" disabled className="flex-1 rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] px-3 py-4 text-base font-semibold opacity-70">
              ⌛ Uploading…
            </button>
          ) : uploadState === "success" || status === "completed" ? (
            <button type="button" disabled className="flex-1 rounded-xl border-2 border-[#3E8E5A] bg-[#EAF5EE] px-3 py-4 text-base font-semibold text-[#3E8E5A]">
              ✅ Picture Uploaded
            </button>
          ) : uploadState === "failure" ? (
            <button type="button" onClick={onCamera} className="flex-1 rounded-xl border-2 border-[#C0392B] bg-[#F7E9E7] px-3 py-4 text-base font-semibold text-[#C0392B]">
              ❌ Failed. Try Again
            </button>
          ) : (
            <button type="button" onClick={onCamera} className="flex-1 rounded-xl border-2 border-[#D6D1C3] bg-[#FBF9F4] px-3 py-4 text-base font-semibold">
              📸 Take a Picture
            </button>
          )}
          {status !== "completed" && uploadState !== "uploading" && uploadState !== "success" && (
            <button type="button" onClick={onSkip} className="flex-1 rounded-xl border-2 border-[#D6D1C3] bg-white px-3 py-4 text-base font-semibold text-[#5C5850]">
              ⏭️ Skip Spot
            </button>
          )}
        </div>
      )}

      {/* Photo and skip advance on their own; break / info spots have neither, so they need this. */}
      {resolvable && (
        <button type="button" onClick={onNext} className="w-full rounded-xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white">
          {isLast ? "Finish Route" : "Next →"}
        </button>
      )}
    </div>
  );
}
