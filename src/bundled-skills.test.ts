import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBundledSkills } from "./bundled-skills";
import { listSkills, skillStore } from "./skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-bundles-"));
  roots.push(root);
  return skillStore("user", ".", root);
}

test("bundle upgrades sync canonical text, preserve managed edits and keep both adapters shared", () => {
  const store = fixture();
  expect(syncBundledSkills(store, { "kiln-config": "first version" })).toEqual([]);
  const document = join(store.directory, "kiln-config", "SKILL.md");
  writeFileSync(document, "user edits");
  expect(syncBundledSkills(store, { "kiln-config": "second version" })).toEqual([]);
  expect(readFileSync(document, "utf8")).toBe("second version");
  const backups = join(store.directory, ".kiln-backups");
  expect(readFileSync(join(backups, readdirSync(backups)[0] as string, "kiln-config", "SKILL.md"), "utf8")).toBe(
    "user edits",
  );
  expect(listSkills(store)[0]).toMatchObject({ claude: "shared", pi: "shared" });
  expect(syncBundledSkills(store, { "kiln-config": "second version" })).toEqual([]);
  expect(readdirSync(backups)).toHaveLength(1);
});

test("same-name user skills are preserved and reported instead of adopted or overwritten", () => {
  const store = fixture();
  const directory = join(store.directory, "kiln-config");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "user-owned instructions");
  expect(syncBundledSkills(store)).toHaveLength(1);
  expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe("user-owned instructions");
  expect(listSkills(store).find((skill) => skill.name === "kiln-skills")).toMatchObject({
    claude: "shared",
    pi: "shared",
  });
});
