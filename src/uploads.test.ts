import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveUpload, UploadsFull, uploadName } from "./uploads";

test("names stay one safe segment", () => {
  expect(uploadName("../../etc/passwd")).toBe("passwd");
  expect(uploadName("my photo (1).jpg")).toBe("my-photo-1-.jpg");
  expect(uploadName("..")).toBe("file");
});

test("uploads stop at the quota and old ones clear", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-uploads-"));
  const before = Bun.env.XDG_CACHE_HOME;
  Bun.env.XDG_CACHE_HOME = directory;
  try {
    const bytes = new TextEncoder().encode("12345678").buffer;
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(dirname(await saveUpload("a.txt", bytes, Date.now(), 10)), old, old);
    // The old upload is cleared before the quota is counted, so this one fits.
    await saveUpload("b.txt", bytes, Date.now(), 10);
    await expect(saveUpload("c.txt", bytes, Date.now(), 10)).rejects.toBeInstanceOf(UploadsFull);
  } finally {
    if (before === undefined) delete Bun.env.XDG_CACHE_HOME;
    else Bun.env.XDG_CACHE_HOME = before;
    rmSync(directory, { recursive: true, force: true });
  }
});
