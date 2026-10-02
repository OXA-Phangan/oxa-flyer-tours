"use client";

import { useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
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

type FlyerRouteDoc = {
  id: string;
  region: string;
  name: string;
  spots: RouteSpot[];
  duplicatedFrom?: string | null;
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
  const [tab, setTab] = useState<"registrations" | "routes">("registrations");

  return (
    <Shell>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="flex gap-2 rounded-full bg-[#E2DFD6] p-1">
          <button
            type="button"
            onClick={() => setTab("registrations")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
              tab === "registrations" ? "bg-white text-[#201E1B]" : "text-[#5C5850]"
            }`}
          >
            Registrations
          </button>
          <button
            type="button"
            onClick={() => setTab("routes")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
              tab === "routes" ? "bg-white text-[#201E1B]" : "text-[#5C5850]"
            }`}
          >
            Routes
          </button>
        </div>
        <button type="button" onClick={() => signOut(auth)} className="pt-2 text-sm text-[#5C5850] underline">
          Sign out
        </button>
      </div>

      {tab === "registrations" ? <RegistrationsSection adminEmail={adminEmail} /> : <RoutesSection />}
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
  const [spots, setSpots] = useState<RouteSpot[]>(route?.spots?.length ? route.spots : [blankSpot()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function updateSpot(i: number, patch: Partial<RouteSpot>) {
    setSpots((prev) => prev.map((sp, idx) => (idx === i ? { ...sp, ...patch } : sp)));
  }

  function removeSpot(i: number) {
    setSpots((prev) => prev.filter((_, idx) => idx !== i));
  }

  function moveSpot(i: number, dir: -1 | 1) {
    setSpots((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
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
      time: sp.time.trim(),
      comment: sp.comment.trim(),
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
          <div key={i} className={`${cardClass} space-y-3 p-4`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-[#8A857A]">#{i + 1}</span>
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
          onClick={() => setSpots((prev) => [...prev, blankSpot()])}
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
