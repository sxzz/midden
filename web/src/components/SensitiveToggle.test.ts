import { afterEach, expect, it, vi } from "vitest";
import { createVaporApp, nextTick } from "vue";
import CollectionLibrary from "./CollectionLibrary.vue";
const collection = {
  id: "00000000-0000-4000-8000-000000000001",
  text: "测试正文",
  author_name: "测试作者",
  url: "https://example.test/post",
  assets: [
    {
      id: "sensitive-image",
      state: "ready",
      mime: "image/png",
      sensitive: true,
    },
  ],
};
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: vi.fn(async (path: string) => {
    if (path === "/collections" || path.startsWith("/collections?"))
      return { items: [collection] };
    if (path.endsWith("/revisions")) return { items: [] };
    if (path.endsWith("/availability")) return { available: true };
    if (path.startsWith("/collections/")) return collection;
    return { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 };
  }),
}));
let unmount = () => {};
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  location.hash = "/";
  vi.restoreAllMocks();
});
it("toggles sensitive media across the collection and detail without losing the preference", async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  location.hash = "/";
  const el = document.createElement("div");
  document.body.append(el);
  const app = createVaporApp(CollectionLibrary);
  app.mount(el);
  unmount = () => app.unmount();
  const toggle = () =>
    el.querySelector<HTMLButtonElement>('[aria-label="显示敏感内容"]')!;
  const image = () =>
    el.querySelector('img[src="/v1/assets/sensitive-image?inline=1"]');
  await vi.waitFor(() => expect(el.textContent).toContain("测试正文"));
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(image()).not.toBeNull();
  expect(image()?.closest(".blurred, .sensitive")).not.toBeNull();
  toggle().click();
  await nextTick();
  expect(image()).not.toBeNull();
  expect(image()?.closest(".blurred, .sensitive")).toBeNull();
  el.querySelector<HTMLButtonElement>(".row")!.click();
  await vi.waitFor(() => expect(el.textContent).toContain("收藏详情"));
  await vi.waitFor(() => expect(image()).not.toBeNull());
  expect(image()?.closest(".blurred, .sensitive")).toBeNull();
  toggle().click();
  await nextTick();
  expect(image()).not.toBeNull();
  expect(image()?.closest(".blurred, .sensitive")).not.toBeNull();
  expect(el.textContent).toContain("敏感内容 · 点按显示");
  el.querySelector<HTMLButtonElement>(".sensitive")!.click();
  await nextTick();
  expect(image()).not.toBeNull();
  toggle().click();
  await nextTick();
  toggle().click();
  await nextTick();
  expect(image()).not.toBeNull();
  expect(image()?.closest(".blurred, .sensitive")).not.toBeNull();
  el.querySelector<HTMLButtonElement>(".back")!.click();
  await vi.waitFor(() => expect(el.textContent).toContain("我的收藏"));
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(image()).not.toBeNull();
  expect(image()?.closest(".blurred, .sensitive")).not.toBeNull();
});
