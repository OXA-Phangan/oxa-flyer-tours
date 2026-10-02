// Bootstrap management accounts — must match the email list in
// isFlyerAdmin() in firestore.rules / storage.rules, so the admin UI gate
// and the actual Firestore permission agree. Same two addresses as
// oxa-poster-tour's ALLOWED_MANAGEMENT_EMAILS.
export const FLYER_MANAGEMENT_EMAILS = [
  "info@oxaphangan.com",
  "bella.oxaphangan@gmail.com",
  "mobit.booking@gmail.com",
];
