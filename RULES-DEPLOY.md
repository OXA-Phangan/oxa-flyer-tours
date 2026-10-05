# Rules deployment — read before deploying anything

One Firebase project (`oxa-ticket-app`) = one Firestore ruleset + one Storage ruleset, shared by all apps.
Deploy ONLY from these sources, never from this repo:

- Firestore rules: `oxa-ticket-app/firestore.rules`  (`firebase deploy --only firestore:rules --project oxa-ticket-app`)
- Storage rules:   `oxa-poster-tour/storage.rules`   (`firebase deploy --only storage --project oxa-ticket-app`)

The flyer-app parts live as paste-in blocks here:
- `firestore.flyer-block.rules.txt`
- `storage.flyer-block.rules.txt`
