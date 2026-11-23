import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  Pencil,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { native } from "@/api";
import {
  Browser,
  Vault,
  watchBrowser,
  type Account,
  type BrowserState,
  type VaultStatus,
  type SaveInput,
} from "@/browser";
import type { Dictionary } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Panel, PanelHeader } from "@/components/surface";
import { useBrowserViewport } from "@/hooks/use-browser-viewport";

const locked: VaultStatus = {
  available: false,
  state: "unauthenticated",
  server: "https://vault.bitwarden.com",
  email: "",
};
const emptyAccount: SaveInput = { id: "", name: "", url: "", username: "", password: "" };

export function BrowserView({
  projectId,
  t,
  suspended,
  showVault,
}: {
  projectId: string;
  t: Dictionary;
  suspended: boolean;
  showVault: boolean;
}) {
  const [state, setState] = useState<BrowserState>({ tabs: [], selectedId: "" });
  const [address, setAddress] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<VaultStatus>(locked);
  const [accountResult, setAccountResult] = useState<{ scope: string; items: Account[] }>({
    scope: "",
    items: [],
  });
  const [accountsRevision, setAccountsRevision] = useState(0);
  const [login, setLogin] = useState({
    email: "",
    password: "",
    code: "",
    server: "https://vault.bitwarden.com",
  });
  const [editing, setEditing] = useState<SaveInput | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const actionPending = useRef(false);
  const vaultMutation = useRef(false);
  const vaultVersion = useRef(0);
  const tabs = state.tabs.filter((tab) => tab.projectId === projectId);
  const tab = tabs.find((tab) => tab.id === state.selectedId) ?? tabs[0];
  const unlocked = status.state === "unlocked";
  const accountScope = JSON.stringify([status.server, status.email, tab?.id, tab?.url]);
  const accounts = unlocked && accountResult.scope === accountScope ? accountResult.items : [];
  useBrowserViewport(
    slot,
    newTab ? undefined : tab?.id,
    suspended || !!editing || !!deleting || !!tab?.error,
  );

  function failure(error: unknown) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
  async function action(task: () => Promise<unknown>, changesVault = false) {
    if (actionPending.current) return;
    actionPending.current = true;
    if (changesVault) {
      vaultMutation.current = true;
      vaultVersion.current++;
    }
    setBusy(true);
    try {
      await task();
    } catch (error) {
      failure(error);
    } finally {
      if (changesVault) {
        vaultVersion.current++;
        vaultMutation.current = false;
      }
      actionPending.current = false;
      setBusy(false);
    }
  }
  async function refreshVault() {
    const next = await Vault.status();
    setStatus(next);
    setLogin((v) => ({
      ...v,
      email: next.email || v.email,
      server: next.state === "unauthenticated" ? v.server : next.server,
    }));
    return next;
  }
  useEffect(() => {
    if (!native) return;
    let disposed = false,
      live = false;
    const controller = new AbortController();
    let timer: number | undefined;
    const off = watchBrowser((next) => {
      live = true;
      if (!disposed) setState(next);
    });
    void Browser.status()
      .then((next) => {
        if (!disposed && !live) setState(next);
      })
      .catch(failure);
    async function pollVault(initial: boolean) {
      const version = vaultVersion.current;
      try {
        if (vaultMutation.current) return;
        const next = await Vault.status.with({ signal: controller.signal })();
        if (!disposed && !vaultMutation.current && version === vaultVersion.current) {
          setStatus(next);
          if (initial)
            setLogin((v) => ({
              ...v,
              email: next.email,
              server: next.state === "unauthenticated" ? v.server : next.server,
            }));
        }
      } catch (error) {
        if (initial && !disposed) failure(error);
      } finally {
        // A slow CLI invocation must finish before another poll starts.
        if (!disposed) timer = window.setTimeout(() => void pollVault(false), 15000);
      }
    }
    void pollVault(true);
    return () => {
      disposed = true;
      controller.abort();
      off();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    setAddress(tab?.url ?? "");
    setNewTab(false);
    if (native && tab && state.selectedId !== tab.id)
      void Browser.select(tab.id).then(setState).catch(failure);
  }, [tab?.id, tab?.url]);
  useEffect(() => {
    if (!native || !unlocked) return;
    const controller = new AbortController();
    // CLI unlock can use an old offline snapshot; refresh changes from other clients.
    void Vault.sync
      .with({ signal: controller.signal })()
      .then(() => {
        if (!controller.signal.aborted) setAccountsRevision((v) => v + 1);
      })
      .catch((error) => {
        if (!controller.signal.aborted) failure(error);
      });
    return () => controller.abort();
  }, [unlocked]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    if (!unlocked) setAccountResult({ scope: "", items: [] });
    if (native && unlocked && tab?.url)
      void Vault.accounts
        .with({ signal: controller.signal })(tab.url)
        .then((items) => {
          if (!disposed) setAccountResult({ scope: accountScope, items });
        })
        .catch((error) => {
          if (!disposed) failure(error);
        });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [unlocked, accountScope, accountsRevision]);
  function reloadAccounts() {
    setAccountsRevision((v) => v + 1);
  }
  function navigate() {
    let url = address.trim();
    if (!url) return;
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
    void action(async () => {
      if (!tab || newTab) setState(await Browser.open({ url, projectId }));
      else await Browser.navigate(tab.id, url);
      setNewTab(false);
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 md:flex-row">
        {/* The page takes the larger share when stacked, and all of it side by
            side: the guest WebView is the reason this view exists. */}
        <Panel className="min-h-0 flex-[2] md:flex-1">
          <div className="flex h-[42px] shrink-0 items-center gap-2 border-b bg-strip px-2">
            <Tabs
              value={newTab ? "" : (tab?.id ?? "")}
              onValueChange={(id) => {
                setNewTab(false);
                void action(async () => setState(await Browser.select(id)));
              }}
              className="min-w-0 overflow-x-auto"
            >
              <TabsList variant="editor" aria-label={t.browserTabs}>
                {(!tab || newTab) && (
                  <div className="flex h-7 w-44 shrink-0 items-center gap-2 rounded-sm bg-sidebar-accent px-2 text-xs">
                    <Globe className="size-3.5" />
                    {t.newBrowserTab}
                  </div>
                )}
                {tabs.map((item) => (
                  <div key={item.id} className="relative flex shrink-0">
                    <TabsTrigger value={item.id} className="max-w-52 pr-8">
                      <Globe />
                      <span className="truncate">{item.title || item.url}</span>
                    </TabsTrigger>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-1 top-0.5"
                      aria-label={`${t.close}: ${item.title}`}
                      onClick={() =>
                        void action(async () => setState(await Browser.close(item.id)))
                      }
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.newBrowserTab}
              disabled={!native || busy}
              onClick={() => {
                setNewTab(true);
                setAddress("");
                addressInput.current?.focus();
              }}
            >
              <Plus />
            </Button>
          </div>
          <form
            className="flex shrink-0 items-center gap-1 border-b bg-strip px-2.5 py-1"
            onSubmit={(event) => {
              event.preventDefault();
              navigate();
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.back}
              disabled={!tab?.back || busy}
              onClick={() => void action(() => Browser.action(tab!.id, "back"))}
            >
              <ArrowLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.forward}
              disabled={!tab?.forward || busy}
              onClick={() => void action(() => Browser.action(tab!.id, "forward"))}
            >
              <ArrowRight />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={tab?.loading ? t.cancel : t.reload}
              disabled={!tab || busy}
              onClick={() =>
                void action(() => Browser.action(tab!.id, tab?.loading ? "stop" : "reload"))
              }
            >
              {tab?.loading ? <Square /> : <RefreshCw />}
            </Button>
            <Input
              ref={addressInput}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              aria-label={t.address}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
              disabled={!native}
              className="h-[30px] min-w-0 flex-1 rounded-xl bg-field px-3 font-mono text-xs"
            />
          </form>
          <div ref={slot} data-testid="browser-viewport" className="relative min-h-0 flex-1">
            {!native || !tab || newTab ? (
              <Empty className="h-full border-0">
                <EmptyHeader>
                  <Globe className="mx-auto mb-1 size-8 text-muted-foreground" />
                  <EmptyTitle>{t.openWebsite}</EmptyTitle>
                  <EmptyDescription>
                    {native
                      ? t.browserEmpty
                      : "Website browsing and Bitwarden are available in the desktop app"}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : tab.error ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {tab.error}
              </p>
            ) : null}
          </div>
        </Panel>
        {showVault && (
          // Stacked under the page on narrow windows, the panel shares the
          // height with the page's instead of taking a fixed slice of it:
          // the guest WebView needs the room, and this panel scrolls itself.
          <Panel className="min-h-0 flex-1 bg-vault md:w-[270px] md:flex-none xl:w-[300px]">
            <PanelHeader title={t.credentials}>
              <span className="text-xs text-muted-foreground">Bitwarden</span>
              {unlocked && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t.lockVault}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await Vault.lock();
                      setAccountResult({ scope: "", items: [] });
                      await refreshVault();
                    }, true)
                  }
                >
                  <LockKeyhole />
                </Button>
              )}
            </PanelHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
              {!native ? (
                <p className="text-sm text-muted-foreground">Bitwarden requires the desktop app</p>
              ) : !status.available ? (
                <div className="flex flex-col gap-3">
                  <p role="status" className="text-sm">
                    Bitwarden CLI not found
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Install bw, then restart Acro or refresh the connection
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void action(refreshVault)}
                  >
                    {t.reload}
                  </Button>
                </div>
              ) : !unlocked ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = { ...login };
                    setLogin((v) => ({ ...v, password: "", code: "" }));
                    setRevealPassword(false);
                    void action(async () => {
                      setStatus(await Vault.unlock(input));
                      input.password = "";
                      input.code = "";
                    }, true);
                  }}
                >
                  <FieldGroup>
                    <div className="flex flex-col items-center gap-2 py-1 text-center">
                      {status.state === "unauthenticated" ? (
                        <ShieldCheck className="size-8 text-muted-foreground" />
                      ) : (
                        <LockKeyhole className="size-8 text-muted-foreground" />
                      )}
                      <h2 className="text-xl font-semibold">
                        {status.state === "unauthenticated" ? t.signInBitwarden : t.unlockVault}
                      </h2>
                      {status.state !== "unauthenticated" && (
                        <p className="text-xs text-muted-foreground">{t.unlockVaultHint}</p>
                      )}
                    </div>
                    {status.state !== "unauthenticated" && (
                      <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{status.email}</p>
                          <p className="truncate text-xs text-muted-foreground">{status.server}</p>
                        </div>
                      </div>
                    )}
                    {status.state === "unauthenticated" && (
                      <>
                        <Field>
                          <FieldLabel htmlFor="vault-server">{t.vaultServer}</FieldLabel>
                          <Input
                            id="vault-server"
                            value={login.server}
                            onChange={(e) => setLogin({ ...login, server: e.target.value })}
                            placeholder="https://vault.bitwarden.com"
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="vault-email">{t.email}</FieldLabel>
                          <Input
                            id="vault-email"
                            type="email"
                            autoComplete="username"
                            placeholder="you@example.com"
                            value={login.email}
                            onChange={(e) => setLogin({ ...login, email: e.target.value })}
                            required
                          />
                        </Field>
                      </>
                    )}
                    <Field>
                      <FieldLabel htmlFor="vault-password">{t.masterPassword}</FieldLabel>
                      <InputGroup className="h-9 bg-field">
                        <InputGroupInput
                          id="vault-password"
                          type={revealPassword ? "text" : "password"}
                          autoComplete={revealPassword ? "off" : "current-password"}
                          placeholder={t.masterPassword}
                          value={login.password}
                          onChange={(e) => setLogin({ ...login, password: e.target.value })}
                          required
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            variant="quiet-icon"
                            size="icon-xs"
                            aria-label={t.showPassword}
                            aria-pressed={revealPassword}
                            onClick={() => setRevealPassword((v) => !v)}
                          >
                            {revealPassword ? <EyeOff /> : <Eye />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </Field>
                    {status.state === "unauthenticated" && (
                      <Field>
                        <FieldLabel htmlFor="vault-code">{t.twoFactorCode}</FieldLabel>
                        <Input
                          id="vault-code"
                          autoComplete="one-time-code"
                          value={login.code}
                          onChange={(e) => setLogin({ ...login, code: e.target.value })}
                        />
                        <FieldDescription>{t.optional}</FieldDescription>
                      </Field>
                    )}
                    <Button type="submit" size="lg" disabled={busy}>
                      {busy
                        ? t.connecting
                        : status.state === "unauthenticated"
                          ? t.signIn
                          : t.unlockVault}
                    </Button>
                    {status.state !== "unauthenticated" && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await Vault.logout();
                            await refreshVault();
                          }, true)
                        }
                      >
                        {t.disconnect}
                      </Button>
                    )}
                  </FieldGroup>
                </form>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">
                        {status.email || status.server}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{status.server}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!tab || busy}
                      onClick={() =>
                        setEditing({ ...emptyAccount, url: tab ? safeOrigin(tab.url) : "" })
                      }
                    >
                      <Plus />
                      {t.addAccount}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.syncVault}
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await Vault.sync();
                          await reloadAccounts();
                        })
                      }
                    >
                      <RefreshCw />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-1 border-t pt-3 text-xs">
                    <strong>{t.siteLogins}</strong>
                    <span className="min-w-0 break-all text-muted-foreground">
                      {tab ? safeOrigin(tab.url) : t.openWebsite}
                    </span>
                  </div>
                  {accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {tab ? t.noAccounts : t.browserEmpty}
                    </p>
                  ) : (
                    <ul className="flex flex-col divide-y">
                      {accounts.map((account) => (
                        <li key={account.id} className="flex flex-col gap-2 py-3">
                          <div>
                            <p className="truncate text-sm font-medium">{account.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {account.username}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || !tab || newTab}
                              onClick={() =>
                                void action(async () => {
                                  await Browser.fill({ tabId: tab!.id, credentialId: account.id });
                                  toast.success("Account filled");
                                })
                              }
                            >
                              {t.fillAccount}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t.editAccount}: ${account.name}`}
                              disabled={busy}
                              onClick={() =>
                                setEditing({
                                  id: account.id,
                                  name: account.name,
                                  username: account.username,
                                  url: tab!.url,
                                  password: "",
                                })
                              }
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t.deleteAccount}: ${account.name}`}
                              disabled={busy}
                              onClick={() => setDeleting(account)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-auto text-xs text-muted-foreground">{t.fillOnly}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await Vault.logout();
                        setAccountResult({ scope: "", items: [] });
                        await refreshVault();
                      }, true)
                    }
                  >
                    {t.disconnect}
                  </Button>
                </>
              )}
            </div>
          </Panel>
        )}
      </div>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t.editAccount : t.addAccount}</DialogTitle>
            <DialogDescription>
              {editing?.id ? t.keepPassword : t.saveToBitwarden}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = { ...editing };
                setEditing(null);
                void action(async () => {
                  await Vault.save(input);
                  input.password = "";
                  await reloadAccounts();
                  toast.success("Account saved");
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="account-name">{t.accountName}</FieldLabel>
                  <Input
                    id="account-name"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-url">{t.url}</FieldLabel>
                  <Input id="account-url" value={editing.url} readOnly />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-username">{t.username}</FieldLabel>
                  <Input
                    id="account-username"
                    autoComplete="off"
                    value={editing.username}
                    onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-secret">{t.password}</FieldLabel>
                  <Input
                    id="account-secret"
                    type="password"
                    autoComplete="off"
                    value={editing.password}
                    onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                    required={!editing.id}
                  />
                </Field>
                <Button type="submit" disabled={busy}>
                  {t.saveAccount}
                </Button>
              </FieldGroup>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.deleteAccount}</DialogTitle>
            <DialogDescription>{deleting?.name}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const id = deleting!.id;
                setDeleting(null);
                void action(async () => {
                  await Vault.delete(id, tab!.url);
                  await reloadAccounts();
                });
              }}
            >
              {t.deleteAccount}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function safeOrigin(raw: string) {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
