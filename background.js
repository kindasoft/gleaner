// The service worker: opens Claude in the side panel for Send, and answers the
// development messages from the unpacked copy. Everything else happens on the
// YouTube page (content.js).

// ------------------------------------------------------------ Send to Claude

var RULE_IDS = [1, 2]; // 2 was the ChatGPT rule; still listed so an old copy gets removed
var STRIP_HEADERS = [
  { header: 'x-frame-options', operation: 'remove' },
  { header: 'content-security-policy', operation: 'remove' },
  { header: 'content-security-policy-report-only', operation: 'remove' }
];
// -1 is chrome.tabs.TAB_ID_NONE: requests that don't come from a browser tab.
// The side panel's frame isn't in a tab; a website's frame always is. So even
// a rule left behind (see the bottom of this file) can't touch any website.
var NOT_IN_A_TAB = [-1];
var STRIP_RULES = [
  {
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: STRIP_HEADERS },
    condition: { urlFilter: '||claude.ai^', resourceTypes: ['sub_frame'], tabIds: NOT_IN_A_TAB }
  }
];

function addRules() {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS, addRules: STRIP_RULES });
}

// Store installs carry an update_url; the unpacked copy doesn't. The dev-only
// messages below do nothing in a store install.
function isDevCopy() { return !('update_url' in chrome.runtime.getManifest()); }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.action === 'devReload') {
    if (isDevCopy()) chrome.runtime.reload();
    return;
  }
  if (msg.action === 'devDryRun') {
    // Test mode: the side panel pastes the prompt, reports, clears the box and
    // never presses send. Switches itself off after five minutes.
    if (isDevCopy()) chrome.storage.session.set({ dryRunUntil: msg.on ? Date.now() + 5 * 60000 : 0 });
    return;
  }
  if (msg.action === 'devStatus') {
    if (!isDevCopy()) return;
    var w = sender.tab ? sender.tab.windowId : -1;
    chrome.storage.session.get(['lastInject', 'dryRunUntil', 'pending:' + w, 'preparing:' + w]).then(function (items) {
      var pending = items['pending:' + w];
      sendResponse({
        lastInject: items.lastInject, dryRunUntil: items.dryRunUntil,
        preparing: items['preparing:' + w] || null,
        pending: pending ? { chars: pending.prompt.length, ts: pending.ts } : null // no prompt text
      });
    });
    return true; // answering asynchronously
  }
  // Sends are kept per window: each window's side panel only picks up sends
  // made in its own window, so two open panels never both send the same prompt.
  var tabId = sender.tab ? sender.tab.id : -1;
  var win = sender.tab ? sender.tab.windowId : -1;
  var PENDING = 'pending:' + win, PREPARING = 'preparing:' + win;

  if (msg.action === 'sendCancel') {
    // The page gave up before the prompt was ready. Only the tab whose Send
    // the panel is waiting on can call it off.
    chrome.storage.session.get([PENDING, PREPARING]).then(function (items) {
      var pending = items[PENDING], prep = items[PREPARING];
      if (pending && pending.tabId === tabId) chrome.storage.session.remove(PENDING);
      if (!prep || prep.tabId !== tabId || prep.cancelled) return;
      var upd = {};
      upd[PREPARING] = { ts: prep.ts, tabId: tabId, cancelled: String(msg.reason || 'Nothing was sent.').slice(0, 300) };
      return chrome.storage.session.set(upd);
    });
    return;
  }

  if (msg.action !== 'sendToAI') return;

  if (!msg.prompt) {
    // Step 1, still inside the click: open the panel. sidePanel.open() only
    // works during a user gesture, so it must run before any await. The page
    // hears back whether a side panel is there to take the send.
    var answering = false;
    if (sender.tab) {
      answering = true;
      chrome.sidePanel.open({ tabId: tabId }).then(function () {
        // open() also resolves in app and popup windows, which have no side panel.
        return chrome.windows.get(win).then(function (w) { return w.type === 'normal'; }, function () { return true; });
      }, function (e) {
        console.warn('[Scribe] side panel did not open:', e && e.message);
        // It may be open in this window already, which is just as good.
        return chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], windowIds: [win] })
          .then(function (found) { return found.length > 0; }, function () { return false; });
      }).then(function (ok) { sendResponse({ ok: ok }); });
    }
    // A new Send replaces any older prompt the panel never picked up.
    chrome.storage.session.remove(PENDING);
    var prep = {};
    prep[PREPARING] = { ts: Date.now(), tabId: tabId };
    chrome.storage.session.set(prep);
    addRules();
    return answering; // true: the answer comes later
  }

  // Step 2, once the prompt is built. Rules go in before the prompt is stored,
  // so the panel never loads Claude without them. Then the 'preparing' flag
  // goes, so a panel opened later doesn't wait for a send that's done.
  addRules().then(function () {
    var items = {};
    items[PENDING] = { prompt: msg.prompt, question: msg.question || '', tabId: tabId, ts: Date.now() };
    return chrome.storage.session.set(items);
  }).then(function () {
    return chrome.storage.session.remove(PREPARING);
  });
});

// After an install or update, YouTube tabs that were already open still run
// the old relay.js, which can no longer reach this worker, so Send would stop
// working until the page is refreshed. Give those tabs a fresh relay.
chrome.runtime.onInstalled.addListener(function () {
  chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then(function (tabs) {
    tabs.forEach(function (tab) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['relay.js'] }).catch(function () {});
    });
  });
});

// The header-stripping rules are only needed while a side panel is open, so
// they come off when the last one closes. That's best effort: Chrome stops
// this worker after about 30 quiet seconds, and the panel reconnects when it
// does (sidepanel.js). The tab condition on the rules is what keeps websites
// out either way. An always-on static ruleset would let ANY website frame
// claude.ai while Scribe is installed; sub_frame navigations skip the
// initiator permission check, so the rules can't be scoped by initiator.
var panelPorts = 0;
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'scribe-sidepanel') return;
  panelPorts++;
  port.onDisconnect.addListener(function () {
    panelPorts--;
    if (panelPorts <= 0) {
      panelPorts = 0;
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS });
    }
  });
});
