// Google Maps links: the Maps app on some phones answers "Unsupported link" for share links
// (maps.app.goo.gl short links, long /place/…/data=… links). The official
// https://www.google.com/maps/search/?api=1&query=… format is accepted everywhere, so we
// turn a stored link into that format before opening it.

export type LatLng = { lat: number; lng: number };

function valid(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Pulls coordinates out of a long Google Maps URL (pin first, then map centre, then q=/query=). */
export function extractLatLng(url: string): LatLng | null {
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    /* keep raw */
  }
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  if (pin && valid(+pin[1], +pin[2])) return { lat: +pin[1], lng: +pin[2] };
  const query = /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)[, +]+(-?\d+(?:\.\d+)?)/.exec(text);
  if (query && valid(+query[1], +query[2])) return { lat: +query[1], lng: +query[2] };
  const centre = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (centre && valid(+centre[1], +centre[2])) return { lat: +centre[1], lng: +centre[2] };
  return null;
}

export function isShortMapsLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "maps.app.goo.gl" || (u.hostname === "goo.gl" && u.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

export function searchUrl({ lat, lng }: LatLng): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
