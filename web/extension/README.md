# DIAMOND:CONTEXT — Watch (Chrome extension)

The companion that makes the **Watch** tab actually watch. Pick a game in
DIAMOND:CONTEXT and this extension opens it on MLB.tv, starts playback, and
floats it into a picture-in-picture window you can park in the corner of your
screen.

## Why an extension (and not just the web app)

MLB.tv video is **DRM-protected** (Widevine/FairPlay). A web page — including
DIAMOND:CONTEXT — **cannot** embed it, proxy it, or pull it into its own
`<video>` element. The only way to watch it is in MLB's own player. So the web
app is the *launcher* and this extension is the *player driver*.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `web/extension/` folder.
4. Make sure you're signed in to [mlb.com](https://www.mlb.com) with an active
   MLB.tv subscription. (Auth is your normal browser session — the extension
   never sees your credentials.)

Once loaded, the Watch tab in DIAMOND:CONTEXT will show **"Watch extension
connected"** instead of the install prompt.

### Logging in — once

You sign in to MLB.tv **yourself**, one time, in your normal browser. MLB stores
a session cookie, and the extension opens every game in that already-signed-in
session — so no password is ever entered, stored, or seen by the extension.
When the session eventually expires, a watch click lands on MLB's login page;
the extension detects that (`looksLoggedOut()` in `content-mlb.js`) and the
Watch tab shows a one-click **"Sign in to MLB.tv"** prompt. The extension never
handles the password itself.

## How it works

```
Watch tab  ──postMessage──▶  content-bridge.js  ──runtime msg──▶  background.js
 (web app)                    (in the web app)                      (worker)
                                                                       │
                                                          opens MLB.tv tab
                                                                       │
                                                                       ▼
                                              content-mlb.js  ◀──"enter PiP"──┘
                                              (on mlb.com): play + auto-PiP
```

- `content-bridge.js` runs inside the DIAMOND:CONTEXT page, tells it the
  extension is installed (via a DOM attribute), and relays your game pick to
  the worker.
- `background.js` opens the MLB.tv deep link for that game's `gamePk` and, when
  the player reports in, tells it to play and float.
- `content-mlb.js` finds the game video, starts it, and shows the one-tap
  "click to watch in the corner" overlay that floats it into PiP. If the feed
  is signed out, it sends you to MLB's login first (it never handles the
  password).

## The picture-in-picture flow — read this

Two browser constraints shape how this works (both verified against the live
MLB.tv player):

1. `requestPictureInPicture()` **requires a user gesture**, and the Watch click
   happens in the DIAMOND:CONTEXT tab — a gesture there doesn't carry to the
   MLB.tv tab. `video.autoPictureInPicture` is also unsupported in current
   Chrome. So there's **no reliable zero-click PiP**.
2. Browser/extension APIs **cannot pin a native PiP window to a screen corner** —
   the OS owns its position.

So the flow is **one tap**: when the feed starts, the extension shows a small
"▶ Click anywhere to watch in the corner" overlay. Your first click in that tab
(a real gesture) floats it into PiP — confirmed working on the live feed at
1080p. Then switch back to DIAMOND:CONTEXT and the PiP window stays on top.
**Drag it to the bottom-right once** and Chrome reuses that spot every time
after. (The popup's "Pop current video into PiP" button does the same thing.)

## Auto-snap the PiP to the corner (macOS)

To pin the PiP window to the bottom-right *automatically* (no dragging), a
small Hammerspoon helper is included: `hammerspoon-dc-pip.lua`. It watches for
Chrome's PiP window and snaps it into the bottom-right of whatever screen it
appears on (each window is moved once, so you can still re-drag it).

Setup:

1. Install Hammerspoon: `brew install --cask hammerspoon`.
2. `~/.hammerspoon/init.lua` loads the helper from this repo (already created).
   If you cloned the repo elsewhere, update the path in that file.
3. Launch Hammerspoon, then grant it **Accessibility** permission:
   System Settings → Privacy & Security → Accessibility → enable **Hammerspoon**.
   (Moving windows is a protected action — this can't be scripted.)
4. Reload the config: Hammerspoon menu-bar icon → *Reload Config*
   (or ⌘⌃R). You'll see a "D:C PiP auto-snap loaded" toast.

Now every time the feed pops into PiP, it jumps to the bottom-right corner. If
detection ever misses (a Chrome update changes the PiP window), run
`dcPiPDebug()` in the Hammerspoon console to list Chrome windows and tune the
match in `hammerspoon-dc-pip.lua`.

## Things that may need tuning

I can't see behind the MLB.tv paywall, so two spots are best-effort and may
need a tweak against the live DOM once you're signed in:

- **The deep-link URL** — `mlbTvUrl()` in `background.js`. If clicking Watch
  lands on a listing page instead of the player, update that path.
- **Play-button / video selectors** — in `content-mlb.js` (`tryPlay`,
  `pickVideo`, `maybeClickIntoGame`). The largest-video heuristic usually finds
  the feed, but the play-button selector list may need MLB's current class.

Once it's installed and you're logged in, ask Claude Code to do a live
selector-discovery pass on an actual game page and it'll pin these down.

## Permissions

- `tabs`, `activeTab`, `scripting` — open the MLB.tv tab and run the play/PiP
  script on it (and on the active tab for the popup's manual button).
- `host_permissions: *.mlb.com` — so the content script can run on the player.
- No analytics, no network calls of its own, no credential access.
