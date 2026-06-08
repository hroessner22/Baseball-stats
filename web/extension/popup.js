// popup.js — manual fallback. Clicking the button is a real user gesture,
// so it can force PiP on whatever tab is active even when auto-PiP didn't
// fire (e.g. you're already watching and just want it floated now).

document.getElementById("pip").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    status.textContent = "No active tab.";
    return;
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const v = [...document.querySelectorAll("video")]
          .filter((x) => x.offsetWidth > 100)
          .sort(
            (a, b) =>
              b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight
          )[0];
        if (!v) return "no-video";
        v.autoPictureInPicture = true;
        try {
          v.requestPictureInPicture?.();
        } catch (_) {}
        return "ok";
      },
    });
    status.textContent =
      result === "no-video"
        ? "No video found on this tab."
        : "Picture-in-picture requested.";
  } catch (_) {
    status.textContent = "Can't control this tab (try the MLB.tv tab).";
  }
});
