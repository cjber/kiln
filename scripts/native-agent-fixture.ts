import { createInterface } from "node:readline";

console.log("Native TUI fixture: type a message here");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => console.log(`Native reply: ${line}`));
