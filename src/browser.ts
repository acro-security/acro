import { Browser, Vault, events } from "@/mygo";
import { native } from "@/api";
export { Browser, Vault };
export type {
  Account,
  State as BrowserState,
  Status as VaultStatus,
  Tab as BrowserTab,
  LoginInput,
  SaveInput,
} from "@/mygo";
export function watchBrowser(onChange: (state: import("@/mygo").State) => void) {
  return native ? events.browserState.on(onChange) : () => {};
}
