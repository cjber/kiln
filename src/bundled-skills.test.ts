import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBundledSkills } from "./bundled-skills";
import { listSkills, shareSkill, skillStore } from "./skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-bundles-"));
  roots.push(root);
  return skillStore("user", ".", root);
}
const skill = (text: string) => ({ "SKILL.md": text });

test("bundle upgrades sync canonical text, preserve managed edits and keep both adapters shared", () => {
  const store = fixture();
  expect(syncBundledSkills(store, { kiln: skill("first version") }, [])).toEqual([]);
  const document = join(store.directory, "kiln", "SKILL.md");
  writeFileSync(document, "user edits");
  expect(syncBundledSkills(store, { kiln: skill("second version") }, [])).toEqual([]);
  expect(readFileSync(document, "utf8")).toBe("second version");
  const backups = join(store.directory, ".kiln-backups");
  expect(readFileSync(join(backups, readdirSync(backups)[0] as string, "kiln", "SKILL.md"), "utf8")).toBe("user edits");
  expect(listSkills(store)[0]).toMatchObject({ claude: "shared", pi: "shared" });
  expect(syncBundledSkills(store, { kiln: skill("second version") }, [])).toEqual([]);
  expect(readdirSync(backups)).toHaveLength(1);
});

test("reference files are written, updated and removed with the skill", () => {
  const store = fixture();
  const files = { "SKILL.md": "body", "references/config.md": "config v1", "references/skills.md": "skills" };
  expect(syncBundledSkills(store, { kiln: files }, [])).toEqual([]);
  const reference = join(store.directory, "kiln", "references", "config.md");
  expect(readFileSync(reference, "utf8")).toBe("config v1");
  expect(syncBundledSkills(store, { kiln: { "SKILL.md": "body", "references/config.md": "config v2" } }, [])).toEqual(
    [],
  );
  expect(readFileSync(reference, "utf8")).toBe("config v2");
  expect(existsSync(join(store.directory, "kiln", "references", "skills.md"))).toBe(false);
  expect(existsSync(join(store.directory, ".kiln-backups"))).toBe(false);
});

test("same-name user skills are preserved and reported instead of adopted or overwritten", () => {
  const store = fixture();
  const directory = join(store.directory, "kiln");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "user-owned instructions");
  expect(syncBundledSkills(store)).toHaveLength(1);
  expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe("user-owned instructions");
});

test("the bundled kiln skill carries its reference files", () => {
  const store = fixture();
  expect(syncBundledSkills(store)).toEqual([]);
  const directory = join(store.directory, "kiln");
  expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toContain("name: kiln");
  for (const name of ["config", "skills"])
    expect(readFileSync(join(directory, "references", `${name}.md`), "utf8")).not.toBe("");
});

test("retired kiln-owned skills and their links are removed, edited ones backed up, user ones kept", () => {
  const store = fixture();
  const install = (name: string, text: string, edited?: string) => {
    const directory = join(store.directory, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), edited ?? text);
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    writeFileSync(join(directory, ".kiln-bundle.json"), JSON.stringify({ owner: "kiln", name, sha256 }));
    shareSkill(store, name);
  };
  install("kiln-agents", "old agents");
  install("kiln-config", "old config", "edited config");
  const mine = join(store.directory, "kiln-skills");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "my own");

  expect(syncBundledSkills(store, { kiln: skill("new") })).toEqual([]);

  for (const name of ["kiln-agents", "kiln-config"]) {
    expect(existsSync(join(store.directory, name))).toBe(false);
    for (const adapter of Object.values(store.adapters)) {
      expect(() => lstatSync(join(adapter, name))).toThrow();
    }
  }
  expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("my own");
  const backups = join(store.directory, ".kiln-backups");
  const saved = readdirSync(backups).map((id) => readdirSync(join(backups, id)));
  expect(saved).toEqual([["kiln-config"]]);
  expect(readFileSync(join(backups, readdirSync(backups)[0] as string, "kiln-config", "SKILL.md"), "utf8")).toBe(
    "edited config",
  );
  expect(
    listSkills(store)
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["kiln", "kiln-skills"]);
});

test("retired skills stay until the replacement installs, and user additions inside them are backed up", () => {
  const store = fixture();
  const directory = join(store.directory, "kiln-agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "old");
  const sha256 = new Bun.CryptoHasher("sha256").update("old").digest("hex");
  writeFileSync(join(directory, ".kiln-bundle.json"), JSON.stringify({ owner: "kiln", name: "kiln-agents", sha256 }));
  mkdirSync(join(directory, "notes"));
  mkdirSync(join(store.directory, "kiln"));
  writeFileSync(join(store.directory, "kiln", "SKILL.md"), "the user's own kiln skill");

  expect(syncBundledSkills(store, { kiln: skill("new") })).toHaveLength(1);
  expect(existsSync(directory)).toBe(true);

  rmSync(join(store.directory, "kiln"), { recursive: true });
  expect(syncBundledSkills(store, { kiln: skill("new") })).toEqual([]);
  expect(existsSync(directory)).toBe(false);
  const backups = join(store.directory, ".kiln-backups");
  expect(existsSync(join(backups, readdirSync(backups)[0] as string, "kiln-agents", "notes"))).toBe(true);
});
