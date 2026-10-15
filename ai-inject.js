// Runs inside the claude.ai frame that Gleaner's side panel opens. Waits for
// the message box, pastes the video in, adds the question and presses send.
// Runs in the page's own context (manifest "world": "MAIN") so it can use the
// editor's API; it talks to the side panel only by postMessage.
(function() {
  if (window.top === window.self) return; // only inside Gleaner's side panel frame
  // ...and only when an extension page (Gleaner's side panel) is the direct
  // parent. A website that frames claude.ai, or an app or artifact frame
  // inside Claude, must never be able to make this script paste and send.
  var parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  if (parentOrigin.indexOf('chrome-extension://') !== 0) return;

  var EDITOR_SELECTORS = ['div.ProseMirror[contenteditable="true"]', 'div.ProseMirror', '[contenteditable="true"]'];

  // Only the real send button. (An older fallback clicked "the last small
  // button in the box", which on claude.ai can be Dictate or the model menu.)
  var SEND_SELECTORS = ['button[data-testid="chat-input-send"]', '[data-testid="chat-input-send"] button', 'button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label="Send"]'];

  function findEditor() {
    for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
      var e = document.querySelector(EDITOR_SELECTORS[i]);
      if (e) return e;
    }
    return null;
  }

  function findSend() {
    for (var i = 0; i < SEND_SELECTORS.length; i++) {
      var b = document.querySelector(SEND_SELECTORS[i]);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
    }
    return null;
  }

  function waitFor(fn, cb, maxMs, intervalMs) {
    maxMs = maxMs || 15000;
    intervalMs = intervalMs || 250;
    var start = Date.now();
    var iv = setInterval(function() {
      var v = fn();
      if (v) { clearInterval(iv); cb(v); return; }
      if (Date.now() - start > maxMs) { clearInterval(iv); cb(null); }
    }, intervalMs);
  }

  function post(msg) {
    msg.source = 'scribe-ai-frame';
    try { window.parent.postMessage(msg, parentOrigin); } catch (e) {}
  }

  function textIn(editor) { return editor.textContent || ''; }

  // The area around the message box, which also holds attachment chips.
  function composerBox(editor) {
    var box = editor.closest('fieldset') || editor.closest('form') || editor.parentElement;
    for (var i = 0; box && i < 5 && !box.querySelector('button'); i++) box = box.parentElement;
    return box;
  }

  // Claude files a long paste as a "Pasted text" chip and keeps it in the
  // draft across reloads. Take off any left from an earlier attempt, so a send
  // only ever carries this video. Only pasted-text chips: anything else in the
  // box (a file you attached, a project) is left alone. Returns how many.
  function removeAttachments(editor) {
    var box = composerBox(editor), n = 0;
    if (!box) return 0;
    Array.prototype.forEach.call(box.querySelectorAll('button[aria-label]'), function(b) {
      if (/^remove\b.*\bpasted\b/i.test(b.getAttribute('aria-label'))) { b.click(); n++; }
    });
    return n;
  }

  // Typing a long prompt with execCommand('insertText') is very slow in these
  // editors: 100K characters froze claude.ai for over 45 seconds. A paste
  // event lands the same text in milliseconds. With replace, the paste
  // replaces what's in the box; otherwise it goes in at the end. Returns true
  // when the page took the paste.
  function paste(editor, text, replace) {
    editor.focus();
    var api = editor.editor && editor.editor.commands; // TipTap, on claude.ai
    try {
      if (replace) {
        if (api && api.selectAll) api.selectAll();
        else document.execCommand('selectAll', false, null);
      } else if (api && api.focus) {
        api.focus('end');
      } else {
        var range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
    try {
      var data = new DataTransfer();
      data.setData('text/plain', text);
      var ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      editor.dispatchEvent(ev);
      return ev.defaultPrevented;
    } catch (e) {
      return false;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // For when the page ignores the paste: the editor's own API, then plain
  // typing (only for short text, where it's still fast). insertContent keeps
  // every space (the indents that mark replies) and tells claude.ai the text
  // changed; setContent does neither on TipTap 2.
  function fallbackInsert(editor, text, replace) {
    var tt = editor.editor;
    var html = text.split('\n').map(function(l) { return '<p>' + escapeHtml(l) + '</p>'; }).join('');
    try {
      if (tt && tt.chain) {
        var chain = tt.chain().focus(replace ? undefined : 'end');
        if (replace) chain = chain.selectAll();
        if (chain.insertContent(html).run() !== false) return true;
      }
    } catch (e) {}
    if (text.length <= 20000) {
      try { return document.execCommand('insertText', false, text); } catch (e) {}
    }
    return false;
  }

  function addText(editor, text, replace) {
    if (paste(editor, text, replace)) return { ok: true, handled: true };
    return { ok: fallbackInsert(editor, text, replace), handled: false };
  }

  // What the box holds right now, for test-run reports. Structure and counts
  // only: the report can be read from the YouTube page.
  function describeComposer(editor, question) {
    var box = composerBox(editor);
    if (!box) return null;
    var inBox = textIn(editor).replace(/\s+/g, ' ').trim();
    var q = (question || '').replace(/\s+/g, ' ');
    return {
      tag: box.tagName,
      testids: Array.prototype.map.call(box.querySelectorAll('[data-testid]'), function(n) { return n.getAttribute('data-testid'); }).slice(0, 30),
      buttons: box.querySelectorAll('button').length,
      pastedChips: Array.prototype.filter.call(box.querySelectorAll('button[aria-label]'), function(b) {
        return /\bpasted\b/i.test(b.getAttribute('aria-label'));
      }).length,
      textChars: inBox.length,
      questionShown: !!q && inBox.slice(-q.length) === q
    };
  }

  // Empties the box after a test run. Shrinks it with a paste first: clearing
  // 100K characters directly freezes claude.ai the same way typing them does.
  function clearComposer(editor) {
    try {
      removeAttachments(editor);
      paste(editor, ' ', true);
      var api = editor.editor && editor.editor.commands;
      if (api && api.clearContent) api.clearContent(true);
      else { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
      return (editor.textContent || '').trim().length === 0;
    } catch (e) {
      return false;
    }
  }

  function injectPrompt(editor, text, question, dryRun) {
    var removed = removeAttachments(editor);
    setTimeout(function() {
      var started = performance.now();
      var data = addText(editor, text, true);
      if (!data.ok) { post({ type: 'error', reason: 'paste-failed' }); return; }
      if (question) {
        // Short, so it stays as text and shows as the message. When the video
        // stayed inline instead of becoming an attachment, leave a blank line.
        var sep = textIn(editor).trim() ? '\n\n' : '';
        addText(editor, sep + question, false);
      }
      var pasteMs = Math.round(performance.now() - started);

      if (dryRun) {
        // Test mode: report what landed, empty the box, never press send.
        waitFor(findSend, function(sendBtn) {
          var report = {
            type: 'dry-run', handled: data.handled, pasteMs: pasteMs, sendReady: !!sendBtn,
            removedBefore: removed, questionSent: !!question,
            want: text.replace(/\s+/g, '').length, got: textIn(editor).replace(/\s+/g, '').length,
            composer: describeComposer(editor, question)
          };
          report.cleared = clearComposer(editor);
          setTimeout(function() {
            report.composerAfter = describeComposer(editor, '');
            post(report);
          }, 600);
        }, 3000, 100);
        return;
      }

      var startPath = location.pathname;
      waitFor(findSend, function(sendBtn) {
        if (!sendBtn) {
          post({ type: 'error', reason: 'send-timeout' });
          // The prompt stays in the box for the user to send. When they do,
          // Claude moves to the new chat's address: report that, so a send
          // waiting behind this one can go.
          waitFor(function() { return location.pathname !== startPath; }, function(moved) {
            if (moved) post({ type: 'sent', pasteMs: pasteMs });
          }, 128000, 1024);
          return;
        }
        sendBtn.click();
        // Only report "sent" with proof: Claude moves to the new chat's
        // address, or the box (text and chips) empties.
        waitFor(function() { return sentProof(editor, startPath); }, function(proof) {
          post(proof ? { type: 'sent', pasteMs: pasteMs } : { type: 'error', reason: 'unconfirmed' });
        }, 16000, 250);
      }, 5000, 200);
    }, removed ? 250 : 0);
  }

  function sentProof(editor, startPath) {
    if (location.pathname !== startPath) return true;
    if (!editor.isConnected) return true; // the page swapped the box out after sending
    var box = composerBox(editor);
    var chips = box ? Array.prototype.filter.call(box.querySelectorAll('button[aria-label]'), function(b) {
      return /\bpasted\b/i.test(b.getAttribute('aria-label'));
    }).length : 0;
    return !textIn(editor).trim() && chips === 0;
  }

  // Watches until the message box shows up, however long that takes (the
  // side panel promises the prompt sends itself once it's ready, for example
  // after logging in inside the panel).
  function watchForEditor() {
    waitFor(findEditor, function(editor) { if (editor) post({ type: 'ready' }); }, Infinity, 1024);
  }

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent || e.origin !== parentOrigin) return;
    if (!e.data || e.data.source !== 'scribe-host') return;
    if (e.data.type !== 'inject') return;
    var text = e.data.prompt;
    if (!text) return;
    var question = typeof e.data.question === 'string' ? e.data.question.trim() : '';
    var dryRun = !!e.data.dryRun;
    waitFor(findEditor, function(editor) {
      if (editor) { injectPrompt(editor, text, question, dryRun); return; }
      post({ type: 'error', reason: 'editor-timeout' });
      watchForEditor();
    });
  });

  waitFor(findEditor, function(editor) {
    if (editor) { post({ type: 'ready' }); return; }
    post({ type: 'timeout' });
    watchForEditor(); // login wall or slow loading
  });
})();
