-- DIAMOND:CONTEXT — pin Chrome's Picture-in-Picture window into the box above
-- the field.
--
-- Chrome's PiP window can't be moved by the extension (it isn't a chrome.windows
-- window), so this helper does it via the macOS Accessibility API. DIAMOND:CONTEXT
-- computes the exact box (field width, just below the WATCH tab, just above the
-- field) and — while you're looking at the D:C page — heartbeats it to a tiny
-- local HTTP server here. Whenever a PiP window exists and the target is fresh
-- (i.e. you're on D:C), we snap the PiP window to that box.
--
-- Flow: click Watch → MLB.tv opens → you click the PiP button → scroll to D:C →
-- the PiP snaps into place above the field and stays there.
--
-- Install: see web/extension/README.md. Loaded from ~/.hammerspoon/init.lua.

local M = {}

local PORT = 27894
local SCAN_INTERVAL = 0.15
local FRESH = 3.0          -- only pin while the page is actively heartbeating
local TOLERANCE = 3        -- px drift before we re-pin (avoids jitter)

local target = nil         -- {x, y, w, h} screen points
local lastUpdate = 0       -- secondsSinceEpoch of the last heartbeat
local server = nil

-- Chrome's PiP window: a Google Chrome window whose title contains "picture in
-- picture". Must be a Chrome window (so a terminal/editor that merely shows the
-- phrase "picture-in-picture" in its title can't match) and not the D:C page.
local function isPipWindow(win)
  if not win then return false end
  local app = win:application()
  if not app or not (app:name() or ""):find("Chrome") then return false end
  local title = (win:title() or ""):lower()
  if title:find("diamond") then return false end
  return title:find("picture in picture") ~= nil
      or title:find("picture%-in%-picture") ~= nil
end

local function findPip()
  -- Chrome's PiP can be reported under the app's window list or the global
  -- window list depending on timing/Space — check both.
  local chrome = hs.application.get("Google Chrome")
  if chrome then
    for _, w in ipairs(chrome:allWindows()) do
      if isPipWindow(w) then return w end
    end
  end
  for _, w in ipairs(hs.window.allWindows()) do
    if isPipWindow(w) then return w end
  end
  return nil
end

local function scan()
  if not target then return end
  if (hs.timer.secondsSinceEpoch() - lastUpdate) > FRESH then return end
  local w = findPip()
  if not w then return end
  local f = w:frame()
  if math.abs(f.x - target.x) > TOLERANCE
      or math.abs(f.y - target.y) > TOLERANCE
      or math.abs(f.w - target.w) > TOLERANCE
      or math.abs(f.h - target.h) > TOLERANCE then
    w:setFrame({ x = target.x, y = target.y, w = target.w, h = target.h })
  end
end

-- Console helper: list current windows (for debugging which is the PiP one).
function dcPiPDebug()
  for _, w in ipairs(hs.window.allWindows()) do
    local f = w:frame()
    print(string.format("title=%q size=%dx%d at (%d,%d)", w:title() or "", f.w, f.h, f.x, f.y))
  end
  print("target:", target and hs.inspect(target) or "none")
end

function M.start()
  -- Clear the stale frame the old build used to restore (made the window huge).
  if hs.settings.get("dcVideoFrame") ~= nil then
    hs.settings.set("dcVideoFrame", nil)
  end

  M.timer = hs.timer.doEvery(SCAN_INTERVAL, scan)
  M.timer:start()

  server = hs.httpserver.new(false, false)
  server:setPort(PORT)
  server:setCallback(function(method, path, headers, body)
    local cors = { ["Access-Control-Allow-Origin"] = "*" }
    if method == "POST" and body and #body > 0 then
      local ok, data = pcall(function() return hs.json.decode(body) end)
      if ok and data and data.w and data.h then
        target = {
          x = math.floor(data.x),
          y = math.floor(data.y),
          w = math.floor(data.w),
          h = math.floor(data.h),
        }
        lastUpdate = hs.timer.secondsSinceEpoch()
        -- snap right away too, don't wait for the next scan tick
        scan()
      end
    end
    return "ok", 200, cors
  end)
  server:start()
  print("DIAMOND:CONTEXT — PiP positioner listening on http://127.0.0.1:" .. PORT)
end

return M
