import { expect, test } from "bun:test";
import { displayWidth, padToWidth } from "./tui";

test("displayWidth counts wide CJK and fullwidth characters as two columns", () => {
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth("日本語")).toBe(6);
  expect(displayWidth("a日本b")).toBe(6);
  expect(displayWidth("ｆｕｌｌ")).toBe(8);
});

test("padToWidth pads by columns, not code units", () => {
  expect(padToWidth("日本語", 8)).toBe("日本語  ");
  expect(padToWidth("abc", 3)).toBe("abc");
  expect(padToWidth("abc", 1)).toBe("abc");
});
