# InstaGrab — Instagram Photo, Video & Reels Downloader

One tool that downloads **everything** from a public Instagram link: single photos, carousel/album posts (every slide, full quality), videos, and Reels. This replaces the two separate projects (photo downloader + video downloader) with a single app and a single Instagram-themed frontend.

## How it works

1. **Primary method — Instagram's own internal API, called directly.** The app asks Instagram's internal GraphQL "persisted query" endpoint for the post's real data — the same JSON Instagram's own website uses to render the page. This works for photos, carousels, videos, and Reels alike, is fast, and needs no browser. This is what the app uses for the vast majority of links.
2. **Automatic fallback — a real headless browser.** If a link fails the fast method (most often because it's login-walled), and Google Chrome or Microsoft Edge is installed on your computer, the app automatically opens the post in a headless Chrome tab and reads the media straight off the rendered page instead — the same way the old dedicated video-downloader project worked. You don't have to do anything for this to kick in; if Chrome isn't installed, the app just skips this step and reports the original error.

The app tells you what kind of post it found (photo / video / carousel) and renders the right kind of result automatically.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`.

The headless-browser fallback is optional. If you never install Chrome, the app still works fully for any post the fast primary method can reach (which is most public content). If you want the fallback available too, just make sure Google Chrome or Microsoft Edge is installed — the app finds it automatically.

## Logged-in / login-walled posts

Some posts (increasingly common for Reels, and always for private accounts you have access to) require a logged-in session to view at all. You can let the app view Instagram the same way your own logged-in browser already can, by giving it a copy of your browser's Instagram session cookie. This does **not** share your password, and only lets the app see what you could already see yourself.

1. Open **instagram.com** in Chrome and make sure you're logged in.
2. Press `F12` → **Application** tab → **Cookies** → `https://www.instagram.com`.
3. Find the row named **`sessionid`** and copy its **Value**.
4. Copy `.env.example` to a new file named **`.env`**.
5. Paste the value in:
   ```
   INSTAGRAM_SESSIONID=paste-the-long-value-here
   ```
6. Save and restart the app (`npm start`).

Notes:
- Treat this cookie like a password — don't share your `.env` file or commit it to a public repo.
- The cookie eventually expires; if login walls come back, repeat the steps above with a fresh value.
- Private accounts still require the cookie to belong to an account that's actually allowed to view that content — no downloader can bypass that.
- **Stories are not supported** — they always require an authenticated session.

## Debugging

```bash
DEBUG_IG=1 npm start          # macOS/Linux
set DEBUG_IG=1 && npm start   # Windows cmd
$env:DEBUG_IG="1"; npm start  # Windows PowerShell
```

Prints which extraction method was used, what Chrome path (if any) it found, and what it saw on the page for each request.

## Project structure

```
instagram-downloader/
├── server.js          # Express server: primary GraphQL extractor + fallback Puppeteer extractor + API routes
├── package.json
├── .env.example        # Copy to .env to add your Instagram session cookie (optional)
├── views/
│   └── index.html       # Single combined downloader page
└── public/
    ├── style.css         # Instagram-themed UI
    └── script.js         # Frontend logic (renders photo / video / carousel results)
```

## If this ever stops working

Instagram periodically rotates the internal `doc_id` behind the primary GraphQL query. If every link suddenly fails at once:
1. Set `IG_DOC_ID` in `.env` to a fresh value if you have one, or
2. Look inside `fetchViaGraphQL()` in `server.js` — that's the one place the doc_id and response shape live.

If Instagram changes its embed page's HTML structure (affecting only the fallback method), the fix lives inside `extractViaBrowser()` / `collectCarousel()` in `server.js`.

## Honesty notes

- Works without any setup for **public** posts.
- Private accounts/posts require a logged-in session belonging to an account that's actually allowed to view them — no downloader bypasses that.
- Each request to the fallback browser method takes a few seconds longer than the primary method, since a real browser tab has to load and render the page.
- Not affiliated with Instagram/Meta. For personal use on content you have the right to save.
