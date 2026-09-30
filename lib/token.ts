/**
 * 32-char random hex token. Used for the temporary flyerPassports/{token}/
 * upload path (register page) and for flyerVolunteers/{token} doc IDs
 * (admin approval) — two independent tokens, never the same value.
 * Uses getRandomValues rather than crypto.randomUUID(): randomUUID only
 * exists in secure contexts, so it would break when testing on a phone
 * via http://<LAN-IP>:3000.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
