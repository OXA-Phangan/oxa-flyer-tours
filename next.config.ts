import { PHASE_PRODUCTION_BUILD } from "next/constants";
import type { NextConfig } from "next";

// Build ID baked into the client bundle (and the server bundle) at build time,
// so an open tab knows which deploy it is running — compared against the live
// value from app/api/version by components/UpdateAvailableBanner.tsx.
//
// Only set for production builds: in local dev it stays empty, which disables
// the check. It is stored on process.env so that if Next re-evaluates this
// config in a worker during the same build, every evaluation sees the same
// value (a mismatch between client and server bundles would make the banner
// show permanently).
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD && !process.env.NEXT_PUBLIC_BUILD_ID) {
    process.env.NEXT_PUBLIC_BUILD_ID = `${Date.now()}`;
  }
  return {
    env: {
      NEXT_PUBLIC_BUILD_ID: process.env.NEXT_PUBLIC_BUILD_ID ?? "",
    },
  };
}
