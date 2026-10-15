// Builds the Chrome Web Store copy from the same source as the unpacked copy
// in this folder. Run from the project folder:
//   node tools/build-store.js
// Output: dist/store/ (load it unpacked to test) and dist/<brand>-<version>.zip
// (upload that one). The differences from the unpacked copy:
//   - its store name, short name and description, from tools/store.json
//   - the question box says "Add a question" and Enter copies
//   - no clips: the Chrome Web Store bans YouTube downloads, so CLIPS is off
//     and media-keeper.js and lib/ (the clip cutter) stay out
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'store');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'store.json'), 'utf8'));
const devManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function fail(msg) { console.error('build-store: ' + msg); process.exit(1); }

if (!config.name || config.name.length > 75) fail('store.json name is missing or over 75 characters');
if (!config.description || config.description.length > 132) fail('store.json description is missing or over 132 characters');
if (!/^[\w-]+$/.test(config.brand || '')) fail('store.json brand should be one plain word');

// Swap exactly one line, or stop: a silent miss would ship the wrong build.
function swap(source, from, to, file) {
  const parts = source.split(from);
  if (parts.length !== 2) fail(file + ': expected exactly one "' + from + '"');
  return parts.join(to);
}

let content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
content = swap(content, "var BUILD = 'dev';", "var BUILD = 'store';", 'content.js');
content = swap(content, "var BRAND = 'Gleaner';", 'var BRAND = ' + JSON.stringify(config.brand) + ';', 'content.js');
content = swap(content, 'var CLIPS = true;', 'var CLIPS = false;', 'content.js');

// Every swap worked, so only now is the last build replaced (the copy loaded in
// Chrome keeps working if a check above stops the build).
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'content.js'), content);

// LICENSE too: the MIT License asks for its notice to travel with every copy.
for (const f of ['background.js', 'relay.js', 'sidepanel.html', 'sidepanel.js', 'ai-inject.js', 'offscreen.html', 'offscreen.js', 'LICENSE']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
// The icons (the wheat stalk), the same as the unpacked copy's.
for (const size of [16, 32, 48, 128]) {
  fs.copyFileSync(path.join(ROOT, 'store', 'icons', 'icon' + size + '.png'), path.join(OUT, 'icons', 'icon' + size + '.png'));
}

const manifest = {
  manifest_version: 3,
  name: config.name,
  short_name: config.brand,
  version: devManifest.version,
  minimum_chrome_version: devManifest.minimum_chrome_version,
  description: config.description,
  icons: devManifest.icons,
  // Same scripts, permissions and side panel as the unpacked copy (Send to
  // Claude included), less the media keeper that clips need.
  content_scripts: devManifest.content_scripts.filter(function (cs) { return cs.js.indexOf('media-keeper.js') < 0; }),
  background: devManifest.background,
  side_panel: devManifest.side_panel,
  permissions: devManifest.permissions,
  host_permissions: devManifest.host_permissions
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Every file the manifest names must be in the build.
manifest.content_scripts.forEach(function (cs) {
  cs.js.forEach(function (f) { if (!fs.existsSync(path.join(OUT, f))) fail('missing from the build: ' + f); });
});
if (!fs.existsSync(path.join(OUT, manifest.side_panel.default_path))) fail('missing from the build: ' + manifest.side_panel.default_path);

const zip = path.join(DIST, config.brand.toLowerCase() + '-' + devManifest.version + '.zip');
fs.rmSync(zip, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  'Compress-Archive -Path ' + JSON.stringify(path.join(OUT, '*')) + ' -DestinationPath ' + JSON.stringify(zip)], { stdio: 'inherit' });

console.log('Built ' + manifest.name + ' ' + devManifest.version);
console.log('  folder: ' + OUT);
console.log('  zip:    ' + zip);
