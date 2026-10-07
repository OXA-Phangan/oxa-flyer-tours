import type { Timestamp } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";

/**
 * Bike rental ("Red Bike" / "Blue Bike") shared types + helpers.
 *
 * Firestore:
 *   flyerVolunteers/{token}/bikeRentals/{autoId}   one rental / extra charge per doc
 *       kind "rental" | "charge", volunteerId, volunteerName, day "YYYY-MM-DD",
 *       bike "red" | "blue" | null (charge), status, amount (THB), issues, note,
 *       photoPaths[], createdBy ("volunteer" | admin e-mail), createdAt.
 *   flyerBikeSlots/{day}_{bike}                    one doc per bike per day.
 *       Created together with the rental (batch). Because it is create-only for
 *       volunteers, a bike can never be requested twice for the same day, even
 *       when two volunteers submit at the same moment. Deleted when OXA cancels.
 *
 * Storage: flyerBike/{token}/{file}.jpg  (deleted 7 days after check-out).
 */

export const BIKE_PRICE_PER_DAY = 150;

export type BikeId = "red" | "blue";
export type BikeStatus = "requested" | "confirmed" | "cancelled";
export type BikeKind = "rental" | "charge";

export const BIKES: { id: BikeId; label: string; dot: string }[] = [
  { id: "red", label: "Red Bike", dot: "#C0392B" },
  { id: "blue", label: "Blue Bike", dot: "#2F5FA8" },
];

export function bikeLabel(id: BikeId | null): string {
  return BIKES.find((b) => b.id === id)?.label ?? "Bike";
}

export function bikeDot(id: BikeId | null): string {
  return BIKES.find((b) => b.id === id)?.dot ?? "#8A857A";
}

export const BIKE_TERMS = [
  "Price per day: 150 THB (one calendar day – not 24h).",
  "Volunteer must return the bike with a full tank.",
  "Volunteer must take pictures of the bike before renting to show all existing damages and report if something is not working (lights, brakes, …).",
  "Volunteer pays for any damage happening during the rental time, as charged by the bike repair shop.",
];

export type BikeRental = {
  id: string;
  kind: BikeKind;
  volunteerId: string;
  volunteerName: string;
  day: string;
  bike: BikeId | null;
  status: BikeStatus;
  amount: number;
  issues: string | null;
  note: string | null;
  photoPaths: string[];
  createdBy: string;
  createdAt: Timestamp | null;
};

export type BikeSlot = {
  day: string;
  bike: BikeId;
  volunteerId: string;
  status: BikeStatus;
};

export function slotId(day: string, bike: BikeId): string {
  return `${day}_${bike}`;
}

export function parseRental(id: string, d: Record<string, unknown>): BikeRental {
  const bike = d.bike === "red" || d.bike === "blue" ? d.bike : null;
  const status: BikeStatus = d.status === "confirmed" || d.status === "cancelled" ? d.status : "requested";
  return {
    id,
    kind: d.kind === "charge" ? "charge" : "rental",
    volunteerId: typeof d.volunteerId === "string" ? d.volunteerId : "",
    volunteerName: typeof d.volunteerName === "string" ? d.volunteerName : "",
    day: typeof d.day === "string" ? d.day : "",
    bike,
    status,
    amount: typeof d.amount === "number" ? d.amount : 0,
    issues: typeof d.issues === "string" && d.issues ? d.issues : null,
    note: typeof d.note === "string" && d.note ? d.note : null,
    photoPaths: Array.isArray(d.photoPaths) ? d.photoPaths.filter((p): p is string => typeof p === "string") : [],
    createdBy: typeof d.createdBy === "string" ? d.createdBy : "",
    createdAt: (d.createdAt as Timestamp | undefined) ?? null,
  };
}

/** Newest day first; within a day, newest created first. */
export function compareRentals(a: BikeRental, b: BikeRental): number {
  return (
    b.day.localeCompare(a.day) ||
    (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
  );
}

/** Cancelled rentals are not charged. */
export function rentalTotal(rentals: BikeRental[]): number {
  return rentals.reduce((sum, r) => (r.status === "cancelled" ? sum : sum + r.amount), 0);
}

export function activeRentalCount(rentals: BikeRental[]): number {
  return rentals.filter((r) => r.kind === "rental" && r.status !== "cancelled").length;
}

/** "2026-10-12" → "12.10.2026" */
export function formatDmy(date: string): string {
  const [y, m, d] = date.split("-");
  return y && m && d ? `${d}.${m}.${y}` : date;
}

export function formatThb(amount: number): string {
  return `${amount.toLocaleString("en-US")} THB`;
}

/** Compresses (max 1024 px) and uploads one live bike photo; returns its Storage path. */
export async function uploadBikePhoto(token: string, file: File | Blob, day: string, bike: BikeId, index: number) {
  const compressed = await compressImageFile(file);
  const path = `flyerBike/${token}/${day}_${bike}_${index}_${Date.now()}.jpg`;
  await uploadBytes(ref(storage, path), compressed, { contentType: "image/jpeg" });
  return path;
}
