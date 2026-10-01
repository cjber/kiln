import { createInterface } from "node:readline";

if (process.argv[2] !== "resume" || process.argv[3] !== "00000000-0000-0000-0000-000000000001")
  throw new Error("Native TUI did not receive the exact saved provider identity");
console.log("Native TUI fixture: type a message here");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => console.log(`Native reply: ${line}`));
