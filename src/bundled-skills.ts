import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../bundled-skills/kiln-config/SKILL.md" with { type: "text" };
import skills from "../bundled-skills/kiln-skills/SKILL.md" with { type: "text" };
import { shareSkill, skillStore } from "./skills";

const bundled = { "kiln-config": config, "kiln-skills": skills };
const digest = (source: string) => createHash("sha256").update(source).digest("hex");

/** Only kiln-owned skills are updated; changed managed instructions are kept in backups. */
export function syncBundledSkills(
  store = skillStore("user", "."),
  sources: Record<string, string> = bundled,
): string[] {
  const problems: string[] = [];
  for (const [name, source] of Object.entries(sources)) {
    const directory = join(store.directory, name);
    const document = join(directory, "SKILL.md");
    const marker = join(directory, ".kiln-bundle.json");
    try {
      let existing: string | undefined;
      let previous: string | undefined;
      try {
        if (!lstatSync(directory).isDirectory() || !lstatSync(document).isFile() || !lstatSync(marker).isFile())
          throw new Error(`${directory} is not a kiln-managed skill`);
        const owned = JSON.parse(readFileSync(marker, "utf8"));
        if (owned.name !== name || owned.owner !== "kiln" || typeof owned.sha256 !== "string")
          throw new Error(`${directory} is not a kiln-managed skill`);
        existing = readFileSync(document, "utf8");
        previous = owned.sha256;
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
      if (existing !== source) {
        if (existing !== undefined && digest(existing) !== previous) {
          const backup = join(store.directory, ".kiln-backups", randomUUID(), name);
          mkdirSync(backup, { recursive: true });
          writeFileSync(join(backup, "SKILL.md"), existing, { flag: "wx" });
        }
        const temporary = join(directory, `.SKILL-${randomUUID()}`);
        writeFileSync(temporary, source, { flag: "wx" });
        renameSync(temporary, document);
      }
      writeFileSync(marker, JSON.stringify({ owner: "kiln", name, sha256: digest(source) }), { mode: 0o600 });
      shareSkill(store, name);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}
