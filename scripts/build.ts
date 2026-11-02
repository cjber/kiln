import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
for (const arch of ["x64", "arm64"] as const) {
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      `--target=bun-linux-${arch}`,
      // OpenTUI loads its musl build only when OPENTUI_LIBC=musl; these binaries target glibc.
      "--external=@opentui/core-linux-x64-musl",
      "--external=@opentui/core-linux-arm64-musl",
      "src/index.tsx",
      "--outfile",
      `dist/kiln-linux-${arch}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
