"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, getDoc, onSnapshot, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";
import { bangkokToday, dayLabel, longDayLabel } from "@/lib/shifts";
import {
  BIKES,
  BIKE_PRICE_PER_DAY,
  BIKE_TERMS,
  activeRentalCount,
  bikeDot,
  bikeLabel,
  compareRentals,
  formatDmy,
  formatThb,
  parseRental,
  rentalTotal,
  slotId,
  uploadBikePhoto,
  type BikeId,
  type BikeRental,
  type BikeStatus,
} from "@/lib/bike";

const MAX_PHOTOS = 8;

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";
const bikeButton =
  "w-full rounded-2xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";
const fieldLabel = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#8A857A]";

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

type Photo = { id: number; blob: Blob; url: string };
type View = "overview" | "form" | "confirm";

export default function BikeRental({
  token,
  volunteerName,
  checkOutDate,
  onClose,
}: {
  token: string;
  volunteerName: string;
  checkOutDate: string;
  onClose: () => void;
}) {
  const today = useMemo(() => bangkokToday(), []);
  const [view, setView] = useState<View>("overview");
  const [rentals, setRentals] = useState<BikeRental[] | null>(null);
  const [taken, setTaken] = useState<Record<BikeId, boolean | null>>({ red: null, blue: null });

  const [bike, setBike] = useState<BikeId | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [issues, setIssues] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentBike, setSentBike] = useState<BikeId | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photoId = useRef(0);
  const photosRef = useRef<Photo[]>([]);
  photosRef.current = photos;

  // This volunteer's rentals (live).
  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers", token, "bikeRentals"),
      (snap) => setRentals(snap.docs.map((d) => parseRental(d.id, d.data())).sort(compareRentals)),
      (err) => {
        console.error("[bike] rentals listener failed:", err);
        setRentals([]);
      },
    );
  }, [token]);

  // Which bikes are already requested for today (live, one tiny doc per bike).
  useEffect(() => {
    const unsubs = BIKES.map((b) =>
      onSnapshot(
        doc(db, "flyerBikeSlots", slotId(today, b.id)),
        (snap) => setTaken((t) => ({ ...t, [b.id]: snap.exists() })),
        (err) => {
          console.error("[bike] slot listener failed:", err);
          setTaken((t) => ({ ...t, [b.id]: false }));
        },
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [today]);

  // Free the preview object URLs on unmount.
  useEffect(() => {
    return () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url));
  }, []);

  // A bike that was free when picked may get taken meanwhile.
  useEffect(() => {
    if (bike && taken[bike]) setBike(null);
  }, [bike, taken]);

  const total = rentals ? rentalTotal(rentals) : 0;
  const days = rentals ? activeRentalCount(rentals) : 0;
  const slotsLoading = taken.red === null || taken.blue === null;
  const noneFree = !slotsLoading && taken.red === true && taken.blue === true;
  const canSubmit = !!bike && accepted && photos.length > 0 && !busy;

  function openForm() {
    setBike(null);
    setAccepted(false);
    setIssues("");
    setError(null);
    setPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setView("form");
  }

  async function addPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || photos.length >= MAX_PHOTOS) return;
    const blob = await compressImageFile(file);
    const id = ++photoId.current;
    setPhotos((prev) => [...prev, { id, blob, url: URL.createObjectURL(blob) }]);
  }

  function removePhoto(id: number) {
    setPhotos((prev) => {
      const p = prev.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.url);
      return prev.filter((x) => x.id !== id);
    });
  }

  async function submit() {
    if (!bike || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const paths: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        paths.push(await uploadBikePhoto(token, photos[i].blob, today, bike, i));
      }
      const batch = writeBatch(db);
      // The slot is create-only: if someone else got this bike first, the whole batch fails.
      batch.set(doc(db, "flyerBikeSlots", slotId(today, bike)), {
        day: today,
        bike,
        volunteerId: token,
        status: "requested",
        createdAt: serverTimestamp(),
      });
      batch.set(doc(collection(db, "flyerVolunteers", token, "bikeRentals")), {
        kind: "rental",
        volunteerId: token,
        volunteerName,
        day: today,
        bike,
        status: "requested",
        amount: BIKE_PRICE_PER_DAY,
        issues: issues.trim() || null,
        note: null,
        photoPaths: paths,
        createdBy: "volunteer",
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setSentBike(bike);
      setView("confirm");
    } catch (err) {
      console.error("[bike] request failed:", err);
      let msg = "Couldn't send your request. Please check your connection and try again.";
      try {
        const slot = await getDoc(doc(db, "flyerBikeSlots", slotId(today, bike)));
        if (slot.exists() && slot.get("volunteerId") !== token) {
          msg = `The ${bikeLabel(bike)} was just requested by someone else. Please pick another bike.`;
          setBike(null);
        }
      } catch {
        /* keep the generic message */
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#EFEDE7] px-4 py-6 text-[#201E1B]">
      <div className="mx-auto w-full max-w-md">
        {view !== "confirm" && (
          <div className="mb-5 flex items-center gap-3">
            <button
              type="button"
              aria-label="Back"
              onClick={() => (view === "form" && !busy ? setView("overview") : view === "overview" ? onClose() : undefined)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#E2DFD6] bg-white text-xl"
            >
              ←
            </button>
            <h1 className="text-xl font-semibold">{view === "form" ? "Request a bike" : "Rent a bike"}</h1>
          </div>
        )}

        {view === "overview" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#BDB6A2] bg-[#E9E4D6] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#5C5850]">To pay at check-out (bikes)</p>
              <p className="mt-1 text-3xl font-semibold">{formatThb(total)}</p>
              <p className="mt-1 text-sm text-[#5C5850]">
                {days} {days === 1 ? "day" : "days"} × {BIKE_PRICE_PER_DAY} THB · check-out {formatDmy(checkOutDate)}
              </p>
            </div>

            <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Your rentals</p>
            <div className={`${cardClass} overflow-hidden`}>
              {rentals === null && <p className="p-4 text-sm text-[#5C5850]">Loading…</p>}
              {rentals !== null && rentals.length === 0 && (
                <p className="p-4 text-sm text-[#5C5850]">No rentals yet.</p>
              )}
              {rentals?.map((r, i) => (
                <div
                  key={r.id}
                  className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? "border-t border-[#E2DFD6]" : ""} ${
                    r.status === "cancelled" ? "opacity-60" : ""
                  }`}
                >
                  <span
                    className="h-3.5 w-3.5 flex-none rounded-full"
                    style={{ background: r.kind === "charge" ? "#8A857A" : bikeDot(r.bike) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`font-semibold ${r.status === "cancelled" ? "line-through" : ""}`}>
                      {r.kind === "charge" ? "Extra charge" : bikeLabel(r.bike)}
                    </p>
                    <p className="text-sm text-[#5C5850]">
                      {dayLabel(r.day)} ·{" "}
                      {r.status === "cancelled" ? "not charged" : formatThb(r.amount)}
                      {r.kind === "charge" && r.note ? ` · ${r.note}` : ""}
                    </p>
                  </div>
                  {r.kind === "rental" && (
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="text-sm leading-relaxed text-[#5C5850]">
              Bike rentals are settled together with your check-out. Questions? Message OXA.
            </p>

            <button type="button" onClick={openForm} className={bikeButton}>
              Rent a bike for today
            </button>
          </div>
        )}

        {view === "form" && (
          <div className="space-y-4">
            <div className={`${cardClass} p-4`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8A857A]">Rental day</p>
              <p className="mt-1 font-semibold">Today · {longDayLabel(today)}</p>
              <p className="mt-0.5 text-sm text-[#5C5850]">Bikes can only be rented for the current day.</p>
            </div>

            <div>
              <p className={fieldLabel}>Which bike?</p>
              <div className="flex gap-3">
                {BIKES.map((b) => {
                  const isTaken = taken[b.id] === true;
                  const selected = bike === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      disabled={isTaken || slotsLoading}
                      onClick={() => setBike(b.id)}
                      aria-pressed={selected}
                      className={`flex min-h-[92px] flex-1 flex-col gap-1.5 rounded-2xl p-3.5 text-left disabled:cursor-not-allowed ${
                        isTaken
                          ? "border border-[#E2DFD6] bg-[#F1EEE6] text-[#8A857A]"
                          : selected
                            ? "border-2 border-[#BDB6A2] bg-[#E9E4D6]"
                            : "border border-[#E2DFD6] bg-white"
                      }`}
                    >
                      <span className="flex items-center gap-2 text-base font-semibold">
                        <span
                          className="h-3.5 w-3.5 rounded-full"
                          style={{ background: b.dot, opacity: isTaken ? 0.5 : 1 }}
                        />
                        {b.label}
                      </span>
                      <span className={`text-sm font-semibold ${isTaken ? "text-[#5C5850]" : "text-[#2F6E48]"}`}>
                        {slotsLoading ? "Checking…" : isTaken ? "Already requested today" : "Available today ✓"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {noneFree && (
                <p className="mt-2 text-sm text-[#5C5850]">Both bikes are already requested for today.</p>
              )}
            </div>

            <div className="rounded-2xl border border-[#E2DFD6] bg-[#FBF9F4] p-4">
              <p className="mb-2 font-semibold">Bike Rental Terms &amp; Conditions</p>
              <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                {BIKE_TERMS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>

            <label className="flex min-h-[44px] items-start gap-3 text-[15px] font-medium leading-snug">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 h-6 w-6 flex-none accent-[#8A7F63]"
              />
              <span>I accept the Bike Rental Terms &amp; Conditions as written above.</span>
            </label>

            <div>
              <p className={fieldLabel}>Photos of the bike right now</p>
              <p className="mb-2.5 text-sm leading-snug text-[#5C5850]">
                Show all existing damages – scratches, dents, everything. Add as many as you need.
              </p>
              {photos.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2.5">
                  {photos.map((p) => (
                    <div key={p.id} className="relative h-[84px] w-[84px]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt="Bike photo" className="h-full w-full rounded-xl object-cover" />
                      <button
                        type="button"
                        aria-label="Remove photo"
                        disabled={busy}
                        onClick={() => removePhoto(p.id)}
                        className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#201E1B] text-sm text-white"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                disabled={busy || photos.length >= MAX_PHOTOS}
                onClick={() => cameraRef.current?.click()}
                className="min-h-[48px] w-full rounded-2xl border border-[#D6D1C3] bg-white px-4 text-[15px] font-semibold disabled:opacity-40"
              >
                📷 Take photo
              </button>
              <p className="mt-1.5 text-xs text-[#8A857A]">Photos must be taken live with your camera.</p>
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={addPhoto} className="hidden" />
            </div>

            <div>
              <label htmlFor="bikeIssues" className={fieldLabel}>
                Anything not working? (optional)
              </label>
              <textarea
                id="bikeIssues"
                rows={3}
                value={issues}
                onChange={(e) => setIssues(e.target.value)}
                placeholder="e.g. rear light flickers, brake feels soft"
                className="block w-full resize-none rounded-xl border border-[#D6D1C3] bg-white px-3 py-3 text-base focus:border-[#201E1B] focus:outline-none"
              />
            </div>

            {error && (
              <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                {error}
              </div>
            )}

            <button type="button" disabled={!canSubmit} onClick={submit} className={bikeButton}>
              {busy ? "Sending…" : `Request Rental · ${BIKE_PRICE_PER_DAY} THB`}
            </button>
            {!canSubmit && !busy && (
              <p className="text-center text-xs text-[#8A857A]">
                Pick a bike, accept the terms and add at least one photo.
              </p>
            )}
          </div>
        )}

        {view === "confirm" && (
          <div className="flex min-h-[80vh] flex-col">
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-[#A9D1B8] bg-[#E6F2EA] text-3xl text-[#2F6E48]">
                ✓
              </div>
              <h1 className="text-2xl font-semibold">Request sent</h1>
              <p className="max-w-[310px] text-base leading-relaxed">
                Your rental request has been sent. Please inform Mo or another team member about your rental request so
                they can process it faster. Drive safe :)
              </p>
              {sentBike && (
                <div className={`${cardClass} mt-2 flex w-full items-center gap-3 px-4 py-3.5 text-left`}>
                  <span className="h-3.5 w-3.5 flex-none rounded-full" style={{ background: bikeDot(sentBike) }} />
                  <div className="flex-1">
                    <p className="font-semibold">{bikeLabel(sentBike)}</p>
                    <p className="text-sm text-[#5C5850]">
                      {dayLabel(today)} · {formatThb(BIKE_PRICE_PER_DAY)}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE.requested}`}>
                    Requested
                  </span>
                </div>
              )}
            </div>
            <button type="button" onClick={() => setView("overview")} className={bikeButton}>
              Back to my rentals
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
