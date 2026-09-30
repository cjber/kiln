import { parseArgs } from "node:util";
import { syncBundledSkills } from "./bundled-skills";
import { listSkills, repairSkill, shareSkill, skillStore } from "./skills";

export function runSkillsCli(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { project: { type: "string" }, "backup-conflicts": { type: "boolean" } },
  });
  const [command, name] = positionals;
  const store = skillStore(values.project === undefined ? "user" : "project", values.project ?? ".");
  switch (command) {
    case "list":
      if (positionals.length !== 1 || values["backup-conflicts"]) break;
      console.log(JSON.stringify({ ...store, skills: listSkills(store) }, null, 2));
      return;
    case "share":
      if (positionals.length !== 2 || !name) break;
      if (values["backup-conflicts"]) {
        const backups = repairSkill(store, name);
        console.log(JSON.stringify({ shared: name, backups }, null, 2));
      } else {
        shareSkill(store, name);
        console.log(`shared ${name}`);
      }
      return;
    case "sync": {
      if (positionals.length !== 1 || values.project !== undefined || values["backup-conflicts"]) break;
      const problems = syncBundledSkills();
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("bundled kiln skills are current and shared");
      return;
    }
  }
  throw new Error("usage: kiln skills list [--project DIR] | share NAME [--project DIR] [--backup-conflicts] | sync");
}
