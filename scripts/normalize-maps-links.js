// Rewrites every spot.mapsLink in flyerRoutes into the format all Google Maps apps accept:
//   https://www.google.com/maps/search/?api=1&query=<lat>,<lng>
// (maps.app.goo.gl short links are followed first to find the coordinates).
//
// DRY RUN by default: prints old -> new for every link, writes NOTHING.
//   node scripts/normalize-maps-links.js
// Apply (also writes a backup file next to the script first):
//   node scripts/normalize-maps-links.js --apply
//
// Auth like import-flyer-routes.js: GOOGLE_APPLICATION_CREDENTIALS=<key.json> or `gcloud auth application-default login`.
// Links that can't be resolved are left untouched and listed at the end.

const fs = require("fs");
const path = require("path");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const APPLY = process.argv.includes("--apply");

initializeApp({ credential: applicationDefault(), projectId: "oxa-ticket-app" });
const db = getFirestore();

const ok = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function extractLatLng(url) {
  let text = url;
  try { text = decodeURIComponent(url); } catch {}
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  if (m && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
  m = /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)[, +]+(-?\d+(?:\.\d+)?)/.exec(text);
  if (m && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
  m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (m && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] };
  return null;
}

function isShort(url) {
  try {
    const u = new URL(url);
    return u.hostname === "maps.app.goo.gl" || (u.hostname === "goo.gl" && u.pathname.startsWith("/maps"));
  } catch { return false; }
}

async function resolveShort(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return null;
    current = new URL(loc, current).toString();
    const found = extractLatLng(current);
    if (found) return found;
  }
  return null;
}

const newUrl = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

async function convert(link) {
  if (/[?&]api=1&query=-?\d/.test(link)) return { link }; // already in the target format
  const direct = extractLatLng(link);
  if (direct) return { link: newUrl(direct) };
  if (isShort(link)) {
    try {
      const c = await resolveShort(link);
      if (c) return { link: newUrl(c) };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }
  return { error: "no coordinates found" };
}

async function main() {
  const snap = await db.collection("flyerRoutes").get();
  const failures = [];
  const updates = [];
  let total = 0, changed = 0;

  for (const d of snap.docs) {
    const data = d.data();
    const spots = Array.isArray(data.spots) ? data.spots : [];
    let touched = false;
    const next = [];
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      const old = typeof sp.mapsLink === "string" ? sp.mapsLink.trim() : "";
      if (!old) { next.push(sp); continue; }
      total++;
      const r = await convert(old);
      if (r.error) {
        failures.push(`${data.region} / ${data.name} #${i + 1} ${sp.name}: ${old}  (${r.error})`);
        next.push(sp);
      } else if (r.link !== old) {
        changed++;
        touched = true;
        console.log(`${data.region} / ${data.name} #${i + 1} ${sp.name}\n  alt: ${old}\n  neu: ${r.link}`);
        next.push({ ...sp, mapsLink: r.link });
      } else {
        next.push(sp);
      }
    }
    if (touched) updates.push({ ref: d.ref, id: d.id, before: spots, after: next });
  }

  console.log(`\n${total} Links gefunden, ${changed} würden umgestellt, ${failures.length} nicht auflösbar.`);
  if (failures.length) console.log("\nNICHT aufgelöst (bleiben unverändert):\n" + failures.join("\n"));

  if (!APPLY) {
    console.log("\nDRY RUN — nichts geschrieben. Zum Anwenden: node scripts/normalize-maps-links.js --apply");
    return;
  }
  const backup = path.join(__dirname, `maps-links-backup-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(updates.map((u) => ({ id: u.id, spots: u.before })), null, 2));
  console.log(`\nBackup: ${backup}`);
  for (const u of updates) await u.ref.update({ spots: u.after });
  console.log(`${updates.length} Touren aktualisiert.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
