import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
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
}: {
  projectId: string;
  t: Dictionary;
  suspended: boolean;
}) {
  const [state, setState] = useState<BrowserState>({ tabs: [], selectedId: "" });
  const [address, setAddress] = useState("");
  const [newTab, setNewTab] = useState(false);
  const [showVault, setShowVault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<VaultStatus>(locked);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [login, setLogin] = useState({
    email: "",
    password: "",
    code: "",
    server: "http://localhost:8222",
  });
  const [editing, setEditing] = useState<SaveInput | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const tabs = state.tabs.filter((tab) => tab.projectId === projectId);
  const tab = tabs.find((tab) => tab.id === state.selectedId) ?? tabs[0];
  const unlocked = status.state === "unlocked";
  useBrowserViewport(
    slot,
    newTab ? undefined : tab?.id,
    suspended || !!editing || !!deleting || !!tab?.error,
  );

  function failure(error: unknown) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
  async function action(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      failure(error);
    } finally {
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
      try {
        const next = await Vault.status.with({ signal: controller.signal })();
        if (!disposed) {
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
    let disposed = false;
    setAccounts([]);
    if (native && unlocked && tab?.url)
      void Vault.accounts(tab.url)
        .then((items) => {
          if (!disposed) setAccounts(items);
        })
        .catch(failure);
    return () => {
      disposed = true;
    };
  }, [unlocked, tab?.id, tab?.url]);
  async function reloadAccounts() {
    if (tab) setAccounts(await Vault.accounts(tab.url));
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
      <div className="flex min-h-8 shrink-0 items-center gap-2">
        <h2 className="text-title font-semibold">{t.browser}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={t.credentials}
          aria-pressed={showVault}
          onClick={() => setShowVault(!showVault)}
        >
          <KeyRound />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* The page takes the larger share when stacked, and all of it side by
            side: the guest WebView is the reason this view exists. */}
        <Panel className="min-h-0 flex-[2] lg:flex-1">
          <div className="flex h-8 shrink-0 items-center border-b">
            <Tabs
              value={newTab ? "" : (tab?.id ?? "")}
              onValueChange={(id) => {
                setNewTab(false);
                void action(async () => setState(await Browser.select(id)));
              }}
              className="min-w-0 flex-1 overflow-x-auto"
            >
              <TabsList variant="editor" aria-label={t.browserTabs}>
                {tabs.map((item) => (
                  <div key={item.id} className="relative flex shrink-0 border-r">
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
            className="flex shrink-0 items-center gap-1 border-b p-2"
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
              className="min-w-0 flex-1"
            />
            <Button type="submit" size="sm" disabled={!native || !address.trim() || busy}>
              {t.go}
            </Button>
          </form>
          <div ref={slot} data-testid="browser-viewport" className="relative min-h-0 flex-1">
            {!native || !tab || newTab ? (
              <Empty className="h-full border-0">
                <EmptyHeader>
                  <Globe className="mx-auto text-muted-foreground" />
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
          <Panel className="min-h-0 flex-1 lg:flex-none lg:w-80">
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
                      setAccounts([]);
                      await refreshVault();
                    })
                  }
                >
                  <LockKeyhole />
                </Button>
              )}
            </PanelHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
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
                    void action(async () => {
                      setStatus(await Vault.unlock(input));
                      input.password = "";
                      input.code = "";
                    });
                  }}
                >
                  <FieldGroup>
                    <p className="flex items-center gap-2 text-sm">
                      <LockKeyhole />
                      {t.vaultLocked}
                    </p>
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
                            value={login.email}
                            onChange={(e) => setLogin({ ...login, email: e.target.value })}
                            required
                          />
                        </Field>
                      </>
                    )}
                    <Field>
                      <FieldLabel htmlFor="vault-password">{t.masterPassword}</FieldLabel>
                      <Input
                        id="vault-password"
                        type="password"
                        autoComplete="off"
                        value={login.password}
                        onChange={(e) => setLogin({ ...login, password: e.target.value })}
                        required
                      />
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
                    <Button type="submit" disabled={busy}>
                      {busy ? t.connecting : t.unlockVault}
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
                          })
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
                    <span className="truncate">{status.email || status.server}</span>
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
                  <p className="break-all text-xs text-muted-foreground">
                    {tab ? safeOrigin(tab.url) : t.openWebsite}
                  </p>
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
                        setAccounts([]);
                        await refreshVault();
                      })
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
