-- DIAMOND:CONTEXT — Hammerspoon helper (inert).
--
-- We tried to auto-position Chrome's Picture-in-Picture window above the field,
-- but Chrome's native PiP window can't be reliably moved by macOS tools, and
-- auto-snapping fought the user's own dragging. Per Harris's call, the PiP is
-- now left exactly where he drags it — so this helper no longer moves, pins, or
-- positions any window.
--
-- It stays loadable (so ~/.hammerspoon/init.lua's require keeps working) and
-- only clears the stale saved frame an earlier build used to restore.
--
-- Install: see web/extension/README.md. Loaded from ~/.hammerspoon/init.lua.

local M = {}

function M.start()
  -- Clear the stale frame the old build used to restore (it once made the
  -- window spawn huge). Nothing else — the PiP stays where you drag it.
  if hs.settings.get("dcVideoFrame") ~= nil then
    hs.settings.set("dcVideoFrame", nil)
  end
end

return M
