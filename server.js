const express = require("express");
const cors = require("cors");
const axios = require("axios");
const qs = require("qs");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_IG === "1"; // set DEBUG_IG=1 for verbose logs

// ---------- .env loader ----------
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const IG_SESSION_COOKIES = {
  sessionid: process.env.INSTAGRAM_SESSIONID || "",
  ds_user_id: process.env.INSTAGRAM_DS_USER_ID || "",
  csrftoken: process.env.INSTAGRAM_CSRFTOKEN || "",
};
const HAS_IG_SESSION = Boolean(IG_SESSION_COOKIES.sessionid);

const GRAPHQL_DOC_ID = process.env.IG_DOC_ID || "27128499623469141";
const IG_APP_ID = "936619743392459";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Puppeteer (browser-automation fallback) is optional — only loaded if
// installed and only used when the fast GraphQL path fails (e.g. a
// login-walled Reel). The app works fully for public photos/carousels/videos
// without it.
let puppeteer = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  // not installed — fallback path just won't be available
}

function log(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local disk folder for media we can only read out of an in-browser blob:
// URL (Puppeteer fallback path only — see resolveIfBlob).
const TMP_DIR = path.join(__dirname, "tmp_downloads");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
for (const f of fs.readdirSync(TMP_DIR)) {
  fs.unlinkSync(path.join(TMP_DIR, f));
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(TMP_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// ================================================================
// SHARED HELPERS
// ================================================================

function extractShortcode(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

// ================================================================
// METHOD 1 (PRIMARY): Instagram's internal GraphQL "persisted query"
// endpoint — the same JSON Instagram's own web app uses to hydrate a post
// page. Works for photos, carousels/albums, AND videos/reels, since a v1
// media item carries image_versions2/video_versions either way. No browser
// needed, so this is fast and doesn't require Chrome to be installed.
//
// Instagram rotates the doc_id behind this query from time to time. If
// every fetch suddenly starts failing, this is the first thing to check —
// see README.md "If this ever stops working".
// ================================================================

function cookieHeader(extraCsrf) {
  const parts = [];
  if (HAS_IG_SESSION) {
    parts.push(`sessionid=${IG_SESSION_COOKIES.sessionid}`);
    if (IG_SESSION_COOKIES.ds_user_id) parts.push(`ds_user_id=${IG_SESSION_COOKIES.ds_user_id}`);
  }
  const csrf = IG_SESSION_COOKIES.csrftoken || extraCsrf;
  if (csrf) parts.push(`csrftoken=${csrf}`);
  return parts.join("; ");
}

async function getCsrfToken() {
  if (IG_SESSION_COOKIES.csrftoken) return IG_SESSION_COOKIES.csrftoken;
  try {
    const headers = { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" };
    if (HAS_IG_SESSION) headers["Cookie"] = cookieHeader();
    const res = await axios.get("https://www.instagram.com/", {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });
    const setCookie = res.headers["set-cookie"] || [];
    for (const c of setCookie) {
      const m = c.match(/csrftoken=([^;]+)/);
      if (m) return m[1];
    }
    log("no csrftoken cookie in homepage response, status was", res.status);
  } catch (e) {
    log("csrf fetch failed:", e.message);
  }
  return crypto.randomBytes(16).toString("hex");
}

function describeFailure(status, data) {
  const bits = [`HTTP ${status}`];
  if (data && typeof data === "object") {
    if (data.message) bits.push(`message: ${data.message}`);
    if (data.status) bits.push(`status: ${data.status}`);
    if (Array.isArray(data.errors) && data.errors.length) {
      bits.push(`errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
    }
    if (data.require_login) bits.push("login required");
  } else if (typeof data === "string" && data.trim()) {
    bits.push(`body: ${data.trim().slice(0, 150)}`);
  }
  return bits.join(" | ");
}

async function fetchViaGraphQL(shortcode) {
  const csrftoken = await getCsrfToken();

  const body = qs.stringify({
    variables: JSON.stringify({
      shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    }),
    doc_id: GRAPHQL_DOC_ID,
  });

  const headers = {
    "User-Agent": BROWSER_UA,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "X-CSRFToken": csrftoken,
    "X-IG-App-ID": IG_APP_ID,
    "X-Asbd-Id": "129477",
    "X-IG-WWW-Claim": "0",
    "X-Requested-With": "XMLHttpRequest",
    Origin: "https://www.instagram.com",
    Referer: `https://www.instagram.com/p/${shortcode}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    Cookie: cookieHeader(csrftoken),
  };

  log("[graphql] fetching", shortcode, HAS_IG_SESSION ? "(with session cookie)" : "(anonymous)");

  const { status, data } = await axios.post("https://www.instagram.com/graphql/query", body, {
    headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  const webInfo = data && data.data && data.data.xdt_api__v1__media__shortcode__web_info;
  const media =
    (webInfo && Array.isArray(webInfo.items) && webInfo.items[0]) ||
    (data && data.data && data.data.xdt_shortcode_media) ||
    null;

  if (!media) {
    const detail = describeFailure(status, data);
    log("[graphql] no media:", detail);
    return { media: null, detail };
  }
  return { media, detail: null };
}

async function fetchPostDataViaGraphQL(shortcode) {
  let attempt = await fetchViaGraphQL(shortcode);
  if (attempt.media) return attempt.media;

  if (attempt.detail && attempt.detail.includes("execution error")) {
    log("transient execution error, retrying once...");
    await delay(1200);
    attempt = await fetchViaGraphQL(shortcode);
    if (attempt.media) return attempt.media;
  }

  const base = HAS_IG_SESSION
    ? "Could not load this post even with the Instagram session cookie in .env. It may be private, deleted, age-restricted, or the cookie has expired."
    : "Could not load this post. It may be private, age-restricted, or require a login.";
  throw new Error(`${base} [debug: ${attempt.detail}]`);
}

function bestFromCandidates(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = [...list].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0].url;
}

function mapV1Node(node) {
  const isVideo = node.media_type === 2; // 1 = photo, 2 = video, 8 = carousel
  const imageUrl = bestFromCandidates(node.image_versions2 && node.image_versions2.candidates);
  if (isVideo) {
    return {
      type: "video",
      url: bestFromCandidates(node.video_versions),
      thumbnail: imageUrl,
      width: node.original_width,
      height: node.original_height,
    };
  }
  return {
    type: "image",
    url: imageUrl,
    thumbnail: imageUrl,
    width: node.original_width,
    height: node.original_height,
  };
}

function extractMediaItemsFromPostData(postData) {
  if (postData.media_type === 8 && Array.isArray(postData.carousel_media)) {
    return postData.carousel_media.map(mapV1Node);
  }
  return [mapV1Node(postData)];
}

// Tries the primary (GraphQL) method end-to-end. Returns a unified result
// shape, or throws.
async function fetchViaPrimaryMethod(shortcode) {
  const postData = await fetchPostDataViaGraphQL(shortcode);
  const items = extractMediaItemsFromPostData(postData);
  const rawCaption = postData.caption && postData.caption.text;
  const title = (rawCaption || "Instagram Post").slice(0, 120);
  return buildUnifiedResult(title, items);
}

function buildUnifiedResult(title, items) {
  const cleanItems = items.filter((i) => i && i.url);
  if (!cleanItems.length) return null;
  const type = cleanItems.length > 1 ? "carousel" : cleanItems[0].type;
  return { title, type, items: cleanItems };
}

// ================================================================
// METHOD 2 (FALLBACK): real headless browser via Puppeteer, driving an
// already-installed Chrome/Edge. Slower, but can get past some login walls
// (with a session cookie) and situations where the GraphQL endpoint alone
// comes back empty. Only used when method 1 fails AND Chrome is available.
// ================================================================

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const home = os.homedir();
  const platform = os.platform();
  let candidates = [];
  if (platform === "win32") {
    candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(home, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  } else if (platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  } else {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge",
    ];
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let browserPromise = null;
async function getBrowser() {
  if (!puppeteer) throw new Error("puppeteer-core is not installed");
  if (!browserPromise) {
    const executablePath = findChromePath();
    if (!executablePath) {
      throw new Error(
        "Could not find Google Chrome or Microsoft Edge on this computer for fallback extraction."
      );
    }
    log("using browser at", executablePath);
    browserPromise = puppeteer
      .launch({
        headless: "new",
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

async function forceImagesToLoad(frame) {
  try {
    await frame.evaluate(async () => {
      function bestFromSrcset(srcset) {
        if (!srcset) return null;
        let best = null;
        let bestW = 0;
        for (const part of srcset.split(",")) {
          const trimmed = part.trim();
          const m = trimmed.match(/^(\S+)\s+(\d+)w$/);
          if (m) {
            const w = parseInt(m[2], 10);
            if (w >= bestW) {
              bestW = w;
              best = m[1];
            }
          } else if (!best) {
            best = trimmed.split(/\s+/)[0];
          }
        }
        return best;
      }
      const imgs = Array.from(document.querySelectorAll("img"));
      await Promise.all(
        imgs.map((img) => {
          img.loading = "eager";
          const better = bestFromSrcset(img.getAttribute("srcset"));
          if (better && img.src !== better) img.src = better;
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 2500);
          });
        })
      );
    });
  } catch {
    // cross-origin or detached frame — skip it
  }
}

async function forceImagesToLoadOnAllFrames(page) {
  for (const frame of page.frames()) {
    await forceImagesToLoad(frame);
  }
}

function extractMediaFromHtml(html) {
  function unescapeUrl(url) {
    return url.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\u003[Dd]/g, "=");
  }
  const videoUrls = new Set();
  for (const re of [/"video_url":"(https:[^"]+?)"/g, /"playback_url":"(https:[^"]+?)"/g]) {
    let m;
    while ((m = re.exec(html))) videoUrls.add(unescapeUrl(m[1]));
  }
  const versionsRe = /"video_versions":\[(.*?)\]/g;
  let vm;
  while ((vm = versionsRe.exec(html))) {
    const urlRe = /"url":"(https:[^"]+?)"/g;
    let um;
    while ((um = urlRe.exec(vm[1]))) videoUrls.add(unescapeUrl(um[1]));
  }
  const imageUrls = new Set();
  for (const re of [/"display_url":"(https:[^"]+?)"/g]) {
    let m;
    while ((m = re.exec(html))) imageUrls.add(unescapeUrl(m[1]));
  }
  return {
    video: videoUrls.size ? [...videoUrls][0] : null,
    images: [...imageUrls],
  };
}

async function grabCurrentMedia(page, opts = {}) {
  const { wantVideo = true, wantImage = true } = opts;
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(
        ({ wantVideo, wantImage }) => {
          function bestWidthFromSrcset(srcset) {
            if (!srcset) return 0;
            let maxW = 0;
            for (const part of srcset.split(",")) {
              const m = part.trim().match(/(\d+)w$/);
              if (m) maxW = Math.max(maxW, parseInt(m[1], 10));
            }
            return maxW;
          }
          if (wantVideo) {
            const video = document.querySelector("video");
            if (video && (video.currentSrc || video.src)) {
              return { url: video.currentSrc || video.src, isVideo: true };
            }
          }
          if (wantImage) {
            const imgs = Array.from(document.querySelectorAll("img"))
              .filter((img) => img.src && img.src.includes("cdninstagram"))
              .map((img) => ({
                url: img.src,
                width: Math.max(img.naturalWidth || 0, bestWidthFromSrcset(img.getAttribute("srcset"))),
              }))
              .filter((img) => img.width > 150)
              .sort((a, b) => b.width - a.width);
            if (imgs.length) return { url: imgs[0].url, isVideo: false };
          }
          return null;
        },
        { wantVideo, wantImage }
      );
      if (result) return { ...result, frame };
    } catch {
      // cross-origin or detached frame — skip it
    }
  }
  return null;
}

async function saveBlobToDisk(frame, blobUrl) {
  const dataUrl = await frame.evaluate(async (url) => {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }, blobUrl);

  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const mime = match[1];
  const base64 = match[2];
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("webm") ? "webm" : mime.includes("quicktime") ? "mov" : "mp4";
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(TMP_DIR, filename), Buffer.from(base64, "base64"));
  log(`saved blob to disk: /media/${filename}`);
  return `/media/${filename}`;
}

async function resolveIfBlob(media) {
  if (!media || !media.url || !media.url.startsWith("blob:")) {
    return media ? media.url : null;
  }
  try {
    return await saveBlobToDisk(media.frame, media.url);
  } catch (e) {
    log("failed to resolve blob URL:", e.message);
    return null;
  }
}

async function clickPlayOverlay(page) {
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const textMatches = all
          .filter((el) => {
            const t = (el.textContent || "").trim().toLowerCase();
            return t.length > 0 && t.length < 60 && t.includes("watch on instagram");
          })
          .sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        if (textMatches[0]) return textMatches[0];
        const svgPlay = document.querySelector("svg[aria-label*='play' i]");
        if (svgPlay) return svgPlay.closest("button, a, div") || svgPlay;
        return null;
      });
      const element = handle.asElement();
      if (element) {
        await element.click({ delay: 50 });
        return true;
      }
    } catch {
      // cross-origin or detached frame — skip it
    } finally {
      if (handle) await handle.dispose().catch(() => {});
    }
  }
  return false;
}

function watchForVideoResponse(page) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (url) => {
      if (!done) {
        done = true;
        page.off("response", handler);
        resolve(url);
      }
    };
    const handler = (response) => {
      try {
        const url = response.url();
        const ct = response.headers()["content-type"] || "";
        if (
          (ct.startsWith("video/") || /\.mp4(\?|$)/i.test(url)) &&
          (url.includes("cdninstagram") || url.includes("fbcdn"))
        ) {
          finish(url);
        }
      } catch {
        // ignore
      }
    };
    page.on("response", handler);
    setTimeout(() => finish(null), 6000);
  });
}

async function dismissOverlays(page) {
  const buttonTexts = [
    "Allow all cookies",
    "Accept all",
    "Allow essential and optional cookies",
    "Continue",
    "See post",
    "Not now",
  ];
  for (const text of buttonTexts) {
    try {
      const clicked = await page.evaluate((text) => {
        const els = Array.from(document.querySelectorAll("button, div[role='button']"));
        const match = els.find((el) => (el.textContent || "").trim() === text);
        if (match) {
          match.click();
          return true;
        }
        return false;
      }, text);
      if (clicked) {
        log("dismissed overlay:", text);
        await delay(800);
      }
    } catch {
      // ignore
    }
  }
}

async function detectBlockReason(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || "").catch(() => "");
  const lower = bodyText.toLowerCase();

  if (lower.includes("sorry, this page isn't available")) {
    return "This post doesn't exist anymore, or the link is incorrect.";
  }
  if (lower.includes("this account is private")) {
    return "This account is private — public downloads aren't possible for private accounts.";
  }

  const loginWallPhrases = [
    "to see photos and videos",
    "log in to continue",
    "log in to see",
    "you must log in",
    "sign up to see",
  ];
  const hasLoginText = loginWallPhrases.some((p) => lower.includes(p));

  const hasLoginForm = await page
    .evaluate(() => {
      const pwInput = document.querySelector('input[type="password"]');
      if (!pwInput) return false;
      const rect = pwInput.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && pwInput.offsetParent !== null;
    })
    .catch(() => false);

  if (hasLoginText || hasLoginForm) {
    return HAS_IG_SESSION
      ? "This post requires logging in to view, and the Instagram session cookie in .env didn't grant access — it may have expired."
      : "This post requires logging in to view — add your own Instagram session cookie in a .env file (see README.md).";
  }
  return null;
}

async function saveDebugArtifacts(page, shortcode, note) {
  try {
    const shotPath = path.join(__dirname, `debug-${shortcode}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    const bodyText = await page.evaluate(() => document.body.innerText || "").catch(() => "");
    const logPath = path.join(__dirname, "debug-log.txt");
    const entry = `\n--- ${new Date().toISOString()} | shortcode: ${shortcode} | ${note} ---\n${bodyText.slice(0, 1000)}\n`;
    fs.appendFileSync(logPath, entry);
    log(`screenshot saved: ${shotPath}, details appended to ${logPath}`);
  } catch (e) {
    log("could not save debug artifacts:", e.message);
  }
}

async function findButtonAcrossFrames(page, selector) {
  for (const frame of page.frames()) {
    try {
      const btn = await frame.$(selector);
      if (btn) return btn;
    } catch {
      // cross-origin or detached frame — skip it
    }
  }
  return null;
}

async function collectCarousel(page) {
  const seen = new Set();
  const items = [];

  await forceImagesToLoadOnAllFrames(page);
  const first = await grabCurrentMedia(page);
  if (first) {
    seen.add(first.url);
    items.push(first);
  }

  for (let i = 0; i < 9; i++) {
    const nextBtn = await findButtonAcrossFrames(page, 'button[aria-label="Next"]');
    if (!nextBtn) break;
    try {
      await nextBtn.click();
    } catch {
      break;
    }
    await delay(700);
    await forceImagesToLoadOnAllFrames(page);
    const item = await grabCurrentMedia(page);
    if (!item || seen.has(item.url)) break;
    seen.add(item.url);
    items.push(item);
  }
  return items;
}

async function grabOgVideo(page) {
  try {
    const secure = await page
      .$eval('meta[property="og:video:secure_url"]', (el) => el.content)
      .catch(() => null);
    if (secure) return secure;
    return await page.$eval('meta[property="og:video"]', (el) => el.content).catch(() => null);
  } catch {
    return null;
  }
}

async function extractViaBrowser(page, shortcode, title) {
  const single = await grabCurrentMedia(page);
  log("single media:", single);

  if (single && single.isVideo) {
    const resolvedUrl = await resolveIfBlob(single);
    if (resolvedUrl) return buildUnifiedResult(title, [{ type: "video", url: resolvedUrl }]);
  }

  const ogVideo = await grabOgVideo(page);
  if (ogVideo) {
    log("found video via og:video meta tag:", ogVideo);
    return buildUnifiedResult(title, [{ type: "video", url: ogVideo }]);
  }

  const htmlMedia = await page.content().then(extractMediaFromHtml).catch(() => ({ video: null, images: [] }));
  if (htmlMedia.video) {
    log("found video via embedded page JSON:", htmlMedia.video);
    return buildUnifiedResult(title, [{ type: "video", url: htmlMedia.video }]);
  }

  const videoResponsePromise = watchForVideoResponse(page);
  const clickedPlay = await clickPlayOverlay(page);
  log("clicked play overlay:", clickedPlay);
  if (clickedPlay) {
    await delay(1500);
    const afterClick = await grabCurrentMedia(page);
    if (afterClick && afterClick.isVideo) {
      const resolvedUrl = await resolveIfBlob(afterClick);
      if (resolvedUrl) return buildUnifiedResult(title, [{ type: "video", url: resolvedUrl }]);
    }
    const sniffedUrl = await videoResponsePromise;
    if (sniffedUrl) {
      log("found video via network sniff:", sniffedUrl);
      return buildUnifiedResult(title, [{ type: "video", url: sniffedUrl }]);
    }
  }

  // Not a video (or couldn't confirm one) — try for photo/carousel instead.
  await forceImagesToLoadOnAllFrames(page);
  const carousel = await collectCarousel(page);
  log("carousel items:", carousel.length);

  if (carousel.length >= 1) {
    const items = carousel.map((c) => ({ type: c.isVideo ? "video" : "image", url: c.url }));
    return buildUnifiedResult(title, items);
  }

  if (single) {
    return buildUnifiedResult(title, [{ type: single.isVideo ? "video" : "image", url: single.url }]);
  }

  // Last resort: navigate to the real post page and try once more.
  const realUrl = `https://www.instagram.com/p/${shortcode}/`;
  try {
    await page.goto(realUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(1500);
    const realBlockReason = await detectBlockReason(page);
    if (realBlockReason) throw new Error(realBlockReason);

    const realOgVideo = await grabOgVideo(page);
    if (realOgVideo) return buildUnifiedResult(title, [{ type: "video", url: realOgVideo }]);

    const realHtmlMedia = await page.content().then(extractMediaFromHtml).catch(() => ({ video: null, images: [] }));
    if (realHtmlMedia.video) return buildUnifiedResult(title, [{ type: "video", url: realHtmlMedia.video }]);

    const realVideoPromise = watchForVideoResponse(page);
    const realMedia = await grabCurrentMedia(page);
    if (realMedia && realMedia.isVideo) {
      const resolvedUrl = await resolveIfBlob(realMedia);
      if (resolvedUrl) return buildUnifiedResult(title, [{ type: "video", url: resolvedUrl }]);
    }
    const realSniffed = await realVideoPromise;
    if (realSniffed) return buildUnifiedResult(title, [{ type: "video", url: realSniffed }]);
    if (realMedia && !realMedia.isVideo) {
      return buildUnifiedResult(title, [{ type: "image", url: realMedia.url }]);
    }
  } catch (realPageError) {
    log("real post page attempt failed:", realPageError.message);
  }

  await saveDebugArtifacts(page, shortcode, "no media found");
  return null;
}

async function fetchViaFallbackBrowser(shortcode) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1280, height: 900 });

    if (HAS_IG_SESSION) {
      const cookies = [
        {
          name: "sessionid",
          value: IG_SESSION_COOKIES.sessionid,
          domain: ".instagram.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
      ];
      if (IG_SESSION_COOKIES.ds_user_id) {
        cookies.push({ name: "ds_user_id", value: IG_SESSION_COOKIES.ds_user_id, domain: ".instagram.com", path: "/" });
      }
      if (IG_SESSION_COOKIES.csrftoken) {
        cookies.push({ name: "csrftoken", value: IG_SESSION_COOKIES.csrftoken, domain: ".instagram.com", path: "/" });
      }
      await page.setCookie(...cookies);
      log("using logged-in Instagram session cookies");
    }

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    log("navigating to", embedUrl);
    await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(1000);
    await dismissOverlays(page);
    await delay(500);

    const blockReason = await detectBlockReason(page);
    if (blockReason) throw new Error(blockReason);

    const title = await page.$eval('meta[property="og:title"]', (el) => el.content).catch(() => null);

    return await extractViaBrowser(page, shortcode, title || "Instagram Post");
  } catch (e) {
    if (!page.isClosed()) await saveDebugArtifacts(page, shortcode, `error: ${e.message}`);
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

// ================================================================
// UNIFIED FETCH: primary GraphQL method, falling back to the browser
// method only if the primary one fails and Chrome is available.
// ================================================================

async function fetchInstagramMedia(shortcode) {
  let primaryError = null;
  try {
    const result = await fetchViaPrimaryMethod(shortcode);
    if (result) return result;
  } catch (e) {
    primaryError = e;
    log("primary (GraphQL) method failed:", e.message);
  }

  if (puppeteer) {
    try {
      const result = await fetchViaFallbackBrowser(shortcode);
      if (result) return result;
    } catch (e) {
      log("fallback (browser) method failed:", e.message);
      // Prefer whichever error message is more specific/useful.
      if (!primaryError) primaryError = e;
    }
  }

  if (primaryError) throw primaryError;
  return null;
}

// ================================================================
// ROUTES
// ================================================================

app.post("/api/fetch", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || !/instagram\.com/i.test(url)) {
      return res.status(400).json({ success: false, message: "Please enter a valid Instagram URL." });
    }

    const shortcode = extractShortcode(url);
    if (!shortcode) {
      return res.status(400).json({
        success: false,
        message: "Could not find a post ID in this link. Paste a public Instagram post, reel, or carousel link.",
      });
    }

    const result = await fetchInstagramMedia(shortcode);

    if (!result) {
      return res.status(404).json({
        success: false,
        message: HAS_IG_SESSION
          ? "Could not load this post even with the Instagram session cookie in .env. It may be private, deleted, or age-restricted — or the cookie has expired."
          : "Could not load this post. It may be private, deleted, or age-restricted, or require a login — try adding your own Instagram session cookie in a .env file (see README.md).",
      });
    }

    return res.json({
      success: true,
      title: result.title || "Instagram Post",
      type: result.type, // "image" | "video" | "carousel"
      items: result.items,
    });
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Something went wrong. Try again." });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send("Missing url");

    // Local files we already saved to disk (resolved blob: URLs from the
    // browser fallback) — serve directly instead of proxying a fetch.
    if (url.startsWith("/media/")) {
      const filePath = path.join(TMP_DIR, path.basename(url));
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
      res.setHeader("Content-Disposition", `attachment; filename="${filename || path.basename(filePath)}"`);
      return fs.createReadStream(filePath).pipe(res);
    }

    const response = await axios.get(url, {
      responseType: "stream",
      headers: { "User-Agent": BROWSER_UA },
    });

    res.setHeader("Content-Disposition", `attachment; filename="${filename || "instagram-download"}"`);
    if (response.headers["content-type"]) {
      res.setHeader("Content-Type", response.headers["content-type"]);
    }
    response.data.pipe(res);
  } catch (err) {
    console.error("Download proxy error:", err.message);
    res.status(500).send("Download failed. Please try again.");
  }
});

const server = app.listen(PORT, () => {
  console.log(`Instagram Downloader running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n❌ Port ${PORT} is already in use — another copy of this app (or something else) is already running.\n` +
        `   Close any other terminal window running this project, then try again.\n`
    );
    process.exit(1);
  } else {
    console.error("Server error:", err);
    process.exit(1);
  }
});

process.on("exit", () => {
  if (browserPromise) browserPromise.then((b) => b.close()).catch(() => {});
});
