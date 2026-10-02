// One-off bulk import: creates a flyerRoutes doc for each of the 10 real
// tour routes parsed from the user's Flyer_Schedules.xlsx (Google Sheet
// export covering Haad Rin, Haad Yao, Mixed, Hin Kong and CM Staff tours).
//
// Usage (run on a machine with a Firebase Admin service account key for the
// shared oxa-ticket-app project):
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json node scripts/import-flyer-routes.js
//
// Safe to re-run — it always creates new documents rather than touching or
// de-duplicating existing ones. If you need to re-import after a fix, delete
// the previously-created routes in the admin Route Builder UI first (or
// filter by createdAt) to avoid ending up with duplicates.

const admin = require("firebase-admin");
const { routesToImport } = require("./flyer-routes-data");

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function main() {
  console.log(`Importing ${routesToImport.length} routes...`);

  for (const route of routesToImport) {
    const ref = db.collection("flyerRoutes").doc();
    await ref.set({
      region: route.region,
      name: route.name,
      duplicatedFrom: null,
      spots: route.spots,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  ✓ ${route.region} / ${route.name} (${route.spots.length} spots) -> ${ref.id}`);
  }

  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
