import type React from "react";
import { extractLatLng, extractPlaceName, isShortMapsLink, searchUrl, searchUrlByName } from "@/lib/maps-link";

/**
 * Opens a stored Google Maps link in the format every Maps app accepts
 * (see lib/maps-link.ts). Falls back to the stored link if anything goes wrong.
 */
export function openMapsLink(e: React.MouseEvent<HTMLAnchorElement>, link: string, query?: string | null) {
  // Goal: tap -> Google Maps APP opens directly (iOS asks once "Open in Google Maps?"), the
  // tour portal stays untouched. The app is addressed via its URL scheme, which never
  // replaces the current page. Desktop browsers get the web version in a new tab.
  e.preventDefault();
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);

  const launch = (c: { name?: string | null; lat?: number; lng?: number } | null) => {
    const name = query || c?.name || extractPlaceName(link);
    const ll = typeof c?.lat === "number" && typeof c?.lng === "number" ? { lat: c.lat, lng: c.lng } : extractLatLng(link);
    const web = name ? searchUrlByName(name) : ll ? searchUrl(ll) : link;
    const q = name ? encodeURIComponent(name) : ll ? `${ll.lat},${ll.lng}` : null;
    const openWeb = () => {
      window.open(web, "_blank");
    };
    if (!q || !(isIOS || isAndroid)) {
      openWeb();
      return;
    }
    const appUrl = isIOS ? `comgooglemaps://?q=${q}` : `geo:0,0?q=${q}`;
    window.location.href = appUrl;
  };

  const direct = query || extractPlaceName(link) || extractLatLng(link);
  if (direct || !isShortMapsLink(link)) {
    launch(null);
    return;
  }
  fetch(`/api/maps-resolve?u=${encodeURIComponent(link)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => launch(c))
    .catch(() => launch(null));
}
