-- DIAMOND:CONTEXT — auto-snap Chrome's Picture-in-Picture window to the
-- bottom-right corner.
--
-- The browser can't position its own PiP window (the OS owns it), so this
-- macOS-side helper watches for Chrome's PiP window and snaps it into the
-- bottom-right of whatever screen it appears on. Each PiP window is moved
-- once, so you can still drag it elsewhere afterward if you want.
--
-- Install: see web/extension/README.md ("Auto-snap the PiP to the corner").
-- This file is loaded from ~/.hammerspoon/init.lua.

local M = {}

local MARGIN = 16        -- gap from the screen edges, in points
local SCAN_INTERVAL = 0.6
local snapped = {}       -- window id -> true (so each PiP window moves once)

local MAX_W = 820       -- clamp the corner window so it stays compact
local MAX_H = 520

-- Should this window be snapped to the corner? Catches both:
--   1. Chrome's Picture-in-Picture window (always-on-top, just the video), and
--   2. the dedicated "MLB.TV Web Player" window (the game in its own window).
-- The fallback catches PiP even if a Chrome update renames its title, by
-- looking for a small, non-standard floating window.
local function shouldSnap(win)
  if not win then return false end
  local app = win:application()
  if not app then return false end
  if not (app:name() or ""):find("Chrome") then return false end

  local title = (win:title() or ""):lower()
  if title:find("picture in picture") or title:find("picture%-in%-picture") then
    return true
  end
  if title:find("mlb%.tv web player") then
    return true
  end

  local sub = win:subrole() or ""
  if sub ~= "AXStandardWindow" then
    local f = win:frame()
    if f and f.w > 120 and f.w < 900 and f.h > 90 and f.h < 700 then
      return true
    end
  end
  return false
end

local function snap(win)
  local screen = win:screen() or hs.screen.mainScreen()
  local sf = screen:frame()          -- usable area (excludes menu bar + Dock)
  local wf = win:frame()
  local w = math.min(wf.w, MAX_W)
  local h = math.min(wf.h, MAX_H)
  win:setFrame({
    x = sf.x + sf.w - w - MARGIN,
    y = sf.y + sf.h - h - MARGIN,
    w = w,
    h = h,
  })
end

local function scan()
  local chrome = hs.application.get("Google Chrome")
  if chrome then
    for _, win in ipairs(chrome:allWindows()) do
      if shouldSnap(win) then
        local id = win:id()
        if id and not snapped[id] then
          snapped[id] = true
          snap(win)
        end
      end
    end
  end
  -- forget closed windows so a re-opened PiP snaps again
  for id in pairs(snapped) do
    if not hs.window.get(id) then snapped[id] = nil end
  end
end

-- Print every Chrome window (title / subrole / size) — run dcPiPDebug() from
-- the Hammerspoon console if detection ever needs tuning.
function dcPiPDebug()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then print("Chrome not running"); return end
  for _, win in ipairs(chrome:allWindows()) do
    local f = win:frame()
    print(string.format("title=%q subrole=%q size=%dx%d",
      win:title() or "", win:subrole() or "", f.w, f.h))
  end
end

function M.start()
  M.timer = hs.timer.doEvery(SCAN_INTERVAL, scan)
  M.timer:start()
end

return M
