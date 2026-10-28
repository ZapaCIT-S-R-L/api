// The next release tag of the chat service (chat-vMAJOR.MINOR.PATCH) from the existing tags and the merged PR's
// labels: no label → patch, `minor` → minor, `major` → major. The account service's tags (vX.Y.Z) don't count.
// CLI (deploy-chat.yml): git tag -l | node scripts/next-version.js [label ...]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RELEASE = /^chat-v(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(tags, labels) {
  const versions = tags
    .map((tag) => tag.match(RELEASE))
    .filter(Boolean)
    .map((m) => m.slice(1).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (versions.length === 0) return "chat-v1.0.0";
  const [major, minor, patch] = versions.at(-1);
  const bump = new Set(labels.map((label) => label.toLowerCase()));
  if (bump.has("major")) return `chat-v${major + 1}.0.0`;
  if (bump.has("minor")) return `chat-v${major}.${minor + 1}.0`;
  return `chat-v${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tags = readFileSync(0, "utf8").split("\n").filter(Boolean);
  console.log(nextVersion(tags, process.argv.slice(2)));
}
