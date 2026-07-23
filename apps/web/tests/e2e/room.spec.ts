import { expect, test, type Page } from "@playwright/test";

/**
 * Pages are prerendered as static HTML, so buttons exist in the DOM before
 * React hydrates (especially slow in `next dev`). Clicking pre-hydration is
 * silently lost; always wait for the data-hydrated marker first.
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.locator('main[data-hydrated="true"]').waitFor({ timeout: 15_000 });
}

async function createRoomAsHost(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.getByLabel("Your display name").fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{8}/, { timeout: 15_000 });
  return page.url();
}

async function joinRoomAsGuest(page: Page, roomUrl: string, name: string): Promise<void> {
  await page.goto(roomUrl);
  await waitForHydration(page);
  await page.getByLabel("Your display name").fill(name);
  await page.getByRole("button", { name: "Join room" }).click();
}

test.describe("room lifecycle", () => {
  test("landing page shows product info and notices", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /WatchShare/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create a room" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join a room" })).toBeVisible();
    await expect(page.getByText(/explicit permission/i)).toBeVisible();
  });

  test("host creates a room and lands in it", async ({ page }) => {
    await createRoomAsHost(page, "HostUser");
    await expect(page.getByRole("button", { name: "Share a tab" })).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByText("Not sharing")).toBeVisible();
  });

  test("guest joins via invite URL and both can chat", async ({ browser, page }) => {
    const roomUrl = await createRoomAsHost(page, "Host");

    // Guest joins from a fresh browser context (separate session storage).
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await joinRoomAsGuest(guest, roomUrl, "Guest");

    // Both sides see each other in the participant list.
    await expect(page.getByText("Guest", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(guest.getByText(/Host/).first()).toBeVisible({ timeout: 15_000 });

    // Chat crosses over. Target the textbox role: getByLabel matches by
    // substring and would also hit the "Chat messages" list.
    await guest.getByRole("textbox", { name: "Chat message" }).fill("hello from guest");
    await guest.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("hello from guest")).toBeVisible({ timeout: 15_000 });

    // Viewer sees the waiting state, not an error.
    await expect(guest.getByText(/host is not sharing yet/i)).toBeVisible();
    await guestContext.close();
  });

  test("invalid room code shows a helpful error", async ({ page }) => {
    await page.goto("/room/ZZZZ9999");
    await waitForHydration(page);
    await page.getByLabel("Your display name").fill("Nobody");
    await page.getByRole("button", { name: "Join room" }).click();
    // Allow for the signaling ack round-trip (up to 10s on a dead socket).
    await expect(page.getByText(/could not be found/i)).toBeVisible({ timeout: 15_000 });
  });

  test("host can close the room and the guest is notified", async ({ browser, page }) => {
    const roomUrl = await createRoomAsHost(page, "Host");

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await joinRoomAsGuest(guest, roomUrl, "Guest");
    await expect(guest.getByText(/host is not sharing yet/i)).toBeVisible({ timeout: 15_000 });

    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Close room" }).click();
    await expect(guest.getByText(/closed/i).first()).toBeVisible({ timeout: 15_000 });
    await guestContext.close();
  });
});
