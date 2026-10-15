// The media keeper: runs in YouTube's page before the player (MAIN world,
// document_start) and keeps a copy of the video and audio the player feeds
// itself through Media Source Extensions, indexed by time, so a clip can be
// cut from what YouTube sent (content.js, clips). It reads nothing the player
// didn't load itself, never keeps protected (DRM) media, and nothing leaves
// the page. Each player's media (the main video, a hover preview, an ad) is
// kept apart and dropped when that player lets go of it; past MAX_BYTES the
// oldest pieces go. Pieces are kept after a clip is made: the player won't
// send again what it still holds, so a piece let go too early can't come
// back. Chrome keeps big Blobs on disk, so they don't weigh on memory.
(function () {
  'use strict';
  if (window.__gleanerMedia || typeof MediaSource === 'undefined') return;

  var MAX_BYTES = 4 * 1024 * 1024 * 1024;
  var sources = [];   // one per MediaSource in use, oldest first: { ms, tracks }
  var kept = 0;       // bytes kept across sources
  var drm = false;
  var seq = 0;        // arrival order of pieces, for dropping the oldest
  var initSeq = 0;
  var bySb = new WeakMap(), byMs = new WeakMap();

  function sourceOf(ms) {
    var s = byMs.get(ms);
    if (!s) {
      s = { ms: ms, tracks: [] };
      byMs.set(ms, s);
      sources.push(s);
      // The player let go of it (another video, an ad ending, a new page).
      ms.addEventListener('sourceclose', function () {
        var i = sources.indexOf(s);
        if (i >= 0) sources.splice(i, 1);
        s.tracks.forEach(clear);
      });
    }
    return s;
  }

  function track(source, mime) {
    var t = {
      mime: String(mime || ''), kind: /^audio\//i.test(mime) ? 'audio' : 'video',
      webm: /webm/i.test(mime), pending: null, init: null, timescale: 1, trexDuration: 0, trexFlags: 0,
      ebml: null, info: null, tracksEl: null, scale: 1e-3,
      frag: null, frags: []
    };
    source.tracks.push(t);
    return t;
  }
  function clear(t) { t.frags.forEach(function (f) { kept -= f.blob.size; }); t.frags = []; }
  function clearAll() { sources.forEach(function (s) { s.tracks.forEach(clear); }); kept = 0; }

  // ------------------------------------------------------------------ bytes

  function u32(b, o) { return b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
  function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function concat(a, b) {
    if (!a || !a.length) return b;
    var c = new Uint8Array(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  }

  // ---------------------------------------------------------------- MP4 side

  // The box at o: { type, size, hdr }, or null if it doesn't fit before end.
  function box(b, o, end) {
    if (o + 8 > end) return null;
    var size = u32(b, o), hdr = 8;
    if (size === 1) { if (o + 16 > end) return null; size = u64(b, o + 8); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr) return { bad: true };
    return { type: fourcc(b, o + 4), size: size, hdr: hdr, start: o };
  }
  function kids(b, parent) {
    var out = [], o = parent.start + parent.hdr, end = parent.start + parent.size;
    while (o < end) { var k = box(b, o, end); if (!k || k.bad || o + k.size > end) break; out.push(k); o += k.size; }
    return out;
  }
  function find(b, parent, path) {
    var cur = parent;
    for (var i = 0; i < path.length && cur; i++) cur = kids(b, cur).filter(function (k) { return k.type === path[i]; })[0] || null;
    return cur;
  }

  function mp4Init(t, b, moov) {
    var mdhd = find(b, moov, ['trak', 'mdia', 'mdhd']);
    if (mdhd) {
      var o = mdhd.start + mdhd.hdr, v = b[o];
      t.timescale = v === 1 ? u32(b, o + 20) : u32(b, o + 12);
    }
    var trex = find(b, moov, ['mvex', 'trex']);
    if (trex) {
      t.trexDuration = u32(b, trex.start + trex.hdr + 12);
      t.trexFlags = u32(b, trex.start + trex.hdr + 20);
    }
    // Protected media carries encryption boxes in its init: never keep it.
    if (hasProtection(b.subarray(moov.start, moov.start + moov.size))) { drm = true; clearAll(); t.init = null; return; }
    var parts = t.ftypBytes ? [t.ftypBytes] : [];
    parts.push(b.slice(moov.start, moov.start + moov.size));
    t.init = { blob: new Blob(parts), id: ++initSeq };
  }
  function hasProtection(bytes) {
    var s = '';
    for (var i = 0; i + 4 <= bytes.length && i < 200000; i++) {
      var c = bytes[i];
      if (c === 0x70 || c === 0x65 || c === 0x74) { // p e t
        s = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
        if (s === 'pssh' || s === 'encv' || s === 'enca' || s === 'tenc') return true;
      }
    }
    return false;
  }

  // A fragment's start (tfdt) and end (trun durations) in seconds, and
  // whether its first frame is a keyframe (a decoder can start there).
  function mp4Times(t, b, moof) {
    var traf = find(b, moof, ['traf']);
    if (!traf) return null;
    var tfdt = find(b, traf, ['tfdt']), tfhd = find(b, traf, ['tfhd']), trun = find(b, traf, ['trun']);
    if (!tfdt) return null;
    var o = tfdt.start + tfdt.hdr;
    var base = b[o] === 1 ? u64(b, o + 4) : u32(b, o + 4);
    var defDur = t.trexDuration, defFlags = t.trexFlags;
    if (tfhd) {
      var ho = tfhd.start + tfhd.hdr, hf = (b[ho + 1] << 16) | (b[ho + 2] << 8) | b[ho + 3], hp = ho + 8;
      if (hf & 0x1) hp += 8;
      if (hf & 0x2) hp += 4;
      if (hf & 0x8) { defDur = u32(b, hp); hp += 4; }
      if (hf & 0x10) hp += 4;
      if (hf & 0x20) defFlags = u32(b, hp);
    }
    var dur = 0, firstFlags = defFlags;
    if (trun) {
      var ro = trun.start + trun.hdr, rf = (b[ro + 1] << 16) | (b[ro + 2] << 8) | b[ro + 3];
      var n = u32(b, ro + 4), p = ro + 8;
      if (rf & 0x1) p += 4;
      if (rf & 0x4) { firstFlags = u32(b, p); p += 4; }
      var per = ((rf & 0x100) ? 4 : 0) + ((rf & 0x200) ? 4 : 0) + ((rf & 0x400) ? 4 : 0) + ((rf & 0x800) ? 4 : 0);
      if (!(rf & 0x4) && (rf & 0x400) && n) firstFlags = u32(b, p + ((rf & 0x100) ? 4 : 0) + ((rf & 0x200) ? 4 : 0));
      if (rf & 0x100) { for (var i = 0; i < n; i++) dur += u32(b, p + i * per); }
      else dur = n * defDur;
    }
    // sample_is_non_sync_sample is bit 16 of the sample flags.
    return { t0: base / t.timescale, t1: (base + dur) / t.timescale, key: !(firstFlags & 0x10000) };
  }

  // Init (ftyp + moov), then fragments (moof + mdat). Other boxes (sidx,
  // styp, emsg) are skipped, so the kept file has no index to trip a reader.
  function feedMp4(t, b, offset) {
    var o = 0;
    for (;;) {
      var k = box(b, o, b.length);
      if (!k || k.bad || o + k.size > b.length) break; // the rest waits for more bytes
      if (k.type === 'ftyp') t.ftypBytes = b.slice(o, o + k.size);
      else if (k.type === 'moov') mp4Init(t, b, k);
      else if (k.type === 'moof') t.frag = { moof: b.slice(o, o + k.size), times: mp4Times(t, b, k) };
      else if (k.type === 'mdat' && t.frag && t.init) {
        keep(t, t.frag.times, [t.frag.moof, b.subarray(o, o + k.size)], offset);
        t.frag = null;
      }
      o += k.size;
    }
    return o;
  }

  // --------------------------------------------------------------- WebM side

  // An EBML element at o: { id, size, hdr } (size -1 when unknown), or null.
  function vint(b, o, keepMarker) {
    var first = b[o];
    if (first === undefined) return null;
    var len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || o + len > b.length) return null;
    var value = keepMarker ? first : first & (mask - 1), unknown = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < len; i++) { value = value * 256 + b[o + i]; if (b[o + i] !== 0xff) unknown = false; }
    return { value: value, len: len, unknown: unknown };
  }
  function element(b, o) {
    var id = vint(b, o, true);
    if (!id) return null;
    var size = vint(b, o + id.len, false);
    if (!size) return null;
    return { id: id.value, size: size.unknown ? -1 : size.value, hdr: id.len + size.len, start: o };
  }
  var EBML = 0x1a45dfa3, SEGMENT = 0x18538067, INFO = 0x1549a966, TRACKS = 0x1654ae6b, CLUSTER = 0x1f43b675,
    TIMECODE_SCALE = 0x2ad7b1, TIMECODE = 0xe7, SIMPLE_BLOCK = 0xa3, BLOCK_GROUP = 0xa0, BLOCK = 0xa1,
    REFERENCE_BLOCK = 0xfb, TRACK_ENTRY = 0xae, CONTENT_ENCODINGS = 0x6d80;

  function uint(b, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; }

  function webmCluster(t, b, el) {
    var o = el.start + el.hdr, end = el.start + el.size + el.hdr, tc = null, last = 0, key = null;
    while (o < end) {
      var c = element(b, o);
      if (!c || c.size < 0) break;
      var body = o + c.hdr;
      if (c.id === TIMECODE) tc = uint(b, body, c.size);
      else if (c.id === SIMPLE_BLOCK || c.id === BLOCK_GROUP) {
        var blk = c.id === SIMPLE_BLOCK ? c : null, refs = false;
        if (!blk) {
          for (var g = body; g < body + c.size;) {
            var e = element(b, g);
            if (!e || e.size < 0) break;
            if (e.id === BLOCK) blk = e;
            else if (e.id === REFERENCE_BLOCK) refs = true;
            g += e.hdr + e.size;
          }
        }
        if (blk) {
          var tn = vint(b, blk.start + blk.hdr, false);
          if (tn) {
            var at = blk.start + blk.hdr + tn.len, rel = (b[at] << 8) | b[at + 1];
            if (rel & 0x8000) rel -= 0x10000;
            last = Math.max(last, rel);
            if (key === null) key = c.id === SIMPLE_BLOCK ? !!(b[at + 2] & 0x80) : !refs;
          }
        }
      }
      o = body + c.size;
    }
    if (tc === null) return null;
    // Blocks last about 20 ms (Opus) or a frame; good enough to tell pieces apart.
    return { t0: tc * t.scale, t1: (tc + last) * t.scale + 0.02, key: key !== false };
  }

  function webmInit(t) {
    if (!t.ebml || !t.info || !t.tracksEl) return;
    if (t.encrypted) { drm = true; clearAll(); t.init = null; return; }
    // A Segment of unknown size holding just Info and Tracks, so the kept
    // pieces read as one file without the original's index (Cues).
    var head = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    t.init = { blob: new Blob([t.ebml, head, t.info, t.tracksEl]), id: ++initSeq };
  }

  function feedWebm(t, b, offset) {
    var o = 0;
    for (;;) {
      var el = element(b, o);
      if (!el) break;
      if (el.id === SEGMENT) { t.info = t.tracksEl = null; o += el.hdr; continue; }
      if (el.size < 0) break; // unknown sizes inside a Segment aren't used by YouTube
      if (o + el.hdr + el.size > b.length) break; // waits for more bytes
      var bytes = b.subarray(o, o + el.hdr + el.size);
      if (el.id === EBML) t.ebml = bytes.slice();
      else if (el.id === INFO) {
        t.info = bytes.slice();
        var io = o + el.hdr, iend = io + el.size;
        while (io < iend) { var c = element(b, io); if (!c || c.size < 0) break; if (c.id === TIMECODE_SCALE) t.scale = uint(b, io + c.hdr, c.size) / 1e9; io += c.hdr + c.size; }
      } else if (el.id === TRACKS) {
        t.tracksEl = bytes.slice();
        t.encrypted = encryptedTracks(b, el);
        webmInit(t);
      } else if (el.id === CLUSTER && t.init) {
        keep(t, webmCluster(t, b, el), [bytes], offset);
      }
      o += el.hdr + el.size;
    }
    return o;
  }
  // True when a TrackEntry has ContentEncodings (WebM's encryption carrier).
  function encryptedTracks(b, tracksEl) {
    var o = tracksEl.start + tracksEl.hdr, end = o + tracksEl.size;
    while (o < end) {
      var entry = element(b, o);
      if (!entry || entry.size < 0) return false;
      if (entry.id === TRACK_ENTRY) {
        var c = o + entry.hdr, cend = c + entry.size;
        while (c < cend) {
          var k = element(b, c);
          if (!k || k.size < 0) break;
          if (k.id === CONTENT_ENCODINGS) return true;
          c += k.hdr + k.size;
        }
      }
      o += entry.hdr + entry.size;
    }
    return false;
  }

  // ----------------------------------------------------------------- keeping

  // offset: the SourceBuffer's timestampOffset, which moves media time to
  // the player's time.
  function keep(t, times, parts, offset) {
    if (!times || !t.init || drm) return;
    var blob = new Blob(parts), t0 = times.t0 + offset;
    // A piece YouTube sends again replaces the older copy.
    t.frags = t.frags.filter(function (f) {
      if (f.init === t.init && f.offset === offset && Math.abs(f.t0 - t0) < 0.001) { kept -= f.blob.size; return false; }
      return true;
    });
    t.frags.push({ t0: t0, t1: times.t1 + offset, key: times.key, offset: offset, init: t.init, blob: blob, seq: ++seq });
    kept += blob.size;
    while (kept > MAX_BYTES) dropOldest();
  }
  function dropOldest() {
    var oldest = null, owner = null;
    sources.forEach(function (s) {
      s.tracks.forEach(function (t) { t.frags.forEach(function (f) { if (!oldest || f.seq < oldest.seq) { oldest = f; owner = t; } }); });
    });
    if (!oldest) { kept = 0; return; }
    owner.frags.splice(owner.frags.indexOf(oldest), 1);
    kept -= oldest.blob.size;
  }

  function feed(t, data, offset) {
    if (drm) return;
    var view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    var b = t.pending ? concat(t.pending, view) : view;
    var used = t.webm ? feedWebm(t, b, offset) : feedMp4(t, b, offset);
    var rest = b.length - used;
    // Keep what didn't finish for the next append (copied: the player may reuse its buffer).
    t.pending = rest > 0 ? b.slice(used) : null;
    if (t.pending && t.pending.length > 64 * 1024 * 1024) t.pending = null; // not media we understand
  }

  // ------------------------------------------------------------------- hooks

  var addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    var sb = addSourceBuffer.apply(this, arguments);
    try { bySb.set(sb, track(sourceOf(this), mime)); } catch (e) {}
    return sb;
  };
  var appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    // First the player's own append: when the buffer is full it throws and
    // the player sends the same bytes again, which mustn't be read twice.
    var result = appendBuffer.apply(this, arguments);
    try { var t = bySb.get(this); if (t && data) feed(t, data, this.timestampOffset || 0); } catch (e) {}
    return result;
  };
  // The player resets its parser (when it seeks, say): a half-sent piece won't be finished.
  var abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    try { var t = bySb.get(this); if (t) { t.pending = null; t.frag = null; } } catch (e) {}
    return abort.apply(this, arguments);
  };
  if (SourceBuffer.prototype.changeType) {
    var changeType = SourceBuffer.prototype.changeType;
    SourceBuffer.prototype.changeType = function (mime) {
      try {
        var t = bySb.get(this);
        if (t) { t.mime = String(mime || ''); t.webm = /webm/i.test(mime); t.pending = null; t.frag = null; t.init = null; }
      } catch (e) {}
      return changeType.apply(this, arguments);
    };
  }
  // Protected media: any sign of DRM stops keeping, for good on this page.
  var setMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
  if (setMediaKeys) {
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) { drm = true; clearAll(); }
      return setMediaKeys.apply(this, arguments);
    };
  }
  document.addEventListener('encrypted', function () { drm = true; clearAll(); }, true);

  // ------------------------------------------------------------------- reads

  // The media of the player that video shows: the MediaSource whose length is
  // the video's (a hover preview's or an ad's isn't), the newest if several.
  function sourceFor(video) {
    var d = video && video.duration, best = null;
    sources.forEach(function (s) {
      var has = s.tracks.some(function (t) { return t.frags.length; });
      if (!has) return;
      var len = NaN;
      try { len = s.ms.duration; } catch (e) {}
      if (isFinite(d) && isFinite(len) && Math.abs(len - d) < 0.5) best = s;
      else if (!isFinite(d) && !best) best = s;
    });
    return best;
  }

  // A track's pieces by quality (init and offset), each sorted by time, sharpest
  // (most bytes a second) first.
  function groups(t) {
    var map = {}, list = [];
    t.frags.forEach(function (f) {
      var k = f.init.id + ':' + f.offset, g = map[k];
      if (!g) { g = map[k] = { init: f.init, offset: f.offset, frags: [], bytes: 0, secs: 0 }; list.push(g); }
      g.frags.push(f);
      g.bytes += f.blob.size;
      g.secs += Math.max(0.001, f.t1 - f.t0);
    });
    list.forEach(function (g) { g.frags.sort(function (a, b) { return a.t0 - b.t0; }); g.rate = g.bytes / g.secs; });
    return list.sort(function (a, b) { return b.rate - a.rate; });
  }

  // From `at`, the pieces of one quality that play on without a gap, starting
  // back at the keyframe they decode from: { frags, from, to }, or null.
  function chain(g, at, end) {
    var fs = g.frags, i = -1;
    for (var k = 0; k < fs.length; k++) if (fs[k].t0 <= at + 0.001 && fs[k].t1 > at) i = k;
    if (i < 0) return null;
    var a = i;
    while (!fs[a].key && a > 0 && fs[a - 1].t1 >= fs[a].t0 - 0.05) a--;
    var j = i;
    while (fs[j].t1 < end && j + 1 < fs.length && fs[j + 1].t0 <= fs[j].t1 + 0.05) j++;
    return { frags: fs.slice(a, j + 1), from: at, to: fs[j].t1 };
  }

  // For [start, end) of the player's time: { runs: [{ blob, from, to, offset }],
  // mime }, where each run is one file of one quality, together covering it
  // in order; or { missing: [[a, b], ...] } with the stretches not kept yet.
  function pick(kind, start, end, video) {
    var s = sourceFor(video), t = null;
    if (s) s.tracks.forEach(function (x) { if (x.kind === kind && x.frags.length) t = x; });
    if (!t) return { missing: [[start, end]] };
    var gs = groups(t), runs = [], missing = [], at = start;
    while (at < end - 0.001) {
      var run = null;
      for (var i = 0; i < gs.length && !run; i++) {
        run = chain(gs[i], at, end);
        if (run) { run.init = gs[i].init; run.offset = gs[i].offset; }
      }
      if (run) { runs.push(run); at = run.to; continue; }
      // Nothing holds this moment: missing up to the next piece that starts later.
      var next = end;
      gs.forEach(function (g) { g.frags.forEach(function (f) { if (f.t0 > at && f.t0 < next) next = f.t0; }); });
      missing.push([at, next]);
      at = next;
    }
    if (missing.length) return { missing: missing };
    return {
      mime: t.mime,
      runs: runs.map(function (r) {
        return {
          blob: new Blob([r.init.blob].concat(r.frags.map(function (f) { return f.blob; }))),
          from: r.from, to: r.to, offset: r.offset, quality: r.init.id
        };
      })
    };
  }

  function mainTracks(video) { var s = sourceFor(video); return s ? s.tracks : []; }

  window.__gleanerMedia = {
    version: 3,
    protected: function () { return drm; },
    pick: pick,
    // Whether the video's player has a stream of this kind at all (a few
    // videos have no sound).
    has: function (kind, video) { return mainTracks(video).some(function (t) { return t.kind === kind; }); },
    // Every piece kept of one kind, in time order, for copying as is:
    // { t0, t1, key, quality, offset, blob, init } (init: the file start
    // that the piece's quality needs in front of it).
    list: function (kind, video) {
      var out = [];
      mainTracks(video).forEach(function (t) {
        if (t.kind !== kind) return;
        t.frags.forEach(function (f) {
          out.push({ t0: f.t0, t1: f.t1, key: f.key, quality: f.init.id, offset: f.offset, blob: f.blob, init: f.init.blob });
        });
      });
      return out.sort(function (a, b) { return a.t0 - b.t0; });
    },
    // Lets go of the pieces that end before `before` (a clip done with them).
    release: function (before, video) {
      mainTracks(video).forEach(function (t) {
        t.frags = t.frags.filter(function (f) {
          if (f.t1 > before) return true;
          kept -= f.blob.size;
          return false;
        });
      });
    },
    // A summary, for checking from the console.
    state: function (video) {
      var main = sourceFor(video || document.querySelector('#movie_player video'));
      return {
        drm: drm, keptMB: Math.round(kept / 1048576), players: sources.length,
        tracks: main ? main.tracks.map(function (t) {
          var f = t.frags.slice().sort(function (a, b) { return a.t0 - b.t0; });
          return {
            kind: t.kind, mime: t.mime, pieces: f.length, qualities: groups(t).length,
            keys: f.filter(function (x) { return x.key; }).length,
            from: f.length ? +f[0].t0.toFixed(3) : null, to: f.length ? +f[f.length - 1].t1.toFixed(3) : null
          };
        }) : []
      };
    }
  };
})();
