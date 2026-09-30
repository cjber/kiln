import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkill, importSkill, listSkills, shareSkill, skillStore, unshareSkill } from "./skills";

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
