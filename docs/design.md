# Interface design

Acro shows captured HTTP traffic. That is the subject, and it drives every
choice here: the page is nearly monochrome, color is spent only on outcomes, and
protocol text is set in a mono face so a request reads as data rather than prose.

The layout follows the user's ChatGPT Web reference: feature navigation above
projects and LLM sessions in a quiet left sidebar, with active work in the main
panel. Request documents use VS Code-style tabs inside Repeater. The title bar
carries the wordmark, search and the native window controls; there is no
marketing copy. Components use shadcn/ui with the existing radix-nova preset.

## Tokens

| Role               | Light                             | Dark                              |
| ------------------ | --------------------------------- | --------------------------------- |
| Canvas             | `#fbf9fc`                         | `#0e0c10`                         |
| Panel              | `#ffffff`                         | `#17161b`                         |
| Strip (bars)       | `#f5f1f6`                         | `#1d1b22`                         |
| Field              | `#f5eff5`                         | `#251f27`                         |
| Rail               | `#f6f6f7`                         | `#17171b`                         |
| Rail, hovered      | `#ececee`                         | `#2b2931`                         |
| Vault              | `#fbf6fa`                         | `#1d171c`                         |
| Ink                | `#17181a`                         | `#f1edf2`                         |
| Ink, muted         | `#71757b`                         | `#b8afba`                         |
| Ink, faint         | `#9a9ea4`                         | `#a39aa8`                         |
| Hairline           | `#e6e7e9`                         | `#352e38`                         |
| Intercept (accent) | `#0d64b0`                         | `#a6cbfa`                         |
| OK / warn / fail   | `#12924f` / `#9a6400` / `#b42318` | `#95d4b1` / `#e5bf91` / `#f39191` |
| Action (primary)   | `#2b2330` / `#ffffff`             | `#e8e1ea` / `#201923`             |

Upstream ZAP's interception blue marks only what cuts traffic: focus and the
chosen row. Primary buttons use the action pair rather than the accent, so the
send action reads as the one strong control on the page. Method and status colors
follow meaning, not decoration — POST ok, PUT/PATCH warn, DELETE fail, reads and
3xx info, 2xx ok, 4xx warn, 5xx fail.

**Type.** Geist for interface text at 11, 11.5 and 12.5px with a 14px view
title; Geist Mono at 12px/20px for request and response editors. Both faces ship
with the app rather than loading from a network. The mono face is the one
deliberate flourish: it separates protocol from chrome at a glance and makes
columns of paths line up.

**Shape.** One radius family (7px panels, 5px controls, 3px micro chips) and one
hairline weight. Panes are bordered boxes, not floating cards: no shadows except
on the rail when it floats over the panes.

## Principles

1. **Traffic is the content.** Chrome recedes — the rail, strips and hairlines
   are one step from the canvas, labels are 11px and quiet.
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
│ ◐ Acro         ⧉   │ Search  Language  Theme  – □ ×       │
├────────────────────┼──────────────────────────────────────┤
│ Browser            │ #24 Cart state ×  #21 Redirect ×  +  │
│ Repeater           ├──────────────────────────────────────┤
│ Intercept          │ GET  https://…/api/cart     Options  │
│ History            ├──────────────────┬───────────────────┤
│ Evidence           │ Request editor   │ Response viewer   │
│                    │                  │                   │
│ Projects       +   │                  │                   │
│   Checkout QA  ⌄   │                  │                   │
│     Checkout redir │                  │                   │
└────────────────────┴──────────────────────────────────────┘
```

The sidebar is 222px wide and collapses to a 50px icon rail; it narrows to
172px between 768px and 1030px. On narrow screens it opens as an accessible
modal navigation drawer. Features stay at the top; projects and nested session
drafts scroll below them. Navigation is left aligned, with a single selected
surface and no decorative labels or numbering.

Request tabs can be selected and closed. Closing keeps the saved request; the
command palette can reopen it. A new request opens in the active project. Projects
isolate drafts, replay history, and evidence. The interception listener remains
global. Open tabs and edits persist across launches.

Sessions store a title and task instructions locally. Their view explicitly says
no model is connected and offers a JSON export. A project evidence row names the
project, its snapshot count and a link to Evidence. It does not simulate
assistant messages or expose an unimplemented Run action.

## Review against the brief

The previous top toolbar held feature navigation while the rail only listed
requests. The new hierarchy gives the rail to application navigation and the
main-panel tabs to request documents. This makes room for the future harness's
projects and sessions while retaining the working HTTP tools.

The wordmark returns to the title bar, which also carries window controls in the
desktop app. Colors and faces follow the Geist-based dark palette above; no
decorative card grid or slogan was introduced.

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
diagnostics. A body is formatted in full and the formatted result is then cut at
a line boundary to 128 KB, so a minified bundle still reads as code instead of
failing to parse; bodies past 1 MB are cut before formatting, where the fragment
may only be highlighted. Decoded data stops at 2 MiB; retained raw captures and
sent bytes are unaffected.

Highlighting is lazy. Shiki's cost grows faster than the text it sees — one
127 KB bundle takes about 4.7 s as a single call and about 30 ms for its first
screenful — so the worker prepares the text once, ships the first slice, and
waits. The view asks for the next slice when the reader nears the end of what has
arrived, so text nobody scrolls to is never coloured. Slices are cut at line
breaks, and each is highlighted without the newline it was cut at, which keeps
colours independent of their neighbours and stops Shiki inventing an empty line
at every seam. Only the first slice carries Shiki's `<pre><code>` frame; later
slices append line spans into that same block, so the pane stays one continuous
`<pre>` rather than a stack of them. Closing a pane cancels its worker job after a
short grace period, which also lets a remount rejoin work already in flight.
