import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkill, importSkill, listSkills, repairSkill, shareSkill, skillStore, unshareSkill } from "./skills";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "kiln-skills-test-"));
  scratch.push(path);
  return {
    path,
    user: skillStore("user", join(path, "project"), path),
    project: skillStore("project", join(path, "project"), path),
  };
}

test("shared user and project stores keep supporting files and unlink only their own adapters", () => {
  const { path, user, project } = fixture();
  const source = join(path, "original", "deploy");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: deploy\ndescription: Deploy the project.\n---\n");
  writeFileSync(join(source, "scripts", "run.sh"), "echo deploy\n");
  const target = importSkill(user, source);
  expect(readFileSync(join(target, "scripts", "run.sh"), "utf8")).toBe("echo deploy\n");
  expect(existsSync(source)).toBe(true);
  shareSkill(user, "deploy");
  shareSkill(user, "deploy");
  expect(realpathSync(join(user.adapters.claude, "deploy"))).toBe(target);
  expect(listSkills(user)[0]).toMatchObject({ claude: "shared", pi: "shared", external: false });
  createSkill(project, "deploy");
  shareSkill(project, "deploy");
  unshareSkill(user, "deploy");
  expect(existsSync(join(user.adapters.claude, "deploy"))).toBe(false);
  expect(existsSync(join(target, "SKILL.md"))).toBe(true);
  expect(existsSync(join(project.adapters.pi, "deploy"))).toBe(true);
  expect(() => createSkill(user, "../outside")).toThrow("use a name");
});

test("name clashes and broken links are preserved without partially sharing or overwriting", () => {
  const { path, user } = fixture();
  createSkill(user, "deploy");
  mkdirSync(user.adapters.pi, { recursive: true });
  const clash = join(user.adapters.pi, "deploy");
  symlinkSync(join(path, "missing"), clash);
  expect(() => shareSkill(user, "deploy")).toThrow("different skill");
  expect(existsSync(join(user.adapters.claude, "deploy"))).toBe(false);
  unshareSkill(user, "deploy");
  expect(lstatSync(clash).isSymbolicLink()).toBe(true);
  expect(() => importSkill(user, join(user.directory, "deploy"))).toThrow("already exists");
});

test("repair preserves conflicting directories and symlink targets before sharing the canonical skill", () => {
  const { path, user } = fixture();
  createSkill(user, "deploy");
  const conflicting = join(user.adapters.claude, "deploy");
  mkdirSync(conflicting, { recursive: true });
  writeFileSync(join(conflicting, "SKILL.md"), "Claude's original");
  const external = join(path, "original");
  mkdirSync(external);
  writeFileSync(join(external, "SKILL.md"), "Pi's original");
  mkdirSync(user.adapters.pi, { recursive: true });
  symlinkSync("../../../original", join(user.adapters.pi, "deploy"));
  const backups = repairSkill(user, "deploy");
  expect(backups).toHaveLength(2);
  expect(readFileSync(join(backups[0] as string, "SKILL.md"), "utf8")).toBe("Claude's original");
  expect(realpathSync(backups[1] as string)).toBe(external);
  expect(listSkills(user)[0]).toMatchObject({ claude: "shared", pi: "shared" });
  expect(readFileSync(join(external, "SKILL.md"), "utf8")).toBe("Pi's original");
  expect(repairSkill(user, "deploy")).toEqual([]);
  expect(() => repairSkill(user, "../outside")).toThrow("not a path");
});

test("directory backups retain external relative links and internal supporting links", () => {
  const { path, user } = fixture();
  createSkill(user, "deploy");
  const original = join(user.adapters.claude, "deploy");
  mkdirSync(join(original, "scripts"), { recursive: true });
  writeFileSync(join(path, "instructions.md"), "Original instructions");
  symlinkSync("../../../instructions.md", join(original, "SKILL.md"));
  writeFileSync(join(original, "scripts", "run.sh"), "echo deploy");
  symlinkSync("scripts/run.sh", join(original, "run.sh"));
  symlinkSync(join(original, "scripts", "run.sh"), join(original, "absolute.sh"));
  symlinkSync("../../../absent.md", join(original, "missing.md"));
  const [backup] = repairSkill(user, "deploy");
  expect(backup).toBeDefined();
  expect(readFileSync(join(backup as string, "SKILL.md"), "utf8")).toBe("Original instructions");
  expect(readlinkSync(join(backup as string, "run.sh"))).toBe("scripts/run.sh");
  expect(readFileSync(join(backup as string, "run.sh"), "utf8")).toBe("echo deploy");
  expect(readFileSync(join(backup as string, "absolute.sh"), "utf8")).toBe("echo deploy");
  expect(readlinkSync(join(backup as string, "missing.md"))).toBe(join(path, "absent.md"));
});
