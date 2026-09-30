import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export type SkillScope = "user" | "project";
export type SkillStore = { scope: SkillScope; directory: string; adapters: { claude: string; pi: string } };
export type Skill = { name: string; directory: string; external: boolean; claude: LinkState; pi: LinkState };
type LinkState = "shared" | "missing" | "conflict";

/** Codex reads the shared store directly. Claude and Pi need compatibility links. */
export function skillStore(scope: SkillScope, project: string, home = homedir()): SkillStore {
  const base = scope === "user" ? home : resolve(project);
  return {
    scope,
    directory: join(base, ".agents", "skills"),
    adapters: {
      claude: join(base, ".claude", "skills"),
      pi: scope === "user" ? join(base, ".pi", "agent", "skills") : join(base, ".pi", "skills"),
    },
  };
}

function entry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function linkState(path: string, target: string): LinkState {
  const info = entry(path);
  if (!info) return "missing";
  if (info.isSymbolicLink()) {
    try {
      if (realpathSync(path) === realpathSync(target)) return "shared";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "conflict";
}

export function listSkills(store: SkillStore): Skill[] {
  if (!entry(store.directory)) return [];
  return readdirSync(store.directory)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => {
      const directory = join(store.directory, name);
      return {
        name,
        directory,
        external: lstatSync(directory).isSymbolicLink(),
        claude: linkState(join(store.adapters.claude, name), directory),
        pi: linkState(join(store.adapters.pi, name), directory),
      };
    });
}

function destination(store: SkillStore, name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name === "synced")
    throw new Error("use a name of up to 64 lower-case letters, numbers and hyphens; synced is reserved");
  const path = join(store.directory, name);
  if (entry(path)) throw new Error(`${path} already exists`);
  mkdirSync(store.directory, { recursive: true });
  return path;
}

export function createSkill(store: SkillStore, name: string): string {
  const path = destination(store, name);
  mkdirSync(path);
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n\nWrite the skill instructions here.\n`,
    { flag: "wx" },
  );
  return path;
}

/** Copy the whole skill, including supporting files; the original is left intact. */
export function importSkill(store: SkillStore, source: string): string {
  const path = realpathSync(source);
  if (!statSync(path).isDirectory() || !statSync(join(path, "SKILL.md")).isFile())
    throw new Error("choose a directory containing SKILL.md");
  const target = destination(store, basename(resolve(source)));
  cpSync(path, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return target;
}

/** Preflight every adapter so a name clash cannot leave a partially shared skill. */
export function shareSkill(store: SkillStore, name: string): void {
  const target = join(store.directory, name);
  if (!statSync(join(target, "SKILL.md")).isFile()) throw new Error("this entry has no SKILL.md");
  const paths = Object.values(store.adapters).map((directory) => join(directory, name));
  for (const path of paths) {
    if (linkState(path, target) === "conflict") throw new Error(`${path} already contains a different skill`);
  }
  const created: string[] = [];
  try {
    for (const path of paths) {
      if (linkState(path, target) === "shared") continue;
      const parent = resolve(path, "..");
      mkdirSync(parent, { recursive: true });
      symlinkSync(relative(parent, target), path);
      created.push(path);
    }
  } catch (error) {
    for (const path of created) unlinkSync(path);
    throw error;
  }
}

/** Remove only links to this skill. Codex still reads the canonical copy. */
export function unshareSkill(store: SkillStore, name: string): void {
  const target = join(store.directory, name);
  for (const directory of Object.values(store.adapters)) {
    const path = join(directory, name);
    if (linkState(path, target) === "shared") unlinkSync(path);
  }
}
