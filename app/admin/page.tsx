"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { auth, db, googleProvider, storage } from "@/lib/firebase";
import { FLYER_MANAGEMENT_EMAILS } from "@/lib/constants";
import { generateToken } from "@/lib/token";

type Registration = {
  id: string;
  name: string;
  checkInDate: string;
  checkInTime: string | null;
  checkOutDate: string;
  checkOutTime: string | null;
  passportPhotoPath: string;
  depositAcknowledged: boolean;
  submittedAt: Timestamp | null;
};

type SpotType = "NORMAL" | "BREAK" | "SCOOTER_INFO";

type RouteSpot = {
  name: string;
  type: SpotType;
  time: string;
  comment: string;
  mapsLink: string | null;
};

type EditorSpot = RouteSpot & { _k: number };

type FlyerRouteDoc = {
  id: string;
  region: string;
  name: string;
  spots: RouteSpot[];
  duplicatedFrom?: string | null;
};

type PendingStayEdit = {
  checkInDate: string;
  checkInTime: string | null;
  checkOutDate: string;
  checkOutTime: string | null;
};

type FlyerVolunteerDoc = {
  id: string; // token
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

type ChatSenderRole = "volunteer" | "admin";

type ChatMessageDoc = {
  id: string;
  senderRole: ChatSenderRole;
  senderName: string;
  text: string;
  createdAt: Timestamp | null;
};

type SupplyReportStatus = "open" | "resolved";

type SupplyReportDoc = {
  id: string;
  volunteerId: string;
  volunteerName: string;
  item: string;
  note: string | null;
  status: SupplyReportStatus;
  createdAt: Timestamp | null;
};

const SPOT_TYPE_LABELS: Record<SpotType, string> = {
  NORMAL: "Normal",
  BREAK: "Break",
  SCOOTER_INFO: "Scooter Info",
};

function blankSpot(): RouteSpot {
  return { name: "", type: "NORMAL", time: "", comment: "", mapsLink: null };
}

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const primaryButton =
  "w-full rounded-2xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white disabled:opacity-40";
const secondaryButton =
  "w-full rounded-2xl border border-[#E2DFD6] bg-white px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

function formatDateTime(date: string, time: string | null) {
  return time ? `${date} ${time}` : date;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function timeAgo(ts: Timestamp | null): string {
  // submittedAt is a serverTimestamp — null for a moment on a local
  // pending write, never for docs written by other clients.
  if (!ts) return "just now";
  const seconds = Math.round((ts.toMillis() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** 7 days after the check-out date, at local midnight. */
function passportDeleteAfter(checkOutDate: string): Timestamp {
  const [y, m, d] = checkOutDate.split("-").map(Number);
  return Timestamp.fromDate(new Date(y, m - 1, d + 7));
}

export default function AdminPage() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [hasClaim, setHasClaim] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);
      setHasClaim(null);
      if (!firebaseUser) return;
      try {
        // forceRefresh so a newly granted/revoked flyerAdmin claim takes
        // effect immediately (same as oxa-poster-tour's auth-context).
        const tokenResult = await firebaseUser.getIdTokenResult(true);
        setHasClaim(tokenResult.claims.flyerAdmin === true);
      } catch (err) {
        console.error("[admin] getIdTokenResult failed:", err);
        await signOut(auth);
      }
    });
  }, []);

  async function signIn() {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("[admin] signInWithPopup failed:", err);
      setAuthError((err as { code?: string })?.code ?? "unknown");
    }
  }

  // Mirrors isFlyerAdmin() in firestore.rules / storage.rules: flyerAdmin
  // claim OR one of the bootstrap management emails. The email check
  // resolves immediately; the claim only matters for non-allowlisted users.
  const email = user?.email?.toLowerCase() ?? null;
  const isAllowlisted = !!email && FLYER_MANAGEMENT_EMAILS.includes(email);
  const isAuthorized: boolean | null = !user ? false : isAllowlisted || hasClaim;

  if (authLoading || (user && isAuthorized === null)) {
    return (
      <Shell>
        <p className="pt-20 text-center text-[#5C5850]">Loading…</p>
      </Shell>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center bg-[#EFEDE7] px-4 text-[#201E1B]">
        <div className="w-full max-w-xs text-center">
          <h1 className="mb-6 text-2xl font-semibold">OXA Flyer Admin</h1>
          <button type="button" onClick={signIn} className={primaryButton}>
            Sign in with Google
          </button>
          {authError && <p className="mt-3 text-sm text-red-700">Sign-in failed ({authError}).</p>}
        </div>
      </main>
    );
  }

  if (!isAuthorized) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center bg-[#EFEDE7] px-4 text-[#201E1B]">
        <div className="w-full max-w-xs text-center">
          <p className="mb-2 text-lg font-medium">You&apos;re not authorized to view this page.</p>
          <p className="mb-6 text-sm text-[#5C5850]">Signed in as {user.email}</p>
          <button type="button" onClick={() => signOut(auth)} className={secondaryButton}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return <Dashboard adminEmail={user.email ?? user.uid} />;
}

function Dashboard({ adminEmail }: { adminEmail: string }) {
  const [tab, setTab] = useState<"registrations" | "routes" | "crew" | "group-chat" | "supplies">("registrations");

  const tabs: { key: typeof tab; label: string }[] = [
    { key: "registrations", label: "Registrations" },
    { key: "routes", label: "Routes" },
    { key: "crew", label: "Crew" },
    { key: "group-chat", label: "Group Chat" },
    { key: "supplies", label: "Supplies" },
  ];

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2 rounded-full bg-[#E2DFD6] p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                tab === t.key ? "bg-white text-[#201E1B]" : "text-[#5C5850]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => signOut(auth)} className="pt-2 text-sm text-[#5C5850] underline">
          Sign out
        </button>
      </div>

      {tab === "registrations" && <RegistrationsSection adminEmail={adminEmail} />}
      {tab === "routes" && <RoutesSection />}
      {tab === "crew" && <CrewSection adminEmail={adminEmail} />}
      {tab === "group-chat" && <GroupChatSection adminEmail={adminEmail} />}
      {tab === "supplies" && <SupplyReportsSection />}
    </Shell>
  );
}

function RegistrationsSection({ adminEmail }: { adminEmail: string }) {
  const [registrations, setRegistrations] = useState<Registration[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approvedLink, setApprovedLink] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    // Sorted client-side rather than orderBy("submittedAt") — status ==
    // + orderBy on another field would need a composite index.
    const q = query(collection(db, "flyerRegistrations"), where("status", "==", "pending"));
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Registration);
        rows.sort((a, b) => (b.submittedAt?.toMillis() ?? Infinity) - (a.submittedAt?.toMillis() ?? Infinity));
        setRegistrations(rows);
        setListError(null);
      },
      (err) => {
        console.error("[admin] registrations listener failed:", err);
        setListError(err.code === "permission-denied" ? "Permission denied loading registrations." : err.message);
      }
    );
  }, []);

  if (approvedLink) {
    return <ApprovedScreen {...approvedLink} onDone={() => setApprovedLink(null)} />;
  }

  const selected = registrations?.find((r) => r.id === selectedId) ?? null;
  if (selected) {
    return (
      <RegistrationDetail
        registration={selected}
        adminEmail={adminEmail}
        onBack={() => setSelectedId(null)}
        onApproved={(url) => {
          setSelectedId(null);
          setApprovedLink({ name: selected.name, url });
        }}
      />
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-[#5C5850]">Pending review</p>

      {listError && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {listError}
        </div>
      )}

      {registrations === null && !listError && <p className="text-[#5C5850]">Loading…</p>}
      {registrations?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No pending registrations.</div>
      )}

      <ul className="space-y-3">
        {registrations?.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setSelectedId(r.id)}
              className={`${cardClass} block w-full p-4 text-left active:bg-[#FBF9F4]`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-base font-semibold">{r.name}</span>
                <span className="shrink-0 text-xs text-[#8A857A]">{timeAgo(r.submittedAt)}</span>
              </div>
              <div className="mt-1 text-sm text-[#5C5850]">
                {r.checkInDate} → {r.checkOutDate}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function RegistrationDetail({
  registration: r,
  adminEmail,
  onBack,
  onApproved,
}: {
  registration: Registration;
  adminEmail: string;
  onBack: () => void;
  onApproved: (url: string) => void;
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDownloadURL(ref(storage, r.passportPhotoPath))
      .then((url) => !cancelled && setPhotoUrl(url))
      .catch((err) => {
        console.error("[admin] passport photo load failed:", err);
        if (!cancelled) setPhotoError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [r.passportPhotoPath]);

  async function approve() {
    setBusy("approve");
    setError(null);
    const token = generateToken();
    try {
      // One batch so the volunteer doc and the registration status can
      // never get out of sync (e.g. volunteer created but still "pending").
      const batch = writeBatch(db);
      batch.set(doc(db, "flyerVolunteers", token), {
        name: r.name,
        checkInDate: r.checkInDate,
        checkInTime: r.checkInTime ?? null,
        checkOutDate: r.checkOutDate,
        checkOutTime: r.checkOutTime ?? null,
        passportPhotoPath: r.passportPhotoPath,
        passportDeleteAfter: passportDeleteAfter(r.checkOutDate),
        status: "active",
        hasPendingStayEdit: false,
        pendingStayEdit: null,
        onBreak: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      // Chat thread for this volunteer, created up front since
      // flyerChatThreads create is admin-only in the rules — the volunteer
      // can only update it (unread flags), never create it.
      batch.set(doc(db, "flyerChatThreads", token), {
        volunteerId: token,
        volunteerName: r.name,
        lastMessage: null,
        lastMessageAt: null,
        lastSenderRole: null,
        unreadByAdmin: false,
        unreadByVolunteer: false,
        createdAt: serverTimestamp(),
      });
      batch.update(doc(db, "flyerRegistrations", r.id), {
        status: "approved",
        reviewedAt: serverTimestamp(),
        reviewedBy: adminEmail,
      });
      await batch.commit();
      onApproved(`${window.location.origin}/v/${token}`);
    } catch (err) {
      console.error("[admin] approve failed:", err);
      setError("Approving failed. Nothing was saved — please try again.");
      setBusy(null);
    }
  }

  async function reject() {
    if (!confirmReject) {
      setConfirmReject(true);
      return;
    }
    setBusy("reject");
    setError(null);
    try {
      await updateDoc(doc(db, "flyerRegistrations", r.id), {
        status: "rejected",
        reviewedAt: serverTimestamp(),
        reviewedBy: adminEmail,
      });
      onBack();
    } catch (err) {
      console.error("[admin] reject failed:", err);
      setError("Rejecting failed. Please try again.");
      setBusy(null);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-[#5C5850] underline">
        ← Back to list
      </button>

      <div className={`${cardClass} mb-5 overflow-hidden`}>
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt={`Passport of ${r.name}`} className="block w-full" />
        ) : (
          <div className="flex h-48 items-center justify-center bg-[#FBF9F4] text-sm text-[#8A857A]">
            {photoError ? "Passport photo could not be loaded." : "Loading photo…"}
          </div>
        )}
      </div>

      <div className={`${cardClass} mb-5 divide-y divide-[#E2DFD6]`}>
        <Row label="Name" value={r.name} />
        <Row label="Check-in" value={formatDateTime(r.checkInDate, r.checkInTime)} />
        <Row label="Check-out" value={formatDateTime(r.checkOutDate, r.checkOutTime)} />
        <Row label="Deposit acknowledged" value={r.depositAcknowledged ? "✓ Yes" : "✗ No"} />
        <Row label="Submitted" value={timeAgo(r.submittedAt)} />
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <button type="button" onClick={approve} disabled={busy !== null} className={primaryButton}>
          {busy === "approve" ? "Approving…" : "Approve & Generate Link"}
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={busy !== null}
          className={
            confirmReject
              ? "w-full rounded-2xl border border-red-600 bg-red-50 px-4 py-4 text-base font-semibold text-red-800 disabled:opacity-40"
              : secondaryButton
          }
        >
          {busy === "reject" ? "Rejecting…" : confirmReject ? "Tap again to confirm reject" : "Reject"}
        </button>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-3 text-base">
      <span className="text-[#5C5850]">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function ApprovedScreen({ name, url, onDone }: { name: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // navigator.clipboard is unavailable on insecure origins (e.g.
      // http://<LAN-IP>:3000) — fall back to the legacy copy command.
      const input = document.createElement("textarea");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const message = `Hi ${name}! Your OXA Flyer Tours registration is approved 🎉 Here's your personal link: ${url}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;

  return (
    <>
      <div className="mb-5 rounded-2xl border border-green-600 bg-green-50 p-5 text-green-800">
        <h1 className="mb-1 text-xl font-semibold">✓ {name} approved</h1>
        <p className="text-sm">Send them their personal Flyer Tours link:</p>
      </div>

      <div className={`${cardClass} mb-5 break-all p-4 font-mono text-sm`}>{url}</div>

      <div className="space-y-3">
        <button type="button" onClick={copy} className={primaryButton}>
          {copied ? "✓ Copied" : "Copy Link"}
        </button>
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-2xl bg-[#25D366] px-4 py-4 text-center text-base font-semibold text-white"
        >
          Send via WhatsApp
        </a>
        <button type="button" onClick={onDone} className={secondaryButton}>
          Back to registrations
        </button>
      </div>
    </>
  );
}

/* ===================== Routes (Route Builder) ===================== */

function RoutesSection() {
  const [routes, setRoutes] = useState<FlyerRouteDoc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // null = showing the list, "new" = creating, otherwise the route id being edited.
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerRoutes"),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FlyerRouteDoc);
        rows.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
        setRoutes(rows);
        setListError(null);
      },
      (err) => {
        console.error("[admin] routes listener failed:", err);
        setListError(err.code === "permission-denied" ? "Permission denied loading routes." : err.message);
      }
    );
  }, []);

  if (editingId !== null) {
    const existing = editingId === "new" ? null : (routes?.find((r) => r.id === editingId) ?? null);
    return (
      <RouteEditor
        route={existing}
        knownRegions={Array.from(new Set((routes ?? []).map((r) => r.region))).sort()}
        onBack={() => setEditingId(null)}
      />
    );
  }

  const grouped = new Map<string, FlyerRouteDoc[]>();
  for (const r of routes ?? []) {
    const list = grouped.get(r.region) ?? [];
    list.push(r);
    grouped.set(r.region, list);
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-[#5C5850]">Flyering tours, grouped by region</p>
        <button
          type="button"
          onClick={() => setEditingId("new")}
          className="shrink-0 rounded-full bg-[#201E1B] px-4 py-2 text-sm font-semibold text-white"
        >
          + New Route
        </button>
      </div>

      {listError && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {listError}
        </div>
      )}

      {routes === null && !listError && <p className="text-[#5C5850]">Loading…</p>}
      {routes?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No routes yet. Create the first one.</div>
      )}

      <div className="space-y-5">
        {Array.from(grouped.entries()).map(([region, regionRoutes]) => (
          <div key={region}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[#8A857A]">{region}</h2>
            <ul className="space-y-3">
              {regionRoutes.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setEditingId(r.id)}
                    className={`${cardClass} block w-full p-4 text-left active:bg-[#FBF9F4]`}
                  >
                    <span className="block text-base font-semibold">{r.name}</span>
                    <span className="mt-1 block text-sm text-[#5C5850]">
                      {r.spots?.length ?? 0} spot{(r.spots?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

const spotTextInput =
  "block w-full rounded-lg border border-[#E2DFD6] bg-white px-3 py-2 text-sm text-[#201E1B] focus:border-[#201E1B] focus:outline-none";

function RouteEditor({
  route,
  knownRegions,
  onBack,
}: {
  route: FlyerRouteDoc | null;
  knownRegions: string[];
  onBack: () => void;
}) {
  const [region, setRegion] = useState(route?.region ?? "");
  const [name, setName] = useState(route?.name ?? "");
  // Each spot gets a stable client-side key (_k) so a moved card keeps its
  // identity (and we can scroll to it). Stripped again in cleanedSpots().
  const keyCounter = useRef(0);
  const withKey = (sp: RouteSpot): EditorSpot => ({
    ...sp,
    // Imported routes may have comment: null (and older docs may lack fields).
    comment: sp.comment ?? "",
    time: sp.time ?? "",
    _k: keyCounter.current++,
  });
  const [spots, setSpots] = useState<EditorSpot[]>(() =>
    (route?.spots?.length ? route.spots : [blankSpot()]).map(withKey)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // After a move, keep the moved card at the same spot on screen so repeated
  // taps keep moving the same entry instead of whatever slid under the finger.
  const pendingScroll = useRef<{ k: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const p = pendingScroll.current;
    if (!p) return;
    pendingScroll.current = null;
    const el = document.getElementById(`spot-card-${p.k}`);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - p.top);
  }, [spots]);

  function updateSpot(i: number, patch: Partial<RouteSpot>) {
    setSpots((prev) => prev.map((sp, idx) => (idx === i ? { ...sp, ...patch } : sp)));
  }

  function removeSpot(i: number) {
    setSpots((prev) => prev.filter((_, idx) => idx !== i));
  }

  function moveSpotTo(i: number, target: number) {
    if (target < 0 || target >= spots.length || target === i) return;
    const k = spots[i]._k;
    const el = document.getElementById(`spot-card-${k}`);
    if (el) pendingScroll.current = { k, top: el.getBoundingClientRect().top };
    setSpots((prev) => {
      const next = [...prev];
      const [item] = next.splice(i, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  function moveSpot(i: number, dir: -1 | 1) {
    moveSpotTo(i, i + dir);
  }

  function validate(): string | null {
    if (!region.trim()) return "Region is required.";
    if (!name.trim()) return "Route name is required.";
    if (spots.length === 0) return "Add at least one spot.";
    if (spots.some((sp) => !sp.name.trim())) return "Every spot needs a name.";
    return null;
  }

  function cleanedSpots(): RouteSpot[] {
    return spots.map((sp) => ({
      name: sp.name.trim(),
      type: sp.type,
      time: (sp.time ?? "").trim(),
      comment: (sp.comment ?? "").trim(),
      mapsLink: sp.mapsLink?.trim() || null,
    }));
  }

  async function save() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (route) {
        await updateDoc(doc(db, "flyerRoutes", route.id), {
          region: region.trim(),
          name: name.trim(),
          spots: cleanedSpots(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "flyerRoutes"), {
          region: region.trim(),
          name: name.trim(),
          spots: cleanedSpots(),
          duplicatedFrom: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      onBack();
    } catch (err) {
      console.error("[admin] route save failed:", err);
      setError("Saving failed. Please try again.");
      setSaving(false);
    }
  }

  async function duplicate() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addDoc(collection(db, "flyerRoutes"), {
        region: region.trim(),
        name: `${name.trim()} (Copy)`,
        spots: cleanedSpots(),
        duplicatedFrom: route?.id ?? null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onBack();
    } catch (err) {
      console.error("[admin] route duplicate failed:", err);
      setError("Duplicating failed. Please try again.");
      setSaving(false);
    }
  }

  async function remove() {
    if (!route) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteDoc(doc(db, "flyerRoutes", route.id));
      onBack();
    } catch (err) {
      console.error("[admin] route delete failed:", err);
      setError("Deleting failed. Please try again.");
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-[#5C5850] underline">
        ← Back to routes
      </button>

      <div className={`${cardClass} mb-5 space-y-4 p-4`}>
        <div>
          <label htmlFor="route-region" className="mb-1 block text-sm font-medium">
            Region
          </label>
          <input
            id="route-region"
            type="text"
            list="known-regions"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="e.g. Haad Rin"
            className={spotTextInput}
          />
          <datalist id="known-regions">
            {knownRegions.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor="route-name" className="mb-1 block text-sm font-medium">
            Route name
          </label>
          <input
            id="route-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Starter"
            className={spotTextInput}
          />
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[#8A857A]">Spots</h2>
      <div className="mb-4 space-y-3">
        {spots.map((sp, i) => (
          <div key={sp._k} id={`spot-card-${sp._k}`} className={`${cardClass} space-y-3 p-4`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[#8A857A]">#{i + 1}</span>
                <label className="flex items-center gap-1 text-xs text-[#8A857A]">
                  move to
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={spots.length}
                    placeholder="#"
                    aria-label="Move to position"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const n = parseInt((e.target as HTMLInputElement).value, 10);
                      if (!Number.isNaN(n)) {
                        moveSpotTo(i, Math.min(Math.max(n, 1), spots.length) - 1);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }}
                    className="w-14 rounded-lg border border-[#E2DFD6] bg-white px-2 py-1 text-xs text-[#201E1B]"
                  />
                </label>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => moveSpot(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="rounded-lg border border-[#E2DFD6] px-2 py-1 text-sm disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveSpot(i, 1)}
                  disabled={i === spots.length - 1}
                  aria-label="Move down"
                  className="rounded-lg border border-[#E2DFD6] px-2 py-1 text-sm disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeSpot(i)}
                  aria-label="Remove spot"
                  className="rounded-lg border border-red-300 px-2 py-1 text-sm text-red-700"
                >
                  ✕
                </button>
              </div>
            </div>

            <input
              type="text"
              value={sp.name}
              onChange={(e) => updateSpot(i, { name: e.target.value })}
              placeholder="Spot name"
              className={spotTextInput}
            />

            <div className="flex gap-2">
              {(Object.keys(SPOT_TYPE_LABELS) as SpotType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => updateSpot(i, { type: t })}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${
                    sp.type === t
                      ? "border-[#201E1B] bg-[#201E1B] text-white"
                      : "border-[#E2DFD6] bg-white text-[#5C5850]"
                  }`}
                >
                  {SPOT_TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            <input
              type="text"
              value={sp.time}
              onChange={(e) => updateSpot(i, { time: e.target.value })}
              placeholder="Time (e.g. 7:00 – 8:00 PM)"
              className={spotTextInput}
            />

            <textarea
              value={sp.comment}
              onChange={(e) => updateSpot(i, { comment: e.target.value })}
              placeholder="Instructions for the volunteer"
              rows={2}
              className={spotTextInput}
            />

            <input
              type="text"
              value={sp.mapsLink ?? ""}
              onChange={(e) => updateSpot(i, { mapsLink: e.target.value })}
              placeholder="Google Maps link (optional)"
              className={spotTextInput}
            />
          </div>
        ))}

        <button
          type="button"
          onClick={() => setSpots((prev) => [...prev, withKey(blankSpot())])}
          className={secondaryButton}
        >
          + Add Spot
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <button type="button" onClick={save} disabled={saving} className={primaryButton}>
          {saving ? "Saving…" : route ? "Save Changes" : "Create Route"}
        </button>
        {route && (
          <button type="button" onClick={duplicate} disabled={saving} className={secondaryButton}>
            Duplicate as New Route
          </button>
        )}
        {route && (
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
            {saving ? "Deleting…" : confirmDelete ? "Tap again to confirm delete" : "Delete Route"}
          </button>
        )}
      </div>
    </>
  );
}

/* ===================== Crew ===================== */

function CrewSection({ adminEmail }: { adminEmail: string }) {
  const [volunteers, setVolunteers] = useState<FlyerVolunteerDoc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers"),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FlyerVolunteerDoc);
        rows.sort((a, b) => {
          // Active first, pending-stay-edit requests bubble to the top within that, then by name.
          if (a.status !== b.status) return a.status === "active" ? -1 : 1;
          if (a.hasPendingStayEdit !== b.hasPendingStayEdit) return a.hasPendingStayEdit ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setVolunteers(rows);
        setListError(null);
      },
      (err) => {
        console.error("[admin] crew listener failed:", err);
        setListError(err.code === "permission-denied" ? "Permission denied loading crew." : err.message);
      }
    );
  }, []);

  const selected = volunteers?.find((v) => v.id === selectedId) ?? null;
  if (selected) {
    return <CrewDetail volunteer={selected} adminEmail={adminEmail} onBack={() => setSelectedId(null)} />;
  }

  return (
    <>
      <p className="mb-4 text-sm text-[#5C5850]">All flyer volunteers</p>

      {listError && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {listError}
        </div>
      )}

      {volunteers === null && !listError && <p className="text-[#5C5850]">Loading…</p>}
      {volunteers?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No volunteers yet.</div>
      )}

      <ul className="space-y-3">
        {volunteers?.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => setSelectedId(v.id)}
              className={`${cardClass} block w-full p-4 text-left active:bg-[#FBF9F4]`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-base font-semibold">{v.name}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    v.status === "active" ? "bg-green-100 text-green-800" : "bg-[#E2DFD6] text-[#5C5850]"
                  }`}
                >
                  {v.status === "active" ? "Active" : "Departed"}
                </span>
              </div>
              <div className="mt-1 text-sm text-[#5C5850]">
                {v.checkInDate} → {v.checkOutDate}
              </div>
              <div className="mt-1 flex gap-2 text-xs">
                {v.onBreak && <span className="rounded-full bg-[#FBF9F4] px-2 py-0.5 text-[#8A857A]">☕ On break</span>}
                {v.hasPendingStayEdit && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
                    ⏳ Stay change requested
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function CrewDetail({
  volunteer: v,
  adminEmail,
  onBack,
}: {
  volunteer: FlyerVolunteerDoc;
  adminEmail: string;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const link = typeof window !== "undefined" ? `${window.location.origin}/v/${v.id}` : "";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const input = document.createElement("textarea");
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function approveStayEdit() {
    if (!v.pendingStayEdit) return;
    setBusy("approve");
    setError(null);
    try {
      await updateDoc(doc(db, "flyerVolunteers", v.id), {
        checkInDate: v.pendingStayEdit.checkInDate,
        checkInTime: v.pendingStayEdit.checkInTime,
        checkOutDate: v.pendingStayEdit.checkOutDate,
        checkOutTime: v.pendingStayEdit.checkOutTime,
        passportDeleteAfter: passportDeleteAfter(v.pendingStayEdit.checkOutDate),
        pendingStayEdit: null,
        hasPendingStayEdit: false,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[admin] approve stay edit failed:", err);
      setError("Approving failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function rejectStayEdit() {
    setBusy("reject");
    setError(null);
    try {
      await updateDoc(doc(db, "flyerVolunteers", v.id), {
        pendingStayEdit: null,
        hasPendingStayEdit: false,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[admin] reject stay edit failed:", err);
      setError("Rejecting failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} className="mb-4 text-sm text-[#5C5850] underline">
        ← Back to crew
      </button>

      <div className={`${cardClass} mb-5 divide-y divide-[#E2DFD6]`}>
        <Row label="Name" value={v.name} />
        <Row label="Status" value={v.status === "active" ? "Active" : "Departed"} />
        <Row label="Check-in" value={formatDateTime(v.checkInDate, v.checkInTime)} />
        <Row label="Check-out" value={formatDateTime(v.checkOutDate, v.checkOutTime)} />
        <Row label="On break" value={v.onBreak ? "✓ Yes" : "✗ No"} />
      </div>

      {v.hasPendingStayEdit && v.pendingStayEdit && (
        <div className="mb-5 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
          <p className="mb-1 text-sm font-semibold text-amber-900">⏳ Stay change requested</p>
          <p className="mb-3 text-sm text-amber-900">
            {formatDateTime(v.pendingStayEdit.checkInDate, v.pendingStayEdit.checkInTime)} →{" "}
            {formatDateTime(v.pendingStayEdit.checkOutDate, v.pendingStayEdit.checkOutTime)}
          </p>
          <div className="space-y-2">
            <button
              type="button"
              onClick={approveStayEdit}
              disabled={busy !== null}
              className="w-full rounded-xl bg-[#201E1B] px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === "approve" ? "Approving…" : "Approve change"}
            </button>
            <button
              type="button"
              onClick={rejectStayEdit}
              disabled={busy !== null}
              className="w-full rounded-xl border border-red-300 bg-white px-4 py-3 text-sm font-semibold text-red-800 disabled:opacity-40"
            >
              {busy === "reject" ? "Rejecting…" : "Reject change"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className={`${cardClass} mb-5 break-all p-4 font-mono text-sm`}>{link}</div>
      <button type="button" onClick={copyLink} className={`${secondaryButton} mb-5`}>
        {copied ? "✓ Copied" : "Copy Link"}
      </button>

      <ChatPanel token={v.id} volunteerName={v.name} adminEmail={adminEmail} />
    </>
  );
}

function ChatPanel({ token, volunteerName, adminEmail }: { token: string; volunteerName: string; adminEmail: string }) {
  const [messages, setMessages] = useState<ChatMessageDoc[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Make sure the thread exists before subscribing — legacy volunteers
    // approved before chat shipped don't have one yet, and only an admin
    // is allowed to create it (see firestore.rules).
    setDoc(
      doc(db, "flyerChatThreads", token),
      {
        volunteerId: token,
        volunteerName,
        unreadByAdmin: false,
      },
      { merge: true }
    ).catch((err) => console.error("[admin] ensure chat thread failed:", err));
  }, [token, volunteerName]);

  useEffect(() => {
    const q = query(collection(db, "flyerChatThreads", token, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(
      q,
      (snap) => setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ChatMessageDoc)),
      (err) => console.error("[admin] chat messages listener failed:", err)
    );
  }, [token]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      await addDoc(collection(db, "flyerChatThreads", token, "messages"), {
        senderRole: "admin",
        senderName: adminEmail,
        text: trimmed,
        createdAt: serverTimestamp(),
      });
      await setDoc(
        doc(db, "flyerChatThreads", token),
        {
          lastMessage: trimmed,
          lastMessageAt: serverTimestamp(),
          lastSenderRole: "admin",
          unreadByVolunteer: true,
          unreadByAdmin: false,
        },
        { merge: true }
      );
      setText("");
    } catch (err) {
      console.error("[admin] send chat message failed:", err);
      setError("Message failed to send. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`${cardClass} p-4`}>
      <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#8A857A]">Chat with {volunteerName}</p>

      <div className="mb-3 max-h-80 space-y-2 overflow-y-auto">
        {messages === null && <p className="text-sm text-[#5C5850]">Loading…</p>}
        {messages?.length === 0 && <p className="text-sm text-[#5C5850]">No messages yet.</p>}
        {messages?.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
              m.senderRole === "admin" ? "ml-auto bg-[#201E1B] text-white" : "bg-[#FBF9F4] text-[#201E1B]"
            }`}
          >
            {m.text}
          </div>
        ))}
      </div>

      {error && <p className="mb-2 text-sm text-red-800">{error}</p>}

      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Type a message…"
          className={spotTextInput}
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !text.trim()}
          className="shrink-0 rounded-lg bg-[#201E1B] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/* ===================== Group Chat ===================== */

function GroupChatSection({ adminEmail }: { adminEmail: string }) {
  const [messages, setMessages] = useState<ChatMessageDoc[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "flyerGroupMessages"), orderBy("createdAt", "asc"));
    return onSnapshot(
      q,
      (snap) => setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ChatMessageDoc)),
      (err) => {
        console.error("[admin] group chat listener failed:", err);
        setError(err.code === "permission-denied" ? "Permission denied loading the group chat." : err.message);
      }
    );
  }, []);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      await addDoc(collection(db, "flyerGroupMessages"), {
        senderRole: "admin",
        senderName: adminEmail,
        text: trimmed,
        createdAt: serverTimestamp(),
      });
      setText("");
    } catch (err) {
      console.error("[admin] send group message failed:", err);
      setError("Message failed to send. Please try again.");
    } finally {
      setSending(false);
    }
  }

  async function removeMessage(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      await deleteDoc(doc(db, "flyerGroupMessages", id));
    } catch (err) {
      console.error("[admin] delete group message failed:", err);
    } finally {
      setConfirmDeleteId(null);
    }
  }

  return (
    <>
      <p className="mb-4 text-sm text-[#5C5850]">Visible to every active volunteer</p>

      <div className={`${cardClass} p-4`}>
        <div className="mb-3 max-h-[28rem] space-y-2 overflow-y-auto">
          {messages === null && !error && <p className="text-sm text-[#5C5850]">Loading…</p>}
          {messages?.length === 0 && <p className="text-sm text-[#5C5850]">No messages yet.</p>}
          {messages?.map((m) => (
            <div
              key={m.id}
              className={`group max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                m.senderRole === "admin" ? "ml-auto bg-[#201E1B] text-white" : "bg-[#FBF9F4] text-[#201E1B]"
              }`}
            >
              {m.senderRole !== "admin" && (
                <div className="mb-0.5 text-xs font-semibold text-[#8A857A]">{m.senderName}</div>
              )}
              <div className="flex items-start justify-between gap-2">
                <span>{m.text}</span>
                <button
                  type="button"
                  onClick={() => removeMessage(m.id)}
                  className={`shrink-0 text-xs underline ${
                    m.senderRole === "admin" ? "text-white/70" : "text-[#8A857A]"
                  }`}
                >
                  {confirmDeleteId === m.id ? "Confirm?" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="mb-2 text-sm text-red-800">{error}</p>}

        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            placeholder="Message all active volunteers…"
            className={spotTextInput}
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !text.trim()}
            className="shrink-0 rounded-lg bg-[#201E1B] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}

function SupplyReportsSection() {
  const [reports, setReports] = useState<SupplyReportDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    // Sorted client-side rather than orderBy("status") + orderBy("createdAt")
    // — that pairing would need a composite index.
    const q = query(collection(db, "flyerSupplyReports"), orderBy("createdAt", "desc"));
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SupplyReportDoc);
        rows.sort((a, b) => {
          if (a.status !== b.status) return a.status === "open" ? -1 : 1;
          return (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0);
        });
        setReports(rows);
        setError(null);
      },
      (err) => {
        console.error("[admin] supply reports listener failed:", err);
        setError(err.code === "permission-denied" ? "Permission denied loading supply reports." : err.message);
      }
    );
  }, []);

  async function setStatus(id: string, status: SupplyReportStatus) {
    setBusyId(id);
    try {
      await updateDoc(doc(db, "flyerSupplyReports", id), {
        status,
        resolvedAt: status === "resolved" ? serverTimestamp() : null,
      });
    } catch (err) {
      console.error("[admin] failed to update supply report:", err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <p className="mb-4 text-sm text-[#5C5850]">Missing-supply reports from volunteers</p>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {reports === null && !error && <p className="text-[#5C5850]">Loading…</p>}
      {reports?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No supply reports yet.</div>
      )}

      <ul className="space-y-3">
        {reports?.map((r) => (
          <li key={r.id} className={`${cardClass} p-4 ${r.status === "resolved" ? "opacity-60" : ""}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-base font-semibold">{r.item}</span>
              <span className="shrink-0 text-xs text-[#8A857A]">{timeAgo(r.createdAt)}</span>
            </div>
            <div className="mt-1 text-sm text-[#5C5850]">{r.volunteerName}</div>
            {r.note && <div className="mt-2 text-sm">{r.note}</div>}
            <div className="mt-3">
              {r.status === "open" ? (
                <button
                  type="button"
                  onClick={() => setStatus(r.id, "resolved")}
                  disabled={busyId === r.id}
                  className="text-sm font-semibold underline disabled:opacity-40"
                >
                  {busyId === r.id ? "Marking…" : "Mark resolved"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setStatus(r.id, "open")}
                  disabled={busyId === r.id}
                  className="text-sm text-[#8A857A] underline disabled:opacity-40"
                >
                  {busyId === r.id ? "Reopening…" : "✓ Resolved — reopen"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
