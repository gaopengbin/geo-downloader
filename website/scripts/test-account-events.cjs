const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BroadcastChannel } = require("node:worker_threads");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib/account-events.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function scope(channel = BroadcastChannel) {
  const context = { exports: {}, window: new EventTarget(), Event, BroadcastChannel: channel };
  vm.runInNewContext(source, context);
  return context.exports;
}
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Account signal was not received")), 1500); })]).finally(() => clearTimeout(timer));
}

test("official login signals refresh another window and accept the workbench protocol", async () => {
  const official = scope(), secondWindow = scope();
  let localRefreshes = 0, otherRefreshes = 0;
  const unsubscribe = official.subscribeAccountChanges(() => localRefreshes++);
  let received;
  const first = new Promise(resolve => { received = resolve; });
  const unsubscribeOther = secondWindow.subscribeAccountChanges(() => { otherRefreshes++; received(); });
  const workbench = new BroadcastChannel("geod-account-session");
  try {
    official.notifyAccountChanged();
    await bounded(first);
    assert.equal(localRefreshes, 1);
    assert.equal(otherRefreshes, 1);
    const second = new Promise(resolve => { received = resolve; });
    workbench.postMessage({ type: "session-changed" });
    await bounded(second);
    assert.equal(otherRefreshes, 2);
    unsubscribeOther();
    secondWindow.notifyAccountChanged();
    assert.equal(otherRefreshes, 2);
  } finally { unsubscribe(); unsubscribeOther(); workbench.close(); }
});

test("without BroadcastChannel the current window still refreshes", () => {
  const context = { exports: {}, window: new EventTarget(), Event, BroadcastChannel: undefined };
  vm.runInNewContext(source, context);
  let refreshes = 0;
  const unsubscribe = context.exports.subscribeAccountChanges(() => refreshes++);
  context.exports.notifyAccountChanged();
  assert.equal(refreshes, 1);
  unsubscribe();
  context.exports.notifyAccountChanged();
  assert.equal(refreshes, 1);
});
