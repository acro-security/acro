# Acro

A local-first HTTP workbench: write a raw request, send it, and read the
response beside it. It is a desktop app — a TypeScript frontend in mygo's
webview, with Go doing the HTTP work — and the same page also runs in a browser
against a development server that uses the identical engine.

## Why this shape

mygo does here what Tauri does elsewhere: it owns the window, the system webview
and IPC. It does not draw the interface, so the UI is ordinary web code —
React, TypeScript, Tailwind, shadcn/ui — and the backend stays in Go.

`internal/replay` owns the transport-neutral `Input`, `Result` and `Executor`
contract. `main.go` binds `replay.Service`, which `mygo generate` turns into the
typed client at `src/mygo.ts`. A future agent harness calls the same `Executor`.

## Run

```sh
nix develop path:.
just install
just dev          # the desktop app, with live reload
```

The dev shell provides WebKitGTK 4.1, which the desktop window needs; outside
Nix, install `libwebkit2gtk-4.1-0` (Debian/Ubuntu) or `webkit2gtk4.1` (Fedora).

Browser development needs the transport and the page in two terminals:

```sh
just api          # replay engine on 127.0.0.1:7777
bun run dev:web   # page on 127.0.0.1:5173
```

`just echo` starts an optional local capture target.

## Intercept traffic

Acro is an intercepting proxy. Start **Intercept**, then point a client's HTTP
proxy at `127.0.0.1:8081`:

```sh
curl --proxy http://127.0.0.1:8081 http://example.com/
```

Plain HTTP is recorded as it passes. HTTPS is read by terminating TLS with Acro's
own certificate authority: download **CA certificate** from the command palette
(Ctrl/Command + K), trust it in the client, and decrypted requests appear beside
their responses.

## Use it

- Start with an empty workspace; projects and requests are created explicitly
- Right-click a captured exchange and choose **Send to repeater**
- Capture rows and replay tabs share the same incremental capture number
- Press Escape to close a captured exchange
- Edit the name, the origin and the raw HTTP message
- Send with the button or Ctrl/Command + Enter; Cancel stops a request
- Read the response as body, headers or the reconstructed raw message
- Pretty formats and highlights JSON, HTML, JavaScript and HTTP without changing sent bytes
- Copy a request or response, or save the response
- Open request options in the settings popup
- Save request/response snapshots in Evidence, then export them as JSON
- Switch saved request tabs in the main panel; closing a tab keeps its request
- Create projects to separate requests and prepare local LLM session drafts
- Press Ctrl/Command + K for the command palette
- Switch language between English, Simplified Chinese and Japanese

English is the initial language. Only interface labels are translated: errors,
logs, protocol fields and anything you typed remain as they are. Workspace
projects, request drafts, open tabs, language, appearance, and session drafts live
in `localStorage`. Existing v1/v2 workspaces migrate automatically without dropping
request content. Replay history and evidence remain in memory until exported.
LLM sessions currently save task instructions locally; no model execution is
connected yet.

## Commands

| Command                             | Purpose                                   |
| ----------------------------------- | ----------------------------------------- |
| `just dev`                          | Start the desktop app with live reload    |
| `just api`                          | Start the browser development transport   |
| `just check`                        | Frontend build, Go tests, and Go vet      |
| `just build`                        | Package the desktop app in `build/`       |
| `just format` / `just format-check` | Format or check Go, Nix and TypeScript    |
| `just echo`                         | Start the optional local HTTP echo target |

See [design](docs/design.md) for the interface and
[architecture](docs/architecture.md) for the boundaries.
