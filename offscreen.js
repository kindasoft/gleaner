// The offscreen document: puts a saved comments export together into one file
// for background.js to download. The chunks are Blobs kept on disk by the
// database, so a file of any size is assembled without reading it into memory.
var DB_NAME = 'gleaner-exports';

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

// Every chunk of the video's export as { order, blob }, in file order.
function chunks(videoId) {
  return openDb().then(function (d) {
    return new Promise(function (resolve, reject) {
      var range = IDBKeyRange.bound([videoId, -Infinity], [videoId, Infinity]);
      var store = d.transaction('parts').objectStore('parts');
      var keys = store.getAllKeys(range), values = store.getAll(range);
      values.onsuccess = function () {
        d.close();
        resolve((values.result || []).map(function (blob, i) { return { order: keys.result[i][1], blob: blob }; }));
      };
      values.onerror = keys.onerror = function () { d.close(); reject(values.error || keys.error); };
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.action === 'build') {
    chunks(msg.videoId).then(function (saved) {
      // The chunks the page still held go in by their place in the file.
      var all = saved.concat((msg.extra || []).map(function (x) { return { order: x.order, blob: new Blob([x.text]) }; }));
      all.sort(function (a, b) { return a.order - b.order; });
      var file = new Blob([msg.header || ''].concat(all.map(function (x) { return x.blob; })), { type: 'text/csv;charset=utf-8' });
      sendResponse({ url: URL.createObjectURL(file), bytes: file.size });
    }, function (e) {
      sendResponse({ error: String((e && e.message) || e).slice(0, 200) });
    });
    return true; // answering asynchronously
  }
  if (msg.action === 'release') URL.revokeObjectURL(msg.url);
});
