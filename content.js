// Gleaner: copy a YouTube video's transcript, details and comments in one click,
// or send them to Claude. Runs in YouTube's own page context (manifest
// "world": "MAIN") so it can read the player and page data. Anything that
// needs chrome.* APIs goes through relay.js.
(function () {
  'use strict';
  if (window.__scribe) return;
  var scribe = window.__scribe = { version: '3.3' };

  // 'dev' is the copy loaded unpacked from this folder (Enter in the question
  // box sends to Claude). tools/build-store.js makes the Chrome Web Store copy:
  // 'store' (Enter copies). Gleaner was called Scribe at first, so the code's
  // own names (window.__scribe, the scribe: events, #scribe-pill) still say so.
  var BUILD = 'dev';
  var BRAND = 'Gleaner';

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) {
      if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    chevron: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    send: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    cross: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    dash: 'M19 13H5v-2h14v2z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    lines: 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
    stop: 'M6 6h12v12H6z',
    play: 'M8 5v14l11-7z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 108 8h-2a6 6 0 11-1.76-4.24L13 11h7V4z',
    trash: 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
    movie: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
    scissors: 'M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z',
    prev: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    next: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    first: 'M18.41 16.59L13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z',
    last: 'M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'
  };

  function icon(name, size) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 20));
    s.setAttribute('height', String(size || 20));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }

  // YouTube stores text either as a plain string, {simpleText} or {runs: [{text}]}.
  function text(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map(function (r) { return r.text || ''; }).join('');
    if (typeof t.content === 'string') return t.content;
    return '';
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fmtTime(ms) {
    var t = Math.floor((ms || 0) / 1000);
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  function fmtDuration(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? h + 'h ' + m + 'm ' + s + 's' : m ? m + 'm ' + s + 's' : s + 's';
  }

  // Uses the calendar date exactly as YouTube states it (no timezone shift).
  function fmtDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return v ? String(v) : '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
  }

  var compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  function fmtCount(v) {
    var n = typeof v === 'number' ? v : parseInt(String(v || '').replace(/[^0-9]/g, ''), 10);
    return isFinite(n) ? compact.format(n) : '';
  }

  function currentVideoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    // Streams and premieres are shared as youtube.com/live/<id>, and that
    // address stays while the normal watch page plays.
    var m = /^\/live\/([\w-]{11})\/?$/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function failure(message, code) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // Gleaner's own messages are plain sentences. Anything else (a network
  // TypeError, a JSON SyntaxError) becomes one.
  function plainError(e) {
    var msg = e && e.name === 'Error' && e.message ? e.message : "YouTube didn't answer.";
    return msg.replace(/\.?$/, '.');
  }

  // ------------------------------------------------------------- transcript
  //
  // YouTube guards its caption files with a proof-of-origin token, so Gleaner
  // never fetches them itself. It listens to the player's own requests
  // instead and, when needed, flicks the CC button to make the player ask.
  // Every caption file is filed under the video id in its URL, so a preview
  // or an ad can never be mistaken for the video you're on.

  var transcripts = {}, transcriptOrder = [], transcriptWaiters = {}, transcriptJobs = {};

  function rememberTranscript(videoId, segs) {
    if (!transcripts[videoId]) {
      transcriptOrder.push(videoId);
      if (transcriptOrder.length > 12) delete transcripts[transcriptOrder.shift()];
    }
    transcripts[videoId] = segs;
    var waiting = transcriptWaiters[videoId] || [];
    delete transcriptWaiters[videoId];
    waiting.forEach(function (fn) { try { fn(segs); } catch (e) {} });
  }

  function parseTimedText(body) {
    var data = body;
    if (typeof body === 'string') { try { data = JSON.parse(body); } catch (e) { return null; } }
    if (!data || !data.events) return null;
    var out = [];
    data.events.forEach(function (ev) {
      if (!ev.segs) return;
      var line = ev.segs.map(function (s) { return s.utf8 || ''; }).join('').replace(/\s+/g, ' ').trim();
      if (line) out.push({ start: ev.tStartMs || 0, text: line });
    });
    return out;
  }

  function urlParam(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function onTimedText(url, body) {
    var videoId = urlParam(url, 'v');
    if (!videoId) return;
    var segs = parseTimedText(body);
    if (!segs || !segs.length) return;
    // Which captions these are, so the prompt can say so.
    segs.captions = { lang: urlParam(url, 'lang'), auto: urlParam(url, 'kind') === 'asr', to: urlParam(url, 'tlang') };
    rememberTranscript(videoId, segs);
  }

  var languageNames = null;
  try { languageNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) {}
  function languageName(code) {
    try { return (code && languageNames && languageNames.of(code)) || code; } catch (e) { return code; }
  }

  // "English, auto-generated captions" / "auto-translated to French from English".
  function describeCaptions(c) {
    if (!c || !c.lang) return '';
    if (c.to) return 'auto-translated to ' + languageName(c.to) + ' from ' + languageName(c.lang);
    return languageName(c.lang) + (c.auto ? ', auto-generated captions' : ' captions');
  }

  function installHooks() {
    var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__scribeHooked) {
      var open = XP.open, send = XP.send;
      XP.open = function (method, url) {
        try { this.__scribeUrl = String(url); } catch (e) {}
        return open.apply(this, arguments);
      };
      XP.send = function () {
        var url = this.__scribeUrl;
        if (url && url.indexOf('timedtext') !== -1) {
          var xhr = this;
          xhr.addEventListener('load', function () {
            try {
              if (xhr.status !== 200) return;
              var rt = xhr.responseType;
              onTimedText(url, rt === '' || rt === 'text' ? xhr.responseText : xhr.response);
            } catch (e) {}
          });
        }
        return send.apply(this, arguments);
      };
      XP.__scribeHooked = true;
    }
    // The player uses XHR today; this covers a switch to fetch().
    if (window.fetch && !window.fetch.__scribeHooked) {
      var realFetch = window.fetch;
      var hooked = function (input) {
        var p = realFetch.apply(window, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
          if (url.indexOf('timedtext') !== -1) {
            p.then(function (res) {
              if (res && res.ok) res.clone().text().then(function (t) { onTimedText(url, t); }, function () {});
            }, function () {});
          }
        } catch (e) {}
        return p;
      };
      hooked.__scribeHooked = true;
      window.fetch = hooked;
    }
  }

  function isAdPlaying() {
    var p = document.querySelector('#movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  }

  function ccButton() { return document.querySelector('#movie_player .ytp-subtitles-button'); }

  // Gleaner switches captions on (or off and on again) only to make the player
  // ask for them, and YouTube remembers the switch for every later video. So
  // the capture that touched them puts them back the way the viewer had them
  // (ccWant): on whatever video is showing by then (CC is one setting for the
  // whole player), and right away when the viewer leaves mid-capture. It
  // checks again in case a click didn't land; before 15 Oct 2026 a capture
  // that failed could leave the viewer's captions off.
  var ccOwner = null, ccWant = false;
  function ccOn() { var b = ccButton(); return !!(b && b.getAttribute('aria-pressed') === 'true'); }
  function restoreCC(owner) {
    if (!ccOwner || (owner && owner !== ccOwner)) return;
    ccOwner = null;
    var want = ccWant, tries = 0;
    (function fix() {
      var b = ccButton();
      if (!b || ccOwner) return; // gone, or another capture has taken over
      if (ccOn() === want) return;
      b.click();
      if (++tries < 3) setTimeout(fix, 700);
    })();
  }
  // Resolves once the CC switch shows on (or off), or after ms.
  function ccSettled(on, ms) {
    var until = Date.now() + ms;
    return new Promise(function (resolve) {
      (function check() {
        if (ccOn() === on || Date.now() > until) resolve(ccOn() === on);
        else setTimeout(check, 50);
      })();
    });
  }

  function captionTracks(videoId) {
    var pr = playerResponse(videoId);
    if (!pr) return null; // player not ready for this video yet
    var list = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    return (list && list.captionTracks) || [];
  }

  // One shared attempt per video, however many buttons ask for it.
  function getTranscript(videoId, onStatus) {
    if (transcripts[videoId]) return Promise.resolve(transcripts[videoId]);
    if (transcriptJobs[videoId]) return transcriptJobs[videoId];

    var job = new Promise(function (resolve, reject) {
      var settled = false, timer = 0, touched = false, me = {};

      function onSegs(segs) { finish(null, segs); }
      function finish(err, segs) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        var list = transcriptWaiters[videoId];
        if (list) { var i = list.indexOf(onSegs); if (i !== -1) list.splice(i, 1); }
        delete transcriptJobs[videoId];
        // Put captions back the way the viewer had them (see restoreCC).
        if (touched) setTimeout(function () { restoreCC(me); }, 300);
        if (err) reject(err); else resolve(segs);
      }
      (transcriptWaiters[videoId] = transcriptWaiters[videoId] || []).push(onSegs);

      (async function () {
        // Let getTranscript file this job first. A result on the very first
        // check (no captions, or the viewer already left) must still be taken
        // out of transcriptJobs by finish(), not kept for good.
        await 0;
        var started = Date.now();
        for (;;) {
          if (settled) return;
          if (currentVideoId() !== videoId) return finish(failure('moved', 'moved'));
          if (isAdPlaying()) {
            if (onStatus) onStatus('ad');
            await sleep(500);
            started = Date.now();
            continue;
          }
          var tracks = captionTracks(videoId);
          if (tracks && !tracks.length) return finish(failure('This video has no captions.', 'no-captions'));
          if (tracks && ccButton()) break;
          if (Date.now() - started > 10000) return finish(failure("The video player didn't load. Refresh the page and try again.", 'player'));
          await sleep(250);
        }
        if (settled) return;
        if (onStatus) onStatus('fetching');
        // YouTube sometimes takes 10 seconds or more to answer (seen live while
        // the video was buffering), so give it room before calling it failed.
        // Ad time doesn't count: when an ad starts right after the click, the
        // player asks for the captions only once the video itself plays. The
        // wait also ends as soon as the viewer leaves the video.
        var deadline = Date.now() + 30000, slowAt = Date.now() + 6000, inAd = false, slow = false;
        timer = setInterval(function () {
          if (currentVideoId() !== videoId) return finish(failure('moved', 'moved'));
          var now = Date.now();
          if (isAdPlaying()) {
            deadline = now + 30000;
            slowAt = now + 6000;
            if (!inAd && onStatus) onStatus('ad');
            inAd = true;
            return;
          }
          if (inAd) { inAd = false; slow = false; if (onStatus) onStatus('fetching'); }
          if (!slow && now > slowAt) { slow = true; if (onStatus) onStatus('slow'); }
          if (now > deadline) finish(failure("YouTube didn't send the captions. Try again.", 'timeout'));
        }, 500);
        // The viewer's own setting: what the switch shows now, unless an earlier
        // capture's put-back is still pending (then that one knew it). From
        // here this capture puts captions back to it, however it ends.
        var wasOn = ccOn();
        ccWant = ccOwner ? ccWant : wasOn;
        ccOwner = me;
        touched = true;
        ccButton().click();
        if (wasOn) {
          // Captions were on: off, then on again once the switch shows off, so
          // the player asks for them again.
          await ccSettled(false, 3000);
          if (ccOwner === me && !settled && !ccOn()) ccButton().click();
        }
      })();
    });

    transcriptJobs[videoId] = job;
    return job;
  }

  // ---------------------------------------------------------- video details
  //
  // After you click into another video, window.ytInitialData and
  // ytInitialPlayerResponse still describe the FIRST video on the page.
  // The player and <ytd-watch-flexy> hold the current one, so read those
  // first and check the video id on everything.

  function playerResponse(videoId) {
    try {
      var mp = document.querySelector('#movie_player');
      var pr = mp && typeof mp.getPlayerResponse === 'function' ? mp.getPlayerResponse() : null;
      if (pr && pr.videoDetails && pr.videoDetails.videoId === videoId) return pr;
    } catch (e) {}
    try {
      var pd = document.querySelector('ytd-watch-flexy').playerData;
      if (pd && pd.videoDetails && pd.videoDetails.videoId === videoId) return pd;
    } catch (e) {}
    try {
      var ip = window.ytInitialPlayerResponse;
      if (ip && ip.videoDetails && ip.videoDetails.videoId === videoId) return ip;
    } catch (e) {}
    return null;
  }

  function pageData(videoId) {
    function matches(d) {
      try { return d.currentVideoEndpoint.watchEndpoint.videoId === videoId; } catch (e) { return false; }
    }
    try {
      var d = document.querySelector('ytd-watch-flexy').data;
      if (matches(d)) return d;
    } catch (e) {}
    return matches(window.ytInitialData) ? window.ytInitialData : null;
  }

  function watchContents(pd) {
    try { return pd.contents.twoColumnWatchNextResults.results.results.contents || []; } catch (e) { return []; }
  }

  function readChapters(pd) {
    var panels = (pd && pd.engagementPanels) || [];
    function fromPanel(id) {
      for (var i = 0; i < panels.length; i++) {
        var r = panels[i].engagementPanelSectionListRenderer;
        if (!r || r.panelIdentifier !== id) continue;
        var items = (r.content && r.content.macroMarkersListRenderer && r.content.macroMarkersListRenderer.contents) || [];
        return items
          .map(function (it) { return it.macroMarkersListItemRenderer; })
          .filter(Boolean)
          .map(function (m) { return { time: text(m.timeDescription), title: text(m.title) }; })
          .filter(function (c) { return c.title; });
      }
      return [];
    }
    var own = fromPanel('engagement-panel-macro-markers-description-chapters');
    if (own.length) return { list: own, auto: false };
    var auto = fromPanel('engagement-panel-macro-markers-auto-chapters');
    return auto.length ? { list: auto, auto: true } : null;
  }

  function readDetails(videoId) {
    var pr = playerResponse(videoId) || {};
    var vd = pr.videoDetails || {};
    var mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    var pd = pageData(videoId);
    var prim = null, sec = null;
    watchContents(pd).forEach(function (c) {
      if (c.videoPrimaryInfoRenderer) prim = c.videoPrimaryInfoRenderer;
      if (c.videoSecondaryInfoRenderer) sec = c.videoSecondaryInfoRenderer;
    });
    var owner = sec && sec.owner && sec.owner.videoOwnerRenderer;
    var secs = parseInt(vd.lengthSeconds, 10); // '0' for live and upcoming streams
    return {
      ready: !!pr.videoDetails,
      title: vd.title || text(prim && prim.title),
      channel: vd.author || mf.ownerChannelName || text(owner && owner.title),
      subscribers: text(owner && owner.subscriberCountText),
      url: 'https://www.youtube.com/watch?v=' + videoId,
      published: fmtDate(mf.publishDate || mf.uploadDate) || text(prim && prim.dateText),
      duration: secs > 0 ? fmtDuration(secs) : '',
      views: vd.viewCount ? fmtCount(vd.viewCount) : '',
      likes: mf.likeCount ? fmtCount(mf.likeCount) : '',
      category: mf.category || '',
      tags: (vd.keywords || []).slice(0, 15),
      description: vd.shortDescription || text(mf.description),
      chapters: readChapters(pd),
      liveNow: !!vd.isLive
    };
  }

  // Waits (up to 8 s) until the player or page data has this video's details.
  function waitForDetails(videoId) {
    return (async function () {
      for (var i = 0; i < 32; i++) {
        if (currentVideoId() !== videoId || readDetails(videoId).ready) break;
        await sleep(250);
      }
      return readDetails(videoId);
    })();
  }

  // --------------------------------------------------------------- comments

  var MAX_COMMENT_PAGES = 16; // about 320 top comments, plus their replies
  var REPLY_WORKERS = 8;
  var comments = {}, commentOrder = [], commentJobs = {};

  // One page of comments or replies (continuation), or with videoId the
  // video's whole watch-page data, the same shape as the page's own.
  function innertubeNext(continuation, videoId) {
    var cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    var context = cfg && cfg.get('INNERTUBE_CONTEXT');
    if (!context) {
      context = { client: { clientName: 'WEB', clientVersion: (cfg && cfg.get('INNERTUBE_CLIENT_VERSION')) || '2.20260901.00.00' } };
    }
    return fetch('/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(videoId ? { context: context, videoId: videoId } : { context: context, continuation: continuation }),
      signal: AbortSignal.timeout(16000) // covers reading the answer too
    }).then(function (r) {
      if (!r.ok) throw new Error('YouTube answered ' + r.status + '.');
      return r.json();
    }).catch(function (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error("YouTube didn't answer in time.");
      throw e;
    });
  }

  async function withRetry(fn, retries) {
    for (var i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= (retries == null ? 2 : retries)) throw e;
        await sleep(600 * (i + 1));
      }
    }
  }

  function continuationToken(ci) {
    if (!ci) return null;
    try { if (ci.continuationEndpoint.continuationCommand.token) return ci.continuationEndpoint.continuationCommand.token; } catch (e) {}
    try { return ci.button.buttonRenderer.command.continuationCommand.token || null; } catch (e) {}
    return null;
  }

  function findCommentsToken(pd) {
    if (!pd) return { state: 'unknown' };
    var section = null;
    watchContents(pd).forEach(function (c) {
      var s = c.itemSectionRenderer;
      if (s && s.sectionIdentifier === 'comment-item-section') section = s;
    });
    if (!section) return { state: 'nosection' };
    var token = null, threads = false, message = false;
    (section.contents || []).forEach(function (it) {
      if (it.commentThreadRenderer) threads = true;
      if (it.messageRenderer) message = true;
      if (!token) token = continuationToken(it.continuationItemRenderer);
    });
    // Once YouTube has shown the comments under the video, it keeps them in
    // this section, and the token left here points past the top ones
    // (checked live, 22 Sep 2026). Gleaner asks for a fresh copy then.
    if (threads) return { state: 'stale' };
    if (token) return { state: 'ok', token: token };
    // 'Comments are turned off' shows as a message; anything else is unknown.
    return { state: message ? 'off' : 'stale' };
  }

  function continuationItems(data) {
    var items = [];
    (data.onResponseReceivedEndpoints || []).forEach(function (ep) {
      var a = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
      if (a && a.continuationItems) items = items.concat(a.continuationItems);
    });
    return items;
  }

  function commentPayloads(data) {
    var muts = (data.frameworkUpdates && data.frameworkUpdates.entityBatchUpdate &&
      data.frameworkUpdates.entityBatchUpdate.mutations) || [];
    return muts
      .map(function (m) { return m.payload && m.payload.commentEntityPayload; })
      .filter(function (p) { return p && p.properties && p.properties.commentId; });
  }

  function toComment(p) {
    var tb = p.toolbar || {}, au = p.author || {}, pr = p.properties || {};
    var likes = String(tb.likeCountNotliked || '').trim();
    return {
      author: au.displayName || 'Someone',
      creator: !!au.isCreator,
      text: String((pr.content && pr.content.content) || '').trim(),
      likes: likes && likes !== '0' ? likes : '',
      time: String(pr.publishedTime || '').replace(/\s*\(edited\)\s*$/, ', edited'),
      hearted: !!tb.creatorThumbnailUrl,
      pinned: false,
      level: pr.replyLevel || 0,
      replies: []
    };
  }

  function rememberComments(videoId, result) {
    if (!comments[videoId]) {
      commentOrder.push(videoId);
      if (commentOrder.length > 6) delete comments[commentOrder.shift()];
    }
    comments[videoId] = result;
  }

  // Where this video's comments start: { state: 'ok', token } or 'off'
  // (turned off) or 'nosection' (no comments section, e.g. live chat).
  async function commentsStart(videoId) {
    // Page data can trail a click into a new video by a moment.
    var found = { state: 'unknown' }, started = Date.now(), dataAt = 0;
    while (Date.now() - started < 8000) {
      if (currentVideoId() !== videoId) throw failure('moved', 'moved');
      found = findCommentsToken(pageData(videoId));
      if (found.state === 'ok' || found.state === 'off' || found.state === 'stale') break;
      // The comments section arrives with the page data. If the data is
      // here and still has no section after a moment, there won't be one
      // (live streams have live chat instead).
      if (found.state === 'nosection') {
        if (!dataAt) dataAt = Date.now();
        else if (Date.now() - dataAt > 2500) break;
      }
      await sleep(300);
    }
    if (found.state === 'unknown') throw new Error("The page didn't finish loading.");
    if (found.state === 'stale') {
      // The page's copy is used up: ask YouTube for a fresh one.
      found = findCommentsToken(await withRetry(function () { return innertubeNext(null, videoId); }));
      if (found.state === 'stale' || found.state === 'unknown') throw new Error("YouTube didn't send the comments.");
    }
    return found;
  }

  // With refetch, a set that came back incomplete is fetched again.
  function getComments(videoId, onProgress, refetch) {
    var cached = comments[videoId];
    var job = commentJobs[videoId];
    if (job) return job;
    if (cached && !(refetch && cached.partial)) return Promise.resolve(cached);

    job = (async function () {
      // However slow YouTube is, Copy and Send get an answer: past this, keep
      // what has loaded and mark it incomplete.
      var deadline = Date.now() + 64000;
      var found = await commentsStart(videoId);

      var result = {
        off: found.state === 'off', none: found.state === 'nosection', list: [], replies: 0,
        partial: false
      };

      // Replies load while the pages are still coming in: each thread with
      // replies joins a queue that a few workers drain as it fills. (Pages
      // have to be fetched one after another; replies don't.)
      var queue = [], next = 0, pagesDone = false;
      async function worker() {
        for (;;) {
          if (Date.now() > deadline) return; // anything left counts as missing, below
          if (next < queue.length) {
            var c = queue[next++];
            try {
              var rd = await withRetry(function () { return innertubeNext(c.replyToken); }, 1);
              commentPayloads(rd).forEach(function (p) {
                var r = toComment(p);
                if (r.level > 0) c.replies.push(r);
              });
            } catch (e) {
              result.partial = true;
            }
            delete c.replyToken;
          } else if (pagesDone) {
            return;
          } else {
            await sleep(80);
          }
        }
      }
      var workers = [];
      for (var w = 0; w < REPLY_WORKERS; w++) workers.push(worker());

      var token = found.token, page = 0;
      try {
        while (token) {
          if (page >= MAX_COMMENT_PAGES) break; // any more stay out of the copy
          if (Date.now() > deadline) { result.partial = true; break; }
          page++;
          if (onProgress) onProgress(page);
          var data;
          try {
            data = await withRetry(function () { return innertubeNext(token); });
          } catch (e) {
            if (!result.list.length) throw e;
            result.partial = true; // keep what already loaded
            break;
          }
          var byId = {};
          commentPayloads(data).forEach(function (p) { byId[p.properties.commentId] = p; });
          token = null;
          continuationItems(data).forEach(function (item) {
            var thread = item.commentThreadRenderer;
            if (thread) {
              var vm = thread.commentViewModel && thread.commentViewModel.commentViewModel;
              var p = vm && byId[vm.commentId];
              if (!p) return;
              var c = toComment(p);
              c.pinned = !!text(vm.pinnedText);
              var rr = thread.replies && thread.replies.commentRepliesRenderer;
              // Replies moved from .contents to .subThreads in 2026; read both.
              var subs = (rr && (rr.subThreads || rr.contents)) || [];
              for (var i = 0; i < subs.length && !c.replyToken; i++) c.replyToken = continuationToken(subs[i].continuationItemRenderer);
              result.list.push(c);
              if (c.replyToken) queue.push(c);
            } else if (item.continuationItemRenderer) {
              token = continuationToken(item.continuationItemRenderer);
            }
          });
        }
      } finally {
        pagesDone = true;
      }
      await Promise.all(workers);
      if (next < queue.length) result.partial = true; // replies the time ran out on

      result.list.forEach(function (c) { result.replies += c.replies.length; });
      rememberComments(videoId, result);
      return result;
    })();

    // A second try that fails, or gets less, keeps what the first one got.
    if (cached) job = job.then(function (res) {
      if (res.partial && res.list.length < cached.list.length) { rememberComments(videoId, cached); return cached; }
      return res;
    }, function (e) {
      if (e && e.code === 'moved') throw e;
      return cached;
    });

    commentJobs[videoId] = job;
    function done() { if (commentJobs[videoId] === job) delete commentJobs[videoId]; }
    job.then(done, done);
    return job;
  }

  // ------------------------------------------------------- comments export
  //
  // Every comment and reply on a video, for a spreadsheet. Unlike the copied
  // text it follows every page, including each thread's "more replies".

  // Per thread, only to end a "more replies" chain that never ends; a page
  // holds about 10 replies signed in, 45 signed out.
  var MAX_REPLY_PAGES = 10000;
  var CSV_PART_ROWS = 5000; // rows per Blob part of the file

  // True when the page's memory is getting close to Chrome's limit (Chrome
  // only; elsewhere it never stops an export).
  function memoryTight() {
    var m = window.performance && window.performance.memory;
    return !!(m && m.jsHeapSizeLimit && m.usedJSHeapSize > m.jsHeapSizeLimit * 0.6);
  }

  // The "Newest first" entry of the comments header's sort menu, or null.
  function newestToken(data) {
    var token = null;
    continuationItems(data).forEach(function (it) {
      var h = it.commentsHeaderRenderer;
      var menu = h && h.sortMenu && h.sortMenu.sortFilterSubMenuRenderer;
      var entry = menu && menu.subMenuItems && menu.subMenuItems[1]; // [Top, Newest]
      if (!token && entry) {
        try { token = entry.serviceEndpoint.continuationCommand.token || null; } catch (e) {}
      }
    });
    return token;
  }

  // The comment count in the comments header ("1,543 Comments"), or 0.
  function headerCount(data) {
    var n = 0;
    continuationItems(data).forEach(function (it) {
      var h = it.commentsHeaderRenderer;
      if (h && !n) n = parseInt(text(h.countText).replace(/[^0-9]/g, ''), 10) || 0;
    });
    return n;
  }

  // "559" -> 559, "1.3K" -> 1300 (YouTube rounds counts over 1,000), and
  // YouTube's blank for none -> 0.
  function countValue(s) {
    var str = String(s || '').trim();
    if (!str) return 0;
    var m = /^([\d.,]+)\s*([KMB])?$/i.exec(str);
    if (!m) return str;
    var n = parseFloat(m[1].replace(/,/g, ''));
    var mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(n * mult);
  }

  function exportRow(videoId, p, node) {
    var tb = p.toolbar || {}, au = p.author || {}, pr = p.properties || {};
    var time = String(pr.publishedTime || '');
    var level = pr.replyLevel || 0;
    return {
      video_id: videoId,
      comment_id: pr.commentId,
      parent_id: node.parent || '',
      thread_id: node.thread,
      reply_level: level,
      // Handles start with @, which spreadsheets would read as a formula.
      author: String(au.displayName || '').replace(/^@/, ''),
      author_channel_id: au.channelId || '',
      text: String((pr.content && pr.content.content) || ''),
      likes: countValue(tb.likeCountNotliked),
      replies: level ? '' : countValue(tb.replyCount),
      published: time.replace(/\s*\(edited\)\s*$/, ''),
      edited: /\(edited\)\s*$/.test(time) ? 'yes' : 'no',
      pinned: node.pinned ? 'yes' : 'no',
      hearted: tb.creatorThumbnailUrl ? 'yes' : 'no',
      by_creator: au.isCreator ? 'yes' : 'no'
    };
  }

  // Walks a list of comment items: comments (whose replies can nest inside
  // them, several levels deep for signed-in viewers) and "more" links, noting
  // the parent of each. parent is '' for top comments.
  function walkComments(list, parent, out) {
    (list || []).forEach(function (it) {
      var t = it.commentThreadRenderer;
      if (t) {
        var vm = t.commentViewModel && t.commentViewModel.commentViewModel;
        var id = vm && vm.commentId;
        if (id) out.nodes.push({ id: id, parent: parent, pinned: !!text(vm.pinnedText) });
        var rr = t.replies && t.replies.commentRepliesRenderer;
        if (rr) walkComments(rr.subThreads || rr.contents, id || parent, out);
      } else if (it.commentViewModel) {
        var v = it.commentViewModel.commentViewModel || it.commentViewModel;
        if (v.commentId) out.nodes.push({ id: v.commentId, parent: parent, pinned: false });
      } else if (it.continuationItemRenderer) {
        var token = continuationToken(it.continuationItemRenderer);
        if (token) out.more.push({ token: token, parent: parent });
      }
    });
  }

  // How long a running export has left: eta reads like "about 25 min left"
  // once there's enough to go on, and long says there's more than half an
  // hour to go. gained is what this run has read so far; left is the rows
  // still to come, or -1 when the total isn't known.
  function exportPlan(started, gained, left) {
    var secs = (Date.now() - started) / 1000, t = -1;
    if (left >= 0 && secs >= 10 && gained >= 200) t = left / (gained / secs);
    var eta = t < 0 ? '' : t < 45 ? 'Under a minute left' : 'About ' + timeLeft(t) + ' left';
    return { eta: eta, long: t > 1800 };
  }
  // "under a minute", "25 min", "12 h 24 min".
  function timeLeft(t) {
    var mins = Math.round(t / 60);
    if (t < 45) return 'under a minute';
    if (mins < 60) return Math.max(1, mins) + ' min';
    return Math.floor(mins / 60) + ' h' + (mins % 60 ? ' ' + (mins % 60) + ' min' : '');
  }

  // An export of every comment and reply on a video. run() reads until the
  // end or until stop(), and run() again carries on where it stopped. Each
  // run resolves to { finished, stopped, why, comments, replies, rows, total,
  // cut, off, none }: why is 'memory' (the page ran low), 'youtube' (it
  // stopped answering; another run tries again), 'loop' (it kept sending the
  // same comments) or 'storage' (its progress couldn't be saved); cut says
  // some replies didn't load. onProgress gets (rows read, total from the
  // header, rows already in the file).
  //
  // With store (the saved exports background.js keeps), each chunk of the
  // file is saved as soon as it's done, together with a note of where the
  // reading stands, so another visit can save it again, carry on from the
  // note (restore), or update() it with just the comments posted since.
  // Without store, the file stays in this page. save() writes the file.
  // gentle reads more slowly (an export that started by itself).
  function exportComments(videoId, onProgress, store, restore, gentle) {
    var total = 0, count = 0, comments = 0, replies = 0, rows = 0;
    // Rows per second, measured during a run and kept in the note, so a
    // paused export can say how long it needs to finish.
    var pace = (restore && restore.pace) || 0, runStart = 0, runCount = 0;
    // There's no limit on how many comments an export reads, so nothing big
    // stays in the page's memory: each comment becomes its CSV line as soon as
    // it arrives (YouTube's bulky payload is dropped), and each thread moves
    // into the file as soon as all its replies are in. The file is a list of
    // Blobs, which Chrome keeps outside the page's memory, on disk when big.
    var threadOf = {};         // comment id -> the id of its thread; also what's been seen
    var lineOf = {};           // comment id -> its CSV line, until it's in the file
    var waiting = {};          // comment id -> its node, until its payload arrives
    var children = { '': [] }; // parent id -> child ids, in the order YouTube shows them
    var pending = {};          // thread id -> "more replies" pages still to read
    var rootMore = {};         // top comment id -> its first "more replies" links, until it's in the file
    var fetchesPerThread = {};
    var pinnedIds = {};        // only the top list marks the pinned comment
    var waiters = [];          // reply workers with nothing to do yet
    var parts = [];            // without store: the file's chunks, as Blobs
    var buf = [], flushAt = 0;
    // Where the reading stands, kept from one run to the next.
    var begun = false, finished = false, off = false, none = false, cut = false;
    var token = null, queue = [], next = 0, active = 0, pagesDone = false, stopped = false, running = null;
    // For the saved note: newest comments seen first (an update stops at
    // them), the latest ones seen (a repeat after carrying on is skipped), and
    // counts of what's in the file.
    var firstIds = [], lastIds = [], fileComments = 0, fileReplies = 0;
    var startedAt = Date.now(), seq = 0, nextOrder = MAIN_ORDER, headBatches = 0;
    var writes = Promise.resolve(), broken = false;
    var updating = false, updateLines = null; // an update keeps its rows here until it's done

    if (restore) {
      startedAt = restore.startedAt || startedAt;
      total = restore.total || 0;
      seq = restore.seq || 0;
      begun = !!restore.begun;
      finished = !!restore.finished;
      cut = !!restore.cut;
      token = restore.token || null;
      nextOrder = restore.nextOrder || MAIN_ORDER;
      headBatches = restore.headBatches || 0;
      rows = restore.rows || 0;
      fileComments = restore.fileComments || 0;
      fileReplies = restore.fileReplies || 0;
      firstIds = (restore.firstIds || []).slice();
      lastIds = (restore.lastIds || []).slice();
      (restore.pinned || []).forEach(function (id) { pinnedIds[id] = true; });
      // Already in the file: if YouTube sends one again, it's skipped. The
      // pinned comment comes first and again in its place among the oldest
      // (a carried-on Bloodbark export saved its thread twice before this).
      firstIds.concat(lastIds, restore.pinned || []).forEach(function (id) { threadOf[id] = id; });
      // Threads that were still loading start over from their first replies.
      (restore.unflushed || []).forEach(function (u) {
        threadOf[u.id] = u.id;
        children[''].push(u.id);
        if (typeof u.line === 'string') { lineOf[u.id] = u.line; comments++; }
        rootMore[u.id] = (u.roots || []).slice();
        rootMore[u.id].forEach(function (t) {
          queue.push({ token: t, parent: u.id, thread: u.id });
          pending[u.id] = (pending[u.id] || 0) + 1;
        });
      });
      comments += fileComments;
      replies = fileReplies;
      count = rows + children[''].length;
    }

    function tick() { if (onProgress) onProgress(count, total, rows); }
    // Wakes idle reply workers. They wait on this instead of a timer, because
    // Chrome slows timers in a background tab to about once a minute.
    function wake() { var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }

    function finish(n, p) {
      var row = exportRow(videoId, p, n);
      lineOf[n.id] = csvLine(row);
      if (row.reply_level > 0) replies++; else comments++;
    }

    // Returns the page's "more" links, and how many comments on it were new.
    // items is the page's list, or part of it (an update stops partway).
    function absorb(data, parent, items) {
      var byId = {}, added = 0, fresh = {};
      commentPayloads(data).forEach(function (p) {
        var id = p.properties.commentId;
        if (waiting[id]) { finish(waiting[id], p); delete waiting[id]; } else byId[id] = p;
      });
      var out = { nodes: [], more: [] };
      walkComments(items || continuationItems(data), parent, out);
      out.nodes.forEach(function (n) {
        if (threadOf[n.id] !== undefined) return;
        if (pinnedIds[n.id]) n.pinned = true;
        n.thread = n.parent ? (threadOf[n.parent] !== undefined ? threadOf[n.parent] : n.parent) : n.id;
        threadOf[n.id] = n.thread;
        (children[n.parent] = children[n.parent] || []).push(n.id);
        if (byId[n.id]) finish(n, byId[n.id]); else waiting[n.id] = n;
        count++;
        added++;
        fresh[n.id] = true;
        if (!n.parent) {
          if (firstIds.length < FIRST_IDS) firstIds.push(n.id);
          lastIds.push(n.id);
          if (lastIds.length > LAST_IDS) lastIds.shift();
        }
      });
      var more = out.more;
      if (!parent) {
        // A top comment's replies are read once: a repeat's links are dropped,
        // and a new one's are kept, so a later visit can read them again.
        more = more.filter(function (m) { return !m.parent || fresh[m.parent]; });
        more.forEach(function (m) { if (m.parent) (rootMore[m.parent] = rootMore[m.parent] || []).push(m.token); });
      }
      return { more: more, added: added };
    }

    // A comment, then its replies under it, from memory into the file.
    function emit(id) {
      delete waiting[id];
      delete fetchesPerThread[id];
      delete rootMore[id];
      if (lineOf[id] !== undefined) {
        buf.push(lineOf[id]);
        delete lineOf[id];
        rows++;
        if (threadOf[id] === id) fileComments++; else fileReplies++;
      }
      var kids = children[id];
      delete children[id];
      if (kids) kids.forEach(emit);
    }

    // Where the reading stands, for a later visit: everything before the
    // token is in the file or in the threads still loading, which are kept as
    // their top comment and the links to their first replies.
    function note() {
      var secs = runStart ? (Date.now() - runStart) / 1000 : 0;
      if (secs > 20 && count - runCount > 200) pace = (count - runCount) / secs;
      var unflushed = [], tops = children[''];
      for (var i = flushAt; i < tops.length; i++) {
        if (tops[i] == null) continue;
        unflushed.push({ id: tops[i], line: lineOf[tops[i]], roots: rootMore[tops[i]] || [] });
      }
      return {
        v: 1, videoId: videoId, seq: ++seq, startedAt: startedAt, updatedAt: Date.now(),
        title: readDetails(videoId).title || '', total: total, rows: rows,
        fileComments: fileComments, fileReplies: fileReplies,
        begun: begun, finished: finished, cut: cut, token: token, nextOrder: nextOrder, headBatches: headBatches, pace: pace,
        unflushed: unflushed, firstIds: firstIds.slice(), lastIds: lastIds.slice(), pinned: Object.keys(pinnedIds)
      };
    }

    // Saves a chunk (or just the note) in the order they happen. A save that
    // fails three times stops the run: what's saved is still whole, so the
    // next visit carries on from there.
    function commit(text, order) {
      if (!store || broken) return;
      var part = text ? { order: order !== undefined ? order : nextOrder++, text: text } : null;
      var meta = note();
      writes = writes.then(function () {
        if (broken) return;
        var tries = 0;
        return (function attempt() {
          return store.commit(part, meta).then(function (res) {
            if (res && res.ok) return;
            if (++tries >= 3) throw new Error((res && res.error) || 'not saved');
            return sleep(2000).then(attempt);
          });
        })();
      }).catch(function () {
        broken = true;
        stopped = true;
        wake();
      });
    }

    function seal() {
      if (!buf.length) return;
      var text = buf.join('\r\n') + '\r\n';
      buf = [];
      if (updating) updateLines.push(text);
      else if (store) commit(text);
      else parts.push(new Blob([text]));
    }
    // A checkpoint: what's done goes into the file, with the note.
    function checkpoint() {
      if (updating) return;
      if (buf.length) seal(); else commit(null);
    }
    // Moves every finished thread at the front, in order, into the file. With
    // all, everything left goes: the run is over.
    function flush(all) {
      var tops = children[''];
      while (flushAt < tops.length && (all || !pending[tops[flushAt]])) {
        emit(tops[flushAt]);
        tops[flushAt++] = null;
        if (buf.length >= CSV_PART_ROWS) seal();
      }
      if (flushAt > 50000) { children[''] = tops.slice(flushAt); flushAt = 0; }
      if (all && buf.length) seal();
    }

    // "More replies" links, from top-level pages and from reply pages alike.
    function queueMore(list) {
      var added = false;
      list.forEach(function (m) {
        if (!m.parent) return;
        var thread = threadOf[m.parent] !== undefined ? threadOf[m.parent] : m.parent;
        queue.push({ token: m.token, parent: m.parent, thread: thread });
        pending[thread] = (pending[thread] || 0) + 1;
        added = true;
      });
      if (added) wake();
    }
    function done(thread) {
      if (!--pending[thread]) delete pending[thread];
      flush(false);
    }
    async function replyWorker() {
      for (;;) {
        if (stopped) return; // what's left in the queue waits for the next run
        if (next < queue.length) {
          var q = queue[next];
          queue[next++] = null; // let a long run's done items go
          if ((fetchesPerThread[q.thread] = (fetchesPerThread[q.thread] || 0) + 1) > MAX_REPLY_PAGES) { cut = true; done(q.thread); continue; }
          active++;
          try {
            var rd = await withRetry(function () { return innertubeNext(q.token); }, 2);
            queueMore(absorb(rd, q.parent).more);
            tick();
          } catch (e) {
            cut = true;
          } finally {
            active--;
            done(q.thread);
            wake();
          }
        } else if (pagesDone && !active) {
          return;
        } else {
          await new Promise(function (r) { waiters.push(r); });
        }
      }
    }

    // The first page: the total, the pinned comment, and where "Newest first"
    // starts. YouTube's "Top comments" list ends near 1,000 comments on a big
    // video (988 of 9,757 on Sintel, checked 8 Oct 2026); "Newest first" runs
    // to the end (9,234). So the export reads Newest, in newest-first order.
    async function begin() {
      var found = await commentsStart(videoId);
      if (found.state !== 'ok') { off = found.state === 'off'; none = found.state === 'nosection'; finished = true; return; }
      var first = await withRetry(function () { return innertubeNext(found.token); });
      total = headerCount(first);
      var top = { nodes: [], more: [] };
      walkComments(continuationItems(first), '', top);
      top.nodes.forEach(function (n) { if (n.pinned) pinnedIds[n.id] = true; });
      token = newestToken(first);
      if (!token) {
        // No sort menu: fall back to the top list, from the page in hand.
        var more0 = absorb(first, '').more;
        more0.forEach(function (m) { if (!m.parent) token = m.token; });
        queueMore(more0);
        flush(false);
        tick();
      }
      begun = true;
    }

    function startWorkers() {
      pagesDone = false;
      var workers = [];
      for (var w = 0; w < (gentle ? GENTLE_WORKERS : REPLY_WORKERS); w++) workers.push(replyWorker());
      return workers;
    }

    async function read() {
      stopped = false;
      if (!begun) await begin();
      runStart = Date.now();
      runCount = count;
      var why = '';
      if (!finished) {
        var timer = store ? setInterval(checkpoint, CHECKPOINT_MS) : null;
        var workers = startWorkers();
        var page = 0, stale = 0;
        try {
          while (token && !stopped) {
            if (currentVideoId() !== videoId) throw failure('moved', 'moved');
            // Pauses short of a crash if the page's memory fills anyway.
            if (++page % 25 === 0 && memoryTight()) { why = 'memory'; break; }
            var data;
            try {
              // A long run meets the odd hiccup, so a page gets a few more tries.
              data = await withRetry(function () { return innertubeNext(token); }, 5);
            } catch (e) {
              if (!count) throw e;
              why = 'youtube'; // the token stays, so the next run tries this page again
              break;
            }
            if (!total) total = headerCount(data);
            var got = absorb(data, '');
            token = null;
            got.more.forEach(function (m) { if (!m.parent) token = m.token; }); // the next page of top comments
            queueMore(got.more);
            // Pages with nothing new, over and over, mean YouTube is going in circles.
            if (got.added) stale = 0; else if (++stale >= 5) { why = 'loop'; token = null; cut = true; }
            flush(false);
            tick();
            if (gentle && token) await sleep(GENTLE_GAP_MS);
          }
        } finally {
          pagesDone = true;
          wake();
          if (timer) clearInterval(timer);
        }
        await Promise.all(workers);
        if (!stopped && !token && next >= queue.length) { finished = true; flush(true); tick(); }
      }
      if (!off && !none) {
        checkpoint();
        await writes;
      }
      return {
        finished: finished, stopped: stopped && !finished, why: broken ? 'storage' : why, comments: comments,
        replies: replies, rows: rows, total: total, cut: cut, off: off, none: none
      };
    }

    // Only forward: reads "Newest first" from the top, stops at the newest
    // comments the file already has, and puts what's new above them, in one
    // chunk once it's all in. A stopped update keeps nothing, so the next one
    // simply starts again. For a finished export only.
    async function readUpdate() {
      stopped = false;
      var markers = {};
      firstIds.forEach(function (id) { markers[id] = true; threadOf[id] = id; });
      var oldFirst = firstIds, startRows = rows;
      firstIds = []; // fills with this update's newest comments, for the next update
      updating = true;
      updateLines = [];
      var found = await commentsStart(videoId);
      if (found.state !== 'ok') { updating = false; firstIds = oldFirst; return { update: true, complete: false, off: found.state === 'off', none: found.state !== 'off', added: 0 }; }
      var first = await withRetry(function () { return innertubeNext(found.token); });
      total = headerCount(first) || total;
      var tok = newestToken(first);
      queue = [];
      next = 0;
      var workers = startWorkers();
      var reachedOld = !tok;
      try {
        while (tok && !stopped && !reachedOld) {
          if (currentVideoId() !== videoId) throw failure('moved', 'moved');
          var data = await withRetry(function () { return innertubeNext(tok); }, 5);
          var list = continuationItems(data), cutAt = -1;
          for (var i = 0; i < list.length && cutAt < 0; i++) {
            var t = list[i].commentThreadRenderer;
            var vm = t && t.commentViewModel && t.commentViewModel.commentViewModel;
            if (vm && markers[vm.commentId]) cutAt = i;
          }
          if (cutAt >= 0) { list = list.slice(0, cutAt); reachedOld = true; }
          var got = absorb(data, '', list);
          tok = null;
          if (!reachedOld) got.more.forEach(function (m) { if (!m.parent) tok = m.token; });
          queueMore(got.more);
          flush(false);
          tick();
        }
      } finally {
        pagesDone = true;
        wake();
      }
      await Promise.all(workers);
      var complete = !stopped && next >= queue.length;
      flush(true);
      updating = false;
      var added = rows - startRows;
      firstIds = complete ? firstIds.concat(oldFirst).slice(0, FIRST_IDS * 2) : oldFirst;
      if (complete && updateLines.length) {
        headBatches++;
        commit(updateLines.join(''), MAIN_ORDER - headBatches * BATCH_SPAN);
      } else if (complete) {
        commit(null); // nothing new: the note still gets the latest total
      }
      updateLines = null;
      await writes;
      return {
        update: true, complete: complete && !broken, stopped: stopped, why: broken ? 'storage' : '', added: added,
        comments: comments, replies: replies, rows: rows, total: total
      };
    }

    // The rows not in a saved chunk yet: the last few done, then the threads
    // still loading, copied without disturbing them.
    function tail() {
      var lines = buf.slice(), loading = 0;
      (function walk(ids) {
        ids.forEach(function (id) {
          if (id == null) return;
          if (lineOf[id] !== undefined) { lines.push(lineOf[id]); loading++; }
          if (children[id]) walk(children[id]);
        });
      })(children[''].slice(flushAt));
      return { text: lines.length ? lines.join('\r\n') + '\r\n' : '', rows: rows + loading };
    }

    // Writes everything so far to a file in Downloads. Without store it has to
    // run inside a click (see saveFile).
    function save(filename) {
      var t = tail();
      if (!store) {
        saveFile(filename, [CSV_HEADER].concat(parts, t.text ? [t.text] : []), 'text/csv;charset=utf-8');
        return Promise.resolve({ ok: true, rows: t.rows });
      }
      return writes.then(function () {
        // After a failed save of progress, only what's stored is whole.
        var extra = !broken && t.text ? [{ order: nextOrder, text: t.text }] : [];
        return store.save(filename, extra);
      }).then(function (res) {
        return { ok: !!(res && res.ok), rows: broken ? rows : t.rows, error: res && res.error };
      });
    }

    function once(fn) {
      return function () {
        if (!running) running = fn().finally(function () { running = null; });
        return running;
      };
    }
    return {
      run: once(read),
      update: once(readUpdate),
      stop: function () { stopped = true; wake(); },
      save: save,
      finished: function () { return finished; },
      setGentle: function (g) { gentle = !!g; } // takes effect from the next run
    };
  }

  // Where chunks go in the saved file: the first export's from MAIN_ORDER up,
  // each update's just below the one before, so newer comments come first.
  var MAIN_ORDER = 1e9, BATCH_SPAN = 1e5;
  var FIRST_IDS = 200, LAST_IDS = 200;
  var CHECKPOINT_MS = 30000; // a long run saves its place at least this often
  // An export that starts by itself reads with fewer helpers and a pause
  // between pages, so a day of browsing doesn't look like a scraper to YouTube.
  var GENTLE_WORKERS = 2, GENTLE_GAP_MS = 400;
  var AUTO_UPDATE_AFTER = 5 * 60000; // a finished export checks for new comments at most this often

  var EXPORT_COLUMNS = ['video_id', 'comment_id', 'parent_id', 'thread_id', 'reply_level', 'author', 'author_channel_id',
    'text', 'likes', 'replies', 'published', 'edited', 'pinned', 'hearted', 'by_creator'];
  // With a byte-order mark first, so Excel reads emoji and accents right.
  var CSV_HEADER = String.fromCharCode(0xFEFF) + EXPORT_COLUMNS.join(',') + '\r\n';

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // Spreadsheets run a cell that starts with one of these as a formula, so a
    // comment like =HYPERLINK(...) stays plain text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvLine(row) {
    return EXPORT_COLUMNS.map(function (k) { return csvCell(row[k]); }).join(',');
  }

  function safeFileName(s) {
    return String(s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  }

  // Must run inside a click: Chrome lets a page save a file without asking
  // only right after the user does something.
  function saveFile(name, content, type) {
    var url = URL.createObjectURL(new Blob(Array.isArray(content) ? content : [content], { type: type }));
    var a = el('a', { href: url, download: name, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // ----------------------------------------------------------------- prompt

  function commentLine(c) {
    var meta = [];
    if (c.creator) meta.push('creator');
    if (c.pinned) meta.push('pinned');
    if (c.hearted) meta.push('hearted by creator');
    if (c.likes) meta.push(c.likes + ' likes');
    if (c.time) meta.push(c.time);
    return c.author + (meta.length ? ' (' + meta.join(', ') + ')' : '') + ': ' + c.text.replace(/\s*\n\s*/g, ' ');
  }

  function buildPrompt(b, question) {
    var d = b.details, L = [];
    L.push('Title: ' + (d.title || '(unknown)'));
    L.push('Channel: ' + (d.channel || '(unknown)') + (d.subscribers ? ' (' + d.subscribers + ')' : ''));
    L.push('URL: ' + d.url);
    if (d.published) L.push('Published: ' + d.published);
    if (d.duration) L.push('Duration: ' + d.duration);
    if (d.views) L.push('Views: ' + d.views);
    if (d.likes) L.push('Likes: ' + d.likes);
    if (d.category) L.push('Category: ' + d.category);
    if (d.tags && d.tags.length) L.push('Tags: ' + d.tags.join(', '));
    if (d.description) { L.push(''); L.push('Description:'); L.push(d.description.trim()); }
    if (d.chapters && d.chapters.list.length) {
      L.push('');
      L.push(d.chapters.auto ? 'Chapters (auto-generated by YouTube):' : 'Chapters:');
      d.chapters.list.forEach(function (c) { L.push(c.time + ' ' + c.title); });
    }
    L.push('');
    if (b.segments && b.segments.length) {
      var kind = describeCaptions(b.segments.captions);
      L.push('Transcript' + (kind ? ' (' + kind + ')' : '') + ':');
      b.segments.forEach(function (s) { L.push('[' + fmtTime(s.start) + '] ' + s.text); });
    } else if (d.liveNow) {
      L.push('Transcript: (not available yet; live streams usually get one after they end)');
    } else {
      L.push('Transcript: (not available' + (b.transcriptError ? ': ' + b.transcriptError.replace(/\.$/, '') : '') + ')');
    }
    var cm = b.comments;
    if (cm && cm.list.length) {
      L.push('');
      L.push('YouTube comments (' + cm.list.length + ' comments, ' + cm.replies + ' replies, top first' +
        (cm.partial ? '; some failed to load' : '') + '):');
      cm.list.forEach(function (c, i) {
        L.push((i + 1) + '. ' + commentLine(c));
        c.replies.forEach(function (r) { L.push((r.level > 1 ? '      > ' : '   > ') + commentLine(r)); });
      });
    } else if (cm && cm.off) {
      L.push('');
      L.push('YouTube comments: turned off for this video.');
    } else if (cm && cm.none && d.liveNow) {
      L.push('');
      L.push("YouTube comments: none (this is a live stream; its live chat isn't included).");
    } else if (b.commentsError) {
      L.push('');
      L.push('YouTube comments: (not available: ' + b.commentsError.replace(/\.$/, '') + ')');
    }
    if (question && question.trim()) { L.push(''); L.push('Instruction: ' + question.trim()); }
    return L.join('\n');
  }

  // ------------------------------------------------------------------- look
  //
  // Built from YouTube's own colour variables, so it matches the page in
  // light and dark mode.

  var CSS = [
    '#scribe-pill,#scribe-panel,#scribe-shorts{',
    '--sc-chip:var(--yt-spec-badge-chip-background,rgba(255,255,255,.1));',
    '--sc-chip-hover:var(--yt-spec-button-chip-background-hover,rgba(255,255,255,.2));',
    '--sc-text:var(--yt-spec-text-primary,#f1f1f1);',
    '--sc-text2:var(--yt-spec-text-secondary,#aaa);',
    '--sc-line:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1));',
    '--sc-base:var(--yt-spec-base-background,#0f0f0f);',
    '--sc-accent:var(--yt-spec-call-to-action,#3ea6ff);',
    '--sc-ok:#2ba640;--sc-bad:#e5484d;--sc-ease:cubic-bezier(.2,.8,.2,1)}',

    '#scribe-pill{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;align-self:center;width:max-content;height:36px;padding:0 10px 0 16px;margin-left:8px;border-radius:18px;background:var(--sc-chip);color:var(--sc-text);font:500 14px/36px "Roboto","Arial",sans-serif;white-space:nowrap;cursor:pointer;user-select:none;flex:none;transition:background-color .15s,transform .1s}',
    '#scribe-pill:hover{background:var(--sc-chip-hover)}',
    // The button in a Short's action column, sized like YouTube's own there.
    '#scribe-shorts{display:flex;flex-direction:column;align-items:center;gap:6px;margin:0 0 16px}',
    '#scribe-shorts button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:var(--sc-chip);color:var(--sc-text);cursor:pointer;transition:background-color .15s,transform .1s}',
    '#scribe-shorts button:hover{background:var(--sc-chip-hover)}',
    '#scribe-shorts button:active{transform:scale(.95)}',
    '#scribe-shorts button:focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px}',
    '#scribe-shorts span{font:400 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text);text-align:center}',
    '#scribe-pill:active{transform:scale(.97)}',
    '#scribe-pill:focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px}',
    '#scribe-pill svg{margin-left:4px;transition:transform .25s var(--sc-ease)}',
    '#scribe-pill[aria-expanded="true"] svg{transform:rotate(180deg)}',

    '#scribe-panel{display:grid;grid-template-rows:0fr;margin-top:0;transition:grid-template-rows .3s var(--sc-ease),margin-top .3s var(--sc-ease)}',
    '#scribe-panel.sc-open{grid-template-rows:1fr;margin-top:12px}',
    '#scribe-panel .sc-clip{min-height:0;overflow:hidden}',
    '#scribe-panel .sc-card{box-sizing:border-box;padding:12px;border-radius:12px;background:var(--sc-chip);color:var(--sc-text);font:400 14px/20px "Roboto","Arial",sans-serif;opacity:0;transform:translateY(-6px);transition:opacity .2s ease,transform .3s var(--sc-ease)}',
    '#scribe-panel.sc-open .sc-card{opacity:1;transform:none}',
    '#scribe-panel .sc-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin:0 4px 12px}',
    '#scribe-panel .sc-name{font-weight:500}',
    '#scribe-panel .sc-steps{display:flex;flex-wrap:wrap;gap:4px 14px}',
    '#scribe-panel .sc-step{all:unset;display:inline-flex;align-items:center;gap:6px;font:400 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text2);cursor:default}',
    '#scribe-panel .sc-step[data-state="fail"]{color:var(--sc-bad);cursor:pointer}',
    '#scribe-panel .sc-step[data-state="fail"]:hover .sc-label{text-decoration:underline}',
    '#scribe-panel .sc-step:focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px;border-radius:4px}',
    '#scribe-panel .sc-mark{display:inline-grid;place-items:center;width:14px;height:14px;flex:none}',
    '#scribe-panel .sc-step[data-state="done"] .sc-mark{color:var(--sc-ok)}',
    '#scribe-panel .sc-step[data-state="idle"] .sc-mark::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--sc-line)}',
    '#scribe-panel .sc-spin{box-sizing:border-box;width:12px;height:12px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;animation:sc-spin .7s linear infinite}',
    '#scribe-panel .sc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '#scribe-panel .sc-ask{box-sizing:border-box;flex:1 1 240px;min-width:0;height:36px;margin:0;padding:0 14px;border:1px solid var(--sc-line);border-radius:18px;background:var(--sc-base);color:var(--sc-text);font:400 14px "Roboto","Arial",sans-serif;outline:none;transition:border-color .15s}',
    '#scribe-panel .sc-ask::placeholder{color:var(--sc-text2);opacity:1}',
    '#scribe-panel .sc-ask:focus{border-color:var(--sc-accent)}',
    '#scribe-panel .sc-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 16px 0 12px;border-radius:18px;font:500 14px/36px "Roboto","Arial",sans-serif;white-space:nowrap;cursor:pointer;transition:background-color .15s,opacity .15s,transform .1s}',
    '#scribe-panel .sc-btn:active{transform:scale(.97)}',
    '#scribe-panel .sc-btn:focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px}',
    '#scribe-panel .sc-btn[data-state="busy"]{cursor:progress}',
    '#scribe-panel .sc-ic{display:inline-grid;place-items:center;width:18px;height:18px;flex:none}',
    '#scribe-panel .sc-primary{background:var(--sc-text);color:var(--sc-base)}',
    '#scribe-panel .sc-primary:hover{opacity:.85}',
    '#scribe-panel .sc-tonal{background:color-mix(in srgb,var(--sc-text) 10%,transparent);color:var(--sc-text)}',
    '#scribe-panel .sc-tonal:hover{background:color-mix(in srgb,var(--sc-text) 18%,transparent)}',
    '#scribe-panel .sc-note{margin:10px 4px 0;font:400 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text2)}',
    '#scribe-panel .sc-note:empty{display:none}',
    '#scribe-panel .sc-note.sc-bad{color:var(--sc-bad)}',
    '#scribe-panel [hidden]{display:none!important}',
    '#scribe-panel .sc-pop{animation:sc-pop .25s var(--sc-ease)}',
    '#scribe-panel .sc-auto{all:unset;margin-left:auto;font:400 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text2);cursor:pointer;padding:2px 6px;border-radius:8px}',
    '#scribe-panel .sc-auto:hover{background:color-mix(in srgb,var(--sc-text) 10%,transparent)}',
    '#scribe-panel .sc-auto:focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px}',
    '#scribe-panel .sc-btn[aria-pressed="true"]{background:color-mix(in srgb,var(--sc-text) 22%,transparent)}',
    '#scribe-panel .sc-cut{margin-top:12px;padding-top:12px;border-top:1px solid var(--sc-line)}',
    '#scribe-panel .sc-cut>.sc-row+.sc-row{margin-top:8px}',
    '#scribe-panel .sc-mini{gap:0;padding:0 8px}',
    '#scribe-panel .sc-time{flex:0 0 112px;padding:0 10px;text-align:center;font-variant-numeric:tabular-nums}',
    '#scribe-panel .sc-partname{font:500 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text2);margin:0 2px}',
    '#scribe-panel .sc-cliplen{flex:1 1 auto;margin:0 4px;font:400 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text2);font-variant-numeric:tabular-nums}',
    '#scribe-panel .sc-clipresult{margin-top:10px;align-items:flex-end}',
    '#scribe-panel .sc-clipvid{display:block;width:320px;max-width:100%;border-radius:8px;background:#000}',
    // The bar: the whole video, a part per pair of needles, the playhead.
    '#scribe-panel .sc-bar{position:relative;height:48px;margin:8px 7px 14px;border-radius:6px;background:var(--sc-base);cursor:pointer;user-select:none;touch-action:none}',
    '#scribe-panel .sc-strip{position:absolute;inset:0;display:flex;overflow:hidden;border-radius:6px;opacity:.5}',
    '#scribe-panel .sc-tile{flex:none;height:100%;background-repeat:no-repeat}',
    '#scribe-panel .sc-parts{position:absolute;inset:0}',
    '#scribe-panel .sc-part{position:absolute;top:0;bottom:0;border-radius:3px;background:color-mix(in srgb,var(--sc-accent) 22%,transparent);box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--sc-accent) 55%,transparent)}',
    '#scribe-panel .sc-part.sc-sel{background:color-mix(in srgb,var(--sc-accent) 32%,transparent);box-shadow:inset 0 0 0 2px var(--sc-accent)}',
    '#scribe-panel .sc-needle{position:absolute;top:-7px;bottom:-7px;width:16px;margin-left:-8px;cursor:ew-resize;outline:none;z-index:1}',
    '#scribe-panel .sc-needle[data-edge="from"]{left:0}',
    '#scribe-panel .sc-needle[data-edge="to"]{left:100%}',
    '#scribe-panel .sc-needle::before{content:"";position:absolute;left:7px;top:6px;bottom:0;width:2px;background:var(--sc-accent)}',
    '#scribe-panel .sc-needle::after{content:"";position:absolute;left:2px;top:0;width:12px;height:12px;border-radius:50%;background:var(--sc-accent)}',
    '#scribe-panel .sc-needle:focus-visible::after{box-shadow:0 0 0 2px var(--sc-text)}',
    '#scribe-panel .sc-peek{position:fixed;z-index:2300;padding:4px;border-radius:8px;background:var(--sc-base);box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none;text-align:center}',
    '#scribe-panel .sc-peek-img{border-radius:4px;background-color:#000;background-repeat:no-repeat}',
    '#scribe-panel .sc-peek-time{margin-top:3px;font:500 12px/16px "Roboto","Arial",sans-serif;color:var(--sc-text);font-variant-numeric:tabular-nums}',
    '#scribe-panel .sc-playhead{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:var(--sc-text);pointer-events:none;z-index:2}',
    '@keyframes sc-spin{to{transform:rotate(360deg)}}',
    '@keyframes sc-pop{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}',
    '@media (prefers-reduced-motion:reduce){#scribe-panel,#scribe-panel .sc-card,#scribe-pill,#scribe-pill svg{transition:none}#scribe-panel .sc-pop{animation:none}}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('scribe-styles')) return;
    (document.head || document.documentElement).appendChild(el('style', { id: 'scribe-styles', text: CSS }));
  }

  // ------------------------------------------------------------------ panel

  var ASK_KEY = 'scribe.question';
  function loadQuestion() { try { return localStorage.getItem(ASK_KEY) || ''; } catch (e) { return ''; } }
  function saveQuestion(v) { try { localStorage.setItem(ASK_KEY, v); } catch (e) {} }

  var ui = null; // everything about the video on screen

  function freshState(videoId) {
    return {
      videoId: videoId, open: false, panel: null, refs: null,
      transcript: { state: 'idle' }, details: { state: 'idle' }, comments: { state: 'idle' },
      copy: 'idle', send: 'idle', copyBusy: false, sendBusy: false,
      exportState: 'idle', exportJob: null, exportCount: 0, exportTotal: 0, exportTarget: 0,
      exportStopping: false, exportWritten: 0, exportRunStart: 0, exportBase: 0,
      exportMode: 'run', exportSaved: null, storeOk: null, overArmed: false,
      savedAsking: false, savedTries: 0, autoTried: false, exportAuto: false,
      clipOpen: false, clipParts: [], clipSel: 0, clipSnap: null, clipDrag: null, clipJob: null, clipStatus: '',
      clipNote: '', clipBad: false, clipResult: null,
      note: '', noteBad: false, lastCopyChars: 0
    };
  }

  var numbers = new Intl.NumberFormat('en');
  function fmtNumber(n) { return numbers.format(n || 0); }

  function pop(node) {
    node.classList.remove('sc-pop');
    void node.offsetWidth;
    node.classList.add('sc-pop');
  }

  function makeStep(label, onRetry) {
    var mark = el('span', { class: 'sc-mark' });
    var name = el('span', { class: 'sc-label', text: label });
    var node = el('button', { class: 'sc-step', type: 'button', 'data-state': 'idle', tabindex: '-1' }, [mark, name]);
    node.addEventListener('click', function () { if (node.getAttribute('data-state') === 'fail') onRetry(); });
    return { node: node, mark: mark, name: name };
  }

  function setStep(s, state, label, title) {
    if (s.node.getAttribute('data-state') !== state) {
      s.node.setAttribute('data-state', state);
      s.mark.textContent = '';
      if (state === 'loading') s.mark.appendChild(el('span', { class: 'sc-spin' }));
      else if (state === 'done') { s.mark.appendChild(icon('check', 14)); pop(s.mark); }
      else if (state === 'fail') s.mark.appendChild(icon('cross', 14));
      else if (state === 'skip') s.mark.appendChild(icon('dash', 14));
    }
    s.name.textContent = label;
    s.node.title = title || '';
    s.node.tabIndex = state === 'fail' ? 0 : -1;
  }

  function makeButton(kind, iconName, label, title, onClick) {
    var ic = el('span', { class: 'sc-ic' }, [icon(iconName, 18)]);
    var lb = el('span', { text: label });
    var node = el('button', { class: 'sc-btn ' + kind, type: 'button', title: title, 'data-state': 'idle' }, [ic, lb]);
    node.addEventListener('click', onClick);
    return { node: node, ic: ic, lb: lb, iconName: iconName };
  }

  function setButton(b, state, label) {
    var changed = b.node.getAttribute('data-state') !== state;
    b.node.setAttribute('data-state', state);
    b.lb.textContent = label;
    if (!changed) return;
    b.ic.textContent = '';
    if (state === 'busy') b.ic.appendChild(el('span', { class: 'sc-spin' }));
    else if (state === 'done') { b.ic.appendChild(icon('check', 18)); pop(b.ic); }
    else b.ic.appendChild(icon(b.iconName, 18));
  }

  function buildPanel() {
    var stepT = makeStep('Transcript', function () { loadTranscript(true); });
    var stepD = makeStep('Details', function () { loadDetails(); });
    var stepC = makeStep('Comments', function () { loadComments(true); });

    // The unpacked copy mostly sends to Claude; the store copy mostly copies,
    // into whichever AI people use.
    var mine = BUILD === 'dev';
    var ask = el('input', {
      class: 'sc-ask', type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: mine ? 'Question for Claude (optional)' : 'Add a question (optional)',
      'aria-label': mine ? 'Question for Claude' : 'Question'
    });
    ask.value = loadQuestion();
    ask.addEventListener('input', function () { saveQuestion(ask.value); });
    // Keep YouTube's keyboard shortcuts (k, j, l, f, m, numbers...) out of the text box.
    ['keydown', 'keyup', 'keypress'].forEach(function (t) {
      ask.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    ask.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!e.repeat) (mine ? doSend : doCopy)(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeToPill(); }
    });

    var copy = makeButton('sc-primary', 'copy', 'Copy', 'Copy the details, transcript and comments', doCopy);
    var exp = makeButton('sc-tonal', 'download', 'Export comments', '', doExport);
    var stop = makeButton('sc-tonal', 'stop', 'Stop', 'Pause here: save what has loaded, and carry on later if you like', stopExport);
    stop.node.hidden = true;
    var cont = makeButton('sc-tonal', 'play', 'Continue', 'Carry on from where it stopped', continueExport);
    cont.node.hidden = true;
    var auto = el('button', { class: 'sc-auto', type: 'button', onclick: toggleAuto });
    var upd = makeButton('sc-tonal', 'refresh', 'Update', 'Add the comments posted since, at the top', updateExport);
    upd.node.hidden = true;
    var over = makeButton('sc-tonal', 'trash', 'Start over', 'Delete the saved export of this video', startOver);
    over.node.hidden = true;
    var send = makeButton('sc-tonal', 'send', 'Send to Claude', "Open Claude in Chrome's side panel and send it everything", doSend);
    var clip = CLIPS ? makeButton('sc-tonal', 'movie', 'Clip', 'Cut a part of this video, frame by frame, into a video file', toggleClip) : null;
    var clipRow = CLIPS ? buildClipRow() : null;
    var note = el('div', { class: 'sc-note', role: 'status', 'aria-live': 'polite' });

    var card = el('div', { class: 'sc-card' }, [
      el('div', { class: 'sc-head' }, [
        el('span', { class: 'sc-name', text: BRAND }),
        el('div', { class: 'sc-steps' }, [stepT.node, stepD.node, stepC.node]),
        auto
      ]),
      el('div', { class: 'sc-row' }, [ask, copy.node, exp.node, stop.node, cont.node, upd.node, over.node, send && send.node, clip && clip.node]),
      note,
      clipRow && clipRow.node
    ]);
    var panel = el('div', { id: 'scribe-panel', role: 'region', 'aria-label': BRAND }, [
      el('div', { class: 'sc-clip' }, [card])
    ]);
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeToPill();
    });

    ui.panel = panel;
    ui.refs = {
      stepT: stepT, stepD: stepD, stepC: stepC, ask: ask, copy: copy, exp: exp, stop: stop, cont: cont, upd: upd, over: over, auto: auto,
      send: send, clip: clip, clipRow: clipRow, note: note
    };
  }

  // Full-width band under the action buttons, above the description. The
  // description sits inside a flex row, so go in before the top-level
  // #above-the-fold child that holds it (not before the description itself,
  // which would squeeze the panel in beside it).
  function placePanel(panel) {
    var meta = document.querySelector('ytd-watch-metadata');
    var fold = meta && meta.querySelector('#above-the-fold');
    var desc = meta && meta.querySelector('#description');
    if (fold && desc && fold.contains(desc)) {
      var child = desc;
      while (child.parentElement && child.parentElement !== fold) child = child.parentElement;
      if (child.parentElement === fold) {
        if (panel.parentNode !== fold || panel.nextSibling !== child) fold.insertBefore(panel, child);
        return true;
      }
    }
    if (fold) { if (panel.parentNode !== fold) fold.appendChild(panel); return true; }
    if (meta && meta.parentNode) {
      if (panel.previousSibling !== meta) meta.parentNode.insertBefore(panel, meta.nextSibling);
      return true;
    }
    return false;
  }

  function render() {
    if (!ui || !ui.refs) return;
    var r = ui.refs, t = ui.transcript, d = ui.details, c = ui.comments;

    if (t.state === 'loading') {
      if (t.ad) setStep(r.stepT, 'loading', 'Waiting for the ad', BRAND + ' grabs the captions once the ad ends.');
      else if (t.slow) setStep(r.stepT, 'loading', 'Waiting on YouTube', 'YouTube is taking a while to send the captions.');
      else setStep(r.stepT, 'loading', 'Transcript', 'Getting the captions');
    } else if (t.state === 'done') {
      setStep(r.stepT, 'done', 'Transcript', 'Ready');
    } else if (t.state === 'fail' && t.code === 'no-captions' && d.liveNow) {
      setStep(r.stepT, 'skip', 'No captions yet', 'Live streams usually get a transcript after they end.');
    } else if (t.state === 'fail' && t.code === 'no-captions') {
      setStep(r.stepT, 'skip', 'No captions', 'This video has no captions, so there is no transcript to copy.');
    } else if (t.state === 'fail') {
      setStep(r.stepT, 'fail', 'Transcript failed', t.error + ' Click to try again.');
    } else {
      setStep(r.stepT, 'idle', 'Transcript', '');
    }

    if (d.state === 'loading') setStep(r.stepD, 'loading', 'Details', 'Reading the title, views, date and chapters');
    else if (d.state === 'done') setStep(r.stepD, 'done', 'Details', 'Ready');
    else if (d.state === 'fail') setStep(r.stepD, 'fail', 'Details failed', d.error + ' Click to try again.');
    else setStep(r.stepD, 'idle', 'Details', '');

    if (c.state === 'loading') {
      setStep(r.stepC, 'loading', 'Comments', c.page ? 'Reading page ' + c.page : 'Getting the comments');
    } else if (c.state === 'done') {
      setStep(r.stepC, 'done', 'Comments', 'Ready');
    } else if (c.state === 'partial') {
      setStep(r.stepC, 'fail', 'Some comments missing', 'YouTube stopped answering partway. Click to try again.');
    } else if (c.state === 'none' && d.liveNow) {
      setStep(r.stepC, 'skip', 'Live chat', 'Live streams have live chat instead of comments. ' + BRAND + " doesn't copy live chat.");
    } else if (c.state === 'none') {
      setStep(r.stepC, 'skip', 'No comments', 'This page has no comments section.');
    } else if (c.state === 'off') {
      setStep(r.stepC, 'skip', 'Comments off', 'Comments are turned off for this video.');
    } else if (c.state === 'fail') {
      setStep(r.stepC, 'fail', 'Comments failed', c.error + ' Click to try again.');
    } else {
      setStep(r.stepC, 'idle', 'Comments', '');
    }

    setButton(r.copy, ui.copy, { idle: 'Copy', busy: 'Copying…', done: 'Copied', fail: 'Copy failed' }[ui.copy]);
    if (r.send) setButton(r.send, ui.send, { idle: 'Send to Claude', busy: 'Sending…', done: 'Opened in Claude', fail: "Didn't send" }[ui.send]);

    // Paused looks like ready: either way, the button saves what has loaded.
    var ex = ui.exportState === 'paused' ? 'ready' : ui.exportState, n = ui.exportCount;
    setButton(r.exp, ex, {
      idle: 'Export comments',
      busy: ui.exportMode === 'update' ? 'Checking for new comments…' : 'Exporting… ' + fmtNumber(n) + (ui.exportTarget ? ' of ' + fmtNumber(ui.exportTarget) : ''),
      ready: 'Save spreadsheet',
      done: 'Saved',
      fail: 'Export failed'
    }[ex]);
    r.exp.node.title = ex === 'busy' ? "Click to stop and keep what's loaded"
      : ex === 'ready' ? 'Download the comments as a CSV file (opens in Excel or Google Sheets)'
      : 'Every comment and reply on this video, as a spreadsheet';
    r.stop.node.hidden = ex !== 'busy';
    setButton(r.stop, ui.exportStopping ? 'busy' : 'idle', ui.exportStopping ? 'Stopping…' : 'Stop');
    r.cont.node.hidden = ui.exportState !== 'paused';
    r.auto.textContent = autoOn() ? 'Saves comments by itself: on' : 'Saves comments by itself: off';
    r.auto.title = autoOn()
      ? 'Comments start saving as soon as a video opens, and saved ones pick up new comments. Click to turn off.'
      : 'Click to save comments as soon as a video opens, and keep saved ones up to date.';
    r.upd.node.hidden = !(ui.exportState === 'ready' && ui.storeOk && ui.exportSaved && ui.exportSaved.finished);
    r.over.node.hidden = ui.exportState !== 'ready' && ui.exportState !== 'paused';
    setButton(r.over, 'idle', ui.overArmed ? 'Sure? Click again' : 'Start over');

    r.note.textContent = ui.note;
    r.note.classList.toggle('sc-bad', !!ui.noteBad);
    renderClip(r);
  }

  function setNote(message, bad) {
    if (!ui) return;
    ui.note = message || '';
    ui.noteBad = !!bad;
    render();
  }

  // ------------------------------------------------------------------ loading

  function loadTranscript(retry) {
    var st = ui;
    if (!st || (!retry && st.transcript.state !== 'idle' && st.transcript.state !== 'fail')) return;
    st.transcript = { state: 'loading' };
    render();
    getTranscript(st.videoId, function (s) {
      if (ui === st && st.transcript.state === 'loading') {
        st.transcript.ad = s === 'ad';
        st.transcript.slow = s === 'slow';
        render();
      }
    }).then(function (segs) {
      if (ui !== st) return;
      st.transcript = { state: 'done', lines: segs.length };
      render();
    }, function (e) {
      if (ui !== st || e.code === 'moved') return;
      st.transcript = { state: 'fail', error: e.message, code: e.code };
      render();
    });
  }

  function loadDetails() {
    var st = ui;
    if (!st || st.details.state === 'loading' || st.details.state === 'done') return;
    st.details = { state: 'loading' };
    render();
    waitForDetails(st.videoId).then(function (det) {
      if (ui !== st) return;
      st.details = det.ready
        ? { state: 'done', liveNow: det.liveNow }
        : { state: 'fail', liveNow: det.liveNow, error: "YouTube hadn't finished loading this video." };
      render();
    });
  }

  function loadComments(retry) {
    var st = ui;
    if (!st || (!retry && st.comments.state !== 'idle' && st.comments.state !== 'fail')) return;
    st.comments = { state: 'loading', page: 0 };
    render();
    getComments(st.videoId, function (page) {
      if (ui === st && st.comments.state === 'loading') { st.comments.page = page; render(); }
    }, retry).then(function (res) {
      if (ui !== st) return;
      st.comments = {
        state: res.off ? 'off' : res.none ? 'none' : res.partial ? 'partial' : 'done',
        count: res.list.length, replies: res.replies
      };
      render();
    }, function (e) {
      if (ui !== st || e.code === 'moved') return;
      st.comments = { state: 'fail', error: plainError(e) };
      render();
    });
  }

  function startLoading() {
    loadTranscript(false);
    loadDetails();
    loadComments(false);
  }

  // Before Copy or Send: try again whatever failed outright. (An incomplete
  // comments set is retried only by clicking it, so Copy stays quick.)
  function retryFailures() {
    if (!ui) return;
    if (ui.transcript.state === 'fail' && ui.transcript.code !== 'no-captions') loadTranscript(true);
    if (ui.details.state === 'fail') loadDetails();
    if (ui.comments.state === 'fail') loadComments(true);
  }

  // Waits for everything that is still loading, then hands back the lot.
  function gatherAll(videoId) {
    var t = getTranscript(videoId).then(function (segs) { return { segs: segs }; }, function (e) { return { error: e }; });
    var c = getComments(videoId, null, false).then(function (res) { return { res: res }; }, function (e) { return { error: e }; });
    return Promise.all([t, c, waitForDetails(videoId)]).then(function (out) {
      var cErr = out[1].error;
      return {
        details: out[2],
        segments: out[0].segs || null,
        transcriptError: out[0].error ? out[0].error.message : '',
        transcriptCode: out[0].error ? out[0].error.code || '' : '',
        comments: out[1].res || null,
        commentsError: cErr && cErr.code !== 'moved' ? plainError(cErr) : ''
      };
    });
  }

  function writeClipboard(value) {
    return navigator.clipboard.writeText(value).then(function () { return true; }, function () {
      try {
        var ta = el('textarea', { readonly: '', style: 'position:fixed;top:-1000px;left:0;opacity:0' });
        ta.value = value;
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    });
  }

  // What the Copy/Send button is still waiting for, in plain words.
  function waitingNote(verb) {
    if (!ui) return '';
    var t = ui.transcript.state === 'loading', c = ui.comments.state === 'loading';
    if (!t && !c) return '';
    return verb + ' as soon as the ' + (t && c ? 'transcript and comments are' : t ? 'transcript is' : 'comments are') + ' ready…';
  }

  // What's missing from the copy or send, in plain words ('' when nothing is).
  function missingNote(bundle, verb) {
    var notes = [];
    if (!bundle.segments) notes.push(verb + ' without a transcript: ' + (bundle.transcriptError || 'none was found.').replace(/\.?$/, '.'));
    if (bundle.commentsError) notes.push((notes.length ? 'Comments' : verb + ' without comments') + ': ' + bundle.commentsError);
    else if (bundle.comments && bundle.comments.partial) notes.push("Some comments didn't load.");
    return notes.join(' ');
  }

  // The page still shows the video this state belongs to. `ui` only switches
  // on the next tick (up to 60 ms after the address changes), so check both.
  function stillOn(st) { return ui === st && currentVideoId() === st.videoId; }

  function doCopy() {
    var st = ui;
    if (!st || st.copyBusy) return;
    st.copyBusy = true;
    retryFailures();
    st.copy = 'busy';
    setNote(waitingNote('Copying'));
    gatherAll(st.videoId).then(function (bundle) {
      if (!stillOn(st)) return null; // moved to another video while waiting
      var value = buildPrompt(bundle, st.refs ? st.refs.ask.value : loadQuestion());
      return writeClipboard(value).then(function (ok) { return { ok: ok, bundle: bundle, chars: value.length }; });
    }).then(function (r) {
      st.copyBusy = false;
      if (!r || ui !== st) return;
      if (r.ok) {
        st.copy = 'done';
        st.lastCopyChars = r.chars;
        var note = missingNote(r.bundle, 'Copied');
        setNote(note, !!note);
      } else {
        st.copy = 'fail';
        setNote('The browser blocked the copy, usually because the page lost focus. Click Copy again.', true);
      }
      setTimeout(function () { if (ui === st && !st.copyBusy) { st.copy = 'idle'; render(); } }, 1800);
    }, function () {
      st.copyBusy = false;
      if (ui !== st) return;
      st.copy = 'fail';
      setNote('Something went wrong. Click Copy again.', true);
    });
  }

  // ------------------------------------------------------------------ clips
  //
  // The clip editor: the whole video as a bar of YouTube's own preview
  // thumbnails, two needles for each part to keep, and + for another part.
  // Make clip joins the parts in time order, with no gap, into one MP4 (H.264
  // + AAC) cut at exact frames: a part starts on the frame on screen at its
  // start needle (the browser reports each frame's own time) and ends on the
  // frame on screen at its end needle, and the sound is cut at the same
  // moments, with a 4 ms fade where parts meet. The whole video as one part is
  // copied as YouTube sent it instead: no re-encoding, full quality, about as
  // fast as YouTube sends it.
  //
  // The media: media-keeper.js keeps a copy of what the player loads (as
  // Blobs, which Chrome keeps on disk when they get big). Gleaner moves the
  // player (paused) through a part so it loads at download speed, and cuts it
  // in windows as they arrive, so the page's memory stays flat however long
  // the clip. The file is written to disk as it's made (the page's private
  // storage), so its size doesn't matter either; Save copies it to Downloads.
  // The cutter (lib/mediabunny.js) goes into the page only when a clip is
  // made. Protected (DRM) video is refused.
  var CLIPS = true; // tools/build-store.js turns this off: the Chrome Web Store bans YouTube downloads
  var CLIP_WINDOW = 60; // seconds loaded and cut at a time
  var AUDIO_BITRATE = 192e3;
  var CLIP_DIR = 'gleaner-clips';

  function mainVideo() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
  }
  function videoLength() { var v = mainVideo(); return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0; }
  // A moment inside the last frame: as far as an end needle goes.
  function lastMoment() { return Math.max(0, videoLength() - 0.001); }

  // What the player is showing, from its own stats: { width, height, fps }.
  function playerFormat() {
    var out = { width: 0, height: 0, fps: 30 };
    try {
      var m = /(\d+)x(\d+)@(\d+(?:\.\d+)?)/.exec(document.getElementById('movie_player').getStatsForNerds().resolution || '');
      if (m) { out.width = +m[1]; out.height = +m[2]; if (+m[3] > 0) out.fps = +m[3]; }
    } catch (e) {}
    return out;
  }
  // YouTube's own name for the quality showing ("1080p60"), which goes by the
  // usual heights even for wide films (2048×872 is "1080p").
  function qualityLabel(f) {
    try {
      var label = document.getElementById('movie_player').getPlaybackQualityLabel();
      if (label && /^\d+p/.test(label)) return label;
    } catch (e) {}
    return f.height ? f.height + 'p' + (f.fps > 30 ? Math.round(f.fps) : '') : '';
  }

  function clipClock(t) {
    var ms = Math.round(Math.max(0, t || 0) * 1000);
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return (h ? h + ':' + pad(m, 2) : m) + ':' + pad(s, 2) + '.' + pad(ms % 1000, 3);
  }
  function parseClipClock(value) {
    var parts = String(value || '').trim().split(':'), t = 0;
    if (!parts[0] || parts.length > 3) return null;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+(\.\d*)?$/.test(parts[i])) return null;
      t = t * 60 + parseFloat(parts[i]);
    }
    return t;
  }
  function lengthWords(sec) {
    sec = Math.max(1, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? h + ' h ' + m + ' min' : m ? m + ' min' + (s ? ' ' + s + ' s' : '') : s + ' s';
  }
  function secsWords(sec) { return sec < 60 ? (Math.round(sec * 1000) / 1000) + ' s' : lengthWords(sec); }
  function sizeWords(bytes) { return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(1) + ' GB' : Math.max(0.1, bytes / 1048576).toFixed(1) + ' MB'; }

  function selectedPart(st) { return st.clipParts[st.clipSel] || st.clipParts[0] || null; }
  function partsInOrder(st) {
    return st.clipParts.map(function (p) { return { from: p.from, to: p.to }; }).sort(function (a, b) { return a.from - b.from; });
  }
  function isWhole(st, fps) {
    var d = videoLength(), p = st.clipParts[0];
    return !!d && st.clipParts.length === 1 && p.from <= 0.5 / fps && p.to >= d - 1.5 / fps;
  }

  // The time of the frame on screen. The browser says which frame it showed
  // (requestVideoFrameCallback), which is exact; while playing, or before it
  // has said, the player's clock stands in.
  var shown = { video: null, time: -1 }, frameWatch = null, timed = new WeakSet();
  function watchFrames() {
    var v = mainVideo();
    if (!v || !v.requestVideoFrameCallback || (frameWatch && frameWatch.video === v)) return;
    frameWatch = { video: v };
    if (!timed.has(v)) {
      timed.add(v);
      v.addEventListener('timeupdate', movePlayhead);
      v.addEventListener('seeking', movePlayhead);
    }
    v.requestVideoFrameCallback(function (now, meta) {
      frameWatch = null;
      shown = { video: v, time: meta.mediaTime };
      var st = ui;
      if (!st || !st.clipOpen) return;
      var snap = st.clipSnap, p = snap && st.clipParts[snap.part];
      if (p && !st.clipDrag) {
        // A needle was placed: settle it on that frame's own time.
        p[snap.edge] = meta.mediaTime;
        if (p.to < p.from) { var t = p.to; p.to = p.from; p.from = t; }
        st.clipSnap = null;
        render();
      } else {
        movePlayhead();
      }
      watchFrames();
    });
  }
  function frameNow() {
    var v = mainVideo();
    if (!v) return null;
    if (shown.video === v && v.paused && Math.abs(v.currentTime - shown.time) < 0.25) return shown.time;
    return v.currentTime;
  }
  function movePlayhead() {
    var c = ui && ui.clipOpen && ui.refs && ui.refs.clipRow, v = mainVideo(), d = videoLength();
    if (!c || !v || !d) return;
    c.playhead.style.left = Math.min(100, v.currentTime / d * 100) + '%';
  }
  function showMoment(t, pause) {
    var v = mainVideo();
    if (!v) return;
    if (pause && !v.paused) v.pause();
    v.currentTime = Math.max(0, Math.min(lastMoment() || t, t));
  }

  var engineLoading = null;
  function clipEngine() {
    if (window.Mediabunny) return Promise.resolve(window.Mediabunny);
    if (!engineLoading) {
      engineLoading = new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { finish({ ok: false, error: 'no answer' }); }, 20000);
        function finish(res) {
          clearTimeout(timer);
          window.removeEventListener('scribe:clip-engine-result', onResult);
          engineLoading = null;
          if (res && res.ok && window.Mediabunny) resolve(window.Mediabunny);
          else reject(failure(BRAND + " couldn't load its clip cutter" + (res && res.error ? ' (' + res.error + ')' : '') + '. Refresh the page and try again.'));
        }
        function onResult(e) { var res = null; try { res = JSON.parse(e.detail); } catch (err) {} finish(res); }
        window.addEventListener('scribe:clip-engine-result', onResult);
        window.dispatchEvent(new CustomEvent('scribe:clip-engine'));
      });
    }
    return engineLoading;
  }

  function stopIfAsked(job) {
    if (job.cancelled) throw failure('Stopped.', 'stopped');
    if (currentVideoId() !== job.videoId) throw failure('moved', 'moved');
  }

  // Moves the player for a clip, and puts it back where it was after.
  function playerSession(job) {
    var v = mainVideo(), player = document.getElementById('movie_player');
    var wasPaused = v.paused, wasAt = v.currentTime, moved = false;
    return {
      video: v,
      seek: function (t) {
        moved = true;
        if (!v.paused) v.pause();
        if (player && player.seekTo) player.seekTo(t, true); else v.currentTime = t;
      },
      restore: function () {
        if (!moved || currentVideoId() !== job.videoId) return;
        moved = false;
        if (player && player.seekTo) player.seekTo(wasAt, true); else v.currentTime = wasAt;
        if (wasPaused) v.pause(); else v.play().catch(function () {});
      }
    };
  }

  // Makes the player load [start, end) until the media keeper holds all of
  // it: the player is moved to the first moment that's missing whenever its
  // own reading ahead is about done there, or loading stalls.
  async function loadRange(session, start, end, onProgress, job) {
    var media = window.__gleanerMedia, v = session.video, d = videoLength();
    if (d) end = Math.min(end, d - 0.05); // the streams can stop a hair before the stated length
    start = Math.min(start, end);
    var sound = media.has('audio', v);
    var best = -1, gainAt = Date.now(), seekAt = 0, losses = 0;
    for (;;) {
      stopIfAsked(job);
      var now = Date.now();
      if (isAdPlaying()) { gainAt = now; best = -1; seekAt = 0; await sleep(500); continue; }
      var pv = media.pick('video', start, end, v), pa = sound ? media.pick('audio', start, end, v) : {};
      if (!pv.missing && !pa.missing) return { video: pv, audio: sound ? pa : null };
      var front = Math.min(pv.missing ? pv.missing[0][0] : end, pa.missing ? pa.missing[0][0] : end);
      if (onProgress) onProgress(Math.max(0, Math.min(1, (front - start) / Math.max(0.001, end - start))));
      if (front > best + 0.01) {
        best = front;
        gainAt = now;
      } else if (front < best - 0.5) {
        // Pieces it had were let go (YouTube restarted its player, say).
        if (++losses > 3) throw failure('YouTube kept dropping that part. Try again.');
        best = front;
        gainAt = now;
      }
      if (now - gainAt > 20000) throw failure("YouTube didn't send that part of the video. Refresh the page and try again.");
      if (!seekAt || (front - v.currentTime > 15 && now - seekAt > 500) || (now - gainAt > 1000 && now - seekAt > 1000)) {
        session.seek(front);
        seekAt = now;
      }
      await sleep(150);
    }
  }

  // The finished file is written to the page's private storage (OPFS) as it's
  // made; Save copies it to Downloads.
  async function clipFile(ext) {
    var root = await navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(CLIP_DIR, { create: true });
    // Clips left from earlier visits (a day old or more) go.
    try {
      for await (var entry of dir.values()) {
        if (entry.kind !== 'file') continue;
        var f = await entry.getFile();
        if (Date.now() - f.lastModified > 864e5) await dir.removeEntry(entry.name);
      }
    } catch (e) {}
    var name = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    var handle = await dir.getFileHandle(name, { create: true });
    return { name: name, handle: handle, writable: await handle.createWritable() };
  }
  function removeClipFile(name) {
    if (!name) return;
    navigator.storage.getDirectory()
      .then(function (root) { return root.getDirectoryHandle(CLIP_DIR); })
      .then(function (dir) { return dir.removeEntry(name); })
      .catch(function () {});
  }
  async function roomFor(bytes) {
    var e = null;
    try { e = await navigator.storage.estimate(); } catch (err) {}
    if (e && e.quota && e.quota - (e.usage || 0) < bytes * 1.1) {
      throw failure("There isn't enough free disk space for this: it needs about " + sizeWords(bytes) + '.');
    }
  }

  // The frames from a to b seconds into a sound packet, faded in or out over
  // 4 ms where parts are joined (a hard cut can click).
  function audioPiece(MB, s, a, b, fadeIn, fadeOut) {
    var sr = s.sampleRate, ch = s.numberOfChannels;
    var off = Math.max(0, Math.min(s.numberOfFrames, Math.round(a * sr)));
    var n = Math.max(0, Math.min(s.numberOfFrames, Math.round(b * sr)) - off);
    if (!n) return null;
    var data = new Float32Array(n * ch), ramp = Math.min(n, Math.round(sr * 0.004));
    for (var c = 0; c < ch; c++) {
      var plane = data.subarray(c * n, (c + 1) * n);
      s.copyTo(plane, { planeIndex: c, format: 'f32-planar', frameOffset: off, frameCount: n });
      for (var i = 0; i < ramp; i++) {
        var g = (i + 0.5) / ramp;
        if (fadeIn) plane[i] *= g;
        if (fadeOut) plane[n - 1 - i] *= g;
      }
    }
    return new MB.AudioSample({ data: data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: s.timestamp + off / sr });
  }

  function openTrack(MB, inputs, blob, kind) {
    var input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    inputs.push(input);
    return (kind === 'video' ? input.getPrimaryVideoTrack() : input.getPrimaryAudioTrack()).then(function (track) {
      if (!track) throw failure('The ' + kind + " YouTube sent couldn't be read.");
      return track;
    });
  }
  function disposeAll(inputs) { inputs.splice(0).forEach(function (i) { try { i.dispose(); } catch (e) {} }); }

  // Cuts the parts (in time order) at exact frames and encodes them, joined
  // with no gap, into one MP4 (H.264 + AAC). For speed (measured 15 Oct 2026
  // on 1080p60): frames are decoded on the CPU, because handing GPU-decoded
  // frames to the encoder held everything to about 75 a second, and encoded
  // on the GPU, ENCODERS windows at once, each by its own encoder (75 → about
  // 586 a second). The windows are written in order; the sound goes through
  // one encoder, in order, since separate sound encoders would leave clicks
  // where they meet.
  var ENCODERS = 3, ENCODE_WINDOW = 30; // windows at once; seconds each

  // H.264 High profile at the level the size and frame rate need.
  function avcCodec(w, h, fps) {
    var mbs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = mbs * fps;
    var level = mbs <= 8704 && rate <= 522240 ? '2A' : mbs <= 36864 && rate <= 983040 ? '33' : mbs <= 36864 && rate <= 2073600 ? '34' : '3C';
    return 'avc1.6400' + level;
  }

  async function encodeParts(MB, parts, fmt, session, progress, job) {
    var media = window.__gleanerMedia, v = session.video, tol = 1e-4, fd = 1 / fmt.fps;
    // The windows, in order: each part ENCODE_WINDOW seconds at a time.
    var wins = [];
    parts.forEach(function (p, k) {
      for (var s = p.from; ; s += ENCODE_WINDOW) {
        var last = s + ENCODE_WINDOW >= p.to + fd;
        wins.push({ part: k, start: s, end: last ? p.to + fd : s + ENCODE_WINDOW, first: s === p.from, last: last, made: 0 });
        if (last) break;
      }
    });
    var total = 0;
    wins.forEach(function (w) { total += w.end - w.start; });
    var A = [], L = [], E = [];          // per part: first frame, last frame, end of the last frame
    var file = null, out = null, vSrc = null, aSrc = null, firstConfig = null, encConfig = null, settingUp = null;
    var W = 0, H = 0, frames = 0, base = 0, aAt = 0, written = 0, halted = null;
    var running = 0, waiting = [];

    function report() {
      var made = 0;
      wins.forEach(function (w) { made += w.made; });
      progress('Cutting', made / total);
    }
    function check() {
      stopIfAsked(job);
      if (halted) throw halted;
    }
    async function open(runs, kind, inputs) {
      var list = [];
      for (var i = 0; i < runs.length; i++) {
        list.push({ track: await openTrack(MB, inputs, runs[i].blob, kind), from: runs[i].from, to: runs[i].to, offset: runs[i].offset });
      }
      return list;
    }
    // The frame on screen at t: the last one that starts at or before it.
    async function frameAt(runs, t) {
      for (var i = runs.length - 1; i >= 0; i--) {
        if (i && runs[i].from > t + tol) continue;
        var sink = new MB.EncodedPacketSink(runs[i].track);
        var p = await sink.getPacket(t - runs[i].offset + tol, { metadataOnly: true }) || await sink.getFirstPacket({ metadataOnly: true });
        if (p) return { time: p.timestamp + runs[i].offset, duration: p.duration };
      }
      return null;
    }
    // The encoder settings, from the first window's frames: GPU if it can, else CPU.
    async function setUp(track) {
      W = track.displayWidth;
      H = track.displayHeight;
      // About 0.07 bits a pixel: close to the source by eye (8.7 Mbps at 1080p60).
      var bitrate = Math.round(Math.min(40e6, Math.max(2e6, W * H * fmt.fps * 0.07)));
      var tries = ['prefer-hardware', 'prefer-software'];
      for (var i = 0; i < tries.length && !encConfig; i++) {
        var cfg = { codec: avcCodec(W, H, fmt.fps), width: W, height: H, bitrate: bitrate, framerate: fmt.fps, hardwareAcceleration: tries[i], avc: { format: 'avc' } };
        try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) encConfig = cfg; } catch (e) {}
      }
      if (!encConfig) throw failure("This browser can't encode video here.");
      await roomFor((bitrate + AUDIO_BITRATE) / 8 * total);
    }

    // One window's frames, encoded by its own encoder: the chunks wait in the
    // window until it's its turn to be written.
    async function encodeWindow(w) {
      var inputs = [], enc = null, failed = null;
      try {
        var vRuns = await open(w.got.video.runs, 'video', inputs);
        var p = parts[w.part];
        if (w.first) {
          var f = await frameAt(vRuns, p.from);
          if (!f) throw failure("A part's first frame couldn't be found in what YouTube sent.");
          A[w.part] = f.time;
        }
        if (w.last) {
          var l = await frameAt(vRuns, p.to);
          if (!l || (w.first && l.time < A[w.part] - tol)) throw failure("A part's last frame couldn't be found in what YouTube sent.");
          L[w.part] = l.time;
          E[w.part] = l.time + (l.duration || fd);
        }
        // Once, from whichever window gets there first.
        await (settingUp || (settingUp = setUp(vRuns[0].track)));
        check();
        var lo = w.first ? A[w.part] : w.start, hi = w.last ? L[w.part] : null;
        var chunks = [], config = null, n = 0, lastTs = -Infinity, keyEvery = Math.max(1, Math.round(fmt.fps * 2));
        enc = new VideoEncoder({
          output: function (chunk, meta) {
            var data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ data: data, key: chunk.type === 'key', ts: chunk.timestamp / 1e6, dur: (chunk.duration || 0) / 1e6 });
            if (meta && meta.decoderConfig && !config) config = meta.decoderConfig;
          },
          error: function (e) { failed = e; }
        });
        enc.configure(encConfig);
        for (var i = 0; i < vRuns.length; i++) {
          var r = vRuns[i];
          if (r.to <= lo - tol) continue;
          var sink = new MB.VideoSampleSink(r.track, { hardwareAcceleration: 'prefer-software' });
          for await (var s of sink.samples(Math.max(0, lo - r.offset - 0.5), (w.last ? hi + tol : w.end) - r.offset + 0.001)) {
            var ts = s.timestamp + r.offset;
            if (ts >= lo - tol && ts > lastTs + tol && (w.last ? ts <= hi + tol : ts < w.end - tol)) {
              var frame = s.toVideoFrame();
              // The frame keeps its own time (in the player's timeline); the writer moves it into the clip's.
              var timed = new VideoFrame(frame, { timestamp: Math.round(ts * 1e6), duration: Math.round((s.duration || fd) * 1e6) });
              frame.close();
              while (enc.encodeQueueSize >= 8) await new Promise(function (res) { enc.addEventListener('dequeue', res, { once: true }); });
              enc.encode(timed, { keyFrame: n % keyEvery === 0 });
              timed.close();
              lastTs = ts;
              n++;
              w.made = Math.max(0, Math.min(w.end - w.start, ts - w.start));
              report();
            }
            s.close();
            if (failed) throw failed;
            check();
          }
        }
        await enc.flush();
        if (failed) throw failed;
        w.chunks = chunks;
        w.config = config;
        w.frames = n;
        w.made = w.end - w.start;
        report();
      } finally {
        if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) {} }
        disposeAll(inputs);
      }
    }

    function slot() {
      if (running < ENCODERS) { running++; return Promise.resolve(); }
      return new Promise(function (res) { waiting.push(res); });
    }
    function freeSlot() { var next = waiting.shift(); if (next) next(); else running--; }

    // Loads the windows in order (one player), and starts each one's encoding.
    async function loadAll() {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        // Not too far ahead of the writer: each waiting window holds its encoded video.
        while (i - written > ENCODERS) { check(); await sleep(100); }
        check();
        w.got = await loadRange(session, Math.max(0, w.start - 1), w.end, function (p) {
          if (!written && i === 0) progress('Loading', p * (w.end - w.start) / total);
        }, job);
        await slot();
        w.done = encodeWindow(w).then(freeSlot, function (e) { freeSlot(); if (!halted) halted = e; throw e; });
        w.done.catch(function () {});
      }
    }

    // The sound for one window, through the one sound encoder, in order.
    async function writeSound(w, inputs) {
      if (!aSrc || !w.got.audio) return;
      var aRuns = await open(w.got.audio.runs, 'audio', inputs);
      var k = w.part, a0 = A[k], aTo = w.last ? E[k] : w.end;
      for (var j = 0; j < aRuns.length; j++) {
        var ar = aRuns[j];
        if (ar.to <= aAt || ar.from >= aTo) continue;
        var sink = new MB.AudioSampleSink(ar.track);
        for await (var a of sink.samples(Math.max(0, aAt - ar.offset - 0.5), aTo - ar.offset)) {
          var t0 = a.timestamp + ar.offset, t1 = t0 + a.duration;
          var lo = Math.max(t0, aAt), hi = Math.min(t1, aTo);
          if (hi - lo > 1e-6) {
            var fadeIn = lo <= a0 + 1e-6, fadeOut = w.last && hi >= E[k] - 1e-6;
            var piece = fadeIn || fadeOut || lo - t0 > 1e-6 || t1 - hi > 1e-6 ? audioPiece(MB, a, lo - t0, hi - t0, fadeIn, fadeOut) : a;
            if (piece) {
              piece.setTimestamp(base + piece.timestamp + ar.offset - a0);
              await aSrc.add(piece);
              if (piece !== a) piece.close();
              aAt = hi;
            }
          }
          a.close();
          check();
        }
      }
    }

    var loading = loadAll();
    loading.catch(function (e) { if (!halted) halted = e; });
    try {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i], inputs = [];
        while (!w.done) { check(); await sleep(50); }
        await w.done;
        check();
        var k = w.part;
        if (!out) {
          if (!w.config) throw failure("The video encoder didn't start.");
          firstConfig = w.config;
          file = await clipFile('mp4');
          out = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.StreamTarget(file.writable, { chunked: true }) });
          vSrc = new MB.EncodedVideoPacketSource('avc');
          out.addVideoTrack(vSrc);
          if (w.got.audio) {
            var aac = await MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE });
            aSrc = new MB.AudioSampleSource({ codec: aac ? 'aac' : 'opus', bitrate: AUDIO_BITRATE });
            out.addAudioTrack(aSrc);
          }
          await out.start();
        } else if (w.config && !sameBytes(w.config.description, firstConfig.description)) {
          // Each encoder describes its stream; one file can only take one description.
          throw failure("The video encoders didn't agree. Try again.");
        }
        if (w.first) aAt = A[k];
        for (var c = 0; c < w.chunks.length; c++) {
          var ch = w.chunks[c];
          var packet = new MB.EncodedPacket(ch.data, ch.key ? 'key' : 'delta', base + ch.ts - A[k], ch.dur);
          await vSrc.add(packet, frames === 0 ? { decoderConfig: firstConfig } : undefined);
          frames++;
        }
        w.chunks = null;
        await writeSound(w, inputs);
        disposeAll(inputs);
        w.got = null;
        if (w.last) base += E[k] - A[k];
        written = i + 1;
      }
      await loading;
      if (!frames) throw failure('No frames came out.');
      vSrc.close();
      if (aSrc) aSrc.close();
      await out.finalize();
    } catch (e) {
      halted = halted || e;
      if (out) { try { await out.cancel(); } catch (err) {} }
      if (file) removeClipFile(file.name);
      // Let the encoders still running see the stop before going on.
      await Promise.all(wins.map(function (x) { return x.done ? x.done.catch(function () {}) : null; }));
      throw e;
    }
    return { file: file, ext: 'mp4', frames: frames, seconds: base, width: W, height: H, first: A[0], last: L[parts.length - 1] };
  }

  function sameBytes(a, b) {
    if (!a || !b) return !a && !b;
    var x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
    var y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // The whole video as YouTube sent it: its own video and sound, copied into
  // one file without decoding. If YouTube switched quality partway, that can't
  // be copied into one file, so it throws 'switched' and the caller re-encodes.
  async function copyWhole(MB, fmt, session, progress, job) {
    var media = window.__gleanerMedia, v = session.video, d = videoLength(), tol = 1e-3;
    var kinds = media.has('audio', v) ? ['video', 'audio'] : ['video'];
    var end = Math.max(0, d - 0.25), cursor = { video: 0, audio: 0 }, quality = {}, offset = {}, src = {}, first = {}, codecs = {};
    var file = null, out = null, inputs = [], W = 0, H = 0, ext = 'webm';

    // This quality's pieces from the cursor on, without a gap, up to `to`.
    function pieces(kind, to) {
      var list = media.list(kind, v), at = cursor[kind];
      if (quality[kind] === undefined) {
        // The sharpest quality (most bytes a second) among those holding the start.
        var rate = {};
        list.forEach(function (f) {
          var r = rate[f.quality] || (rate[f.quality] = { bytes: 0, secs: 0 });
          r.bytes += f.blob.size;
          r.secs += Math.max(0.001, f.t1 - f.t0);
        });
        var holders = list.filter(function (f) { return f.t0 <= at + tol && f.t1 > at; }).sort(function (a, b) {
          return rate[b.quality].bytes / rate[b.quality].secs - rate[a.quality].bytes / rate[a.quality].secs;
        });
        if (!holders.length) return [];
        quality[kind] = holders[0].quality;
        offset[kind] = holders[0].offset;
      }
      var mine = list.filter(function (f) { return f.quality === quality[kind] && f.offset === offset[kind] && f.t1 > at + tol; });
      var take = [];
      for (var i = 0; i < mine.length && at < to; i++) {
        if (mine[i].t0 > at + 0.05) break;
        take.push(mine[i]);
        at = mine[i].t1;
      }
      if (at < to && list.some(function (f) { return (f.quality !== quality[kind] || f.offset !== offset[kind]) && f.t0 <= at + tol && f.t1 > at; })) {
        throw failure('switched', 'switched');
      }
      return take;
    }
    async function begin(tracks, take) {
      var vc = tracks.video.codec, ac = tracks.audio ? tracks.audio.codec : null;
      W = tracks.video.displayWidth;
      H = tracks.video.displayHeight;
      var format = [new MB.WebMOutputFormat(), new MB.Mp4OutputFormat(), new MB.MkvOutputFormat()].filter(function (f) {
        var ok = f.getSupportedCodecs();
        return ok.indexOf(vc) >= 0 && (!ac || ok.indexOf(ac) >= 0);
      })[0];
      if (!format) throw failure('switched', 'switched');
      ext = String(format.fileExtension || '.webm').replace(/^\./, '');
      codecs = { video: vc, audio: ac };
      // Room for the whole video, at the rate of what's kept so far.
      var rate = 0;
      Object.keys(take).forEach(function (kind) {
        var bytes = 0, secs = 0;
        take[kind].forEach(function (f) { bytes += f.blob.size; secs += f.t1 - f.t0; });
        if (secs > 0) rate += bytes / secs;
      });
      await roomFor(rate * d);
      file = await clipFile(ext);
      out = new MB.Output({ format: format, target: new MB.StreamTarget(file.writable, { chunked: true }) });
      src.video = new MB.EncodedVideoPacketSource(vc);
      out.addVideoTrack(src.video);
      if (ac) {
        src.audio = new MB.EncodedAudioPacketSource(ac);
        out.addAudioTrack(src.audio);
      }
      await out.start();
    }
    async function write(kind, track, take) {
      var meta = first[kind] ? undefined : { decoderConfig: await track.getDecoderConfig() };
      var off = take[0].offset;
      for await (var p of new MB.EncodedPacketSink(track).packets()) {
        await src[kind].add(off ? p.clone({ timestamp: p.timestamp + off }) : p, meta);
        meta = undefined;
        first[kind] = true;
        stopIfAsked(job);
      }
      cursor[kind] = take[take.length - 1].t1;
    }

    try {
      var idle = 0;
      while (kinds.some(function (k) { return cursor[k] < end - tol; })) {
        if (++idle > 5) throw failure("YouTube didn't send that part of the video. Refresh the page and try again.");
        var wStart = Math.min.apply(null, kinds.map(function (k) { return cursor[k]; }));
        var wEnd = Math.min(end, wStart + CLIP_WINDOW);
        await loadRange(session, wStart, Math.max(wEnd, wStart + 0.05), function (p) {
          progress('Loading', (wStart + p * (wEnd - wStart)) / d);
        }, job);
        var take = {}, tracks = {};
        for (var i = 0; i < kinds.length; i++) {
          var kind = kinds[i];
          take[kind] = cursor[kind] < end - tol ? pieces(kind, wEnd) : [];
          if (take[kind].length) {
            var blob = new Blob([take[kind][0].init].concat(take[kind].map(function (f) { return f.blob; })));
            tracks[kind] = await openTrack(MB, inputs, blob, kind);
          }
        }
        if (!out) {
          // Not loaded after all: around again (the file needs every stream from the start).
          if (kinds.some(function (k) { return !tracks[k]; })) { disposeAll(inputs); continue; }
          await begin(tracks, take);
        }
        await Promise.all(kinds.map(function (kind) { return tracks[kind] ? write(kind, tracks[kind], take[kind]) : null; }));
        disposeAll(inputs);
        var at = Math.min.apply(null, kinds.map(function (k) { return cursor[k]; }));
        if (at > wStart + tol) idle = 0;
        progress('Copying', Math.min(1, at / d));
      }
      if (!out) throw failure('Nothing came out.');
      src.video.close();
      if (src.audio) src.audio.close();
      await out.finalize();
    } catch (e) {
      disposeAll(inputs);
      if (out) { try { await out.cancel(); } catch (err) {} } else if (file) { try { await file.writable.abort(); } catch (err) {} }
      if (file) removeClipFile(file.name);
      throw e;
    }
    return { file: file, ext: ext, seconds: d, width: W, height: H, codecs: codecs, copied: true };
  }

  var CODEC_NAMES = { av1: 'AV1', vp9: 'VP9', vp8: 'VP8', avc: 'H.264', hevc: 'H.265', opus: 'Opus', aac: 'AAC', vorbis: 'Vorbis', mp3: 'MP3' };

  function makeClip() {
    var st = ui;
    if (!st) return;
    if (st.clipJob) { st.clipJob.cancelled = true; return; } // the button says Stop while it works
    var media = window.__gleanerMedia, v = mainVideo(), fmt = playerFormat();
    if (!media) { setClipNote('Refresh the page once, then try again: ' + BRAND + ' starts keeping the video as the page loads.', true); return; }
    if (!v) { setClipNote('No video found on the page.', true); return; }
    if (!videoLength()) { setClipNote("Live streams can be clipped once they've ended.", true); return; }
    if (v.mediaKeys || media.protected()) { setClipNote("This video is protected (DRM), so it can't be clipped.", true); return; }
    if (isAdPlaying()) { setClipNote('Try again once the ad is over.', true); return; }
    if (!st.clipParts.length || st.clipParts.some(function (p) { return !(p.to >= p.from); })) { setClipNote('Each part has to end at or after its start.', true); return; }
    var parts = partsInOrder(st), whole = isWhole(st, fmt.fps);
    releaseClip(st);
    var job = st.clipJob = { cancelled: false, videoId: st.videoId }, began = Date.now(), session = null, switched = false;
    function progress(stage, p) {
      if (ui !== st || st.clipJob !== job) return;
      p = Math.max(0, Math.min(1, p));
      var spent = (Date.now() - began) / 1000, left = p > 0.02 && spent > 5 ? spent * (1 - p) / p : 0;
      var label = stage + ' ' + Math.round(p * 100) + '%' + (left > 5 ? ', ' + lengthWords(left) + ' left' : '');
      if (label === st.clipStatus) return;
      st.clipStatus = label;
      render();
    }
    st.clipStatus = 'Starting';
    setClipNote('');
    clipEngine().then(function (MB) {
      session = playerSession(job);
      if (!whole) return encodeParts(MB, parts, fmt, session, progress, job);
      return copyWhole(MB, fmt, session, progress, job).catch(function (e) {
        if (!e || e.code !== 'switched') throw e;
        // YouTube changed quality partway: one file can't hold both, so it's re-encoded.
        switched = true;
        return encodeParts(MB, [{ from: 0, to: lastMoment() }], fmt, session, progress, job);
      });
    }).then(async function (res) {
      if (session) session.restore();
      if (ui !== st || st.clipJob !== job) { removeClipFile(res.file.name); return; }
      var f = await res.file.handle.getFile();
      st.clipJob = null;
      var title = safeFileName(readDetails(st.videoId).title);
      var name = whole ? title + '.' + res.ext
        : parts.length > 1 ? title + ' (' + parts.length + ' parts).' + res.ext
        : title + ' (' + clipClock(res.first).replace(/:/g, '.') + ' to ' + clipClock(res.last).replace(/:/g, '.') + ').' + res.ext;
      var type = res.ext === 'mp4' ? 'video/mp4' : res.ext === 'webm' ? 'video/webm' : 'video/x-matroska';
      st.clipResult = { file: f, url: URL.createObjectURL(f), name: name, type: type, stored: res.file.name };
      var took = lengthWords((Date.now() - began) / 1000);
      if (res.copied) {
        setClipNote('Whole video ready: ' + lengthWords(res.seconds) + ' at ' + res.width + '×' + res.height + ', ' + sizeWords(f.size) + ', in ' + took + '. ' +
          'Copied as YouTube sent it (' + (CODEC_NAMES[res.codecs.video] || res.codecs.video) + ' video' +
          (res.codecs.audio ? ', ' + (CODEC_NAMES[res.codecs.audio] || res.codecs.audio) + ' sound' : '') + ', in a ' + res.ext.toUpperCase() + ' file).');
      } else {
        setClipNote((switched ? 'YouTube changed quality partway, so the video was re-encoded. ' : '') +
          'Made a ' + secsWords(res.seconds) + (whole ? ' video' : ' clip') + (parts.length > 1 ? ' from ' + parts.length + ' parts' : '') + ': ' +
          fmtNumber(res.frames) + ' frames at ' + res.width + '×' + res.height + ', ' + sizeWords(f.size) + ', in ' + took + '.');
      }
    }, function (e) {
      if (session) session.restore();
      if (ui !== st || st.clipJob !== job) return;
      st.clipJob = null;
      if (e && e.code === 'moved') return;
      if (e && e.code === 'stopped') setClipNote('Stopped.');
      else setClipNote("The clip didn't work: " + plainError(e), true);
    });
  }

  // Must run inside a click (see saveFile).
  function saveClip() {
    var r = ui && ui.clipResult;
    if (r) saveFile(r.name, r.file, r.type);
  }
  function setClipNote(text, bad) {
    if (!ui) return;
    ui.clipNote = text || '';
    ui.clipBad = !!bad;
    render();
  }
  function releaseClip(st) {
    if (!st.clipResult) return;
    URL.revokeObjectURL(st.clipResult.url);
    removeClipFile(st.clipResult.stored);
    st.clipResult = null;
  }

  // ------------------------------------------------------------ clip editor

  function toggleClip() {
    var st = ui;
    if (!st) return;
    st.clipOpen = !st.clipOpen;
    var v = mainVideo();
    if (st.clipOpen && v) {
      if (!st.clipParts.length) {
        var t = frameNow() || 0;
        st.clipParts.push({ from: t, to: Math.min(lastMoment() || t + 10, t + 10) });
        st.clipSel = 0;
        st.clipSnap = { part: 0, edge: 'from' };
      }
      watchFrames();
      // Shows the same frame again, so the browser says exactly which it is.
      if (v.paused) v.currentTime = v.currentTime;
    }
    render();
  }
  function addPart() {
    var st = ui;
    if (!st || !videoLength()) return;
    var fps = playerFormat().fps, t = frameNow() || 0;
    // On the playhead, or just after the part it's in.
    st.clipParts.forEach(function (p) { if (t >= p.from - 1e-3 && t <= p.to + 1e-3) t = p.to + 1 / fps; });
    t = Math.min(lastMoment(), t);
    st.clipParts.push({ from: t, to: Math.min(lastMoment(), t + 10) });
    st.clipSel = st.clipParts.length - 1;
    st.clipNote = '';
    render();
  }
  function removePart() {
    var st = ui;
    if (!st || st.clipParts.length < 2) return;
    st.clipParts.splice(st.clipSel, 1);
    st.clipSel = Math.min(st.clipSel, st.clipParts.length - 1);
    st.clipSnap = null;
    render();
  }
  function selectWhole() {
    var st = ui;
    if (!st || !videoLength()) return;
    st.clipParts = [{ from: 0, to: lastMoment() }];
    st.clipSel = 0;
    st.clipSnap = null;
    st.clipNote = '';
    render();
  }
  // One frame back or forward, paused: into the middle of the next frame, so
  // it moves by exactly one.
  function stepFrame(dir) {
    var v = mainVideo();
    if (!v) return;
    v.pause();
    var fps = playerFormat().fps, t = frameNow();
    v.currentTime = Math.max(0, dir > 0 ? t + 1.5 / fps : t - 0.5 / fps);
    watchFrames();
  }
  // edge: 'from' or 'to' of the chosen part. With no time, the frame on
  // screen; with a typed time, the frame on screen then (the player goes
  // there to show it).
  function setClipTime(edge, t) {
    var st = ui, v = mainVideo(), p = st && selectedPart(st);
    if (!p || !v) return;
    var typed = t !== null && t !== undefined, len = p.to - p.from;
    if (!typed) t = frameNow();
    t = Math.max(0, Math.min(lastMoment() || t, t));
    p[edge] = t;
    // Past the other needle: the part moves, keeping its length.
    if (p.to < p.from) {
      if (edge === 'from') p.to = Math.min(lastMoment(), p.from + len);
      else p.from = Math.max(0, p.to - len);
    }
    if (typed) {
      showMoment(t, true);
      st.clipSnap = { part: st.clipParts.indexOf(p), edge: edge };
      watchFrames();
    }
    st.clipNote = '';
    st.clipBad = false;
    render();
  }
  // Arrow keys on a needle: a frame (Shift: a second) at a time.
  function nudgeNeedle(i, edge, dir, big) {
    var st = ui, p = st && st.clipParts[i];
    if (!p) return;
    var fps = playerFormat().fps;
    var t = big ? p[edge] + dir : dir > 0 ? p[edge] + 1.5 / fps : p[edge] - 0.5 / fps;
    t = Math.max(0, Math.min(lastMoment(), t));
    p[edge] = edge === 'from' ? Math.min(t, p.to) : Math.max(t, p.from);
    st.clipSel = i;
    showMoment(p[edge], true);
    st.clipSnap = { part: i, edge: edge };
    watchFrames();
    render();
  }

  // Shows the frame at t while a needle is dragged: one seek at a time, always
  // to the latest place (seeks that pile up leave the video lagging behind).
  var seekWant = null, seekBusy = 0;
  function liveSeek(t) {
    var v = mainVideo();
    if (!v) return;
    seekWant = t;
    if (seekBusy && Date.now() - seekBusy < 1500) return;
    seekBusy = Date.now();
    if (!v.paused) v.pause();
    var target = seekWant;
    seekWant = null;
    v.addEventListener('seeked', function done() {
      v.removeEventListener('seeked', done);
      seekBusy = 0;
      if (seekWant !== null) liveSeek(seekWant);
    });
    v.currentTime = target;
  }

  // A thumbnail of the moment under the pointer (or the needle being
  // dragged), with its exact time, above the bar: instant, from YouTube's
  // own preview thumbnails. Fixed to the window, so the panel can't clip it.
  function peekAt(c, t, x) {
    var st = ui, d = videoLength();
    if (!st || !d) return;
    if (c.peekFor !== st.videoId) { c.peekFor = st.videoId; c.peekBoard = storyboard(st.videoId, 3); }
    var sb = c.peekBoard;
    c.peekImg.hidden = !sb;
    if (sb) {
      var w = 192, h = Math.round(w * sb.h / sb.w), s = sprite(sb, t, d, w, h);
      c.peekImg.style.width = w + 'px';
      c.peekImg.style.height = h + 'px';
      c.peekImg.style.backgroundImage = s.image;
      c.peekImg.style.backgroundSize = s.size;
      c.peekImg.style.backgroundPosition = s.position;
    }
    c.peekTime.textContent = clipClock(t);
    c.peek.hidden = false;
    var rect = c.bar.getBoundingClientRect(), pw = c.peek.offsetWidth, ph = c.peek.offsetHeight;
    var top = rect.top - ph - 14;
    if (top < 64) top = rect.bottom + 14; // under YouTube's top bar: below the bar instead
    c.peek.style.left = Math.max(4, Math.min(window.innerWidth - pw - 4, x - pw / 2)) + 'px';
    c.peek.style.top = top + 'px';
  }
  function hidePeek() {
    var c = ui && ui.refs && ui.refs.clipRow;
    if (c) c.peek.hidden = true;
  }

  // Dragging a needle moves that end of its part, with the frame there on the
  // video and in the thumbnail above; a click anywhere else on the bar shows
  // that moment.
  function onBarDown(e) {
    var st = ui, bar = e.currentTarget, d = videoLength();
    if (e.button !== 0 || !st || !d || st.clipJob) return;
    var rect = bar.getBoundingClientRect();
    function timeAt(x) { return Math.max(0, Math.min(lastMoment(), (x - rect.left) / rect.width * d)); }
    var needle = e.target.closest('.sc-needle'), partNode = e.target.closest('.sc-part');
    if (!needle) {
      if (partNode) st.clipSel = +partNode.getAttribute('data-i');
      showMoment(timeAt(e.clientX), false);
      render();
      return;
    }
    e.preventDefault();
    var i = +needle.parentNode.getAttribute('data-i'), edge = needle.getAttribute('data-edge');
    st.clipSel = i;
    st.clipDrag = { part: i, edge: edge };
    needle.focus({ preventScroll: true });
    bar.setPointerCapture(e.pointerId);
    function move(ev) {
      var p = st.clipParts[i];
      if (!p) return;
      var t = timeAt(ev.clientX);
      if (edge === 'from') p.from = Math.min(t, p.to); else p.to = Math.max(t, p.from);
      liveSeek(p[edge]);
      peekAt(st.refs.clipRow, p[edge], rect.left + p[edge] / d * rect.width);
      render();
    }
    function up() {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      st.clipDrag = null;
      hidePeek();
      var p = st.clipParts[i];
      if (!p) return;
      showMoment(p[edge], true);
      st.clipSnap = { part: i, edge: edge };
      watchFrames();
      render();
    }
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  }

  // YouTube's own preview thumbnails (what its timeline shows on hover), at
  // the sharpest level up to `want` it has: level 0 is one small sheet,
  // level 1 is sharp enough for the bar, level 3 for the preview.
  function storyboard(videoId, want) {
    var pr = playerResponse(videoId);
    var spec = pr && pr.storyboards && pr.storyboards.playerStoryboardSpecRenderer && pr.storyboards.playerStoryboardSpecRenderer.spec;
    var levels = String(spec || '').split('|'), base = levels[0];
    if (!/^https:\/\/i\.ytimg\.com\//.test(base)) return null;
    for (var level = Math.min(want, levels.length - 2); level >= 0; level--) {
      var f = (levels[level + 1] || '').split('#');
      var w = +f[0], h = +f[1], count = +f[2], cols = +f[3], rows = +f[4];
      if (!(w > 0 && h > 0 && count > 0 && cols > 0 && rows > 0) || !f[6] || !f[7]) continue;
      return {
        w: w, h: h, count: count, cols: cols, rows: rows, gap: (+f[5] || 0) / 1000,
        sheet: (function (lv, name, sigh) {
          return function (n) {
            return base.replace('$L', String(lv)).replace('$N', name.replace('$M', String(n))) + (base.indexOf('?') >= 0 ? '&' : '?') + 'sigh=' + sigh;
          };
        })(level, f[6], f[7])
      };
    }
    return null;
  }

  // Where the thumbnail for moment t sits in its sheet, shown at tw × th.
  function sprite(sb, t, d, tw, th) {
    var per = sb.cols * sb.rows;
    var k = Math.max(0, Math.min(sb.count - 1, sb.gap > 0 ? Math.floor(t / sb.gap) : Math.floor(t / d * sb.count)));
    var sheet = Math.floor(k / per), cell = k % per;
    // The last sheet holds only the thumbnails left, so it's smaller.
    var inSheet = Math.min(per, sb.count - sheet * per), rowsIn = Math.ceil(inSheet / sb.cols), colsIn = rowsIn > 1 ? sb.cols : inSheet;
    return {
      image: 'url("' + sb.sheet(sheet) + '")',
      size: (colsIn * tw) + 'px ' + (rowsIn * th) + 'px',
      position: (-(cell % sb.cols) * tw) + 'px ' + (-Math.floor(cell / sb.cols) * th) + 'px'
    };
  }

  function renderStrip(c, st) {
    var w = c.bar.clientWidth, h = c.bar.clientHeight, d = videoLength();
    var key = st.videoId + ':' + w + ':' + Math.round(d);
    if (!w || !h || !d || c.stripKey === key) return;
    var sb = storyboard(st.videoId, 1);
    if (!sb) return; // no thumbnails (yet): a plain bar
    c.stripKey = key;
    c.strip.textContent = '';
    var n = Math.max(1, Math.round(w / (h * sb.w / sb.h))), tw = w / n;
    for (var i = 0; i < n; i++) {
      var s = sprite(sb, (i + 0.5) / n * d, d, tw, h), tile = el('div', { class: 'sc-tile' });
      tile.style.width = tw + 'px';
      tile.style.backgroundImage = s.image;
      tile.style.backgroundSize = s.size;
      tile.style.backgroundPosition = s.position;
      c.strip.appendChild(tile);
    }
  }

  function renderBar(c, st) {
    var d = videoLength(), fd = 1 / playerFormat().fps, kids = c.layer.children;
    renderStrip(c, st);
    while (kids.length > st.clipParts.length) c.layer.lastChild.remove();
    while (kids.length < st.clipParts.length) {
      c.layer.appendChild(el('div', { class: 'sc-part' }, [
        el('div', { class: 'sc-needle', 'data-edge': 'from', tabindex: '0', role: 'slider', 'aria-label': 'Start of part', title: 'Drag to choose where this part starts (arrow keys: one frame)' }),
        el('div', { class: 'sc-needle', 'data-edge': 'to', tabindex: '0', role: 'slider', 'aria-label': 'End of part', title: 'Drag to choose where this part ends (arrow keys: one frame)' })
      ]));
    }
    st.clipParts.forEach(function (p, i) {
      var n = kids[i];
      n.setAttribute('data-i', String(i));
      n.classList.toggle('sc-sel', i === st.clipSel);
      n.style.left = d ? (p.from / d * 100) + '%' : '0';
      n.style.width = d ? (Math.max(0, Math.min(d, p.to + fd) - p.from) / d * 100) + '%' : '0';
      n.firstChild.setAttribute('aria-valuetext', clipClock(p.from));
      n.lastChild.setAttribute('aria-valuetext', clipClock(p.to));
    });
    movePlayhead();
  }

  function buildClipRow() {
    var strip = el('div', { class: 'sc-strip' });
    var layer = el('div', { class: 'sc-parts' });
    var playhead = el('div', { class: 'sc-playhead' });
    var bar = el('div', { class: 'sc-bar', title: 'The whole video. Drag the needles to choose each part; click anywhere to see that moment.' }, [strip, layer, playhead]);
    bar.addEventListener('pointerdown', onBarDown);
    bar.addEventListener('pointermove', function (e) {
      var st = ui, d = videoLength();
      if (!st || st.clipDrag || !d) return;
      var rect = bar.getBoundingClientRect();
      peekAt(st.refs.clipRow, Math.max(0, Math.min(lastMoment(), (e.clientX - rect.left) / rect.width * d)), e.clientX);
    });
    bar.addEventListener('pointerleave', function () { if (ui && !ui.clipDrag) hidePeek(); });
    bar.addEventListener('keydown', function (e) {
      var n = e.target.closest && e.target.closest('.sc-needle');
      if (!n) return;
      e.stopPropagation(); // keep YouTube's own keys out
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      nudgeNeedle(+n.parentNode.getAttribute('data-i'), n.getAttribute('data-edge'), e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    });

    function timeBox(label, edge) {
      var input = el('input', { class: 'sc-ask sc-time', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': label, title: 'Type a time (like 1:23.450) to choose the frame on screen then' });
      ['keydown', 'keyup', 'keypress'].forEach(function (t) { input.addEventListener(t, function (e) { e.stopPropagation(); }); });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('change', function () {
        var t = parseClipClock(input.value);
        if (t === null) { render(); return; }
        setClipTime(edge, t);
      });
      return input;
    }
    var partName = el('span', { class: 'sc-partname' });
    var setFrom = makeButton('sc-tonal', 'first', 'Start', 'Start this part at the frame on screen now', function () { setClipTime('from', null); });
    var from = timeBox('Start time', 'from');
    var back = makeButton('sc-tonal sc-mini', 'prev', '', 'One frame back', function () { stepFrame(-1); });
    var fwd = makeButton('sc-tonal sc-mini', 'next', '', 'One frame forward', function () { stepFrame(1); });
    var setTo = makeButton('sc-tonal', 'last', 'End', 'End this part at the frame on screen now (that frame is in the clip)', function () { setClipTime('to', null); });
    var to = timeBox('End time', 'to');
    var remove = makeButton('sc-tonal sc-mini', 'trash', '', 'Remove this part', removePart);

    var add = makeButton('sc-tonal', 'plus', 'Add part', 'Add another part (parts are joined in time order, with no gap)', addPart);
    var whole = makeButton('sc-tonal', 'movie', 'Whole video', 'Select the whole video', selectWhole);
    var len = el('span', { class: 'sc-cliplen' });
    var make = makeButton('sc-primary', 'scissors', 'Make clip', '', makeClip);

    var preview = el('video', { class: 'sc-clipvid', controls: '', preload: 'metadata', playsinline: '', draggable: 'true', title: 'Drag this onto your desktop or into a folder to save it there' });
    preview.addEventListener('dragstart', function (e) {
      var r = ui && ui.clipResult;
      // Chrome turns this into a real file where it's dropped.
      if (r) e.dataTransfer.setData('DownloadURL', r.type + ':' + r.name + ':' + r.url);
    });
    var save = makeButton('sc-tonal', 'download', 'Save', 'Save it in your downloads', saveClip);
    var result = el('div', { class: 'sc-row sc-clipresult' }, [preview, save.node]);
    var note = el('div', { class: 'sc-note', role: 'status', 'aria-live': 'polite' });
    var peekImg = el('div', { class: 'sc-peek-img' }), peekTime = el('div', { class: 'sc-peek-time' });
    var peek = el('div', { class: 'sc-peek', hidden: '' }, [peekImg, peekTime]);

    var node = el('div', { class: 'sc-cut' }, [
      peek,
      bar,
      el('div', { class: 'sc-row' }, [partName, setFrom.node, from, back.node, fwd.node, setTo.node, to, remove.node]),
      el('div', { class: 'sc-row sc-cliptools' }, [add.node, whole.node, len, make.node]),
      result, note
    ]);
    return {
      node: node, bar: bar, strip: strip, layer: layer, playhead: playhead, stripKey: '',
      peek: peek, peekImg: peekImg, peekTime: peekTime, peekFor: null, peekBoard: null,
      partName: partName, from: from, to: to, remove: remove, len: len, make: make, preview: preview, result: result, note: note
    };
  }

  function renderClip(r) {
    var c = r.clipRow, st = ui;
    if (!c) return;
    r.clip.node.setAttribute('aria-pressed', String(!!st.clipOpen));
    c.node.hidden = !st.clipOpen;
    if (!st.clipOpen) return;
    var fmt = playerFormat(), d = videoLength(), p = selectedPart(st), many = st.clipParts.length > 1;
    renderBar(c, st);
    c.partName.textContent = many ? 'Part ' + (st.clipParts.indexOf(p) + 1) + ' of ' + st.clipParts.length : '';
    c.partName.hidden = !many;
    c.remove.node.hidden = !many;
    if (document.activeElement !== c.from) c.from.value = p ? clipClock(p.from) : '';
    if (document.activeElement !== c.to) c.to.value = p ? clipClock(p.to) : '';
    var whole = isWhole(st, fmt.fps), secs = 0;
    st.clipParts.forEach(function (q) { secs += Math.max(0, q.to - q.from) + 1 / fmt.fps; });
    c.len.textContent = !d ? '' : whole
      ? 'Whole video · ' + lengthWords(d) + ' · copied as YouTube sent it' + (fmt.height ? ' (' + qualityLabel(fmt) + ')' : '')
      : (many ? st.clipParts.length + ' parts · ' : '') + secsWords(secs) + ' · about ' + fmtNumber(Math.round(secs * fmt.fps)) + ' frames' +
        (fmt.height ? ' · ' + qualityLabel(fmt) : '');
    c.len.title = "Clips come out in the quality the player is showing. For a sharper clip, pick a higher quality in YouTube's settings first.";
    setButton(c.make, st.clipJob ? 'busy' : 'idle', st.clipJob ? (st.clipStatus || 'Working') + ' · Stop' : whole ? 'Make video' : 'Make clip');
    c.make.node.title = st.clipJob ? 'Click to stop' : whole
      ? 'Copy the whole video as YouTube sent it: full quality, no re-encoding'
      : 'Cut exactly these frames into an MP4' + (many ? ', parts joined in time order' : '');
    c.result.hidden = !st.clipResult;
    if (st.clipResult && c.preview.getAttribute('src') !== st.clipResult.url) c.preview.src = st.clipResult.url;
    c.note.textContent = st.clipNote;
    c.note.classList.toggle('sc-bad', !!st.clipBad);
  }

  // ---------------------------------------------------------- saved exports
  //
  // background.js keeps every export (see exportComments), so a video's export
  // can be saved again, continued after the tab is gone, or brought up to date
  // with just the new comments. The page asks through relay.js.

  var cacheCalls = {}, cacheSeq = 0;
  window.addEventListener('scribe:cache-result', function (e) {
    var m = null;
    try { m = JSON.parse(e.detail); } catch (err) {}
    var done = m && cacheCalls[m.id];
    if (!done) return;
    delete cacheCalls[m.id];
    done(m.res || { ok: false });
  });
  function cacheCall(op, args, waitMs) {
    return new Promise(function (resolve) {
      var id = 'c' + (++cacheSeq);
      cacheCalls[id] = resolve;
      setTimeout(function () {
        if (cacheCalls[id]) { delete cacheCalls[id]; resolve({ ok: false, error: 'no answer' }); }
      }, waitMs || 120000);
      window.dispatchEvent(new CustomEvent('scribe:cache', { detail: JSON.stringify(Object.assign({ id: id, op: op }, args)) }));
    });
  }
  function exportStore(videoId) {
    return {
      commit: function (part, meta) { return cacheCall('commit', { videoId: videoId, part: part, meta: meta }); },
      save: function (filename, extra) {
        return cacheCall('save', { videoId: videoId, filename: filename, header: CSV_HEADER, extra: extra });
      }
    };
  }

  function whenText(t) {
    try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function savedNote(meta) {
    var have = meta.rows + (meta.unflushed || []).length;
    var head = 'Saved ' + whenText(meta.updatedAt) + ': ' + fmtNumber(have) + (meta.finished || !meta.total ? '' : ' of ' + fmtNumber(meta.total)) + ' rows';
    // How long the rest would take at the pace it last ran.
    if (!meta.finished && meta.pace && meta.total > have) head += ', about ' + timeLeft((meta.total - have) / meta.pace) + ' to finish';
    return head + '. ' + (meta.finished ? 'Save spreadsheet, get new comments with Update, or Start over.' : 'Save spreadsheet, Continue, or Start over.');
  }

  // As soon as a video opens: is there a saved export of it? Without an
  // answer from the extension, exports stay in the page as before. The
  // extension's relay may still be loading, so no answer means ask again later.
  function loadSaved(st) {
    if (st.storeOk !== null || st.savedAsking) return;
    st.savedAsking = true;
    cacheCall('get', { videoId: st.videoId }, 5000).then(function (res) {
      st.savedAsking = false;
      if (ui !== st) return;
      if (!res || (!res.ok && res.error === 'no answer')) {
        if (++st.savedTries < 4) setTimeout(function () { if (ui === st) loadSaved(st); }, 2000);
        return;
      }
      st.storeOk = !!res.ok;
      var meta = res.ok ? res.meta : null;
      if (meta && !st.exportJob && st.exportState === 'idle') {
        st.exportSaved = meta;
        st.exportState = meta.finished ? 'ready' : 'paused';
        st.exportCount = meta.rows;
        st.exportTotal = st.exportTarget = meta.total || 0;
        setNote(savedNote(meta));
      }
      autoSave(st);
    });
  }

  // Saving by itself: once a video is open in a tab that's on screen, its
  // comments start saving, a paused export carries on, and a finished one
  // picks up the comments posted since. It reads gently (see exportComments)
  // and stops when the video changes; a click on Stop ends it for this visit.
  var AUTO_KEY = 'scribe.autoSave';
  function autoOn() {
    var v = null;
    try { v = localStorage.getItem(AUTO_KEY); } catch (e) {}
    return v === null ? BUILD === 'dev' : v === 'on';
  }
  function toggleAuto() {
    var on = !autoOn();
    try { localStorage.setItem(AUTO_KEY, on ? 'on' : 'off'); } catch (e) {}
    if (ui) { ui.autoTried = false; if (on) autoSave(ui); }
    render();
  }
  function autoSave(st) {
    if (!autoOn() || st.autoTried || ui !== st || st.storeOk !== true || !st.videoId) return;
    if (document.visibilityState !== 'visible') return; // starts when the tab is looked at
    if (st.exportJob || (st.exportState !== 'idle' && st.exportState !== 'paused' && st.exportState !== 'ready')) return;
    var meta = st.exportSaved;
    if (meta && meta.finished && Date.now() - (meta.updatedAt || 0) < AUTO_UPDATE_AFTER) return;
    st.autoTried = true;
    st.exportAuto = true;
    if (!meta) {
      st.exportCount = st.exportTotal = st.exportTarget = st.exportWritten = 0;
      newJob(st, null);
      runExport(st, 'run');
    } else {
      newJob(st, meta);
      runExport(st, meta.finished ? 'update' : 'run');
    }
  }
  document.addEventListener('visibilitychange', function () { if (ui) autoSave(ui); });

  function newJob(st, restore) {
    var job = exportComments(st.videoId, function (count, total, written) {
      if (ui !== st || st.exportJob !== job) return;
      st.exportCount = count;
      st.exportWritten = written;
      st.exportTotal = total;
      st.exportTarget = total;
      if (st.exportMode === 'update') { render(); return; }
      var plan = exportPlan(st.exportRunStart, count - st.exportBase, total ? Math.max(0, total - count) : -1);
      if (!plan.eta || st.exportStopping) { render(); return; }
      var lead = st.exportAuto ? 'Saving the comments by itself: ' + fmtNumber(count) + (total ? ' of ' + fmtNumber(total) : '') + '. ' : '';
      var longNote = st.storeOk ? '. Closing this tab just pauses it: it carries on next time. ' : '. Keep this tab open. ';
      setNote(lead + plan.eta + (plan.long ? longNote : '. ') + 'Stop anytime to save what has loaded.');
    }, st.storeOk ? exportStore(st.videoId) : null, restore || null, !!st.exportAuto);
    st.exportJob = job;
    return job;
  }

  // The newest saved note, for carrying on or updating from it.
  function freshSaved(st) {
    return cacheCall('get', { videoId: st.videoId }).then(function (res) {
      st.exportSaved = res && res.ok ? res.meta : null;
      return st.exportSaved;
    });
  }

  // Export comments: reads every comment. Stop pauses it, Continue carries on
  // from there (also on a later visit), and Save spreadsheet downloads what
  // has loaded, as often as wanted. Update adds the comments posted since.
  function doExport() {
    var st = ui;
    if (!st) return;
    if (st.exportState === 'busy') { stopExport(); return; }
    if (st.exportState === 'ready' || st.exportState === 'paused') { saveExport(st); return; }
    st.exportCount = 0;
    st.exportTotal = 0;
    st.exportTarget = 0;
    st.exportWritten = 0;
    st.exportAuto = false; // a click reads at full speed
    newJob(st, null);
    runExport(st, 'run');
  }

  // Starts the export's reading, carries it on after a stop, or (mode
  // 'update') reads just the comments posted since.
  function runExport(st, mode) {
    var job = st.exportJob;
    st.exportState = 'busy';
    st.exportMode = mode;
    st.exportStopping = false;
    st.overArmed = false;
    st.exportRunStart = Date.now();
    st.exportBase = st.exportCount; // the time left is judged on this run's pace
    setNote(mode === 'update' ? 'Checking for comments posted since ' + whenText(st.exportSaved ? st.exportSaved.updatedAt : Date.now()) + '…' : '');
    job[mode]().then(function (res) {
      if (ui !== st || st.exportJob !== job) return;
      st.exportStopping = false;
      if (res.why === 'storage') {
        st.exportJob = null; // what's stored is whole; Continue starts from it
        st.exportState = 'paused';
        setNote(BRAND + " couldn't save its progress. Refresh the page, then press Continue.", true);
        return;
      }
      if (res.update) { updated(st, res); return; }
      if (res.off || res.none || (res.finished && !res.rows)) {
        st.exportJob = null;
        st.exportState = 'idle';
        if (st.storeOk) cacheCall('delete', { videoId: st.videoId });
        setNote(res.off ? 'Comments are turned off for this video.' : res.none ? 'This video has no comments section.' : 'This video has no comments yet.');
        return;
      }
      var counts = fmtNumber(res.comments) + ' comments and ' + fmtNumber(res.replies) + ' replies';
      if (res.finished) {
        st.exportState = 'ready';
        if (res.why === 'loop') setNote('YouTube kept sending the same comments, so the export ended at ' + counts + '. Click Save spreadsheet to download them.', true);
        else if (res.cut) setNote(counts + ". A few replies didn't load. Click Save spreadsheet to download them.");
        else setNote(counts + '. Click Save spreadsheet to download them.');
        if (st.storeOk) freshSaved(st).then(function () { if (ui === st) render(); });
        return;
      }
      st.exportState = 'paused';
      if (res.why === 'memory') setNote('Paused at ' + counts + ' because your browser is low on memory. Click Save spreadsheet to download them.', true);
      else if (res.why === 'youtube') setNote('YouTube stopped answering at ' + counts + '. Save what has loaded, or Continue to try again.', true);
      else setNote('Paused at ' + counts + '. Save what has loaded, or Continue to keep going' + (st.storeOk ? ', now or another day.' : '.'));
    }, function (e) {
      if (ui !== st || st.exportJob !== job) return;
      st.exportJob = null;
      st.exportStopping = false;
      if (e && e.code === 'moved') { st.exportState = 'idle'; render(); return; }
      st.exportState = 'fail';
      setNote("The export didn't work: " + plainError(e) + ' Click Export comments to try again.', true);
    });
  }

  function updated(st, res) {
    st.exportJob = null; // the next step starts from the saved note
    st.exportState = 'ready';
    freshSaved(st).then(function () { if (ui === st) render(); });
    if (res.off || res.none) setNote(res.off ? 'Comments are turned off for this video now.' : 'This video has no comments section now.', true);
    else if (!res.complete) setNote('Update stopped, and nothing was added. Update again anytime.');
    else if (!res.added) setNote('Up to date: ' + fmtNumber(res.rows) + ' rows saved, and no new comments since ' + whenText(st.exportSaved ? st.exportSaved.updatedAt : Date.now()) + '.');
    else setNote('Added ' + fmtNumber(res.added) + ' new rows at the top: ' + fmtNumber(res.rows) + ' saved in all. Save spreadsheet to get everything.');
  }

  // The Stop button (or Export clicked again while it runs): pauses the
  // export once the requests in flight are back.
  function stopExport() {
    var st = ui;
    if (!st || st.exportState !== 'busy' || !st.exportJob || st.exportStopping) return;
    st.exportStopping = true;
    st.exportJob.stop();
    setNote('Stopping…');
  }

  function continueExport() {
    var st = ui;
    if (!st || st.exportState !== 'paused') return;
    st.exportAuto = false; // a click reads at full speed
    if (st.exportJob) { st.exportJob.setGentle(false); runExport(st, 'run'); return; }
    // A saved export from an earlier visit: carry on from its note.
    freshSaved(st).then(function (meta) {
      if (ui !== st || st.exportState !== 'paused' || st.exportJob) return;
      if (!meta) { st.exportState = 'idle'; setNote('The saved export is gone. Click Export comments to start again.', true); return; }
      newJob(st, meta);
      runExport(st, 'run');
    });
  }

  function updateExport() {
    var st = ui;
    if (!st || st.exportState !== 'ready' || !st.storeOk) return;
    freshSaved(st).then(function (meta) {
      if (ui !== st || st.exportState !== 'ready' || !meta || !meta.finished) return;
      st.exportAuto = false;
      newJob(st, meta);
      runExport(st, 'update');
    });
  }

  // Start over deletes the saved export, so it takes a second click.
  function startOver() {
    var st = ui;
    if (!st || (st.exportState !== 'ready' && st.exportState !== 'paused')) return;
    if (!st.overArmed) {
      st.overArmed = true;
      render();
      setTimeout(function () { if (ui === st && st.overArmed) { st.overArmed = false; render(); } }, 4000);
      return;
    }
    st.overArmed = false;
    var hadSaved = st.storeOk;
    st.exportJob = null;
    st.exportSaved = null;
    st.exportState = 'idle';
    st.exportCount = st.exportTotal = st.exportTarget = st.exportWritten = 0;
    setNote(hadSaved ? 'Deleting the saved export…' : '');
    if (hadSaved) cacheCall('delete', { videoId: st.videoId }).then(function (res) {
      if (ui === st) setNote(res && res.ok ? 'The saved export is deleted. Click Export comments to start again.' : "Couldn't delete the saved export. Try again.", !(res && res.ok));
    });
  }

  function saveExport(st) {
    var job = st.exportJob;
    if (!job && st.exportSaved) job = newJob(st, st.exportSaved); // saved earlier: just write the file
    if (!job) return;
    var paused = st.exportState === 'paused';
    setNote('Saving…');
    job.save(safeFileName(readDetails(st.videoId).title || (st.exportSaved && st.exportSaved.title)) + ' - comments.csv').then(function (res) {
      if (ui !== st) return;
      if (!res.ok) { setNote("Couldn't save the file: " + (res.error || 'something went wrong') + '. Try again.', true); return; }
      if (paused) { setNote('Saved ' + fmtNumber(res.rows) + ' rows so far. Continue anytime to get the rest.'); return; }
      st.exportState = 'done';
      setNote('Saved ' + fmtNumber(res.rows) + ' rows. The file is in your downloads.');
      setTimeout(function () {
        if (ui !== st || st.exportState !== 'done') return;
        // A saved export stays, ready to save again or update.
        if (st.storeOk) st.exportState = 'ready'; else { st.exportState = 'idle'; st.exportJob = null; }
        render();
      }, 2400);
    });
  }

  function dispatchSend(prompt, question) {
    window.dispatchEvent(new CustomEvent('yt-tr-send-to-ai', {
      detail: { prompt: prompt, question: question || '' }
    }));
  }

  // Tells the side panel that the Send it's waiting on won't come.
  function dispatchCancel(reason) {
    window.dispatchEvent(new CustomEvent('scribe:send-cancel', { detail: { reason: reason } }));
  }

  function doSend() {
    var st = ui;
    if (!st) return;
    if (st.sendBusy) {
      // Clicked again while the data is still loading (the side panel may have
      // been closed): open it again inside this click. The send under way fills it.
      st.send = 'busy';
      setNote(waitingNote('Sending'));
      dispatchSend(null);
      return;
    }
    st.sendBusy = true;
    st.send = 'busy';
    // Open the side panel right now, while this click still counts as a
    // click. Chrome refuses to open it later, after we've waited for data.
    dispatchSend(null);
    // relay.js answers at once when it can't reach the extension (reloaded
    // under this page): keep its 'refresh' message instead of carrying on.
    if (st.send === 'fail') { st.sendBusy = false; return; }
    retryFailures();
    setNote(waitingNote('Sending'));
    gatherAll(st.videoId).then(function (bundle) {
      st.sendBusy = false;
      if (st.send === 'fail') return; // the reason is already on screen
      if (!stillOn(st)) {
        // Left the video while waiting. switchVideo() already told the side
        // panel, unless `ui` hasn't caught up with the address yet.
        if (ui === st) dispatchCancel('Nothing was sent: you left the video before it was ready.');
        return;
      }
      // Don't spend a Claude message on a prompt without the transcript when
      // a second try usually gets it. Videos with no captions, and live
      // streams, still send.
      if (!bundle.segments && bundle.transcriptCode !== 'no-captions' && !bundle.details.liveNow) {
        var why = (bundle.transcriptError || "The transcript didn't load.").replace(/\.?$/, '.');
        st.send = 'fail';
        setNote("Didn't send: " + why, true);
        dispatchCancel('Nothing was sent: ' + why);
        return;
      }
      // Claude files a long paste as an attachment, so the video goes in as the
      // paste and the question follows as the message you can see in the chat.
      var question = (st.refs ? st.refs.ask.value : loadQuestion()).trim();
      dispatchSend(buildPrompt(bundle, ''), question);
      if (st.send === 'fail') return; // relay.js couldn't reach the extension
      st.send = 'done';
      var note = missingNote(bundle, 'Sent');
      setNote(note, !!note);
      setTimeout(function () { if (ui === st && !st.sendBusy && st.send === 'done') { st.send = 'idle'; render(); } }, 2400);
    }, function () {
      st.sendBusy = false;
      if (ui !== st) return;
      st.send = 'fail';
      setNote('Something went wrong. Click Send again.', true);
      dispatchCancel('Nothing was sent: something went wrong. Click Send again.');
    });
  }

  // relay.js reports back when the extension was updated under an open page.
  window.addEventListener('scribe:relay-error', function () {
    if (!ui) return;
    ui.send = 'fail';
    setNote(BRAND + ' was just updated. Refresh this page, then send again.', true);
  });

  // ...and when Chrome didn't open the side panel (for example in a popup or
  // app window, which have none).
  window.addEventListener('scribe:panel-failed', function () {
    if (!ui || ui.send === 'idle' || ui.send === 'fail') return;
    ui.send = 'fail';
    setNote("Chrome didn't open the side panel, so nothing was sent. Use Copy, or Send from a normal Chrome window.", true);
    dispatchCancel("Nothing was sent: Chrome didn't open the side panel.");
  });

  // ----------------------------------------------------------- open / close

  function closeToPill() {
    setOpen(false);
    var pill = document.getElementById('scribe-pill');
    if (pill) pill.focus();
  }

  function mountPanel() {
    if (!ui.panel) buildPanel();
    placePanel(ui.panel);
    render();
  }

  function setOpen(open) {
    if (!ui || !ui.videoId) return;
    ui.open = open;
    var pill = document.getElementById('scribe-pill');
    if (pill) pill.setAttribute('aria-expanded', String(open));
    if (open) {
      mountPanel();
      ui.panel.inert = false;
      void ui.panel.offsetHeight; // paint the closed state first so it animates open
      ui.panel.classList.add('sc-open');
      startLoading();
      loadSaved(ui);
    } else if (ui.panel) {
      // Out of the Tab order, clicks and screen readers while closed.
      ui.panel.inert = true;
      ui.panel.classList.remove('sc-open');
    }
  }

  // --------------------------------------------------------------- the pill

  function onScreen(e) { return !!(e && e.offsetParent !== null); }

  var rowMissingSince = 0;
  function actionRow() {
    var row = document.querySelector('ytd-watch-metadata #actions #top-level-buttons-computed') ||
      document.querySelector('#actions #top-level-buttons-computed') ||
      document.querySelector('#top-level-buttons-computed');
    if (onScreen(row)) { rowMissingSince = 0; return row; }
    // YouTube tries new layouts now and then. If the usual button row stays
    // missing or hidden on a watch page, use a nearby row so Gleaner stays
    // reachable. The wait keeps it from jumping around while the page loads.
    if (!document.querySelector('ytd-watch-metadata')) return row;
    if (!rowMissingSince) {
      rowMissingSince = Date.now();
      setTimeout(scheduleTick, 4100);
      return row;
    }
    if (Date.now() - rowMissingSince < 4000) return row;
    var fallback = ['ytd-watch-metadata #actions-inner', 'ytd-watch-metadata #actions', 'ytd-watch-metadata #top-row']
      .map(function (s) { return document.querySelector(s); })
      .filter(onScreen)[0];
    return fallback || row;
  }

  // Take the exact height of YouTube's own buttons in the same row.
  function matchPillHeight(pill, tries) {
    var row = pill.parentNode;
    if (!row) return;
    var h = 0, kids = row.querySelectorAll('button');
    for (var i = 0; i < kids.length && !h; i++) {
      if (kids[i] === pill) continue;
      var bh = Math.round(kids[i].getBoundingClientRect().height);
      if (bh >= 24 && bh <= 60) h = bh;
    }
    if (h) {
      pill.style.height = h + 'px';
      pill.style.lineHeight = h + 'px';
      pill.style.borderRadius = (h / 2) + 'px';
    } else if (tries < 10) {
      setTimeout(function () { matchPillHeight(pill, tries + 1); }, 300);
    }
  }

  function injectPill() {
    var row = actionRow();
    if (!row) return;
    var pill = document.getElementById('scribe-pill');
    if (pill && pill.parentNode === row) return;
    if (pill) pill.remove();
    pill = el('button', {
      id: 'scribe-pill', type: 'button',
      title: BUILD === 'dev' ? 'Copy the transcript, or send it to Claude' : 'Copy the transcript and comments, send them to Claude, or export the comments',
      'aria-expanded': String(!!(ui && ui.open)), 'aria-controls': 'scribe-panel'
    }, [BRAND, icon('chevron', 20)]);
    pill.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!(ui && ui.open));
    });
    row.appendChild(pill);
    matchPillHeight(pill, 0);
  }

  // ----------------------------------------------------------------- Shorts
  //
  // A Short gets one button in its action column (like, dislike, comments...).
  // It opens the same video on the normal watch page, where everything works,
  // and the panel opens there by itself.

  var OPEN_KEY = 'scribe.openPanel';

  function shortsId() {
    var m = /^\/shorts\/([\w-]{11})\/?$/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function removeShortsButton() {
    var b = document.getElementById('scribe-shorts');
    if (b) b.remove();
  }

  function injectShortsButton() {
    // Shorts nearby are kept in the page too; only the one on screen counts.
    var bar = [].filter.call(document.querySelectorAll('reel-action-bar-view-model'), onScreen)[0];
    var existing = document.getElementById('scribe-shorts');
    if (!bar) { if (existing) existing.remove(); return; }
    if (existing && existing.parentNode === bar) return;
    if (existing) existing.remove();
    var btn = el('button', { type: 'button', 'aria-label': 'Open in ' + BRAND, title: 'Open this Short as a normal video, with ' + BRAND + ' open' }, [icon('lines', 24)]);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = shortsId(); // read now: scrolling to the next Short changes it
      if (!id) return;
      try { sessionStorage.setItem(OPEN_KEY, id); } catch (err) {}
      location.assign('/watch?v=' + id);
    });
    bar.insertBefore(el('div', { id: 'scribe-shorts' }, [btn, el('span', { text: BRAND })]), bar.firstChild);
  }

  // Arriving from a Short's button: open the panel once, when the page is ready for it.
  function openIfAsked(videoId) {
    var want = null;
    try { want = sessionStorage.getItem(OPEN_KEY); } catch (e) {}
    if (!want) return;
    if (want !== videoId) { try { sessionStorage.removeItem(OPEN_KEY); } catch (e) {} return; }
    var pill = document.getElementById('scribe-pill');
    if (!pill || !pill.isConnected || ui.open) return;
    try { sessionStorage.removeItem(OPEN_KEY); } catch (e) {}
    setOpen(true);
  }

  // ------------------------------------------------------------------ start

  function switchVideo(videoId) {
    if (ui && ui.sendBusy) dispatchCancel('Nothing was sent: you left the video before it was ready.');
    if (ui && ui.exportJob) ui.exportJob.stop();
    if (ui && ui.clipJob) ui.clipJob.cancelled = true;
    if (ui) releaseClip(ui);
    if (ui && ui.panel) ui.panel.remove();
    var st = ui = freshState(videoId);
    rowMissingSince = 0;
    // A saved export of this video, and saving by itself, are looked at right
    // away (a moment later, so the extension's relay has loaded).
    if (videoId) setTimeout(function () { if (ui === st) loadSaved(st); }, 1500);
    var pill = document.getElementById('scribe-pill');
    if (pill) pill.setAttribute('aria-expanded', 'false');
  }

  var tickTimer = 0;
  function scheduleTick() { if (!tickTimer) tickTimer = setTimeout(tick, 60); }

  function tick() {
    tickTimer = 0;
    var videoId = currentVideoId();
    if (!ui || ui.videoId !== videoId) switchVideo(videoId);
    if (!videoId) {
      // Not a video page: take the pill away so it never sits there doing nothing.
      var stale = document.getElementById('scribe-pill');
      if (stale) stale.remove();
      if (shortsId()) injectShortsButton(); else removeShortsButton();
      return;
    }
    removeShortsButton();
    injectPill();
    openIfAsked(videoId);
    if (ui.open) {
      if (!ui.panel || !ui.panel.isConnected) {
        ui.panel = null;
        mountPanel();
        ui.panel.classList.add('sc-open');
      } else {
        placePanel(ui.panel);
      }
    }
  }

  // A small window into the state, for checking the extension from the console.
  scribe.debug = function () {
    return ui && {
      videoId: ui.videoId, open: ui.open,
      transcript: ui.transcript.state, transcriptLines: ui.transcript.lines || 0,
      details: ui.details.state,
      comments: ui.comments.state, commentCount: ui.comments.count || 0, replyCount: ui.comments.replies || 0,
      copy: ui.copy, send: ui.send, note: ui.note, lastCopyChars: ui.lastCopyChars,
      exportState: ui.exportState, exportCount: ui.exportCount, exportTotal: ui.exportTotal,
      exportWritten: ui.exportWritten, // rows already in the file, out of the page's memory
      clipOpen: ui.clipOpen, clipParts: ui.clipParts.map(function (p) { return [p.from, p.to]; }), clipSel: ui.clipSel,
      clipStatus: ui.clipJob ? ui.clipStatus : '', clipNote: ui.clipNote,
      clipBytes: ui.clipResult ? ui.clipResult.file.size : 0, clipName: ui.clipResult ? ui.clipResult.name : '',
      media: window.__gleanerMedia ? window.__gleanerMedia.state(mainVideo()) : null,
      heapMB: window.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      build: BUILD
    };
  };

  installHooks();

  function boot() {
    injectStyles();
    new MutationObserver(scheduleTick).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('yt-navigate-finish', scheduleTick);
    window.addEventListener('popstate', scheduleTick);
    // Leaving mid-capture: put captions back while the old video is loaded.
    window.addEventListener('yt-navigate-start', function () { restoreCC(); });
    window.addEventListener('pagehide', function () { restoreCC(); }); // best effort on refresh or close
    scheduleTick();
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
