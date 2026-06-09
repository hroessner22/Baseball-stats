-- DIAMOND:CONTEXT — keep the MLB video window pinned above the field.
--
-- Whatever MLB video window appears (Chrome's Picture-in-Picture window, or
-- the MLB.tv popup), continuously move it into the theater area at the top of
-- the DIAMOND:CONTEXT window — directly above the field. It keeps the window's
-- own size (so it stays "at that size"), and re-pins every scan, so no matter
-- where Chrome spawns it (e.g. bottom-right) it gets pulled above the field
-- and held there.
--
-- Install: see web/extension/README.md. Loaded from ~/.hammerspoon/init.lua.

local M = {}

local SCAN_INTERVAL = 0.5
local CENTER_FRAC = 0.30   -- horizontal center, as a fraction of the D:C window
                           -- width (~the live-view / field column)
local TOP_OFFSET = 220     -- px below the D:C window top (above the field)
local TOLERANCE = 24       -- only move if it has drifted this many px (avoid jitter)

-- The MLB video window: Chrome's PiP window, or the MLB.tv popup. Never the
-- DIAMOND:CONTEXT app window itself.
local function isVideoWindow(win)
  if not win then return false end
  local app = win:application()
  if not app or not (app:name() or ""):find("Chrome") then return false end
  local title = (win:title() or ""):lower()
  if title:find("diamond") then return false end
  return title:find("picture in picture") or title:find("picture%-in%-picture")
      or title:find("mlb%.tv") or title:find("mlb%.com")
end

local function dcWindow()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then return nil end
  for _, w in ipairs(chrome:allWindows()) do
    if (w:title() or ""):find("DIAMOND") then return w end
  end
  return nil
end

local function scan()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then return end
  local dc = dcWindow()
  if not dc then return end
  local f = dc:frame()
  for _, win in ipairs(chrome:allWindows()) do
    if isVideoWindow(win) then
      local wf = win:frame()
      local x = math.floor(f.x + f.w * CENTER_FRAC - wf.w / 2)
      local y = math.floor(f.y + TOP_OFFSET)
      if x < f.x + 8 then x = f.x + 8 end
      if math.abs(wf.x - x) > TOLERANCE or math.abs(wf.y - y) > TOLERANCE then
        win:setTopLeft({ x = x, y = y })  -- keep its size; just reposition
      end
    end
  end
end

-- Console helper for tuning: lists Chrome windows.
function dcPiPDebug()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then print("Chrome not running"); return end
  for _, win in ipairs(chrome:allWindows()) do
    local f = win:frame()
    print(string.format("title=%q size=%dx%d at (%d,%d)", win:title() or "", f.w, f.h, f.x, f.y))
  end
end

function M.start()
  M.timer = hs.timer.doEvery(SCAN_INTERVAL, scan)
  M.timer:start()
end

return M
