import { describe, expect, it } from "vitest";
import { resolveMemoryDates } from "../memory-command.js";

describe("memory date ranges", () => {
  const now = new Date(2026, 8, 8, 12, 0, 0);

  it("resolves a deterministic lookback range", () => {
    expect(resolveMemoryDates({ range: "3d" }, now)).toEqual([
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
    ]);
  });

  it("rejects zero-length ranges", () => {
    expect(() => resolveMemoryDates({ range: "0d" }, now)).toThrow(
      "memory scan 暂不支持 --range all，请使用 --from/--to 指定范围",
    );
  });
});
