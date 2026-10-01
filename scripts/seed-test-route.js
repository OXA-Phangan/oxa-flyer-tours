// One-off helper to seed a test flyerRoutes doc + a test flyerVolunteers doc
// for manually testing the Tour Module at /v/{token}.
//
// Usage (run on a machine with a Firebase Admin service account key for the
// shared oxa-ticket-app project):
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json node scripts/seed-test-route.js
//
// Prints the volunteer token / test URL at the end. Safe to re-run — it
// always creates new documents rather than touching existing ones.

const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

function randomToken() {
  return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}

async function main() {
  const routeRef = db.collection("flyerRoutes").doc();
  await routeRef.set({
    region: "Haad Rin",
    name: "Starter (Test)",
    duplicatedFrom: null,
    spots: [
      {
        name: "Zen Beach",
        type: "NORMAL",
        time: "6:00 – 6:20 PM (Sunset)",
        comment: "Walk along the beach, don't flyer bikes here.",
        mapsLink: null,
      },
      {
        name: "Break",
        type: "BREAK",
        time: "6:30 – 7:00 PM",
        comment: "Please don't start the restaurants before 7PM.",
        mapsLink: null,
      },
      {
        name: "Mama Market Srithanu",
        type: "NORMAL",
        time: "7:00 – 8:00 PM",
        comment: "All tables here.",
        mapsLink: "https://maps.google.com/?q=Mama+Market+Srithanu",
      },
      {
        name: "Scooter Rental Shop",
        type: "SCOOTER_INFO",
        time: "Anytime",
        comment: "If you need a scooter during your shift, this is the recommended shop.",
        mapsLink: null,
      },
      {
        name: "Vintage Nightmarket",
        type: "NORMAL",
        time: "7:00 – 8:00 PM",
        comment: "Only give to customers and bikes here, no tables.",
        mapsLink: null,
      },
    ],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const token = randomToken();
  await db.collection("flyerVolunteers").doc(token).set({
    name: `Test Volunteer ${Date.now()}`,
    checkInDate: "2026-10-01",
    checkInTime: null,
    checkOutDate: "2026-10-14",
    checkOutTime: null,
    passportPhotoPath: "flyerPassports/seed-test/passport.jpg",
    passportDeleteAfter: admin.firestore.Timestamp.fromDate(new Date("2026-10-21")),
    status: "active",
    hasPendingStayEdit: false,
    pendingStayEdit: null,
    onBreak: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log("Seeded route:", routeRef.id);
  console.log("Test volunteer token:", token);
  console.log("Test URL: /v/" + token);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
