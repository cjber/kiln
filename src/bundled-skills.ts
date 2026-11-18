import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import config from "../skills/kiln/references/config.md" with { type: "text" };
import skills from "../skills/kiln/references/skills.md" with { type: "text" };
import skill from "../skills/kiln/SKILL.md" with { type: "text" };
import { shareSkill, skillStore, unshareSkill } from "./skills";

/** A bundled skill is its files by path relative to the skill directory. */
export type SkillFiles = Record<string, string>;

const bundled: Record<string, SkillFiles> = {
  kiln: { "SKILL.md": skill, "references/config.md": config, "references/skills.md": skills },
};
/** Earlier releases bundled these as three skills; each was one SKILL.md with its marker. */
const retired = ["kiln-agents", "kiln-config", "kiln-skills"];
const markerName = ".kiln-bundle.json";
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const digest = (files: SkillFiles) =>
  sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** The marker's digest when kiln owns `directory`; ENOENT when it is absent, an error when it is the user's. */
function ownedDigest(directory: string, name: string): string {
  const marker = join(directory, markerName);
  if (!lstatSync(directory).isDirectory() || !lstatSync(marker).isFile())
    throw new Error(`${directory} is not a kiln-managed skill`);
  const owned = JSON.parse(readFileSync(marker, "utf8"));
  if (owned.name !== name || owned.owner !== "kiln" || typeof owned.sha256 !== "string")
    throw new Error(`${directory} is not a kiln-managed skill`);
  return owned.sha256;
}

function readFiles(root: string, directory = root): SkillFiles {
  const files: SkillFiles = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, readFiles(root, path));
    else if (entry.isFile() && entry.name !== markerName && !entry.name.startsWith(".kiln-tmp-"))
      files[path.slice(root.length + 1)] = readFileSync(path, "utf8");
  }
  return files;
}

function backUp(store: { directory: string }, name: string, from: string): void {
  const backup = join(store.directory, ".kiln-backups", randomUUID(), name);
  mkdirSync(dirname(backup), { recursive: true });
  cpSync(from, backup, { recursive: true, errorOnExist: true, force: false });
}

function syncOne(store: ReturnType<typeof skillStore>, name: string, source: SkillFiles): void {
  const directory = join(store.directory, name);
  let existing: SkillFiles | undefined;
  let previous: string | undefined;
  try {
    previous = ownedDigest(directory, name);
    existing = readFiles(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A same-name directory without an ownership marker belongs to the user.
    try {
      lstatSync(directory);
      throw new Error(`${directory} already exists; preserve it under a different name before syncing`);
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check;
    }
    mkdirSync(directory, { recursive: true });
  }
  if (existing === undefined || digest(existing) !== digest(source)) {
    if (existing !== undefined && digest(existing) !== previous) backUp(store, name, directory);
    for (const [path, text] of Object.entries(source)) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      const temporary = join(dirname(target), `.kiln-tmp-${randomUUID()}`);
      writeFileSync(temporary, text, { flag: "wx" });
      renameSync(temporary, target);
    }
    for (const path of Object.keys(existing ?? {})) if (!(path in source)) unlinkSync(join(directory, path));
  }
  writeFileSync(join(directory, markerName), JSON.stringify({ owner: "kiln", name, sha256: digest(source) }), {
    mode: 0o600,
  });
  shareSkill(store, name);
}

/** Remove a skill kiln bundled in an earlier release, and its links, keeping a copy of any edits. */
function removeRetired(store: ReturnType<typeof skillStore>, name: string): void {
  const directory = join(store.directory, name);
  let previous: string;
  try {
    previous = ownedDigest(directory, name);
  } catch {
    return; // Absent, or a same-name skill kiln does not own: leave it alone.
  }
  const files = readFiles(directory);
  // Earlier releases digested SKILL.md alone.
  if (sha256(files["SKILL.md"] ?? "") !== previous || Object.keys(files).length !== 1) backUp(store, name, directory);
  unshareSkill(store, name);
  rmSync(directory, { recursive: true });
}

/** Only kiln-owned skills are updated or removed; changed managed instructions are kept in backups. */
export function syncBundledSkills(
  store = skillStore("user", "."),
  sources: Record<string, SkillFiles> = bundled,
  retiredNames: string[] = retired,
): string[] {
  const problems: string[] = [];
  const attempt = (action: () => void) => {
    try {
      action();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  };
  for (const [name, source] of Object.entries(sources)) attempt(() => syncOne(store, name, source));
  for (const name of retiredNames) attempt(() => removeRetired(store, name));
  return problems;
}
