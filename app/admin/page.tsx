"use client";

import { useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  collection,
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
    <Shell>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Registrations</h1>
          <p className="text-sm text-[#5C5850]">Pending review</p>
        </div>
        <button type="button" onClick={() => signOut(auth)} className="pt-1 text-sm text-[#5C5850] underline">
          Sign out
        </button>
      </div>

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
    </Shell>
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
    <Shell>
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
    </Shell>
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
    <Shell>
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
    </Shell>
  );
}
