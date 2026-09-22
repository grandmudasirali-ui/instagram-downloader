document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("dl-form");
  const input = document.getElementById("insta-url");
  const btn = document.getElementById("dl-btn");
  const statusMsg = document.getElementById("status-msg");
  const resultBox = document.getElementById("result");
  const pasteBtn = document.getElementById("paste-btn");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (pasteBtn) {
    pasteBtn.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        input.value = text;
        input.focus();
      } catch (e) {
        setStatus("Could not access clipboard. Please paste manually.", "error");
      }
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = input.value.trim();

    if (!url) {
      setStatus("Please paste an Instagram link first.", "error");
      return;
    }
    if (!/instagram\.com/i.test(url)) {
      setStatus("That doesn't look like an Instagram link.", "error");
      return;
    }

    setLoading(true);
    setStatus("Fetching your media, please wait...", "info");
    resultBox.classList.remove("show");
    resultBox.innerHTML = "";

    try {
      const res = await fetch("/api/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Something went wrong.");
      }

      renderResult(data);
      setStatus("Done — ready to download.", "success");
    } catch (err) {
      setStatus(err.message || "Failed to fetch this link.", "error");
    } finally {
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    btn.disabled = isLoading;
    btn.innerHTML = isLoading
      ? '<span class="btn-label"><span class="spinner"></span>Fetching...</span>'
      : '<span class="btn-label">Download</span>';
  }

  function setStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = "status-msg" + (type ? " " + type : "");
  }

  function proxyLink(url, filename) {
    // Always goes through our own download proxy so the browser saves it
    // with a clean filename instead of a random CDN filename (works the
    // same whether url is a remote Instagram CDN link or our own /media/
    // path for a resolved blob: video).
    return `/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  }

  function safeName(title, ext, suffix) {
    const clean = (title || "instagram").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40).replace(/^-+|-+$/g, "");
    const base = clean || "instagram";
    return suffix ? `${base}-${suffix}.${ext}` : `${base}.${ext}`;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function extFor(type) {
    return type === "video" ? "mp4" : "jpg";
  }

  // Triggers a browser download without navigating away from the page.
  function triggerDownload(href) {
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function badgeLabel(type) {
    if (type === "video") return "Video";
    if (type === "carousel") return "Carousel";
    return "Photo";
  }

  function renderResult(data) {
    resultBox.classList.add("show");
    const { title, type, items } = data;
    const safeTitle = escapeHtml(title);
    const countLabel =
      type === "carousel"
        ? `${items.length} slides`
        : type === "video"
        ? "Video"
        : "Photo";

    let mediaHtml = "";
    let actionsHtml = "";
    let gridHtml = "";

    if (type === "carousel") {
      const links = items.map((item, i) =>
        proxyLink(item.url, safeName(title, extFor(item.type), i + 1))
      );

      gridHtml = items
        .map((item, i) => {
          const preview =
            item.type === "video"
              ? `<video src="${item.url}" muted playsinline preload="metadata"></video><span class="video-badge">▶</span>`
              : `<img src="${item.thumbnail || item.url}" alt="slide ${i + 1}" loading="lazy">`;
          return `
          <div class="carousel-item">
            <span class="slide-num">${i + 1}</span>
            ${preview}
            <a class="save-link" href="${links[i]}" download>Save</a>
          </div>`;
        })
        .join("");

      actionsHtml = `<button type="button" id="dl-all-btn" class="dl-btn primary">⬇ Download All (${items.length})</button>`;

      resultBox.innerHTML = `
        <div class="result-card">
          <div class="result-head">
            <span class="ring"><span></span></span>
            <div class="meta">
              <h3>${safeTitle}</h3>
              <span>${countLabel}</span>
            </div>
            <span class="badge">${badgeLabel(type)}</span>
          </div>
          <div class="result-actions">${actionsHtml}</div>
          <div class="carousel-grid">${gridHtml}</div>
        </div>`;

      const dlAllBtn = document.getElementById("dl-all-btn");
      if (dlAllBtn) {
        dlAllBtn.addEventListener("click", async () => {
          dlAllBtn.disabled = true;
          for (let i = 0; i < links.length; i++) {
            dlAllBtn.textContent = `Downloading ${i + 1}/${links.length}...`;
            triggerDownload(links[i]);
            // Small gap between triggers — browsers can silently drop
            // downloads fired back-to-back with no delay between them.
            await wait(500);
          }
          dlAllBtn.textContent = `⬇ Download All (${links.length})`;
          dlAllBtn.disabled = false;
        });
      }
      return;
    }

    // Single image or single video
    const item = items[0];
    const link = proxyLink(item.url, safeName(title, extFor(item.type)));

    if (item.type === "video") {
      mediaHtml = `<video src="${item.url}" controls playsinline poster="${item.thumbnail || ""}"></video>`;
      actionsHtml = `<a class="dl-btn primary" href="${link}" download>⬇ Download Video</a>`;
    } else {
      mediaHtml = `<img src="${item.url}" alt="photo">`;
      actionsHtml = `<a class="dl-btn primary" href="${link}" download>⬇ Download Photo</a>`;
    }

    resultBox.innerHTML = `
      <div class="result-card">
        <div class="result-head">
          <span class="ring"><span></span></span>
          <div class="meta">
            <h3>${safeTitle}</h3>
            <span>${countLabel}</span>
          </div>
          <span class="badge">${badgeLabel(type)}</span>
        </div>
        <div class="result-media">${mediaHtml}</div>
        <div class="result-actions">${actionsHtml}</div>
      </div>`;
  }
});

// ---------- Title glitch effect ----------
(function () {
  const word = document.getElementById("glitch-word");
  if (!word) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  function fireGlitch() {
    word.classList.add("glitching");
    setTimeout(() => word.classList.remove("glitching"), 600);
  }

  setTimeout(fireGlitch, 5000);   // first glitch at 5s, as requested
  setInterval(fireGlitch, 11000); // then a brief flicker every ~11s
})();
