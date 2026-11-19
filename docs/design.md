# Interface design

Acro shows captured HTTP traffic. That is the subject, and it drives every
choice here: the page is nearly monochrome, color is spent only on outcomes, and
protocol text is set in a mono face so a request reads as data rather than prose.

The layout follows the user's ChatGPT Web reference: feature navigation above
projects and LLM sessions in a quiet left sidebar, with active work in the main
panel. Request documents use VS Code-style tabs inside Repeater. There is no logo
or marketing copy. Components use shadcn/ui with the existing radix-nova preset.

## Tokens

| Role               | Light                             | Dark                              |
| ------------------ | --------------------------------- | --------------------------------- |
| Canvas             | `#fbfbfc`                         | `#08090a`                         |
| Panel              | `#ffffff`                         | `#121415`                         |
| Rail               | `#f6f6f7`                         | `#0e1011`                         |
| Rail, hovered      | `#ececee`                         | `#1b1e20`                         |
| Ink                | `#17181a`                         | `#ecedee`                         |
| Ink, muted         | `#71757b`                         | `#8b9096`                         |
| Ink, faint         | `#9a9ea4`                         | `#5f646a`                         |
| Hairline           | `#e6e7e9`                         | `#25282b`                         |
| Intercept (accent) | `#0d64b0`                         | `#4d9fe0`                         |
| OK / warn / fail   | `#12924f` / `#9a6400` / `#b42318` | `#4ec98a` / `#e0a458` / `#f0736f` |

The accent is ZAP's interception blue, and it marks only what cuts traffic: the
send action, focus, and the chosen row. Method and status colors follow meaning,
not decoration — POST ok, PUT/PATCH warn, DELETE fail, reads and 3xx info, 2xx ok,
4xx warn, 5xx fail. Primary text and controls use the existing semantic theme tokens.

**Type.** Inter Variable for interface text at 11, 11.5 and 12.5px with a 14px
view title; JetBrains Mono at 12px/20px for request and response editors. The mono face is the one deliberate flourish: it separates protocol
from chrome at a glance and makes columns of paths line up.

**Shape.** One radius family (7px panels, 5px controls, 3px micro chips) and one
hairline weight. Panes are bordered boxes, not floating cards: no shadows except
on the rail when it floats over the panes.

## Principles

1. **Traffic is the content.** Chrome recedes — the rail is `#f6f6f7`, hairlines
   are one pixel, labels are 11px and quiet.
2. **Two lines per row.** An incremental capture number leads each row, followed by method and path. You find a target by
   its shape, not by re-reading protocol text.
3. **Outcome colors only.** A green dot and a 201 say what happened. Nothing else
   is colored, so those two carry meaning.
4. **One bold move.** The mono protocol text inside otherwise quiet chrome.
5. **Everything reachable by keyboard.** Ctrl/Command + K for the palette,
   Ctrl/Command + Enter to send, focus rings that follow the accent.

## Workspace layout

```text
┌────────────────────┬──────────────────────────────────────┐
│                    │ Project / current feature   Settings │
│ Repeater           ├──────────────────────────────────────┤
│ Intercept          │ GET Request A ×  POST Request B ×  + │
│ History            ├──────────────────┬───────────────────┤
│ Evidence           │ Request editor   │ Response viewer   │
│                    │                  │                   │
│ Projects       +   │                  │                   │
│   Local workspace  │                  │                   │
│     LLM sessions + │                  │                   │
│     Session draft  │                  │                   │
└────────────────────┴──────────────────┴───────────────────┘
```

The sidebar is 260px wide and can be hidden. On narrow screens it opens as an
accessible modal navigation drawer. Features stay at the top; projects and
nested session drafts scroll below them. Navigation is left aligned, with a
single selected surface and no decorative labels or numbering.

Request tabs can be selected and closed. Closing keeps the saved request; the
command palette can reopen it. A new request opens in the active project. Projects
isolate drafts, replay history, and evidence. The interception listener remains
global. Open tabs and edits persist across launches.

Sessions store a title and task instructions locally. Their view explicitly says
no model is connected and offers a JSON export. It does not simulate assistant
messages or expose an unimplemented Run action.

## Review against the brief

The previous top toolbar held feature navigation while the rail only listed
requests. The new hierarchy gives the rail to application navigation and the
main-panel tabs to request documents. This makes room for the future harness's
projects and sessions while retaining the working HTTP tools.

The logo was removed. Existing colors and fonts were retained; no additional
accent, decorative card grid, or slogan was introduced.

## Writing

Labels are sentence case and say what happens: **Send request** produces
"Response received"; **Save evidence** collects a request and response snapshot. Empty panes
name the next action — _No response yet / Send a request to inspect the
response_ — rather than showing a mood. Failures show what broke, in the
interface's voice, with the technical detail beneath it: _Request failed_, then
the engine's English error, which is never translated.

Interface labels exist in English, Simplified Chinese and Japanese in
`src/i18n.ts`. Diagnostics, protocol fields and anything the user typed are never
translated.

## Verification

Browser tests cover replay, history, evidence export, language switching, request
tabs, project isolation, session drafts, v1 workspace migration, the command
palette, both themes, a 430px window, and no horizontal overflow. Screenshots are
captured after transitions settle. HTTP execution is tested separately in Go.

## Capture to replay

A fresh workspace has no projects, sessions or request drafts. Repeater drafts
come from the capture row context menu, and the compact 28px tab displays the
source capture number. Closing a tab keeps its draft; deleting the final draft leaves
an empty workspace. Request options open in a popover. Language uses an icon
control, and Escape dismisses capture details.

Pretty is a read-only display mode backed by Prettier and Shiki in a Web Worker.
It recognizes HTTP headers and JSON, HTML and JavaScript bodies, with shared
12px/20px editor typography and light/dark syntax colors. Gzip/deflate text bodies
can be decoded for preview. Binary and unsupported compression show English
diagnostics. Pretty previews stop at 128 KB and decoded data at 2 MiB; retained
raw captures and sent bytes are unaffected.
