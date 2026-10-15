// The service worker: opens Claude in the side panel for Send, keeps comment
// exports so they can be saved, continued and brought up to date later, and
// answers the development messages from the unpacked copy. Everything else
// happens on the YouTube page (content.js).

// ------------------------------------------------------------ saved exports
//
// An export is kept here, in Gleaner's own storage on this computer (YouTube
// can't read it, and clearing YouTube's data doesn't touch it), until the
// user starts it over or removes Gleaner. The page sends each chunk of the CSV
// once it's done, together with a note of where the reading stands; both land
// in one transaction, so they never disagree. A save puts the chunks together
// in the offscreen document and hands the file to Chrome's downloads.

var DB_NAME = 'gleaner-exports';
var dbOpen = null;
function db() {
  if (!dbOpen) {
    dbOpen = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('meta');  // video id -> where its export stands
        req.result.createObjectStore('parts'); // [video id, order] -> a Blob of CSV rows
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbOpen = null; reject(req.error); };
    });
  }
  return dbOpen;
}

function partsOf(videoId) { return IDBKeyRange.bound([videoId, -Infinity], [videoId, Infinity]); }

function cacheGet(videoId) {
  return db().then(function (d) {
    return new Promise(function (resolve, reject) {
      var r = d.transaction('meta').objectStore('meta').get(videoId);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
  });
}

// A chunk (or none) and the new note, in one transaction. A note older than
// the one stored (seq) is dropped with its chunk.
function cacheCommit(videoId, part, meta) {
  return db().then(function (d) {
    return new Promise(function (resolve, reject) {
      var t = d.transaction(['meta', 'parts'], 'readwrite');
      var metas = t.objectStore('meta');
      var g = metas.get(videoId);
      g.onsuccess = function () {
        if (g.result && g.result.seq > meta.seq) return;
        if (part) t.objectStore('parts').put(new Blob([part.text], { type: 'text/csv' }), [videoId, part.order]);
        metas.put(meta, videoId);
      };
      t.oncomplete = function () { resolve(true); };
      t.onerror = t.onabort = function () { reject(t.error); };
    });
  });
}

function cacheDelete(videoId) {
  return db().then(function (d) {
    return new Promise(function (resolve, reject) {
      var t = d.transaction(['meta', 'parts'], 'readwrite');
      t.objectStore('meta').delete(videoId);
      t.objectStore('parts').delete(partsOf(videoId));
      t.oncomplete = function () { resolve(true); };
      t.onerror = t.onabort = function () { reject(t.error); };
    });
  });
}

// The offscreen document builds the file (a service worker can't make a URL
// for a Blob), then Chrome's downloads saves it.
var offscreenMaking = null; // only one offscreen document may exist
function offscreenReady() {
  return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(function (found) {
    if (found.length) return;
    if (!offscreenMaking) {
      offscreenMaking = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Puts the saved chunks of a comments export together into one spreadsheet file.'
      }).finally(function () { offscreenMaking = null; });
    }
    return offscreenMaking;
  });
}

var downloadsWaiting = {}; // download id -> blob URL to let go of when it's done
chrome.downloads.onChanged.addListener(function (delta) {
  var url = downloadsWaiting[delta.id];
  if (!url || !delta.state || delta.state.current === 'in_progress') return;
  delete downloadsWaiting[delta.id];
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: url }).catch(function () {});
});

// extra: chunks the page still holds, [{ order, text }], merged in by order.
function cacheSave(videoId, filename, header, extra) {
  return offscreenReady().then(function () {
    return chrome.runtime.sendMessage({ target: 'offscreen', action: 'build', videoId: videoId, header: header, extra: extra });
  }).then(function (built) {
    if (!built || !built.url) throw new Error((built && built.error) || 'The file could not be put together.');
    return chrome.downloads.download({ url: built.url, filename: filename, conflictAction: 'uniquify' }).then(function (id) {
      downloadsWaiting[id] = built.url;
      return { ok: true, bytes: built.bytes };
    });
  });
}

// What the page may ask for. youtube.com's own scripts could send these too,
// so the shapes and sizes are checked.
var VIDEO_ID = /^[\w-]{11}$/;
function cacheRequest(msg) {
  if (!VIDEO_ID.test(msg.videoId || '')) return Promise.resolve({ ok: false, error: 'bad video id' });
  if (msg.op === 'get') return cacheGet(msg.videoId).then(function (meta) { return { ok: true, meta: meta }; });
  if (msg.op === 'delete') return cacheDelete(msg.videoId).then(function () { return { ok: true }; });
  if (msg.op === 'commit') {
    var part = msg.part, meta = msg.meta;
    if (!meta || typeof meta !== 'object' || meta.videoId !== msg.videoId || typeof meta.seq !== 'number') return Promise.resolve({ ok: false, error: 'bad note' });
    if (part && (typeof part.text !== 'string' || typeof part.order !== 'number' || part.text.length > 64 * 1024 * 1024)) return Promise.resolve({ ok: false, error: 'bad chunk' });
    return cacheCommit(msg.videoId, part || null, meta).then(function () { return { ok: true }; });
  }
  if (msg.op === 'save') {
    var name = String(msg.filename || 'comments.csv').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120);
    var extra = (Array.isArray(msg.extra) ? msg.extra : []).filter(function (x) {
      return x && typeof x.order === 'number' && typeof x.text === 'string';
    }).slice(0, 8);
    return cacheSave(msg.videoId, name, String(msg.header || ''), extra);
  }
  return Promise.resolve({ ok: false, error: 'unknown request' });
}

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
  if (!msg || msg.target === 'offscreen') return;

  if (msg.action === 'cache') {
    cacheRequest(msg).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    });
    return true; // answering asynchronously
  }

  // The clip cutter (lib/mediabunny.js) goes into the page only when a clip is
  // made: it's big, and most visits never need it. Injected this way, the
  // page's own script rules don't apply to it.
  if (msg.action === 'clipEngine') {
    if (!sender.tab) return;
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      world: 'MAIN',
      files: ['lib/mediabunny.js']
    }).then(function () { sendResponse({ ok: true }); }, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    });
    return true; // answering asynchronously
  }

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
        console.warn('[Gleaner] side panel did not open:', e && e.message);
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
// claude.ai while Gleaner is installed; sub_frame navigations skip the
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
