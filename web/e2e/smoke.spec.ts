import { expect, test } from "@playwright/test";

// The API isn't running here: /v1 answers with no models and no basemap, as a fresh install would.
test("the app boots, draws the map and throws nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Later routes win in Playwright: the catch-all first, then the models list.
  await page.route("**/v1/**", (r) => r.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.route("**/basemap/**", (r) => r.fulfill({ status: 204 })); // no tiles built here
  await page.route("**/v1/models", (r) => r.fulfill({ json: { models: [] } }));
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByRole("button").first()).toBeVisible();
  expect(errors).toEqual([]);
});
