import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
for (const arch of ["x64", "arm64"] as const) {
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      `--target=bun-linux-${arch}`,
      "src/index.tsx",
      "--outfile",
      `dist/kiln-linux-${arch}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
