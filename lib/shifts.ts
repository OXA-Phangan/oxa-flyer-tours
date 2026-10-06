import type { Timestamp } from "firebase/firestore";

/**
 * A planned shift, stored at flyerVolunteers/{token}/shifts/{shiftId}.
 *
 * The OXA Employee Portal calendar reads these (collection group "shifts"),
 * so the field names are a contract — do not rename them casually:
 *   date        "YYYY-MM-DD" (Asia/Bangkok calendar day)
 *   startTime / endTime  "HH:MM" (Asia/Bangkok)
 *   tourId / tourName / tourRegion  null for a shift without a tour
 *   volunteerToken / volunteerName  denormalised so a calendar needs no join
 */
export type FlyerShift = {
  id: string;
  volunteerToken: string;
  volunteerName: string;
  date: string;
  startTime: string;
  endTime: string;
  tourId: string | null;
  tourName: string | null;
  tourRegion: string | null;
  note: string | null;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
  createdBy?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // Thailand has no DST
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Today's calendar day in Asia/Bangkok, "YYYY-MM-DD". */
export function bangkokToday(): string {
  return new Date(Date.now() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(parseDay(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const dow = (new Date(parseDay(date)).getUTCDay() + 6) % 7; // Mon = 0
  return addDays(date, -dow);
}

export function dowShort(date: string): string {
  return DOW[new Date(parseDay(date)).getUTCDay()];
}

/** "5 Oct" */
export function dayMonth(date: string): string {
  const dt = new Date(parseDay(date));
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

/** "Mon 5 Oct" */
export function dayLabel(date: string): string {
  return `${dowShort(date)} ${dayMonth(date)}`;
}

export function compareShifts(a: FlyerShift, b: FlyerShift): number {
  return a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime);
}

/** "Region – Tour name", or null for a shift without a tour. */
export function tourLabel(s: Pick<FlyerShift, "tourName" | "tourRegion">): string | null {
  if (!s.tourName) return null;
  return s.tourRegion ? `${s.tourRegion} – ${s.tourName}` : s.tourName;
}
