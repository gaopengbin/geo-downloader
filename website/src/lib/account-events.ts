const channelName = "geod-account-session";
const eventName = "geod:account-updated";
const senderId = Math.random().toString(36).slice(2);

/** Share only an invalidation signal. Identity and credentials stay in the API/cookie. */
export function notifyAccountChanged() {
  window.dispatchEvent(new Event(eventName));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "session-changed", senderId });
    channel.close();
  }
}

export function subscribeAccountChanges(refresh: () => void) {
  window.addEventListener(eventName, refresh);
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
  if (channel) channel.onmessage = event => { if (event.data?.type === "session-changed" && event.data.senderId !== senderId) refresh(); };
  return () => {
    window.removeEventListener(eventName, refresh);
    channel?.close();
  };
}
