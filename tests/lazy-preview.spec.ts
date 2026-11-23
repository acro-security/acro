import { expect, test } from "@playwright/test";

/**
 * A body is highlighted on demand, so a large response must become readable
 * after one small slice and only grow when the pane is scrolled.
 */
test("highlights a large body on demand and grows as the pane scrolls", async ({ page }) => {
  const lines = Array.from(
    { length: 6000 },
    (_, i) => `export const value${i} = { id: ${i}, label: "item ${i}" };`,
  ).join("\n");
  expect(lines.length).toBeGreaterThan(128 * 1024);

  await page.route("**/api/replay", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        protocol: "HTTP/1.1",
        status: 200,
        statusText: "OK",
        headers: [{ name: "Content-Type", value: "application/javascript" }],
        body: lines,
        encoding: "utf-8",
        size: lines.length,
        durationMs: 12,
        truncated: false,
      }),
    });
  });

  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "acro.workspace.v1",
      JSON.stringify({
        version: 3,
        projects: [{ id: "p1", name: "QA" }],
        sessions: [],
        drafts: [
          {
            id: "d1",
            projectId: "p1",
            name: "bundle.js",
            target: "http://127.0.0.1:1",
            raw: "GET /bundle.js HTTP/1.1\nHost: 127.0.0.1:1\n\n",
            followRedirects: true,
            timeoutSeconds: 30,
          },
        ],
        openRequestIds: ["d1"],
        selectedId: "d1",
        selectedProjectId: "p1",
        selectedSessionId: null,
        locale: "en",
        appearance: "dark",
      }),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Send request", exact: true }).click();

  const pane = page.getByTestId("code-view").last();
  const preview = pane.locator(".syntax-preview");
  await expect(preview).toBeVisible({ timeout: 60000 });
  await expect(preview.locator(".line").first()).toBeVisible();

  const counted = () => preview.locator(".line").count();
  const first = await counted();
  expect(first).toBeGreaterThan(20);

  // Left alone, the pane must settle instead of colouring the whole body.
  await page.waitForTimeout(2500);
  const idle = await counted();
  expect(idle).toBe(first);

  // One continuous block: the frame is shipped once, not per slice.
  await expect(preview.locator("pre")).toHaveCount(1);

  let previous = idle;
  for (let i = 0; i < 60; i++) {
    await pane.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    const now = await counted();
    if (now === previous) break;
    previous = now;
  }
  expect(previous).toBeGreaterThan(idle);
  await expect(preview.locator("pre")).toHaveCount(1);
});
