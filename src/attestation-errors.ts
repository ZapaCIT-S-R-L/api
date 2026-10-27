// Shared by Play Integrity and App Attest: refused (→ 403 attestation_failed) or can't be checked now (→ 503).
export class AttestationFailed extends Error {}
export class AttestationUnavailable extends Error {}
