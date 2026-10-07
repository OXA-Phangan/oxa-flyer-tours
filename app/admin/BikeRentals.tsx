"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { bangkokToday, dayLabel, longDayLabel } from "@/lib/shifts";
import {
  BIKES,
  BIKE_PRICE_PER_DAY,
  bikeDot,
  bikeLabel,
  compareRentals,
  formatDmy,
  formatThb,
  parseRental,
  rentalTotal,
  slotId,
  type BikeId,
  type BikeRental,
  type BikeStatus,
} from "@/lib/bike";

/* ---------- styles (same palette as the rest of /admin) ---------- */

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const beigeButton =
  "rounded-xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-2.5 text-sm font-semibold text-[#201E1B] disabled:opacity-40";
const plainButton =
  "rounded-xl border border-[#D6D1C3] bg-white px-4 py-2.5 text-sm font-semibold text-[#201E1B] disabled:opacity-40";
const dangerButton =
  "rounded-xl border border-[#D6D1C3] bg-white px-4 py-2.5 text-sm font-semibold text-[#C0392B] disabled:opacity-40";
const smallInput =
  "block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-3 py-2.5 text-base text-[#201E1B] min-h-[44px] focus:border-[#201E1B] focus:outline-none";

const STATUS_STYLE: Record<BikeStatus, string> = {
  requested: "border-[#E2C27A] bg-[#FFF3D6] text-[#96742A]",
  confirmed: "border-[#A9D1B8] bg-[#E6F2EA] text-[#2F6E48]",
  cancelled: "border-[#D6D1C3] bg-[#F1EEE6] text-[#5C5850]",
};
const STATUS_LABEL: Record<BikeStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

function StatusChip({ status }: { status: BikeStatus }) {
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ---------- photo thumbnails (deleted from Storage 7 days after check-out) ---------- */

function PhotoThumbs({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<(string | null)[] | null>(null);
  const key = paths.join("|");

  useEffect(() => {
    let cancelled = false;
    Promise.all(paths.map((p) => getDownloadURL(ref(storage, p)).catch(() => null))).then((u) => {
      if (!cancelled) setUrls(u);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (paths.length === 0) return <span className="text-xs text-[#8A857A]">No photos</span>;
  if (urls === null) return <span className="text-xs text-[#8A857A]">Loading photos…</span>;
  if (urls.every((u) => u === null)) return <span className="text-xs text-[#8A857A]">Photos deleted</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {urls.map((u, i) =>
        u ? (
          <a key={i} href={u} target="_blank" rel="noreferrer" aria-label={`Open photo ${i + 1}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt={`Bike photo ${i + 1}`} className="h-9 w-9 rounded-lg object-cover" />
          </a>
        ) : null,
      )}
      <span className="text-xs text-[#5C5850]">{paths.length}</span>
    </div>
  );
}

/* ---------- shared actions ---------- */

function rentalRef(r: Pick<BikeRental, "volunteerId" | "id">) {
  return doc(db, "flyerVolunteers", r.volunteerId, "bikeRentals", r.id);
}

/** The slot only counts if it belongs to this rental's volunteer. */
async function ownedSlotRef(r: BikeRental) {
  if (r.kind !== "rental" || !r.bike) return null;
  const sRef = doc(db, "flyerBikeSlots", slotId(r.day, r.bike));
  const snap = await getDoc(sRef);
  return snap.exists() && snap.get("volunteerId") === r.volunteerId ? sRef : null;
}

async function confirmRental(r: BikeRental) {
  const batch = writeBatch(db);
  batch.update(rentalRef(r), { status: "confirmed", updatedAt: serverTimestamp() });
  const slot = await ownedSlotRef(r);
  if (slot) batch.update(slot, { status: "confirmed" });
  await batch.commit();
}

/** Cancelling frees the bike for that day again. */
async function cancelRental(r: BikeRental) {
  const batch = writeBatch(db);
  batch.update(rentalRef(r), { status: "cancelled", updatedAt: serverTimestamp() });
  const slot = await ownedSlotRef(r);
  if (slot) batch.delete(slot);
  await batch.commit();
}

/* ---------- one rental row (used in the profile section and in the Bikes tab) ---------- */

function RentalRow({
  r,
  showName,
  first,
}: {
  r: BikeRental;
  showName?: boolean;
  first: boolean;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = r.status === "cancelled";

  async function run(kind: "confirm" | "cancel") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "confirm") await confirmRental(r);
      else await cancelRental(r);
      setAskCancel(false);
    } catch (err) {
      console.error("[admin] bike action failed:", err);
      setError("Couldn't save. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`px-4 py-3.5 ${first ? "" : "border-t border-[#E2DFD6]"}`}>
      <div className={`flex items-center gap-3 ${cancelled ? "opacity-60" : ""}`}>
        <span
          className="h-3 w-3 flex-none rounded-full"
          style={{ background: r.kind === "charge" ? "#8A857A" : bikeDot(r.bike) }}
        />
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] font-semibold ${cancelled ? "line-through" : ""}`}>
            {showName ? `${r.volunteerName} · ` : ""}
            {r.kind === "charge" ? "Extra charge" : bikeLabel(r.bike)}
          </p>
          <p className="text-sm text-[#5C5850]">
            {dayLabel(r.day)}
            {r.kind === "charge" && r.note ? ` · ${r.note}` : ""}
          </p>
        </div>
        {r.kind === "rental" && <StatusChip status={r.status} />}
        <p className={`w-16 text-right text-[15px] font-semibold ${cancelled ? "line-through" : ""}`}>{r.amount}</p>
      </div>

      {r.kind === "rental" && (
        <div className={`mt-2 ${cancelled ? "opacity-60" : ""}`}>
          <PhotoThumbs paths={r.photoPaths} />
        </div>
      )}
      {r.issues && (
        <p className="mt-2 rounded-lg bg-[#FFF3D6] px-3 py-2 text-sm text-[#96742A]">Reported: {r.issues}</p>
      )}

      {error && <p className="mt-2 text-sm text-red-800">{error}</p>}

      {!cancelled && !askCancel && (
        <div className="mt-2.5 flex justify-end gap-2">
          {r.status === "requested" && (
            <button type="button" disabled={busy !== null} onClick={() => run("confirm")} className={beigeButton}>
              {busy === "confirm" ? "Saving…" : "Confirm"}
            </button>
          )}
          <button type="button" disabled={busy !== null} onClick={() => setAskCancel(true)} className={dangerButton}>
            Cancel
          </button>
        </div>
      )}
      {askCancel && (
        <div className="mt-2.5 rounded-xl border border-red-300 bg-red-50 p-3">
          <p className="mb-2.5 text-sm text-red-900">
            Cancel this {r.kind === "charge" ? "charge" : "rental"}? It won&apos;t be charged
            {r.kind === "rental" ? " and the bike becomes available again." : "."}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy !== null} onClick={() => setAskCancel(false)} className={plainButton}>
              Keep
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("cancel")}
              className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel it"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- add rental / add charge (inline panel) ---------- */

function AddPanel({
  mode,
  volunteerId,
  volunteerName,
  adminEmail,
  onDone,
}: {
  mode: "rental" | "charge";
  volunteerId: string;
  volunteerName: string;
  adminEmail: string;
  onDone: () => void;
}) {
  const [day, setDay] = useState(bangkokToday());
  const [bike, setBike] = useState<BikeId>("red");
  const [amount, setAmount] = useState(mode === "rental" ? String(BIKE_PRICE_PER_DAY) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amt = Number(amount);
    if (!day) return setError("Please pick a date.");
    if (!Number.isFinite(amt) || amt <= 0) return setError("Please enter an amount.");
    if (mode === "charge" && !note.trim()) return setError("Please add a short note (e.g. mirror repair).");
    setBusy(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      if (mode === "rental") {
        const sRef = doc(db, "flyerBikeSlots", slotId(day, bike));
        const existing = await getDoc(sRef);
        if (existing.exists()) {
          setError(`${bikeLabel(bike)} is already booked for ${dayLabel(day)}.`);
          setBusy(false);
          return;
        }
        batch.set(sRef, { day, bike, volunteerId, status: "confirmed", createdAt: serverTimestamp() });
      }
      batch.set(doc(collection(db, "flyerVolunteers", volunteerId, "bikeRentals")), {
        kind: mode,
        volunteerId,
        volunteerName,
        day,
        bike: mode === "rental" ? bike : null,
        status: "confirmed",
        amount: Math.round(amt),
        issues: null,
        note: mode === "charge" ? note.trim() : null,
        photoPaths: [],
        createdBy: adminEmail,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onDone();
    } catch (err) {
      console.error("[admin] add bike entry failed:", err);
      setError("Couldn't save. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-b border-[#E2DFD6] bg-[#FBF9F4] px-4 py-4">
      <p className="text-sm font-semibold">{mode === "rental" ? "Add rental" : "Add extra charge"}</p>
      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor={`bike-day-${mode}`} className="mb-1 block text-xs font-medium text-[#5C5850]">
            Date
          </label>
          <input id={`bike-day-${mode}`} type="date" value={day} onChange={(e) => setDay(e.target.value)} className={smallInput} />
        </div>
        {mode === "rental" && (
          <div className="flex-1">
            <label htmlFor="bike-pick" className="mb-1 block text-xs font-medium text-[#5C5850]">
              Bike
            </label>
            <select id="bike-pick" value={bike} onChange={(e) => setBike(e.target.value as BikeId)} className={smallInput}>
              {BIKES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="w-24">
          <label htmlFor={`bike-amt-${mode}`} className="mb-1 block text-xs font-medium text-[#5C5850]">
            THB
          </label>
          <input
            id={`bike-amt-${mode}`}
            type="number"
            inputMode="numeric"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={smallInput}
          />
        </div>
      </div>
      {mode === "charge" && (
        <div>
          <label htmlFor="bike-note" className="mb-1 block text-xs font-medium text-[#5C5850]">
            Note
          </label>
          <input
            id="bike-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Mirror repair (shop receipt)"
            className={smallInput}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onDone} className={plainButton}>
          Close
        </button>
        <button type="button" disabled={busy} onClick={save} className={beigeButton}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ---------- section inside the volunteer profile ---------- */

export function VolunteerBikeSection({
  volunteerId,
  volunteerName,
  checkOutDate,
  adminEmail,
}: {
  volunteerId: string;
  volunteerName: string;
  checkOutDate: string;
  adminEmail: string;
}) {
  const [rentals, setRentals] = useState<BikeRental[] | null>(null);
  const [adding, setAdding] = useState<"rental" | "charge" | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers", volunteerId, "bikeRentals"),
      (snap) => setRentals(snap.docs.map((d) => parseRental(d.id, d.data())).sort(compareRentals)),
      (err) => {
        console.error("[admin] bike rentals listener failed:", err);
        setRentals([]);
      },
    );
  }, [volunteerId]);

  const total = rentals ? rentalTotal(rentals) : 0;
  const days = rentals ? rentals.filter((r) => r.kind === "rental" && r.status !== "cancelled").length : 0;
  const charges = rentals ? rentals.filter((r) => r.kind === "charge" && r.status !== "cancelled").length : 0;

  return (
    <div className={`${cardClass} mb-5 overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E2DFD6] bg-[#FBF9F4] px-4 py-3">
        <p className="flex-1 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">🏍️ Bike rentals</p>
        <button type="button" onClick={() => setAdding(adding === "rental" ? null : "rental")} className={plainButton}>
          + Add rental
        </button>
        <button type="button" onClick={() => setAdding(adding === "charge" ? null : "charge")} className={plainButton}>
          + Add charge
        </button>
      </div>

      {adding && (
        <AddPanel
          key={adding}
          mode={adding}
          volunteerId={volunteerId}
          volunteerName={volunteerName}
          adminEmail={adminEmail}
          onDone={() => setAdding(null)}
        />
      )}

      {rentals === null && <p className="px-4 py-4 text-sm text-[#5C5850]">Loading…</p>}
      {rentals !== null && rentals.length === 0 && <p className="px-4 py-4 text-sm text-[#5C5850]">No bike rentals yet.</p>}
      {rentals?.map((r, i) => <RentalRow key={r.id} r={r} first={i === 0} />)}

      <div className="flex items-center gap-3 border-t border-[#BDB6A2] bg-[#E9E4D6] px-4 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#5C5850]">
            Bikes – collect at check-out ({formatDmy(checkOutDate)})
          </p>
          <p className="mt-1 text-sm text-[#5C5850]">
            {days} {days === 1 ? "rental" : "rentals"} × {BIKE_PRICE_PER_DAY} THB
            {charges > 0 ? ` + ${charges} extra ${charges === 1 ? "charge" : "charges"}` : ""} · cancelled not counted
          </p>
        </div>
        <p className="text-2xl font-semibold">{formatThb(total)}</p>
      </div>
    </div>
  );
}

/* ---------- "Bikes" tab: today + who pays what at check-out ---------- */

type VolunteerLite = { id: string; name: string; checkOutDate: string; status: string };

export function BikesTab() {
  const [rentals, setRentals] = useState<BikeRental[] | null>(null);
  const [volunteers, setVolunteers] = useState<VolunteerLite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const today = bangkokToday();

  useEffect(() => {
    return onSnapshot(
      collectionGroup(db, "bikeRentals"),
      (snap) => setRentals(snap.docs.map((d) => parseRental(d.id, d.data())).sort(compareRentals)),
      (err) => {
        console.error("[admin] bike rentals (all) listener failed:", err);
        setLoadError("Couldn't load bike rentals. The Firestore rules for bike rentals may not be deployed yet.");
        setRentals([]);
      },
    );
  }, []);

  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers"),
      (snap) =>
        setVolunteers(
          snap.docs.map((d) => {
            const x = d.data();
            return {
              id: d.id,
              name: typeof x.name === "string" ? x.name : "",
              checkOutDate: typeof x.checkOutDate === "string" ? x.checkOutDate : "",
              status: typeof x.status === "string" ? x.status : "active",
            };
          }),
        ),
      (err) => console.error("[admin] volunteers listener failed:", err),
    );
  }, []);

  const todayByBike = useMemo(() => {
    const map: Partial<Record<BikeId, BikeRental>> = {};
    for (const r of rentals ?? []) {
      if (r.kind === "rental" && r.bike && r.day === today && r.status !== "cancelled" && !map[r.bike]) map[r.bike] = r;
    }
    return map;
  }, [rentals, today]);

  const toCollect = useMemo(() => {
    const byVol = new Map<string, BikeRental[]>();
    for (const r of rentals ?? []) byVol.set(r.volunteerId, [...(byVol.get(r.volunteerId) ?? []), r]);
    return volunteers
      .filter((v) => v.status === "active")
      .map((v) => {
        const list = byVol.get(v.id) ?? [];
        return {
          v,
          total: rentalTotal(list),
          count: list.filter((r) => r.kind === "rental" && r.status !== "cancelled").length,
        };
      })
      .filter((x) => x.total > 0)
      .sort((a, b) => a.v.checkOutDate.localeCompare(b.v.checkOutDate));
  }, [rentals, volunteers]);

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">🏍️ Bikes today</p>
      <h2 className="mb-4 mt-1 text-xl font-semibold">{longDayLabel(today)}</h2>

      {loadError && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {loadError}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {BIKES.map((b) => {
          const r = todayByBike[b.id];
          return (
            <div
              key={b.id}
              className={`rounded-2xl p-4 ${r ? "border border-[#E2DFD6] bg-white" : "border border-dashed border-[#D6D1C3] bg-[#FBF9F4]"}`}
            >
              <p className="flex items-center gap-2 text-base font-semibold">
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: b.dot }} />
                {b.label}
              </p>
              {r ? (
                <div className="mt-2 space-y-2">
                  <p className="text-[15px] font-semibold">{r.volunteerName}</p>
                  <StatusChip status={r.status} />
                  <PhotoThumbs paths={r.photoPaths} />
                  {r.issues && (
                    <p className="rounded-lg bg-[#FFF3D6] px-3 py-2 text-sm text-[#96742A]">Reported: {r.issues}</p>
                  )}
                  <TodayActions r={r} />
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <p className="text-[15px] text-[#5C5850]">Free today</p>
                  <span className="inline-block rounded-full border border-[#A9D1B8] bg-[#E6F2EA] px-2.5 py-0.5 text-xs font-semibold text-[#2F6E48]">
                    Available
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Bikes to collect at check-out</p>
      <div className={`${cardClass} overflow-hidden`}>
        {rentals === null && <p className="px-4 py-4 text-sm text-[#5C5850]">Loading…</p>}
        {rentals !== null && toCollect.length === 0 && (
          <p className="px-4 py-4 text-sm text-[#5C5850]">Nothing to collect right now.</p>
        )}
        {toCollect.map(({ v, total, count }, i) => (
          <div key={v.id} className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? "border-t border-[#E2DFD6]" : ""}`}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{v.name}</p>
              <p className="text-sm text-[#5C5850]">
                Check-out {dayLabel(v.checkOutDate)} · {count} {count === 1 ? "rental" : "rentals"}
              </p>
            </div>
            <p className="text-base font-semibold">{formatThb(total)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TodayActions({ r }: { r: BikeRental }) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "confirm" | "cancel") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "confirm") await confirmRental(r);
      else await cancelRental(r);
      setAskCancel(false);
    } catch (err) {
      console.error("[admin] bike action failed:", err);
      setError("Couldn't save. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (askCancel) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-3">
        <p className="mb-2.5 text-sm text-red-900">Cancel this rental? The bike becomes available again.</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy !== null} onClick={() => setAskCancel(false)} className={`${plainButton} flex-1`}>
            Keep
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("cancel")}
            className="flex-1 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel it"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-2">
        {r.status === "requested" && (
          <button type="button" disabled={busy !== null} onClick={() => run("confirm")} className={`${beigeButton} flex-1`}>
            {busy === "confirm" ? "Saving…" : "Confirm"}
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => setAskCancel(true)} className={`${dangerButton} flex-1`}>
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-800">{error}</p>}
    </div>
  );
}
