// Builds the shared spot library (flyerSpots) from the spots embedded in all flyerRoutes and
// points the tours at it. Break and Scooter-Info entries stay inside their tour.
//
// DRY RUN by default: prints what would be merged, writes NOTHING and also writes a readable
// report file next to the script.
//   node scripts/migrate-spots-to-library.js
// Apply (backup of all routes first; safe to re-run, already migrated entries are skipped):
//   node scripts/migrate-spots-to-library.js --apply
//
// Merge rule: two spots are the same spot if they have the same NAME (case/spacing ignored) OR the
// same Google Maps link / place. Per library spot: most common name, link and instruction text win.
// A tour whose instruction text differs keeps its own text as an "override" (nothing is lost).
//
// Auth like import-flyer-routes.js: GOOGLE_APPLICATION_CREDENTIALS=<key.json> or `gcloud auth application-default login`.

const fs = require("fs");
const path = require("path");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const APPLY = process.argv.includes("--apply");

initializeApp({ credential: applicationDefault(), projectId: "oxa-ticket-app" });
const db = getFirestore();

// ---- Maps helpers (same logic as lib/maps-link.ts) ----
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
function extractPlaceName(url) {
  const m = /\/maps\/place\/([^/@?]+)/.exec(url);
  if (!m) return null;
  let name = m[1];
  try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { name = name.replace(/\+/g, " "); }
  name = name.trim();
  if (!name || /^-?\d+(\.\d+)?[, ]+-?\d+(\.\d+)?$/.test(name)) return null;
  return name;
}
function isShort(url) {
  try {
    const u = new URL(url);
    return u.hostname === "maps.app.goo.gl" || (u.hostname === "goo.gl" && u.pathname.startsWith("/maps"));
  } catch { return false; }
}
// Follows a short link; returns { name, ll } (either may be null).
async function resolveShort(url) {
  let current = url, name = null, ll = null;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) break;
    current = new URL(loc, current).toString();
    name = name || extractPlaceName(current);
    ll = ll || extractLatLng(current);
    if (name && ll) break;
  }
  return { name, ll };
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const mostCommon = (arr) => {
  const counts = new Map();
  for (const v of arr) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
};

async function mapsInfo(link, cache) {
  if (!link) return { name: null, key: null };
  if (cache.has(link)) return cache.get(link);
  let name = extractPlaceName(link);
  let ll = extractLatLng(link);
  if ((!name || !ll) && isShort(link)) {
    try {
      const r = await resolveShort(link);
      name = name || r.name;
      ll = ll || r.ll;
    } catch {}
  }
  const key = ll ? `ll:${ll.lat.toFixed(4)},${ll.lng.toFixed(4)}` : name ? `nm:${norm(name)}` : `ln:${link}`;
  const info = { name, key };
  cache.set(link, info);
  return info;
}

async function main() {
  const [routesSnap, libSnap] = await Promise.all([db.collection("flyerRoutes").get(), db.collection("flyerSpots").get()]);
  const cache = new Map();

  // Existing library spots (from an earlier run) are reused by name.
  const existingByName = new Map();
  libSnap.docs.forEach((d) => existingByName.set(norm(d.data().name), d.id));

  // 1. Collect every embedded NORMAL spot.
  const items = []; // { routeId, routeLabel, index, spot, nameKey, mapsKey, mapsName }
  const routes = routesSnap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() }));
  for (const r of routes) {
    const label = `${r.data.region} / ${r.data.name}`;
    const spots = Array.isArray(r.data.spots) ? r.data.spots : [];
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (sp.spotId || (sp.type && sp.type !== "NORMAL")) continue;
      const link = typeof sp.mapsLink === "string" ? sp.mapsLink.trim() : "";
      const info = await mapsInfo(link, cache);
      items.push({ routeId: r.id, routeLabel: label, index: i, spot: sp, link, nameKey: norm(sp.name), mapsKey: info.key, mapsName: info.name });
    }
  }

  // 2. Union by name OR maps key.
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const byName = new Map(), byMaps = new Map();
  items.forEach((it, i) => {
    if (it.nameKey) { if (byName.has(it.nameKey)) union(i, byName.get(it.nameKey)); else byName.set(it.nameKey, i); }
    if (it.mapsKey) { if (byMaps.has(it.mapsKey)) union(i, byMaps.get(it.mapsKey)); else byMaps.set(it.mapsKey, i); }
  });
  const groups = new Map();
  items.forEach((it, i) => { const g = find(i); groups.set(g, [...(groups.get(g) || []), it]); });

  // 3. Build library spots.
  const lib = [];
  for (const members of groups.values()) {
    const name = mostCommon(members.map((m) => m.spot.name.trim()));
    const mapsLink = mostCommon(members.map((m) => m.link));
    const mapsName = mostCommon(members.map((m) => m.mapsName)) || null;
    const comment = (mostCommon(members.map((m) => (m.spot.comment || "").trim())) || "").trim();
    const routesIn = [...new Set(members.map((m) => m.routeLabel))];
    const nameVariants = [...new Set(members.map((m) => m.spot.name.trim()))];
    const linkVariants = [...new Set(members.map((m) => m.link).filter(Boolean))];
    const commentVariants = [...new Set(members.map((m) => (m.spot.comment || "").trim()))];
    const existingId = existingByName.get(norm(name)) || null;
    lib.push({ members, name, mapsLink, mapsQuery: mapsName, comment, routesIn, nameVariants, linkVariants, commentVariants, existingId });
  }
  lib.sort((a, b) => a.name.localeCompare(b.name));

  // 4. Report.
  const lines = [];
  const say = (s = "") => { lines.push(s); console.log(s); };
  say(`${items.length} eingebettete Spots in ${routes.length} Touren -> ${lib.length} Spots für die Bibliothek.`);
  say("(Breaks und Scooter-Info bleiben in ihrer Tour.)");
  say();
  const merged = lib.filter((l) => l.members.length > 1);
  say(`=== ZUSAMMENGEFÜHRT (${merged.length}) ===`);
  for (const l of merged) {
    say(`• ${l.name}  — in ${l.routesIn.length} Touren: ${l.routesIn.join("; ")}`);
    if (l.nameVariants.length > 1) say(`    ! verschiedene Namen: ${l.nameVariants.join(" | ")}`);
    if (l.linkVariants.length > 1) say(`    ! verschiedene Links (nehme den häufigsten):\n      ${l.linkVariants.join("\n      ")}`);
    if (l.commentVariants.length > 1) say(`    ! ${l.commentVariants.length} verschiedene Hinweistexte (häufigster wird Standard, Abweichungen bleiben in der Tour)`);
  }
  say();
  const single = lib.filter((l) => l.members.length === 1);
  say(`=== EINZELN (${single.length}) ===`);
  for (const l of single) say(`• ${l.name}  — ${l.routesIn[0]}`);
  say();
  const noLink = lib.filter((l) => !l.mapsLink);
  const noName = lib.filter((l) => l.mapsLink && !l.mapsQuery);
  say(`=== OHNE GOOGLE-MAPS-LINK (${noLink.length}) ===`);
  for (const l of noLink) say(`• ${l.name}`);
  say();
  say(`=== LINK VORHANDEN, ABER KEIN ORTSNAME ERKANNT (${noName.length}) — hier im Admin „Suchname“ prüfen ===`);
  for (const l of noName) say(`• ${l.name}  ${l.mapsLink}`);
  say();
  const reused = lib.filter((l) => l.existingId).length;
  if (reused) say(`${reused} Spots existieren schon in der Bibliothek (gleicher Name) und werden wiederverwendet.\n`);

  const reportFile = path.join(__dirname, `migration-report-${Date.now()}.txt`);
  fs.writeFileSync(reportFile, lines.join("\n"));
  console.log(`Bericht gespeichert: ${reportFile}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nichts geschrieben. Zum Anwenden: node scripts/migrate-spots-to-library.js --apply");
    return;
  }

  // 5. Apply: backup, create library docs, rewrite tours.
  const backup = path.join(__dirname, `routes-backup-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(routes.map((r) => ({ id: r.id, ...r.data })), null, 2));
  console.log(`\nBackup aller Touren: ${backup}`);

  const idFor = new Map(); // item -> library id
  for (const l of lib) {
    let id = l.existingId;
    if (!id) {
      const ref = db.collection("flyerSpots").doc();
      await ref.set({
        name: l.name,
        mapsLink: l.mapsLink || null,
        mapsQuery: l.mapsQuery || null,
        comment: l.comment,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      id = ref.id;
    }
    for (const m of l.members) idFor.set(m, { id, l });
  }

  const byRoute = new Map();
  for (const it of items) byRoute.set(it.routeId, [...(byRoute.get(it.routeId) || []), it]);
  let updated = 0;
  for (const r of routes) {
    const mine = byRoute.get(r.id);
    if (!mine) continue;
    const spots = [...r.data.spots];
    for (const it of mine) {
      const { id, l } = idFor.get(it);
      const own = (it.spot.comment || "").trim();
      spots[it.index] = {
        ...it.spot,
        spotId: id,
        name: l.name,
        mapsLink: l.mapsLink || null,
        mapsQuery: l.mapsQuery || null,
        comment: own && own !== l.comment ? own : "",
      };
    }
    await r.ref.update({ spots, updatedAt: FieldValue.serverTimestamp() });
    updated++;
  }
  console.log(`${lib.length} Spots in der Bibliothek, ${updated} Touren umgestellt.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
