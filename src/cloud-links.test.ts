import { expect, test } from "bun:test";
import { parseCloudPage } from "./cloud";
import { cloudLink } from "./cloud-links";

test("phone handoffs accept exact provider task URLs and never forward credentials or other origins", () => {
  const url = "https://chatgpt.com/codex/tasks/task_123";
  expect(cloudLink("codex", "task_123", url)).toBe(url);
  expect(cloudLink("codex", "task_123")).toBeUndefined();
  expect(cloudLink("claude", "cse_example")).toBe("https://claude.ai/code/cse_example");
  expect(cloudLink("claude", "../../outside")).toBeUndefined();
  for (const invalid of [
    "http://chatgpt.com/codex/tasks/task_123",
    "https://chatgpt.com.evil.test/codex/tasks/task_123",
    "https://user:password@chatgpt.com/codex/tasks/task_123",
    "https://chatgpt.com/codex/tasks/other",
    `${url}?token=private`,
    `${url}#private`,
  ]) {
    expect(() => cloudLink("codex", "task_123", invalid)).toThrow("invalid task URL");
  }
  const page = JSON.stringify({
    tasks: [{ id: "task_123", title: "Update search", status: "ready", updated_at: "2026-09-30T09:00:00Z", url }],
    cursor: null,
  });
  expect(parseCloudPage(page).sessions[0]?.place).toEqual({
    kind: "cloud",
    id: "task_123",
    title: "Update search",
    url,
  });
  expect(() => parseCloudPage("private invalid response")).toThrow("invalid task page");
});
