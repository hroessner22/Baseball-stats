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

local PIP_WIDTH_FRAC = 0.40   -- PiP width as a fraction of the D:C window width
local TOP_OFFSET = 118        -- px below the D:C window top (clears header + board strip)

-- Is this the Chrome Picture-in-Picture window? (Just the video, always-on-top.)
-- Title match first; fallback catches it even if Chrome renames the title, via
-- a small non-standard floating window. We only move the PiP — never the full
-- MLB.TV player window (that's the source, left wherever it is).
local function shouldSnap(win)
  if not win then return false end
  local app = win:application()
  if not app then return false end
  if not (app:name() or ""):find("Chrome") then return false end

  local title = (win:title() or ""):lower()
  if title:find("picture in picture") or title:find("picture%-in%-picture") then
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

-- Find the DIAMOND:CONTEXT browser window so we can center the PiP over it.
local function dcWindow()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then return nil end
  for _, w in ipairs(chrome:allWindows()) do
    if (w:title() or ""):find("DIAMOND") then return w end
  end
  return nil
end

-- Center the PiP over the top-center of the DIAMOND:CONTEXT window (so the
-- field can sit below it — see the watch-mode layout in the web app). Falls
-- back to the screen's bottom-right if the D:C window isn't open.
local function snap(win)
  local dc = dcWindow()
  if dc then
    local f = dc:frame()
    local w = math.floor(f.w * PIP_WIDTH_FRAC)
    local h = math.floor(w * 9 / 16)
    win:setFrame({
      x = math.floor(f.x + (f.w - w) / 2),
      y = math.floor(f.y + TOP_OFFSET),
      w = w,
      h = h,
    })
  else
    local sf = (win:screen() or hs.screen.mainScreen()):frame()
    local wf = win:frame()
    local w = math.min(wf.w, 820)
    local h = math.min(wf.h, 520)
    win:setFrame({ x = sf.x + sf.w - w - MARGIN, y = sf.y + sf.h - h - MARGIN, w = w, h = h })
  end
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
