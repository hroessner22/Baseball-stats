// Bot notifications — surfaces questions the bot can't answer on its own.
//
// Design rule (per user instruction): only push when human input is
// required. Routine errors that the bot self-recovers from (transient
// rate-limit hits, single insufficient_funds, single sell rejection)
// stay in the activity log; the bot retries and the notification log
// stays quiet. A notification means: "I tried, and I need you to look."
//
// Public API (exposed on window.BotNotifications):
//   push({ level, title, body, action?, dedupe_key? }) → id
//   list(limit = 100)                                 → newest-first
//   unreadCount()                                     → number
//   markRead(id)
//   markAllRead()
//   clear()
//
// Levels: 'error' (action needed), 'warn' (bot paused), 'question'
// (judgement call from EOD review), 'info' (FYI).
//
// Dedupe: same dedupe_key inside 60s collapses into the existing
// notification with `count`. So 8 sell failures on the same ticker
// in a minute show as one entry with ×8.
//
// Persists to localStorage. Fires `bot-notification-change` on the
// window so the drawer can re-render.

(function (root) {
    "use strict";

    const LS_KEY            = "diamond_context_bot_notifications";
    const MAX_KEEP          = 200;
    const DEDUPE_WINDOW_MS  = 60 * 1000;

    function loadList() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
        catch { return []; }
    }

    function saveList(list) {
        try {
            const trimmed = list.length > MAX_KEEP
                ? list.slice(-MAX_KEEP)
                : list;
            localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
        } catch { /* quota — drop silently */ }
        try { window.dispatchEvent(new Event("bot-notification-change")); }
        catch { /* old browser, no events — fine */ }
    }

    function push(input) {
        const title = input?.title;
        if (!title) return null;
        const level      = input.level      || "warn";
        const body       = input.body       || "";
        const action     = input.action     || null;
        const dedupeKey  = input.dedupe_key || null;
        const list       = loadList();
        const now        = Date.now();

        if (dedupeKey) {
            const recent = list.find((n) =>
                n.dedupe_key === dedupeKey
                && (now - new Date(n.ts).getTime()) < DEDUPE_WINDOW_MS
            );
            if (recent) {
                recent.count        = (recent.count || 1) + 1;
                recent.ts           = new Date().toISOString();
                recent.body         = body || recent.body;
                recent.acknowledged = false;   // re-fire reopens it
                saveList(list);
                return recent.id;
            }
        }

        const note = {
            id:           `n-${now}-${Math.random().toString(36).slice(2, 7)}`,
            ts:           new Date().toISOString(),
            level,
            title,
            body,
            action,
            dedupe_key:   dedupeKey,
            acknowledged: false,
            count:        1,
        };
        list.push(note);
        saveList(list);
        return note.id;
    }

    function list(limit) {
        const max = typeof limit === "number" ? limit : 100;
        return loadList().slice(-max).reverse();
    }

    function unreadCount() {
        return loadList().filter((n) => !n.acknowledged).length;
    }

    function markRead(id) {
        const arr = loadList();
        const item = arr.find((n) => n.id === id);
        if (!item || item.acknowledged) return;
        item.acknowledged = true;
        saveList(arr);
    }

    function markAllRead() {
        const arr = loadList();
        let any = false;
        for (const n of arr) {
            if (!n.acknowledged) { n.acknowledged = true; any = true; }
        }
        if (any) saveList(arr);
    }

    function clear() { saveList([]); }

    root.BotNotifications = {
        push,
        list,
        unreadCount,
        markRead,
        markAllRead,
        clear,
    };
})(window);
