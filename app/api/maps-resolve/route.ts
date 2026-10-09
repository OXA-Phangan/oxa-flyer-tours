// Resolves a Google Maps short link (maps.app.goo.gl/…) to coordinates by following its
// redirects on the server, so the portal can open it in a format the Maps app accepts.
import { extractLatLng, isShortMapsLink } from "@/lib/maps-link";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("u") ?? "";
  // Only Google's own short-link host — never an arbitrary URL (no open proxy / SSRF).
  if (!isShortMapsLink(target)) return Response.json({ error: "unsupported" }, { status: 400 });

  let current = target;
  for (let hop = 0; hop < 6; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(6000) });
    } catch {
      return Response.json({ error: "unreachable" }, { status: 502 });
    }
    const location = res.headers.get("location");
    if (!location) break;
    current = new URL(location, current).toString();
    const host = new URL(current).hostname;
    if (!/(^|\.)google\.[a-z.]+$|(^|\.)goo\.gl$/.test(host)) break;
    const found = extractLatLng(current);
    if (found) {
      return Response.json(found, { headers: { "Cache-Control": "public, max-age=86400" } });
    }
  }
  return Response.json({ error: "no-coordinates" }, { status: 404 });
}
