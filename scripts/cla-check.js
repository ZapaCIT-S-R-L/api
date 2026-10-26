// CLA check: a pull request can merge only when its author has signed the CLA (CLA.md) by adding a row
// `| @username | Name | Date | CLA version |` to CLA-SIGNATURES.md. Staff and bots don't sign. Staff = org owners and
// members, and the code owners in CODEOWNERS on main (GitHub reports private org members as CONTRIBUTOR).
// CLI (used by .github/workflows/ci.yml): PR_AUTHOR=... PR_ASSOCIATION=... CODEOWNERS_FILE=... node scripts/cla-check.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NO_SIGNATURE_NEEDED = new Set(["OWNER", "MEMBER"]);

// Usernames named as owners in a CODEOWNERS file (comments ignored).
function codeOwners(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .flatMap((line) => [...line.matchAll(/@([A-Za-z0-9-_]+)\b/g)].map((m) => m[1].toLowerCase()));
}

export function hasSigned(login, association, signatures, codeowners = "") {
  if (NO_SIGNATURE_NEEDED.has(association) || login.endsWith("[bot]")) return true;
  if (codeOwners(codeowners).includes(login.toLowerCase())) return true;
  const signed = signatures
    .split("\n")
    .map((line) => line.match(/^\|\s*@([A-Za-z0-9-_]+)\s*\|/))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());
  return signed.includes(login.toLowerCase());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const login = process.env.PR_AUTHOR ?? "";
  const signatures = readFileSync(new URL("../CLA-SIGNATURES.md", import.meta.url), "utf8");
  // CODEOWNERS comes from main (CODEOWNERS_FILE), never from the pull request, so a PR can't make itself staff.
  const owners = process.env.CODEOWNERS_FILE ? readFileSync(process.env.CODEOWNERS_FILE, "utf8") : "";
  if (hasSigned(login, process.env.PR_ASSOCIATION ?? "NONE", signatures, owners)) {
    console.log(`CLA: @${login} is covered.`);
  } else {
    console.error(
      `CLA: @${login} hasn't signed yet. Read CLA.md, then add this row to CLA-SIGNATURES.md in this pull request:\n` +
        `| @${login} | Your name | ${new Date().toISOString().slice(0, 10)} | 1 |`,
    );
    process.exit(1);
  }
}
