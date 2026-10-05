// The build ID of whatever deployment is live right now — never cached, so a
// tab still running an older bundle can notice it's stale. See
// components/UpdateAvailableBanner.tsx and next.config.ts.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { version: process.env.NEXT_PUBLIC_BUILD_ID ?? "" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
