import { test, expect } from "@playwright/test";
const id = "11111111-1111-4111-8111-111111111111";
const collection = {
  id,
  url: "https://example.test/post",
  text: "这是一条保存在 Midden 的测试收藏。",
  author_name: "测试作者",
  published_at: "2026-09-28T10:00:00Z",
  saved_at: "2026-09-29T10:00:00Z",
  observed_at: "2026-09-29T10:00:00Z",
  visibility: "public",
  revision_id: "r1",
  assets: [],
  warnings: [],
};
test("browse, filter, history, refresh and remove a saved post", async ({
  page,
}) => {
  let deleted = false;
  await page.route("https://telegram.org/**", (r) => r.fulfill({ body: "" }));
  await page.route("**/v1/**", async (r) => {
    const u = new URL(r.request().url());
    const path = u.pathname;
    let body: unknown = {};
    if (path === "/v1/session") body = { tenant_id: "fixture" };
    else if (path === "/v1/usage")
      body = {
        used_bytes: 1048576,
        reserved_bytes: 0,
        limit_bytes: 1073741824,
      };
    else if (path === "/v1/collections")
      body = {
        items: deleted || u.searchParams.get("q") === "不存在" ? [] : [collection],
      };
    else if (path.endsWith("/availability")) body = { available: true };
    else if (path.endsWith("/revisions"))
      body = { items: [{ id: "r0", created_at: "2026-09-27T10:00:00Z" }] };
    else if (path.endsWith("/revisions/r0"))
      body = { ...collection, text: "历史正文" };
    else if (path === "/v1/captures")
      body = { id: "job", collection_id: id, state: "complete" };
    else if (path === "/v1/collections/" + id) {
      if (r.request().method() === "DELETE") {
        deleted = true;
        await r.fulfill({ status: 204 });
        return;
      }
      body = collection;
    } else {
      await r.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    await r.fulfill({ json: body });
  });
  const openRow = () =>
    page
      .getByRole("button", { name: /测试作者/ })
      .first()
      .click();
  await page.goto("/app/");
  await expect(page.getByText(collection.text)).toBeVisible();
  await page.screenshot({
    path: "test-results/library-mobile.png",
    fullPage: true,
  });
  await openRow();
  await page.getByRole("button", { name: "历史版本" }).click();
  await page.getByRole("button", { name: /2026年9月27日/ }).click();
  await expect(page.getByText("历史正文")).toBeVisible();
  await page.getByRole("button", { name: /正在查看历史版本/ }).click();
  await page.getByRole("button", { name: "重新抓取" }).click();
  await expect(page.getByText("已更新。")).toBeVisible();
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("searchbox").fill("不存在");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(
    page.getByText("没有匹配的收藏。换个关键词，或清除筛选。"),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await openRow();
  await page.getByRole("button", { name: "删除这条收藏" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(
    page.getByText("这里还是空的。在对话里把链接发给机器人，就会保存到这里。"),
  ).toBeVisible();
});
test("ordinary browser explains Telegram entry", async ({ page }) => {
  await page.route("https://telegram.org/**", (r) => r.fulfill({ body: "" }));
  await page.route("**/v1/session", (r) =>
    r.fulfill({ status: 401, json: { error: "authentication required" } }),
  );
  await page.goto("/app/");
  await expect(
    page.getByText("请从 Telegram Bot 的「打开」进入。"),
  ).toBeVisible();
});

test("sensitive image stays unloaded until revealed and opens inside the page", async ({
  page,
}) => {
  let requests = 0;
  const sensitive = {
    ...collection,
    assets: [
      {
        id: "media",
        mime: "image/png",
        state: "ready",
        sensitive: true,
        alt_text: "合成测试图片",
      },
    ],
  };
  await page.route("https://telegram.org/**", (r) => r.fulfill({ body: "" }));
  await page.route("**/v1/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.startsWith("/v1/assets/")) {
      requests++;
      await r.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
      return;
    }
    const body =
      path === "/v1/session"
        ? { tenant_id: "fixture" }
        : path === "/v1/usage"
          ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
          : path.endsWith("/availability")
            ? { available: true }
            : path === "/v1/collections/" + id
              ? sensitive
              : { items: [sensitive] };
    await r.fulfill({ json: body });
  });
  await page.goto("/app/");
  // The collection row previews media without touching sensitive bytes.
  await expect(page.getByText("1 张图片")).toBeVisible();
  expect(requests).toBe(0);
  await page
    .getByRole("button", { name: /测试作者/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "敏感内容 · 点按显示" }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "敏感内容 · 点按显示" }).click();
  await expect(page.getByAltText("合成测试图片")).toBeVisible();
  await page.getByRole("button", { name: "放大图片" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(requests).toBeGreaterThan(0);
});
