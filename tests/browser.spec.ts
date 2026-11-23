import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("Browser is discoverable in web preview without pretending to embed a browser", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Browser", exact: true }).click();
  await expect(page.getByRole("button", { name: "Browser", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByText("Website browsing and Bitwarden are available in the desktop app"),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Website address" })).toBeDisabled();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("native Browser controls manage metadata and fill via credential references", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const state = {
      tabs: [] as Array<{
        id: string;
        projectId: string;
        url: string;
        title: string;
        loading: boolean;
        back: boolean;
        forward: boolean;
        error: string;
      }>,
      selectedId: "",
    };
    let unlocked = false;
    const syncedAccounts = [
      {
        id: "11111111-2222-4333-8444-555555555555",
        name: "Test account",
        username: "alice",
        origins: ["https://example.test"],
      },
    ];
    const accounts: typeof syncedAccounts = [];
    let accountGate: Promise<void> | null = null;
    let releaseAccountGate = () => {};
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const inspect = Object.assign(window, {
      fills: [] as unknown[],
      viewport: null as unknown,
      syncs: 0,
      accountQueries: 0,
      holdNextStatus: false,
      statusPending: false,
      releaseStatus: () => {},
      holdAccountRequests: () => {
        accountGate = new Promise<void>((resolve) => {
          releaseAccountGate = resolve;
        });
      },
      releaseAccountRequests: () => {
        releaseAccountGate();
        accountGate = null;
      },
    });
    const notify = () => {
      for (const fn of listeners.get("browser:state") ?? []) fn(structuredClone(state));
    };
    const status = () => ({
      available: true,
      state: unlocked ? "unlocked" : "locked",
      server: "https://vault.example.test",
      email: "alice@example.test",
    });
    Object.assign(window, {
      mygo: {
        on(name: string, fn: (data: unknown) => void) {
          const list = listeners.get(name) ?? [];
          list.push(fn);
          listeners.set(name, list);
          return () => {
            const index = list.indexOf(fn);
            if (index >= 0) list.splice(index, 1);
          };
        },
        async callWith(method: string, args: unknown[]) {
          switch (method) {
            case "Capture.Status":
              return { running: false, addr: "", port: 8081, captured: 0 };
            case "Capture.History":
              return [];
            case "Browser.Status":
              return structuredClone(state);
            case "Browser.Open": {
              const input = args[0] as { url: string; projectId: string };
              state.tabs.push({
                id: `tab-${state.tabs.length + 1}`,
                projectId: input.projectId,
                url: input.url,
                title: "Login fixture",
                loading: false,
                back: false,
                forward: false,
                error: "",
              });
              state.selectedId = state.tabs.at(-1)!.id;
              notify();
              return structuredClone(state);
            }
            case "Browser.SetViewport":
              inspect.viewport = args[0];
              return;
            case "Browser.Select":
              state.selectedId = args[0] as string;
              notify();
              return structuredClone(state);
            case "Browser.Fill":
              inspect.fills.push(args[0]);
              return;
            case "Browser.Close":
              state.tabs = state.tabs.filter((tab) => tab.id !== args[0]);
              state.selectedId = state.tabs[0]?.id ?? "";
              notify();
              return structuredClone(state);
            case "Vault.Status": {
              const snapshot = status();
              if (inspect.holdNextStatus) {
                inspect.holdNextStatus = false;
                inspect.statusPending = true;
                await new Promise<void>((resolve) => {
                  inspect.releaseStatus = resolve;
                });
              }
              return snapshot;
            }
            case "Vault.Unlock":
              unlocked = true;
              return status();
            case "Vault.Lock":
              unlocked = false;
              return;
            case "Vault.Accounts":
              inspect.accountQueries++;
              if (accountGate) await accountGate;
              return structuredClone(accounts);
            case "Vault.Save": {
              const input = args[0] as { id: string; name: string; username: string };
              const item = accounts.find((item) => item.id === input.id);
              if (item) Object.assign(item, { name: input.name, username: input.username });
              else
                accounts.push({
                  id: "66666666-7777-4888-8999-000000000000",
                  name: input.name,
                  username: input.username,
                  origins: ["https://example.test"],
                });
              return structuredClone(accounts.at(-1));
            }
            case "Vault.Delete":
              accounts.splice(
                accounts.findIndex((item) => item.id === args[0]),
                1,
              );
              return;
            case "Vault.Sync":
              await new Promise((resolve) => setTimeout(resolve, 50));
              if (inspect.syncs++ === 0) accounts.push(...syncedAccounts);
              return;
            default:
              throw new Error(`Unexpected test call ${method}`);
          }
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByLabel("Website address", { exact: true }).fill("https://example.test/login");
  await page.getByLabel("Website address", { exact: true }).press("Enter");
  await expect(page.getByRole("tab", { name: "Login fixture", exact: true })).toBeVisible();
  await page.getByLabel("Master password", { exact: true }).fill("fixture-master-password");
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await expect(page.getByText("Test account", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { syncs: number }).syncs)).toBe(1);
  const queries = await page.evaluate(() => {
    const fixture = window as Window & { holdAccountRequests(): void; accountQueries: number };
    fixture.holdAccountRequests();
    return fixture.accountQueries;
  });
  await page.getByRole("button", { name: "Sync vault", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { accountQueries: number }).accountQueries))
    .toBeGreaterThan(queries);
  // A delayed refresh must leave the existing list visible.
  await expect(page.getByText("Test account", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as Window & { releaseAccountRequests(): void }).releaseAccountRequests(),
  );
  await page.getByRole("button", { name: "Fill account", exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { fills: unknown[] }).fills)).toEqual([
    { tabId: "tab-1", credentialId: "11111111-2222-4333-8444-555555555555" },
  ]);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill("New account");
  await page.getByLabel("Username", { exact: true }).fill("bob");
  await page.getByLabel("Password", { exact: true }).fill("fixture-item-password");
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { viewport: { visible: boolean } }).viewport.visible),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByText("New account", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit account: New account", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.getByLabel("Account name", { exact: true }).fill("Renamed account");
  await page.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByText("Renamed account", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete account: Renamed account", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete account", exact: true })
    .click();
  await expect(page.getByText("Renamed account", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-master-password",
  );
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-item-password",
  );
  await page.evaluate(() => {
    (window as Window & { holdNextStatus: boolean }).holdNextStatus = true;
  });
  await page.clock.fastForward(16000);
  await expect
    .poll(() => page.evaluate(() => (window as Window & { statusPending: boolean }).statusPending))
    .toBe(true);
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(page.getByLabel("Master password", { exact: true })).toBeVisible();
  // An earlier unlocked status response must not undo the user's lock action.
  await page.evaluate(() => (window as Window & { releaseStatus(): void }).releaseStatus());
  await page.clock.runFor(100);
  await expect(page.getByLabel("Master password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Master password", { exact: true })).toHaveValue("");
  await expect(page.getByText("Test account", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/browser.png", animations: "disabled" });
});

test("fill executor refuses cross-origin and changed forms", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const source = readFileSync("internal/browserapp/fill.js", "utf8");
  const fill = (expectedOrigin = origin) =>
    page.evaluate(
      (script) => new Function(script)(),
      source.replace(
        "__ACRO_CREDENTIAL__",
        JSON.stringify({
          origin: expectedOrigin,
          username: "fixture-user",
          password: "fixture-secret",
        }),
      ),
    );
  await page.setContent('<form><input name="username"><input type="password"></form>');
  expect(await fill()).toBe("filled");
  await expect(page.locator('input[type="password"]')).toHaveValue("fixture-secret");
  await page.setContent(
    '<form action="https://other.example/login"><input name="username"><input type="password"></form>',
  );
  expect(await fill()).toBe("cross-origin-form");
  await expect(page.locator('input[type="password"]')).toHaveValue("");
  await page.setContent('<form><input name="username"><input type="password"></form>');
  await page.locator('[name="username"]').evaluate((input) =>
    input.addEventListener("input", () => {
      (document.querySelector("form") as HTMLFormElement).action = "https://other.example/login";
    }),
  );
  expect(await fill()).toBe("cross-origin-form");
  await expect(page.locator('input[type="password"]')).toHaveValue("");
  await page.setContent(
    '<form><input name="username"><input type="password" autocomplete="new-password"></form>',
  );
  expect(await fill()).toBe("no-password-field");
  expect(await fill("https://other.example")).toBe("origin-changed");
});
