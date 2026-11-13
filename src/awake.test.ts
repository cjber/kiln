import { expect, test } from "bun:test";
import { keepAwake, type Lock } from "./awake";

test("holds one sleep lock while anything works and releases it when nothing does", async () => {
  const locks: { released: boolean; end: () => void }[] = [];
  const take = (): Lock => {
    let end = () => {};
    const released = new Promise<void>((resolve) => {
      end = resolve;
    });
    const lock = { released: false, end };
    locks.push(lock);
    return {
      release: () => {
        lock.released = true;
        end();
      },
      released,
    };
  };
  const awake = keepAwake(take);
  awake(false);
  expect(locks).toHaveLength(0);
  awake(true);
  awake(true);
  expect(locks).toHaveLength(1);
  awake(false);
  expect(locks[0]?.released).toBe(true);
  awake(true);
  expect(locks).toHaveLength(2);
  // A lock that ends on its own is taken again.
  locks[1]?.end();
  await Bun.sleep(0);
  awake(true);
  expect(locks).toHaveLength(3);
});
