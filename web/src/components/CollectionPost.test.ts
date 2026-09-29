import { describe, it, expect, afterEach } from "vitest";
import { createVaporApp, nextTick } from "vue";
import CollectionPost from "./CollectionPost.vue";
import CollectionRow from "./CollectionRow.vue";
import type { Collection } from "../api";
const fixture: Collection = {
  id: "fixture",
  url: "https://example.test/post",
  text: "收藏正文",
  author_name: "测试作者",
  saved_at: "2026-09-29T00:00:00Z",
  observed_at: "2026-09-29T00:00:00Z",
  visibility: "private",
  revision_id: "r1",
  assets: [
    {
      id: "m1",
      state: "ready",
      mime: "image/png",
      sensitive: true,
      alt_text: "测试图片",
    },
  ],
};
let unmount = () => {};
type Mountable = Parameters<typeof createVaporApp>[0];
function mount(component: Mountable, collection: Collection) {
  const el = document.createElement("div");
  document.body.append(el);
  const app = createVaporApp(component, { collection });
  app.mount(el);
  unmount = () => app.unmount();
  return el;
}
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});
describe("Vapor collection rendering", () => {
  it.each([null, undefined, []])(
    "renders a detail with warnings=%s",
    (warnings) => {
      const el = mount(CollectionPost, { ...fixture, warnings });
      expect(el.textContent).toContain("收藏正文");
      expect(el.textContent).toContain("测试作者");
      expect(el.textContent).not.toContain("部分内容没有完整保存");
      expect(el.querySelector(".sensitive")).not.toBeNull();
    },
  );
  it("blurs sensitive media until the reader reveals it", async () => {
    const el = mount(CollectionPost, fixture);
    expect(el.textContent).toContain("收藏正文");
    expect(el.querySelector("img")).not.toBeNull();
    expect(el.querySelector(".blurred")).not.toBeNull();
    (el.querySelector(".sensitive") as HTMLButtonElement).click();
    await nextTick();
    expect(el.querySelector(".blurred")).toBeNull();
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "/v1/assets/m1?inline=1",
    );
  });
  it("blurs sensitive thumbnails in a collection row", () => {
    const el = mount(CollectionRow, fixture);
    expect(el.textContent).toContain("测试作者");
    expect(el.querySelector("img")).not.toBeNull();
    expect(el.querySelector(".blurred")).not.toBeNull();
    expect(el.textContent).toContain("敏感");
  });
  it("shows a row thumbnail for ordinary media", () => {
    const el = mount(CollectionRow, {
      ...fixture,
      assets: [
        { id: "m2", state: "ready", mime: "image/png", sensitive: false },
      ],
    });
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "/v1/assets/m2?inline=1",
    );
    expect(el.textContent).toContain("1 张图片");
  });
  it("keeps storage states out of the reader's way", () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [
        { id: "m3", state: "failed", sensitive: false, error: "download: 502" },
      ],
      warnings: ["resource omitted: unsupported type or resource limit"],
    });
    expect(el.textContent).toContain("这个媒体没能保存下来");
    expect(el.textContent).not.toContain("failed");
    expect(el.textContent).not.toContain("502");
    expect(el.textContent).toContain("部分媒体超出限制，没有保存。");
    expect(el.textContent).not.toContain("resource omitted");
  });
  it("renders unknown entities without executing markup", () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [],
      text: "<script>alert(1)</script>",
      graph: {
        root: "root",
        relations: [],
        entities: [{ key: "root", type: "notes.article", data: {} }],
      },
    });
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });
});
