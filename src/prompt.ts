/**
 * The menu an agent is waiting on, read off its terminal: Claude's permission, plan and question prompts and
 * Codex's approvals all draw a numbered list with a cursor on one option, at the bottom of the screen.
 */
export interface PromptOption {
  number: number;
  label: string;
  detail: string;
  /**
   * Picking it takes text: Claude's "Type something." types into the option itself, while Codex's "No, and tell
   * Codex what to do differently" cancels first and then reads the text as a new message.
   */
  typed: "inline" | "after" | undefined;
}

export interface Prompt {
  /** Names this exact menu, so an answer meant for it never lands on the one that replaced it. */
  key: string;
  question: string;
  context: string[];
  options: PromptOption[];
  cursor: number;
}

const option = /^(\s*)(?:([❯›>])\s*)?(\d{1,2})\.\s+(\S.*)$/;
const rule = /^\s*[─━╌▔▁═-]{8,}\s*$/;
/** A prompt input line under the list means it is conversation scrollback, not a live menu. */
const input = /^[❯›>](\s|$)/;
const inline = /type something|tell \w+ what to change/i;
const after = /what to do differently/i;
/** Codex's key hints, such as "(y)" or "(esc)". */
const hint = /\s+\((?:[a-z]|esc|shift\+tab)\)$/i;

export function parsePrompt(screen: string, width = 0): Prompt | undefined {
  const lines = screen
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => line.trimEnd());
  // The menu sits at the bottom, under at most a short footer.
  const last = lines.findLastIndex((line) => option.test(line));
  if (last < 0 || lines.slice(last + 1).filter((line) => line.trim()).length > 6) return undefined;
  const found: { index: number; indent: number; cursor: boolean; number: number; label: string }[] = [];
  for (let index = last; index >= 0 && index >= last - 40; index--) {
    const match = lines[index]?.match(option);
    if (!match) continue;
    const number = Number(match[3]);
    if (found.length && number !== (found[0]?.number ?? 0) - 1) break;
    found.unshift({ index, indent: (match[1] ?? "").length, cursor: !!match[2], number, label: match[4] ?? "" });
    if (number === 1) break;
  }
  if (found[0]?.number !== 1 || found.length < 2) return undefined;
  if (found.filter((item) => item.cursor).length !== 1) return undefined;
  const end = found.at(-1)?.index ?? last;
  if (lines.slice(end + 1).some((line) => input.test(line) && !option.test(line))) return undefined;
  const options = found.map((item, position): PromptOption => {
    const next = found[position + 1]?.index ?? lines.length;
    let label = item.label;
    const detail: string[] = [];
    let previous = lines[item.index] ?? "";
    for (const line of lines.slice(item.index + 1, next)) {
      if (!line.trim() || rule.test(line) || line.search(/\S/) <= item.indent) break;
      // A line the terminal wrapped belongs to the label; a shorter one under it is the option's description.
      if (!detail.length && width && previous.length >= width - 12) label += ` ${line.trim()}`;
      else detail.push(line.trim());
      previous = line;
    }
    label = label.replace(hint, "");
    return {
      number: item.number,
      label,
      detail: detail.join(" "),
      typed: inline.test(label) ? "inline" : after.test(label) ? "after" : undefined,
    };
  });
  const above: string[] = [];
  let panels = 0;
  for (let index = (found[0]?.index ?? 0) - 1; index >= 0 && above.length < 40; index--) {
    const line = lines[index] ?? "";
    // A full rule closes the prompt's panel; Claude's plan approval puts its question in a panel of its own.
    if (/^\s*[─━▔]{8,}\s*$/.test(line)) {
      if (above.length > 1 || panels++) break;
      continue;
    }
    if (line.trim() && !rule.test(line)) above.unshift(line.trim());
  }
  const question = above.pop() ?? "";
  const cursor = found.find((item) => item.cursor)?.number ?? 1;
  const key = Bun.hash(JSON.stringify([question, options.map((item) => item.label)])).toString(36);
  return { key, question, context: above, options, cursor };
}

/** The keys that move the cursor from where it is to an option. */
export function moves(prompt: Prompt, number: number): string[] {
  const steps = number - prompt.cursor;
  return Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? "Down" : "Up"));
}
