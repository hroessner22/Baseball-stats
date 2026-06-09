-- DIAMOND:CONTEXT — Hammerspoon helper (now a no-op).
--
-- The MLB video window is positioned ENTIRELY by the Chrome extension now:
-- the DIAMOND:CONTEXT page measures the exact rectangle directly above the
-- field and hands it to background.js, which opens the MLB.tv popup there and
-- re-applies the bounds. That single source of truth is reliable, so this
-- helper no longer moves, restores, or saves any window position.
--
-- Why this file still exists: ~/.hammerspoon/init.lua requires it, and an
-- earlier version restored a SAVED frame (hs.settings key "dcVideoFrame") on
-- every watch — which is what made the window spawn huge and cover the screen.
-- We keep the module loadable but inert, and provide a helper to wipe that
-- stale saved frame for good.
--
-- Install: see web/extension/README.md. Loaded from ~/.hammerspoon/init.lua.

local M = {}

local SAVE_KEY = "dcVideoFrame"

-- One-time cleanup: drop the stale saved position that used to be restored
-- (and blown up) on every watch. Safe to call repeatedly.
local function clearStaleFrame()
  if hs.settings.get(SAVE_KEY) ~= nil then
    hs.settings.set(SAVE_KEY, nil)
    print("DIAMOND:CONTEXT — cleared stale saved video frame (dcVideoFrame)")
  end
end

-- Console helper, kept for convenience: lists Chrome windows.
function dcPiPDebug()
  local chrome = hs.application.get("Google Chrome")
  if not chrome then print("Chrome not running"); return end
  for _, win in ipairs(chrome:allWindows()) do
    local f = win:frame()
    print(string.format("title=%q size=%dx%d at (%d,%d)", win:title() or "", f.w, f.h, f.x, f.y))
  end
end

-- Console helper: explicitly wipe the saved position.
function dcResetVideoPos()
  hs.settings.set(SAVE_KEY, nil)
  print("DIAMOND:CONTEXT — saved video position cleared")
end

function M.start()
  -- The extension owns window placement now. Just make sure the old saved
  -- frame can never be restored again.
  clearStaleFrame()
end

return M
