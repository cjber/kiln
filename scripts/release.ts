/**
 * Cut a release: bump package.json, turn CHANGELOG.md's [Unreleased] into the
 * version's entry, then commit and tag, both signed.
 *
 *   bun scripts/release.ts patch|minor|major
 *
 * Pushing the tag is what publishes (GitHub release + AUR, see
 * .github/workflows/release.yml), so this stops short of it and prints the push.
 */
import packageJson from "../package.json";

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error("usage: bun scripts/release.ts patch|minor|major");
  process.exit(2);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

if (git("status", "--porcelain")) throw new Error("the working tree has uncommitted changes");
if (git("branch", "--show-current") !== "main") throw new Error("release from main");

const [major = 0, minor = 0, patch = 0] = packageJson.version.split(".").map(Number);
const next =
  bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const changelog = await Bun.file("CHANGELOG.md").text();
const date = new Date().toISOString().slice(0, 10);
const released = changelog.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${next}] - ${date}`);
if (released === changelog) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");

await Bun.write("package.json", `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", released);
// An empty entry fails here, before anything is committed.
const notes = Bun.spawnSync(["bun", "scripts/changelog.ts", next], { stdout: "ignore", stderr: "inherit" });
if (notes.exitCode !== 0) {
  git("checkout", "--", "package.json", "CHANGELOG.md");
  process.exit(1);
}
git("commit", "-S", "-m", `chore(release): ${next}`, "package.json", "CHANGELOG.md");
git("tag", "-s", `v${next}`, "-m", `kiln v${next}`);
console.log(`tagged v${next}. Publish with:\n  git push origin main v${next}`);
