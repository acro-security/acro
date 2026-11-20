// Called only by the local Go executor; never returned to the model or UI.
const credential = __ACRO_CREDENTIAL__;
if (location.origin !== credential.origin) return "origin-changed";
const visible = (el) =>
  !el.disabled &&
  !el.readOnly &&
  el.getClientRects().length > 0 &&
  getComputedStyle(el).visibility !== "hidden";
const password = [...document.querySelectorAll('input[type="password"]')].find(
  (el) => visible(el) && el.autocomplete !== "new-password",
);
if (!password) return "no-password-field";
const form = password.form;
if (form && new URL(form.action || location.href, location.href).origin !== credential.origin)
  return "cross-origin-form";
const root = form || document;
const username = [
  ...root.querySelectorAll(
    'input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="email" i],input[type="text"],input:not([type])',
  ),
].find(visible);
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
const set = (el, value) => {
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
if (username) set(username, credential.username);
// An input handler can navigate synchronously: check again before releasing the password.
if (location.origin !== credential.origin || !password.isConnected) return "origin-changed";
if (password.type !== "password" || !visible(password)) return "no-password-field";
if (
  password.form &&
  new URL(password.form.action || location.href, location.href).origin !== credential.origin
)
  return "cross-origin-form";
set(password, credential.password);
return "filled";
