# Rules deployment — read before deploying anything

One Firebase project (`oxa-ticket-app`) = one Firestore ruleset + one Storage ruleset, shared by all apps.
Deploy ONLY from these sources, never from this repo:

- Firestore rules: `oxa-ticket-app/firestore.rules`  (`firebase deploy --only firestore:rules --project oxa-ticket-app`)
- Storage rules:   `oxa-poster-tour/storage.rules`   (`firebase deploy --only storage --project oxa-ticket-app`)

The flyer-app parts live as paste-in blocks here:
- `firestore.flyer-block.rules.txt`
- `storage.flyer-block.rules.txt`

## Bike rentals (Red / Blue Bike)

- Firestore: bikeRentals subcollection, `flyerBikeSlots` and the collection-group read are deployed in `oxa-ticket-app/firestore.rules` (commit d290fb4) and mirrored in `firestore.flyer-block.rules.txt`.
- Storage: `flyerBike/{token}/{file}` rule is in `storage.flyer-block.rules.txt`; apply + deploy with `scripts/apply-flyer-bike-photos.ps1` (run inside `oxa-poster-tour`), which also appends the cleanup function `cloud-functions.flyer-bike-photo-cleanup.js.txt` (`cleanupExpiredFlyerBikePhotos`, daily 03:40 Bangkok).

## Registration settings (editable Terms & Conditions + confirmation message)

- Firestore: `flyerSettings/{docId}` (public get, admin write) is deployed in `oxa-ticket-app/firestore.rules` (commit d290fb4) and mirrored in `firestore.flyer-block.rules.txt`.
