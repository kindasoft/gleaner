# Gleaner

Copy any YouTube video's transcript, details and comments for your AI in one click, send it all to Claude, export every comment to a spreadsheet, or cut clips from the video. Free and open source.

![Gleaner's panel under a YouTube video](store/screenshots/1-copy.png)

## What it does
- **Copy**: one block of text with the video's details (title, channel, date, views, likes, tags, description, chapters), the full transcript with timestamps, and up to 320 top comments with their replies. If you type a question, it goes at the end.
- **Send to Claude**: opens claude.ai in Chrome's side panel, next to the video, and sends it everything, in your own Claude account.
- **Export comments**: every comment and every reply on a video, however many there are, as a CSV file for Excel, Google Sheets or Numbers. Each reply sits under the comment it answers. A huge video takes hours, so Stop pauses it anytime: Save spreadsheet gives you what has loaded so far, and Continue carries on. Exports are saved on your computer as they go, so you can close the tab and continue another day, and Update adds just the comments posted since. This build also starts saving a video's comments by itself as soon as you open it; the switch at the top of the panel turns that off.
- **Shorts**: a button on Shorts opens the Short as a normal video with the panel ready.
- **Clips** (this version only, not the store build): the whole video as a bar of thumbnails, with two needles for each part you want; drag them (the video follows), add as many parts as you like, and Make clip joins them, in order and with no gap, into one MP4. Cuts are frame-exact: each part starts on the frame on screen at its start needle and ends on the one at its end needle. Whole video saves the entire video as YouTube sent it, without re-encoding. Nothing is downloaded behind the player's back: Gleaner keeps what the YouTube player itself loads, and moves the player to load the parts you picked. Protected (DRM) videos are refused.

No API key, no account, no servers and no tracking.

![Exporting every comment and reply](store/screenshots/2-export.png)

## Install
It isn't on the Chrome Web Store yet. To load it from this code (Chrome 116 or newer):
1. Download this repository (Code, then Download ZIP) and unzip it, or clone it.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click Load unpacked and pick the folder.

The folder loads as the developer build: Enter in the question box sends to Claude, clips are on, and a few test hooks work. For the build that goes to the store (Enter copies, no clips, since the Chrome Web Store doesn't allow YouTube downloads), run `node tools/build-store.js` (needs Node.js) and load `dist/store` instead.

## How it works
- `content.js` runs inside YouTube's own page (`"world": "MAIN"`) so it can read the player. It gets the transcript by catching the player's own caption request (if captions are off, it turns them on for a moment and back off), reads the details from the player and the page, and reads comments through the same endpoint the page uses.
- `relay.js` passes messages between the page and the rest of the extension.
- `background.js` keeps saved exports in the extension's own storage (IndexedDB) and saves the file through Chrome's downloads, with `offscreen.html` putting the chunks together. It also opens the side panel for Send. While the panel is open, a session rule lets claude.ai load inside it; the rule only matches frames outside browser tabs, so no website can frame claude.ai because of it.
- `sidepanel.html` and `sidepanel.js` show a fresh claude.ai chat. `ai-inject.js` runs in that frame only: it pastes the video as an attachment, puts your question in the message box and presses send.
- Export reads YouTube's "Newest first" order, because "Top comments" stops near 1,000 on big videos.
- `media-keeper.js` starts before YouTube's player and keeps a copy of the video and sound the player feeds itself (Media Source Extensions), piece by piece, by time. Clips are cut from that: the pieces are decoded on the CPU and encoded on the GPU with WebCodecs, several windows at once, and written to the browser's private storage as they're made, so length and size aren't limited. `lib/mediabunny.js` reads and writes the video files; it's loaded into the page only when you make a clip.

## Privacy
Gleaner reads the video page you open it on and nothing else. It has no servers, ads, analytics or tracking. The only time anything leaves your browser is Send to Claude, and that goes to your own Claude account. Clips stay on your computer: the video pieces stay in the tab, and a clip waits in your browser's storage until you save it (clips older than a day are removed). Full policy: https://sites.google.com/view/gleaner-extension/privacy

## License
MIT (see [LICENSE](LICENSE)): do whatever you want with it, including changing it, sharing it and selling it. Just keep the license notice in your copy. It comes as is, with no warranty.

One file comes from elsewhere: `lib/mediabunny.js` is [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.5, unchanged, under the Mozilla Public License 2.0 (its text is in `lib/mediabunny.LICENSE.txt`).

Gleaner isn't made by, endorsed by or affiliated with YouTube, Google or Anthropic.

Contact: shudder-thrum.9i@icloud.com
