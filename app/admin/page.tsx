"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
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
  where,
  writeBatch,
} from "firebase/firestore";
import { getBlob, getDownloadURL, ref } from "firebase/storage";
import { auth, db, googleProvider, storage } from "@/lib/firebase";
import { FLYER_MANAGEMENT_EMAILS } from "@/lib/constants";
import { generateToken } from "@/lib/token";
import ShiftPlan from "./ShiftPlan";
import { bangkokToday } from "@/lib/shifts";
import { readSeen, writeSeen } from "@/lib/chat-seen";
import { messagePreview, uploadChatMedia, type ChatMediaType, type PreparedMedia } from "@/lib/chat-media";
import ChatComposer from "@/components/ChatComposer";
import ChatMessageBody from "@/components/ChatMessageBody";

type Registration = {
  id: string;
  name: string;
  checkInDate: string;
  checkInTime: string | null;
  checkOutDate: string;
  checkOutTime: string | null;
  // null once the retention job (Cloud Function cleanupExpiredFlyerPassports) has deleted the photo.
  passportPhotoPath: string | null;
  // Selfie taken at registration; absent on registrations from before it existed.
  selfiePhotoPath?: string | null;
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
  /** Shown on the "Tour Completed!" screen; empty = default thank-you text. */
  completionMessage?: string | null;
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
  passportPhotoPath?: string | null;
  selfiePhotoPath?: string | null;
};

type ChatSenderRole = "volunteer" | "admin";

type ChatMessageDoc = {
  id: string;
  senderRole: ChatSenderRole;
  senderName: string;
  text: string;
  mediaType?: ChatMediaType | null;
  mediaPath?: string | null;
  createdAt: Timestamp | null;
};

type ChatThreadDoc = {
  id: string;
  volunteerName?: string;
  lastMessage?: string | null;
  lastMessageAt?: Timestamp | null;
  lastSenderRole?: ChatSenderRole | null;
  unreadByAdmin?: boolean;
};

type GroupLatest = { ms: number; fromVolunteer: boolean; text: string; senderName: string };

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

function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className={`w-full ${wide ? "max-w-6xl" : "max-w-md"}`}>{children}</div>
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

/* ---- URL-addressable admin views (tab + route) ----
   Plain History API on purpose: real <a href> links (so right-click ->
   "Open in new tab", reload and the Back button work) without depending on
   Next's routing hooks. Normal left-clicks are intercepted and handled
   in-page; modified clicks fall through to the browser. */

const ADMIN_NAV_EVENT = "oxa-admin-nav";

function readAdminLocation(): { tab: string | null; route: string | null; sub: string | null } {
  const p = new URLSearchParams(window.location.search);
  return { tab: p.get("tab"), route: p.get("route"), sub: p.get("sub") };
}

function adminHref(tab: string, route?: string | null, sub?: string | null): string {
  const p = new URLSearchParams({ tab });
  if (route) p.set("route", route);
  if (sub) p.set("sub", sub);
  return `/admin?${p.toString()}`;
}

function navigateAdmin(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(ADMIN_NAV_EVENT));
}

function useAdminLocation() {
  // Only rendered after sign-in (client-side), so reading window here is safe;
  // the typeof guard just keeps any server render from throwing.
  const [loc, setLoc] = useState(() =>
    typeof window === "undefined" ? { tab: null, route: null, sub: null } : readAdminLocation()
  );
  useEffect(() => {
    const sync = () => setLoc(readAdminLocation());
    window.addEventListener("popstate", sync);
    window.addEventListener(ADMIN_NAV_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(ADMIN_NAV_EVENT, sync);
    };
  }, []);
  return loc;
}

function AdminLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigateAdmin(href);
      }}
    >
      {children}
    </a>
  );
}

const DASHBOARD_TABS = ["crew", "routes", "chat", "supplies"] as const;
type DashboardTab = (typeof DASHBOARD_TABS)[number];
const CREW_SUBS = ["registrations", "volunteers", "shifts"] as const;
type CrewSub = (typeof CREW_SUBS)[number];

function crewHref(sub: CrewSub): string {
  return `/admin?tab=crew&sub=${sub}`;
}

function Dashboard({ adminEmail }: { adminEmail: string }) {
  const { tab: urlTab, sub: urlSub } = useAdminLocation();
  const chat = useAdminChat(adminEmail);
  const chatUnread = chat.groupUnread || Object.values<ChatThreadDoc>(chat.threads).some((t) => t.unreadByAdmin === true);

  // Old bookmarks: ?tab=registrations / ?tab=shifts / ?tab=group-chat now live elsewhere.
  let tab: DashboardTab = "crew";
  let sub: CrewSub = "registrations";
  if (urlTab === "registrations") {
    sub = "registrations";
  } else if (urlTab === "shifts") {
    sub = "shifts";
  } else if (urlTab === "group-chat") {
    tab = "chat";
  } else if ((DASHBOARD_TABS as readonly string[]).includes(urlTab ?? "")) {
    tab = urlTab as DashboardTab;
  }
  if (tab === "crew" && (CREW_SUBS as readonly string[]).includes(urlSub ?? "")) {
    sub = urlSub as CrewSub;
  }

  const tabs: { key: DashboardTab; label: string; href: string }[] = [
    { key: "crew", label: "Crew", href: crewHref(sub) },
    { key: "routes", label: "Routes", href: adminHref("routes") },
    { key: "chat", label: "Chat", href: adminHref("chat") },
    { key: "supplies", label: "Supplies", href: adminHref("supplies") },
  ];
  const subs: { key: CrewSub; label: string }[] = [
    { key: "registrations", label: "Registrations" },
    { key: "volunteers", label: "Volunteers" },
    { key: "shifts", label: "Shifts" },
  ];

  return (
    <Shell wide={tab === "crew" && sub === "shifts"}>
      <div className="sticky top-0 z-30 -mx-4 mb-4 bg-[#EFEDE7]/95 px-4 pb-3 pt-1 backdrop-blur">
        <nav aria-label="Sections" className="grid max-w-md grid-cols-4 gap-1 rounded-full bg-[#E2DFD6] p-1">
          {tabs.map((t) => (
            <AdminLink
              key={t.key}
              href={t.href}
              className={`relative rounded-full px-1 py-2 text-center text-sm font-semibold ${
                tab === t.key ? "bg-white text-[#201E1B]" : "text-[#5C5850]"
              }`}
            >
              {t.key === "chat" && chatUnread && (
                <span
                  role="img"
                  aria-label="New messages"
                  className="absolute left-2 top-1.5 h-2.5 w-2.5 rounded-full bg-green-500"
                />
              )}
              {t.label}
            </AdminLink>
          ))}
        </nav>
      </div>

      {tab === "crew" && (
        <div className="mb-5 flex max-w-md flex-wrap gap-2">
          {subs.map((t) => (
            <AdminLink
              key={t.key}
              href={crewHref(t.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                sub === t.key
                  ? "bg-[#201E1B] text-white"
                  : "border border-[#E2DFD6] bg-white text-[#5C5850]"
              }`}
            >
              {t.label}
            </AdminLink>
          ))}
        </div>
      )}

      <div className="pb-24">
        {tab === "crew" && sub === "registrations" && <RegistrationsSection adminEmail={adminEmail} />}
        {tab === "crew" && sub === "volunteers" && <CrewSection adminEmail={adminEmail} />}
        {tab === "crew" && sub === "shifts" && <ShiftPlan adminEmail={adminEmail} />}
        {tab === "routes" && <RoutesSection />}
        {tab === "chat" && <ChatSection adminEmail={adminEmail} chat={chat} />}
        {tab === "supplies" && <SupplyReportsSection />}

        <button type="button" onClick={() => signOut(auth)} className="mt-10 text-sm text-[#5C5850] underline">
          Sign out
        </button>
      </div>

      <ShareRegistrationFooter />
    </Shell>
  );
}

/** Sticky footer: share (phone share sheet) or copy the public registration link. */
function ShareRegistrationFooter() {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function share() {
    const url = `${window.location.origin}/register`;
    const nav = navigator as Navigator & {
      share?: (data: { url: string; title?: string }) => Promise<void>;
    };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ url, title: "Phangan-Flyer-Tours registration" });
        return;
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        // Any other failure: fall through to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement("textarea");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      input.remove();
      if (!ok) {
        setStatus("failed");
        setTimeout(() => setStatus("idle"), 3000);
        return;
      }
    }
    setStatus("copied");
    setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#E2DFD6] bg-[#EFEDE7]/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto max-w-md">
        <button type="button" onClick={share} className={primaryButton}>
          {status === "copied"
            ? "✓ Link copied"
            : status === "failed"
              ? "Couldn't copy — try again"
              : "Share registration link"}
        </button>
      </div>
    </div>
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

/** A photo from Storage with a "Download JPG" button (falls back to opening it in a new tab). */
function StoragePhoto({
  path,
  label,
  fileName,
}: {
  path: string | null | undefined;
  label: string;
  fileName: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    if (!path) return;
    getDownloadURL(ref(storage, path))
      .then((u) => !cancelled && setUrl(u))
      .catch((err) => {
        console.error("[admin] photo load failed:", err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function download() {
    if (!path || !url) return;
    setDownloading(true);
    try {
      const blob = await getBlob(ref(storage, path));
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (err) {
      console.error("[admin] photo download failed, opening in a new tab instead:", err);
      window.open(url, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className={`${cardClass} mb-5 overflow-hidden`}>
      <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">{label}</p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={label} className="mt-2 block w-full" />
      ) : (
        <div className="mt-2 flex h-40 items-center justify-center bg-[#FBF9F4] px-4 text-center text-sm text-[#8A857A]">
          {!path
            ? "No photo on file (it may have been deleted after the retention period)."
            : failed
              ? "Photo could not be loaded."
              : "Loading photo…"}
        </div>
      )}
      {url && (
        <div className="p-3">
          <button type="button" onClick={download} disabled={downloading} className={secondaryButton}>
            {downloading ? "Preparing…" : "Download JPG"}
          </button>
        </div>
      )}
    </div>
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
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        selfiePhotoPath: r.selfiePhotoPath ?? null,
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

      <StoragePhoto path={r.passportPhotoPath} label="Passport" fileName={`passport-${r.name}.jpg`} />
      {r.selfiePhotoPath && (
        <StoragePhoto path={r.selfiePhotoPath} label="Selfie" fileName={`selfie-${r.name}.jpg`} />
      )}

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
  // From the URL (?tab=routes&route=...): null = showing the list,
  // "new" = creating, otherwise the route id being edited.
  const { route: editingId } = useAdminLocation();
  const backToList = () => navigateAdmin(adminHref("routes"));

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
    // Deep link to a route: wait for the list to load, and don't silently fall
    // back to a blank "new route" editor if the id doesn't exist (e.g. deleted).
    if (editingId !== "new" && !existing) {
      return routes === null && !listError ? (
        <p className="text-[#5C5850]">Loading…</p>
      ) : (
        <>
          <AdminLink href={adminHref("routes")} className="mb-4 inline-block text-sm text-[#5C5850] underline">
            ← Back to routes
          </AdminLink>
          <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
            {listError ?? "This route doesn't exist (it may have been deleted)."}
          </div>
        </>
      );
    }
    return (
      <RouteEditor
        key={editingId}
        route={existing}
        knownRegions={Array.from(new Set((routes ?? []).map((r) => r.region))).sort()}
        onBack={backToList}
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
        <AdminLink
          href={adminHref("routes", "new")}
          className="shrink-0 rounded-full bg-[#201E1B] px-4 py-2 text-sm font-semibold text-white"
        >
          + New Route
        </AdminLink>
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
                  <AdminLink
                    href={adminHref("routes", r.id)}
                    className={`${cardClass} flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left active:bg-[#FBF9F4]`}
                  >
                    <span className="truncate text-base font-semibold">{r.name}</span>
                    <span className="shrink-0 text-sm text-[#5C5850]">
                      {r.spots?.length ?? 0} spot{(r.spots?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </AdminLink>
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
  const [completionMessage, setCompletionMessage] = useState(route?.completionMessage ?? "");
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
          completionMessage: completionMessage.trim() || null,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "flyerRoutes"), {
          region: region.trim(),
          name: name.trim(),
          spots: cleanedSpots(),
          completionMessage: completionMessage.trim() || null,
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
        completionMessage: completionMessage.trim() || null,
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

      <div className={`${cardClass} mb-5 p-4`}>
        <label htmlFor="route-completion" className="mb-1 block text-sm font-medium">
          Message when the tour is completed
        </label>
        <p className="mb-2 text-xs text-[#8A857A]">
          Shown to the volunteer under &quot;Tour Completed!&quot;. Line breaks are kept. Leave empty for the default text
          (&quot;Thank you for flyering today 🙌&quot;).
        </p>
        <textarea
          id="route-completion"
          value={completionMessage}
          onChange={(e) => setCompletionMessage(e.target.value)}
          placeholder="Thank you for flyering today 🙌"
          rows={3}
          className={spotTextInput}
        />
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
  const [busy, setBusy] = useState<"approve" | "reject" | "stay" | "end" | "reactivate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [stayOpen, setStayOpen] = useState(false);
  const [stayForm, setStayForm] = useState({
    checkInDate: v.checkInDate,
    checkInTime: v.checkInTime ?? "",
    checkOutDate: v.checkOutDate,
    checkOutTime: v.checkOutTime ?? "",
  });
  const [confirmEnd, setConfirmEnd] = useState(false);

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

  function openStayEditor() {
    setStayForm({
      checkInDate: v.checkInDate,
      checkInTime: v.checkInTime ?? "",
      checkOutDate: v.checkOutDate,
      checkOutTime: v.checkOutTime ?? "",
    });
    setError(null);
    setStayOpen(true);
  }

  async function saveStay() {
    if (!stayForm.checkInDate || !stayForm.checkOutDate) {
      setError("Please set both dates.");
      return;
    }
    if (stayForm.checkOutDate < stayForm.checkInDate) {
      setError("Check-out can't be before check-in.");
      return;
    }
    setBusy("stay");
    setError(null);
    try {
      await updateDoc(doc(db, "flyerVolunteers", v.id), {
        checkInDate: stayForm.checkInDate,
        checkInTime: stayForm.checkInTime || null,
        checkOutDate: stayForm.checkOutDate,
        checkOutTime: stayForm.checkOutTime || null,
        passportDeleteAfter: passportDeleteAfter(stayForm.checkOutDate),
        updatedAt: serverTimestamp(),
      });
      setStayOpen(false);
    } catch (err) {
      console.error("[admin] saving stay failed:", err);
      setError("Saving failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  // Volunteer leaves early: check-out becomes today (if it was later), the
  // personal link stops working, future shifts are removed, and the 7-day
  // passport-retention clock restarts from the new check-out date.
  async function endStayNow() {
    setBusy("end");
    setError(null);
    try {
      const today = bangkokToday();
      const newCheckOut = v.checkOutDate > today ? today : v.checkOutDate;
      const futureShifts = await getDocs(
        query(collection(db, "flyerVolunteers", v.id, "shifts"), where("date", ">", today))
      );
      const batch = writeBatch(db);
      batch.update(doc(db, "flyerVolunteers", v.id), {
        status: "departed",
        checkOutDate: newCheckOut,
        passportDeleteAfter: passportDeleteAfter(newCheckOut),
        pendingStayEdit: null,
        hasPendingStayEdit: false,
        onBreak: false,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      futureShifts.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      setConfirmEnd(false);
      setStayOpen(false);
    } catch (err) {
      console.error("[admin] ending stay failed:", err);
      setError("Ending the stay failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function reactivate() {
    if (v.checkOutDate < bangkokToday()) {
      setError("The check-out date is in the past. Edit the stay first, then reactivate.");
      return;
    }
    setBusy("reactivate");
    setError(null);
    try {
      await updateDoc(doc(db, "flyerVolunteers", v.id), {
        status: "active",
        endedAt: null,
        passportDeleteAfter: passportDeleteAfter(v.checkOutDate),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[admin] reactivating failed:", err);
      setError("Reactivating failed. Please try again.");
    } finally {
      setBusy(null);
    }
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

      <StoragePhoto path={v.passportPhotoPath} label="Passport" fileName={`passport-${v.name}.jpg`} />
      {v.selfiePhotoPath && (
        <StoragePhoto path={v.selfiePhotoPath} label="Selfie" fileName={`selfie-${v.name}.jpg`} />
      )}

      <div className={`${cardClass} mb-5 p-4`}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Stay</p>

        {stayOpen ? (
          <div className="space-y-3">
            {(
              [
                ["checkInDate", "Check-in date", "date"],
                ["checkInTime", "Check-in time (optional)", "time"],
                ["checkOutDate", "Check-out date", "date"],
                ["checkOutTime", "Check-out time (optional)", "time"],
              ] as const
            ).map(([key, label, type]) => (
              <div key={key}>
                <label htmlFor={`stay-${key}`} className="mb-1.5 block text-sm font-medium">
                  {label}
                </label>
                <input
                  id={`stay-${key}`}
                  type={type}
                  value={stayForm[key]}
                  onChange={(e) => setStayForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base min-h-[50px] focus:border-[#201E1B] focus:outline-none"
                />
              </div>
            ))}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStayOpen(false)} disabled={busy !== null} className={secondaryButton}>
                Cancel
              </button>
              <button type="button" onClick={saveStay} disabled={busy !== null} className={primaryButton}>
                {busy === "stay" ? "Saving…" : "Save stay"}
              </button>
            </div>
            <p className="text-xs text-[#8A857A]">
              The passport photo is deleted 7 days after the check-out date.
            </p>
          </div>
        ) : confirmEnd ? (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3">
            <p className="mb-3 text-sm text-red-900">
              End {v.name}&apos;s stay now? Their link stops working and shifts after today are removed. You can
              reactivate later.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmEnd(false)} disabled={busy !== null} className={secondaryButton}>
                Keep
              </button>
              <button
                type="button"
                onClick={endStayNow}
                disabled={busy !== null}
                className="w-full rounded-2xl bg-red-700 px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
              >
                {busy === "end" ? "Ending…" : "End stay"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button type="button" onClick={openStayEditor} disabled={busy !== null} className={secondaryButton}>
              Edit stay dates
            </button>
            {v.status === "active" ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setConfirmEnd(true);
                }}
                disabled={busy !== null}
                className="w-full rounded-2xl border border-red-300 bg-white px-4 py-4 text-base font-semibold text-red-800 disabled:opacity-40"
              >
                End stay now (left early)
              </button>
            ) : (
              <button type="button" onClick={reactivate} disabled={busy !== null} className={primaryButton}>
                {busy === "reactivate" ? "Reactivating…" : "Reactivate volunteer"}
              </button>
            )}
          </div>
        )}
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

    </>
  );
}

function ChatPanel({ token, volunteerName, adminEmail }: { token: string; volunteerName: string; adminEmail: string }) {
  const [messages, setMessages] = useState<ChatMessageDoc[] | null>(null);

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

  // While this chat is open, anything the volunteer sends counts as read.
  // Listening to the thread doc (not the messages) avoids racing the
  // volunteer's own "unreadByAdmin: true" write.
  useEffect(() => {
    return onSnapshot(
      doc(db, "flyerChatThreads", token),
      (snap) => {
        if (snap.exists() && snap.data().unreadByAdmin === true) {
          updateDoc(doc(db, "flyerChatThreads", token), { unreadByAdmin: false }).catch(() => {});
        }
      },
      () => {}
    );
  }, [token]);

  // Throws on failure — ChatComposer shows the error.
  async function post(text: string, mediaType: ChatMediaType | null, mediaPath: string | null) {
    await addDoc(collection(db, "flyerChatThreads", token, "messages"), {
      senderRole: "admin",
      senderName: adminEmail,
      text,
      mediaType,
      mediaPath,
      createdAt: serverTimestamp(),
    });
    await setDoc(
      doc(db, "flyerChatThreads", token),
      {
        lastMessage: messagePreview(text, mediaType),
        lastMessageAt: serverTimestamp(),
        lastSenderRole: "admin",
        unreadByVolunteer: true,
        unreadByAdmin: false,
      },
      { merge: true }
    );
  }

  async function sendText(text: string) {
    await post(text, null, null);
  }

  async function sendMedia(media: PreparedMedia) {
    const path = await uploadChatMedia(token, media);
    await post("", media.type, path);
  }

  return (
    <div className={`${cardClass} p-4`}>
      <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#8A857A]">Chat with {volunteerName}</p>

      <div className="mb-3 max-h-[60vh] space-y-2 overflow-y-auto">
        {messages === null && <p className="text-sm text-[#5C5850]">Loading…</p>}
        {messages?.length === 0 && <p className="text-sm text-[#5C5850]">No messages yet.</p>}
        {messages?.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
              m.senderRole === "admin" ? "ml-auto bg-[#201E1B] text-white" : "bg-[#FBF9F4] text-[#201E1B]"
            }`}
          >
            <ChatMessageBody text={m.text} mediaType={m.mediaType} mediaPath={m.mediaPath} />
          </div>
        ))}
      </div>

      <ChatComposer inputClassName={spotTextInput} onSendText={sendText} onSendMedia={sendMedia} />
    </div>
  );
}

/* ===================== Chat (central inbox) ===================== */

const GROUP_SEEN_KEY = "flyerAdminGroupSeen";

/**
 * Thread metadata (unread flags, last message) for every volunteer plus the
 * newest group message. Direct-chat unread state lives on the thread docs;
 * the group chat has no per-reader state, so "seen" is kept in this browser.
 */
function useAdminChat(adminEmail: string) {
  const [threads, setThreads] = useState<Record<string, ChatThreadDoc>>({});
  const [groupLatest, setGroupLatest] = useState<GroupLatest | null>(null);
  const [groupSeenMs, setGroupSeenMs] = useState<number | null>(null);
  // True once the synced "seen" marker in Firestore has been looked at (or failed to load).
  const [remoteChecked, setRemoteChecked] = useState(false);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerChatThreads"),
      (snap) => {
        const next: Record<string, ChatThreadDoc> = {};
        snap.docs.forEach((d) => {
          next[d.id] = { id: d.id, ...(d.data() as Omit<ChatThreadDoc, "id">) };
        });
        setThreads(next);
      },
      (err) => console.error("[admin] chat threads listener failed:", err)
    );
  }, []);

  useEffect(() => {
    const q = query(collection(db, "flyerGroupMessages"), orderBy("createdAt", "desc"), limit(1));
    return onSnapshot(
      q,
      (snap) => {
        const d = snap.docs[0];
        if (!d) {
          setGroupLatest(null);
          return;
        }
        const data = d.data() as { senderRole?: ChatSenderRole; senderName?: string; text?: string; mediaType?: ChatMediaType | null; createdAt?: Timestamp | null };
        setGroupLatest({
          ms: data.createdAt?.toMillis() ?? Date.now(),
          fromVolunteer: data.senderRole === "volunteer",
          text: messagePreview(data.text, data.mediaType),
          senderName: data.senderName ?? "",
        });
      },
      (err) => console.error("[admin] group latest listener failed:", err)
    );
  }, []);

  // "Seen" lives in localStorage (this browser) and, so it is also in sync between
  // devices and readable by the management portal, in flyerAdminState/groupChat.
  const saveSeenRemote = useCallback(
    (ms: number) => {
      setDoc(
        doc(db, "flyerAdminState", "groupChat"),
        { seenAt: Timestamp.fromMillis(ms), seenBy: adminEmail },
        { merge: true }
      ).catch((err) => console.error("[admin] saving group chat seen marker failed:", err));
    },
    [adminEmail]
  );

  useEffect(() => {
    const local = readSeen(GROUP_SEEN_KEY);
    setGroupSeenMs(local);
    let cancelled = false;
    getDoc(doc(db, "flyerAdminState", "groupChat"))
      .then((snap) => {
        if (cancelled || !snap.exists()) return;
        const remote = (snap.data().seenAt as Timestamp | undefined)?.toMillis();
        if (remote !== undefined && remote > (local ?? 0)) {
          writeSeen(GROUP_SEEN_KEY, remote);
          setGroupSeenMs(remote);
        }
      })
      .catch((err) => console.error("[admin] loading group chat seen marker failed:", err))
      .finally(() => {
        if (!cancelled) setRemoteChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // First visit on this device (and nothing synced yet): treat existing messages as
  // seen, so the dot only ever means "something new since you were last here".
  useEffect(() => {
    if (groupLatest && groupSeenMs === null && remoteChecked) {
      writeSeen(GROUP_SEEN_KEY, groupLatest.ms);
      setGroupSeenMs(groupLatest.ms);
      saveSeenRemote(groupLatest.ms);
    }
  }, [groupLatest, groupSeenMs, remoteChecked, saveSeenRemote]);

  const markGroupSeen = useCallback(
    (ms: number) => {
      writeSeen(GROUP_SEEN_KEY, ms);
      setGroupSeenMs((prev) => (prev !== null && prev >= ms ? prev : ms));
      saveSeenRemote(ms);
    },
    [saveSeenRemote]
  );

  const groupUnread = !!groupLatest && groupLatest.fromVolunteer && groupSeenMs !== null && groupLatest.ms > groupSeenMs;

  return { threads, groupLatest, groupUnread, markGroupSeen };
}

const UNREAD_DOT = "absolute left-2.5 top-2.5 h-3 w-3 rounded-full bg-green-500 ring-2 ring-white";

function ChatSection({ adminEmail, chat }: { adminEmail: string; chat: ReturnType<typeof useAdminChat> }) {
  const { sub } = useAdminLocation();
  const [volunteers, setVolunteers] = useState<{ id: string; name: string; status: "active" | "departed" }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers"),
      (snap) => {
        setVolunteers(
          snap.docs.map((d) => {
            const data = d.data() as { name?: string; status?: "active" | "departed" };
            return { id: d.id, name: data.name ?? "(no name)", status: data.status ?? "active" };
          })
        );
        setError(null);
      },
      (err) => {
        console.error("[admin] chat volunteers listener failed:", err);
        setError(err.code === "permission-denied" ? "Permission denied loading volunteers." : err.message);
      }
    );
  }, []);

  const backLink = (
    <AdminLink href={adminHref("chat")} className="mb-4 inline-block text-sm text-[#5C5850] underline">
      ← All chats
    </AdminLink>
  );

  if (sub === "group") {
    return (
      <>
        {backLink}
        <GroupChatSection adminEmail={adminEmail} onSeen={chat.markGroupSeen} />
      </>
    );
  }

  if (sub) {
    const vol = volunteers?.find((v) => v.id === sub) ?? null;
    if (!vol) {
      return (
        <>
          {backLink}
          <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>
            {volunteers === null && !error ? "Loading…" : (error ?? "This volunteer doesn't exist.")}
          </div>
        </>
      );
    }
    return (
      <>
        {backLink}
        <ChatPanel token={vol.id} volunteerName={vol.name} adminEmail={adminEmail} />
      </>
    );
  }

  const rows = (volunteers ?? [])
    .map((v) => ({ v, t: chat.threads[v.id] }))
    .sort((a, b) => {
      if ((a.v.status === "active") !== (b.v.status === "active")) return a.v.status === "active" ? -1 : 1;
      const au = a.t?.unreadByAdmin === true;
      const bu = b.t?.unreadByAdmin === true;
      if (au !== bu) return au ? -1 : 1;
      const at = a.t?.lastMessageAt?.toMillis() ?? 0;
      const bt = b.t?.lastMessageAt?.toMillis() ?? 0;
      if (at !== bt) return bt - at;
      return a.v.name.localeCompare(b.v.name);
    });
  const g = chat.groupLatest;

  return (
    <>
      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <AdminLink
        href={adminHref("chat", null, "group")}
        className={`${cardClass} relative mb-5 block w-full p-4 pl-8 text-left active:bg-[#FBF9F4]`}
      >
        {chat.groupUnread && <span role="img" aria-label="New messages" className={UNREAD_DOT} />}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-base font-semibold">👥 Group chat</span>
          <span className="shrink-0 text-xs text-[#8A857A]">All active volunteers</span>
        </div>
        <p className="mt-1 truncate text-sm text-[#5C5850]">
          {g ? `${g.fromVolunteer ? g.senderName : "OXA Team"}: ${g.text}` : "No messages yet"}
        </p>
      </AdminLink>

      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-[#8A857A]">Direct messages</p>
      {volunteers === null && !error && <p className="text-[#5C5850]">Loading…</p>}
      {volunteers?.length === 0 && (
        <div className={`${cardClass} p-6 text-center text-[#5C5850]`}>No volunteers yet.</div>
      )}
      <ul className="space-y-3">
        {rows.map(({ v, t }) => {
          const unread = t?.unreadByAdmin === true;
          return (
            <li key={v.id}>
              <AdminLink
                href={adminHref("chat", null, v.id)}
                className={`${cardClass} relative block w-full p-4 pl-8 text-left active:bg-[#FBF9F4] ${
                  v.status === "departed" ? "opacity-60" : ""
                }`}
              >
                {unread && <span role="img" aria-label="New messages" className={UNREAD_DOT} />}
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`truncate text-base ${unread ? "font-bold" : "font-semibold"}`}>{v.name}</span>
                  <span className="shrink-0 text-xs text-[#8A857A]">
                    {v.status === "departed" ? "Departed" : t?.lastMessageAt ? timeAgo(t.lastMessageAt) : ""}
                  </span>
                </div>
                <p className={`mt-1 truncate text-sm ${unread ? "text-[#201E1B]" : "text-[#5C5850]"}`}>
                  {t?.lastMessage
                    ? `${t.lastSenderRole === "admin" ? "You: " : ""}${t.lastMessage}`
                    : "No messages yet"}
                </p>
              </AdminLink>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ===================== Group Chat ===================== */

function GroupChatSection({ adminEmail, onSeen }: { adminEmail: string; onSeen: (ms: number) => void }) {
  const [messages, setMessages] = useState<ChatMessageDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, "flyerGroupMessages"), orderBy("createdAt", "asc"));
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ChatMessageDoc);
        setMessages(rows);
        const last = rows[rows.length - 1];
        if (last) onSeen(last.createdAt?.toMillis() ?? Date.now());
      },
      (err) => {
        console.error("[admin] group chat listener failed:", err);
        setError(err.code === "permission-denied" ? "Permission denied loading the group chat." : err.message);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Throws on failure — ChatComposer shows the error.
  async function post(text: string, mediaType: ChatMediaType | null, mediaPath: string | null) {
    await addDoc(collection(db, "flyerGroupMessages"), {
      senderRole: "admin",
      senderName: adminEmail,
      text,
      mediaType,
      mediaPath,
      createdAt: serverTimestamp(),
    });
  }

  async function sendText(text: string) {
    await post(text, null, null);
  }

  async function sendMedia(media: PreparedMedia) {
    const path = await uploadChatMedia("group/admin", media);
    await post("", media.type, path);
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
                <span className="min-w-0">
                  <ChatMessageBody text={m.text} mediaType={m.mediaType} mediaPath={m.mediaPath} />
                </span>
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

        <ChatComposer
          placeholder="Message all active volunteers…"
          inputClassName={spotTextInput}
          onSendText={sendText}
          onSendMedia={sendMedia}
        />
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
