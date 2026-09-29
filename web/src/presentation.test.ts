import { it, expect } from "vitest";
import {
  groupCollections,
  mediaSummary,
  present,
  shortDate,
  warningList,
} from "./presentation";
import { safeURL, type Collection } from "./api";
it("does not expose executable original URLs", () => {
  expect(safeURL("javascript:alert(1)")).toBeUndefined();
  expect(safeURL("https://example.test/post")).toBe(
    "https://example.test/post",
  );
});
it("uses the revision profile snapshot", () => {
  const a = {
    text: "text",
    author_name: "Saved name",
    graph: {
      root: "p",
      relations: [{ source: "p", target: "u", type: "authored_by" }],
      entities: [
        { key: "p", type: "x.post", data: {} },
        { key: "u", type: "x.profile", data: { username: "saved_handle" } },
      ],
    },
  } as Collection;
  expect(present(a).handle).toBe("saved_handle");
});
it("buckets the collection by when it was saved", () => {
  const now = new Date(2026, 8, 29, 12, 0);
  const at = (y: number, m: number, d: number) =>
    ({
      id: `${y}-${m}-${d}`,
      saved_at: new Date(y, m, d, 9).toISOString(),
    }) as Collection;
  const groups = groupCollections(
    [at(2026, 8, 29), at(2026, 8, 28), at(2026, 8, 12), at(2025, 10, 3)],
    now,
  );
  expect(groups.map((g) => g.label)).toEqual([
    "今天",
    "昨天",
    "9月",
    "2025年11月",
  ]);
  expect(groups[0].items).toHaveLength(1);
});
it("writes list timestamps the way the chat list does", () => {
  const now = new Date(2026, 8, 29, 12, 0);
  expect(shortDate(new Date(2026, 8, 29, 8, 5).toISOString(), now)).toBe(
    "8:05",
  );
  expect(shortDate(new Date(2026, 8, 28, 8, 5).toISOString(), now)).toBe(
    "昨天",
  );
  expect(shortDate(new Date(2026, 0, 3, 8, 5).toISOString(), now)).toBe(
    "1月3日",
  );
  expect(shortDate(new Date(2025, 0, 3, 8, 5).toISOString(), now)).toBe(
    "2025年1月3日",
  );
  expect(shortDate(undefined, now)).toBe("");
});
it("counts media without naming storage internals", () => {
  expect(
    mediaSummary([
      { id: "a", state: "ready", mime: "image/png", sensitive: false },
      { id: "b", state: "ready", mime: "video/mp4", sensitive: false },
      { id: "c", state: "failed", mime: "image/png", sensitive: false },
    ]),
  ).toBe("1 张图片 · 1 段视频");
  expect(mediaSummary([])).toBe("");
});
it("translates adapter warnings and drops duplicates", () => {
  expect(
    warningList([
      "resource omitted: unsupported type or resource limit",
      "resource omitted: unsupported type or resource limit",
      "some adapter detail",
    ]),
  ).toEqual(["部分媒体超出限制，没有保存。", "部分内容没有完整保存。"]);
});
