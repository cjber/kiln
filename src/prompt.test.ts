import { expect, test } from "bun:test";
import { join } from "node:path";
import { emptyInput, moves, parsePrompt, withoutFaint } from "./prompt";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "prompts", `${name}.txt`)).text();
const read = async (name: string) => parsePrompt(await screen(name), 100);

test("reads the menus Claude and Codex wait on, captured from their terminals", async () => {
  expect(await read("plan")).toMatchObject({
    question: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    context: ["Ready to code?", "Here is Claude's plan:", "Create hello.txt in the repo root containing hi."],
    cursor: 1,
    options: [
      { label: "Yes, and use auto mode" },
      { label: "Yes, manually approve edits" },
      { label: "Tell Claude what to change", detail: "shift+tab to approve with this feedback", typed: "inline" },
    ],
  });
  // A label the terminal wrapped reads as one line.
  expect((await read("perm"))?.options[1]?.label).toBe(
    "Yes, and always allow access to /home/me/.cache/agent-scratch/kiln-hitl-probe from this project",
  );
  expect((await read("ask"))?.options).toMatchObject([
    { number: 1, label: "Tea", detail: "Prefer tea" },
    { number: 2, label: "Coffee" },
    { number: 3, label: "Type something.", typed: "inline" },
    { number: 4, label: "Chat about this", typed: undefined },
  ]);
  // Codex's key hints go, and its "do differently" option takes the text after it cancels.
  expect((await read("codex"))?.options.map((option) => [option.label, option.typed])).toEqual([
    ["Yes, proceed", undefined],
    ["Yes, and don't ask again for commands that start with `touch codex.txt`", undefined],
    ["No, and tell Codex what to do differently", "after"],
  ]);
});

test("a numbered list in the conversation above the input box is not a menu", async () => {
  expect(await read("claude-idle")).toBeUndefined();
  expect(await read("codex-idle")).toBeUndefined();
});

test("the key changes with the question, and moves walk from the cursor", async () => {
  const plan = await read("plan");
  const ask = await read("ask");
  if (!plan || !ask) throw new Error("no menu");
  expect(plan.key).not.toBe(ask.key);
  expect(moves(ask, 3)).toEqual(["Down", "Down"]);
  expect(moves({ ...ask, cursor: 3 }, 1)).toEqual(["Up", "Up"]);
  expect(moves(ask, 1)).toEqual([]);
});

test("an input box is empty only when the cursor's row is the bare marker", () => {
  const rows = ["● Done.", "────────", "❯\u00a0", "────────", "  ⏵⏵ bypass permissions on"];
  expect(emptyInput(rows, 2)).toBe(true);
  expect(emptyInput(["────────", "❯ half a prompt", "────────"], 1)).toBe(false);
  // The second line of a draft, or a cursor outside the box, is not an empty prompt.
  expect(emptyInput(["❯ first line", "  ", "────────"], 1)).toBe(false);
  expect(emptyInput(rows, 0)).toBe(false);
});

test("a suggestion Claude draws faint in an empty prompt box is not a draft", () => {
  // Captured with capture-pane -e from a Claude session showing a prompt suggestion.
  const suggested = "\x1b[39m❯\u00a0\x1b[2mok keep going, ping me when spf ships\x1b[0m";
  expect(emptyInput([withoutFaint(suggested)], 0)).toBe(true);
  expect(emptyInput([withoutFaint("\x1b[39m❯\u00a0half a prompt\x1b[0m")], 0)).toBe(false);
  // Truecolour arguments carry 2s that are not the faint attribute.
  expect(withoutFaint("\x1b[38;2;2;2;2mtyped\x1b[22m")).toBe("typed");
  expect(withoutFaint("\x1b[2mfaint\x1b[22m kept")).toBe(" kept");
});
