var CLAUDE = { url: 'https://claude.ai/new', origin: 'https://claude.ai', name: 'Claude' };
// The extension's own name for the messages here: "Gleaner" in the store copy.
var BRAND = chrome.runtime.getManifest().short_name || chrome.runtime.getManifest().name;

// A send that sat unused longer than this (panel closed, reopened much later)
// is dropped instead of being typed and sent by surprise.
var FRESH_MS = 60000;

var frame = document.getElementById('frame');
var barEl = document.getElementById('bar');
var statusEl = document.getElementById('status');
var openTabBtn = document.getElementById('open-tab');
document.title = BRAND;
statusEl.textContent = 'Click Send in ' + BRAND + ' under any YouTube video and it shows up here.';

var PENDING = null, PREPARING = null; // this window's storage keys, set at the bottom
var pendingPrompt = null;  // armed: pasted and sent as soon as Claude is ready
var pendingQuestion = '';
var fallbackText = null;   // handed over to the user: only 'Open in a tab' uses it
var lastTs = 0;
var inFlight = false;
var queued = null;
var watchdog = null;
var safety = null;
var hideTimer = null;
var prepTimer = null;
var preparingShown = false;
var dryRunUntil = 0; // test mode from the unpacked copy: paste, report, clear, never send

function remember(result) {
  result.ts = Date.now();
  chrome.storage.session.set({ lastInject: result });
}

// Lets the service worker take the header rules away when this panel closes.
// Chrome stops the worker after about 30 quiet seconds, which drops the
// connection, so connect again each time that happens.
function connectPort() {
  chrome.runtime.connect({ name: 'scribe-sidepanel' }).onDisconnect.addListener(function () {
    setTimeout(connectPort, 1024);
  });
}
connectPort();

function showBar(text, withFallback, busy) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  statusEl.textContent = text;
  barEl.classList.remove('hidden');
  barEl.classList.toggle('busy', !!busy);
  openTabBtn.classList.toggle('hidden', !withFallback);
}

function hideBarAfter(ms) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(function () { barEl.classList.add('hidden'); }, ms);
}

function fullText(prompt, question) {
  return question ? prompt + '\n\nInstruction: ' + question : prompt;
}

// The prompt is now the user's to finish (or may already have gone through):
// never paste it again, even if the frame reloads. 'Open in a tab' keeps it.
function disarm() {
  if (pendingPrompt != null) fallbackText = fullText(pendingPrompt, pendingQuestion);
  pendingPrompt = null;
}

function clearTimers() {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  if (safety) { clearTimeout(safety); safety = null; }
}

function stuck() {
  if (pendingPrompt == null) return;
  showBar(CLAUDE.name + " hasn't loaded its message box. Log in below if it asks; the prompt sends itself once it's ready.", true);
}

function flushQueue() {
  if (!queued) return;
  var q = queued;
  queued = null;
  load(q);
}

// After a send, give Claude a few seconds to finish creating the chat before
// a queued send reloads the frame; a send that arrives meanwhile waits.
function settleThenFlush() {
  inFlight = true;
  setTimeout(function () { inFlight = false; flushQueue(); }, 4096);
}

function isFresh(ts) { return ts && Date.now() - ts < FRESH_MS; }

function load(pending) {
  if (!pending || pending.ts === lastTs) return;
  if (!isFresh(pending.ts)) { chrome.storage.session.remove(PENDING); return; }
  // Don't destroy an injection mid-flight — park the newest send instead
  if (inFlight) { queued = pending; return; }
  queued = null; // this one is newer than anything parked
  lastTs = pending.ts;
  stopPreparing();
  // Consume — a reopened panel must never replay (and auto-send) an old prompt
  chrome.storage.session.remove(PENDING);
  pendingPrompt = pending.prompt;
  pendingQuestion = pending.question || '';
  fallbackText = null;
  showBar('Opening ' + CLAUDE.name + '…', false, true);
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(stuck, 16000);
  // Always (re)navigate so each send starts a fresh chat
  frame.src = CLAUDE.url;
}

function stopPreparing() {
  preparingShown = false;
  if (prepTimer) { clearTimeout(prepTimer); prepTimer = null; }
}

function showPreparing(p) {
  if (!p || pendingPrompt != null) return;
  if (p.cancelled) {
    // Scribe gave up before the prompt was ready: say why instead of spinning.
    if (preparingShown) { stopPreparing(); showBar(p.cancelled); }
    return;
  }
  if (!isFresh(p.ts)) return;
  stopPreparing();
  preparingShown = true;
  showBar(BRAND + ' is getting the transcript ready…', false, true);
  // For when nothing can report back (the YouTube tab was refreshed or
  // closed). A prompt that still arrives later loads as usual.
  prepTimer = setTimeout(function () {
    stopPreparing();
    if (pendingPrompt == null) showBar('Nothing has come from ' + BRAND + ' yet. If you left or refreshed the video, click Send again.');
  }, Math.max(0, 128000 - (Date.now() - p.ts)));
}

window.addEventListener('message', function (e) {
  // Only our own frame, not a frame nested inside it.
  if (e.origin !== CLAUDE.origin || e.source !== frame.contentWindow) return;
  if (!e.data || e.data.source !== 'scribe-ai-frame') return;
  var type = e.data.type, reason = e.data.reason;

  if (type === 'ready') {
    if (pendingPrompt == null) return;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; } // the message box loaded
    frame.contentWindow.postMessage(
      { source: 'scribe-host', type: 'inject', prompt: pendingPrompt, question: pendingQuestion, dryRun: Date.now() < dryRunUntil },
      CLAUDE.origin
    );
    inFlight = true;
    showBar('Sending…', false, true);
    // Longer than ai-inject's worst case (5s for the send button + 16s for
    // proof that Claude got it), so a queued send never cuts it off.
    if (safety) clearTimeout(safety);
    safety = setTimeout(function () {
      safety = null;
      inFlight = false;
      if (pendingPrompt != null) {
        disarm();
        showBar(CLAUDE.name + " didn't answer. If the prompt isn't below, open it in a tab; the prompt goes on your clipboard.", true);
      }
      flushQueue();
    }, 32000);
  } else if (type === 'sent') {
    remember({ kind: 'sent', chars: pendingPrompt ? pendingPrompt.length : 0, pasteMs: e.data.pasteMs });
    pendingPrompt = null;
    fallbackText = null;
    clearTimers();
    showBar('Sent');
    hideBarAfter(1600);
    settleThenFlush();
  } else if (type === 'error' && reason === 'unconfirmed') {
    remember({ kind: 'error', reason: 'unconfirmed' });
    disarm(); // it may have gone through: never paste it again
    clearTimers();
    showBar("Couldn't confirm " + CLAUDE.name + " got it. If it isn't below, open it in a tab; the prompt goes on your clipboard.", true);
    settleThenFlush();
  } else if (type === 'dry-run') {
    var report = { kind: 'dry-run', chars: pendingPrompt ? pendingPrompt.length : 0 };
    ['want', 'got', 'handled', 'sendReady', 'pasteMs', 'removedBefore', 'questionSent', 'cleared', 'composer', 'composerAfter'].forEach(function (k) {
      report[k] = e.data[k];
    });
    remember(report);
    pendingPrompt = null;
    inFlight = false;
    clearTimers();
    showBar('Test run: the prompt went into ' + CLAUDE.name + ' and was cleared. Nothing was sent.');
    flushQueue();
  } else if (type === 'error' && reason === 'send-timeout') {
    // The prompt is in the box but the send click never landed: hand it over.
    // A send parked behind it waits: it goes once the user sends this one
    // (the frame reports that as 'sent') or opens it in a tab.
    remember({ kind: 'error', reason: 'send-timeout' });
    disarm();
    inFlight = false;
    clearTimers();
    showBar('The prompt is in the box below. Press send in ' + CLAUDE.name + ' to finish.');
  } else if (type === 'error' && reason === 'paste-failed') {
    remember({ kind: 'error', reason: 'paste-failed' });
    disarm();
    inFlight = false;
    clearTimers();
    showBar(CLAUDE.name + " wouldn't take the prompt. Open it in a tab instead; the prompt goes on your clipboard.", true);
  } else if (type === 'timeout' || type === 'error') {
    remember({ kind: 'error', reason: reason || type });
    // An error mid-send (the box went away) ends this attempt; the frame keeps
    // watching and says 'ready' again when the box is back. A newer send
    // parked meanwhile takes over, as it would from any send not in flight.
    if (type === 'error') { inFlight = false; if (safety) { clearTimeout(safety); safety = null; } }
    stuck();
    if (type === 'error') flushQueue();
  }
});

openTabBtn.addEventListener('click', function () {
  var text = pendingPrompt != null ? fullText(pendingPrompt, pendingQuestion) : fallbackText;
  // Handed to the user: the panel must not paste it again later.
  disarm();
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  function open(message) {
    chrome.tabs.create({ url: CLAUDE.url });
    showBar(message);
    // The user has this one now. A send parked behind it can go, after a
    // moment so this message can be read.
    if (queued) settleThenFlush();
  }
  if (!text) { open('Opened in a tab.'); return; }
  navigator.clipboard.writeText(text).then(
    function () { open('Opened in a tab. The prompt is on your clipboard; paste it there.'); },
    function () { open("Opened in a tab, but copying the prompt didn't work. Use Copy under the video, then paste it there."); }
  );
});

// This window's keys (see background.js): the panel only picks up sends made
// in its own window.
chrome.windows.getCurrent().then(function (w) {
  PENDING = 'pending:' + w.id;
  PREPARING = 'preparing:' + w.id;
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'session') return;
    if (changes.dryRunUntil) dryRunUntil = changes.dryRunUntil.newValue || 0;
    if (changes[PENDING] && changes[PENDING].newValue) load(changes[PENDING].newValue);
    else if (changes[PREPARING] && changes[PREPARING].newValue) showPreparing(changes[PREPARING].newValue);
  });
  return chrome.storage.session.get([PENDING, PREPARING, 'dryRunUntil']).then(function (items) {
    dryRunUntil = items.dryRunUntil || 0;
    if (items[PENDING] && isFresh(items[PENDING].ts)) load(items[PENDING]);
    else showPreparing(items[PREPARING]);
  });
});
