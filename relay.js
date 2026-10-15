// Bridge between the page (content.js runs in YouTube's own context and has
// no chrome.* APIs) and the rest of the extension.
(function () {
  // After an update, background.js injects a fresh copy of this script into
  // YouTube tabs that were already open, next to the old, disconnected one.
  // Only the newest copy acts.
  var me = String(Math.random()).slice(2);
  var root = document.documentElement;
  root.setAttribute('data-scribe-relay', me);
  function newest() { return root.getAttribute('data-scribe-relay') === me; }

  function relayError() { window.dispatchEvent(new CustomEvent('scribe:relay-error')); }

  // With onReply, the page also hears when the extension couldn't be reached.
  function toExtension(message, onReply) {
    if (!newest()) return;
    // A disconnected copy with nothing newer to take over: tell the page so it
    // can ask for a refresh.
    if (!chrome.runtime || !chrome.runtime.id) { relayError(); return; }
    try {
      var p = chrome.runtime.sendMessage(message);
      if (p && p.then) p.then(function (reply) { if (onReply) onReply(reply); }, function (err) {
        // Not answering is fine; not being reached isn't.
        if (onReply && !/(port|channel) closed/i.test(String(err && err.message))) relayError();
      });
    } catch (e) {
      relayError();
    }
  }

  // Called twice per Send: first with no prompt (inside the click, so the side
  // panel can open), then with the finished prompt.
  window.addEventListener('yt-tr-send-to-ai', function (e) {
    var d = e.detail || {};
    var prompt = typeof d.prompt === 'string' && d.prompt ? d.prompt : null;
    toExtension({
      action: 'sendToAI',
      prompt: prompt,
      question: typeof d.question === 'string' ? d.question : ''
    }, function (reply) {
      // The first call answers whether a side panel is there to take the send.
      if (!prompt && reply && reply.ok === false) window.dispatchEvent(new CustomEvent('scribe:panel-failed'));
    });
  });

  // Send gave up before the prompt was ready (the viewer left the video, or
  // the transcript failed): tell the side panel so it stops waiting.
  window.addEventListener('scribe:send-cancel', function (e) {
    var d = e.detail || {};
    toExtension({ action: 'sendCancel', reason: typeof d.reason === 'string' ? d.reason.slice(0, 300) : '' });
  });

  // Saved exports, kept by background.js. The page asks with an id and hears
  // back on scribe:cache-result with the same id.
  window.addEventListener('scribe:cache', function (e) {
    var req = null;
    try { req = JSON.parse(e.detail); } catch (err) {}
    if (!req || typeof req.id !== 'string' || !newest()) return;
    function answer(res) {
      window.dispatchEvent(new CustomEvent('scribe:cache-result', { detail: JSON.stringify({ id: req.id, res: res }) }));
    }
    if (!chrome.runtime || !chrome.runtime.id) { answer({ ok: false, error: 'unreachable' }); return; }
    chrome.runtime.sendMessage({
      action: 'cache', op: req.op, videoId: req.videoId, part: req.part, meta: req.meta,
      filename: req.filename, header: req.header, extra: req.extra
    }).then(function (res) { answer(res || { ok: false, error: 'no answer' }); }, function () { answer({ ok: false, error: 'unreachable' }); });
  });

  // Development only (background.js ignores these in store installs): reload
  // the unpacked copy, switch the side panel's test mode, read its last result.
  window.addEventListener('scribe:dev-reload', function () {
    toExtension({ action: 'devReload' });
  });
  window.addEventListener('scribe:dev-dryrun', function (e) {
    toExtension({ action: 'devDryRun', on: !!(e.detail && e.detail.on) });
  });
  window.addEventListener('scribe:dev-status', function () {
    if (!newest() || !chrome.runtime || !chrome.runtime.id) return;
    chrome.runtime.sendMessage({ action: 'devStatus' }).then(function (res) {
      window.dispatchEvent(new CustomEvent('scribe:dev-status-result', { detail: JSON.stringify(res || null) }));
    }, function () {});
  });
})();
