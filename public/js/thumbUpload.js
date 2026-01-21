// public/thumbUpload.js
(function () {
  const PLACEHOLDER_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
        <rect width="100%" height="100%" rx="10" ry="10" fill="#f2f2f2"/>
        <path d="M40 24v32M24 40h32" stroke="#9aa0a6" stroke-width="4" stroke-linecap="round"/>
      </svg>
      `);

  function startLoadingFallback(label) {
    // optional: if your page defines startLoading/stopLoading, use them
    if (typeof window.startLoading === "function") window.startLoading(label || "");
  }
  function stopLoadingFallback() {
    if (typeof window.stopLoading === "function") window.stopLoading();
  }

  /**
   * Renders an editable thumbnail image.
   *
   * Required upload endpoint: POST /api/update-item-image (FormData)
   * FormData fields supported by your server currently:
   *   - image: File
   *   - gtin (optional but nice)
   *   - merchantId (recommended)
   *   - itemId (recommended)
   *   - variationId (optional)
   *
   * opts:
   *  - imageUrl: string|null
   *  - gtin: string|null
   *  - merchantId: string|null
   *  - itemId: string|null
   *  - variationId: string|null
   *  - onSuccess: (data)=>void   // called when upload succeeds
   */
  function createEditableThumb(opts) {
    const {
      imageUrl,
      gtin,
      merchantId,
      itemId,
      itemName,
      variationId,
      onSuccess,
    } = opts || {};

    const imgTd = document.createElement("td");
    imgTd.className = "thumb-cell";

    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";

    const img = document.createElement("img");
    img.className = "thumb-img clickable";
    img.loading = "lazy";
    img.alt = itemName || 'Item image';
    img.src = (imageUrl && String(imageUrl).trim()) ? String(imageUrl).trim() : PLACEHOLDER_SVG;
    
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";

    // allow click to choose file
    img.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      // optimistic preview
      const prevSrc = img.src;
      try {
        startLoadingFallback("Uploading image…");
        img.src = URL.createObjectURL(file);

        const fd = new FormData();
        fd.append("image", file);
        if (gtin) fd.append("gtin", gtin);
        if (merchantId) fd.append("merchantId", merchantId);
        if (itemId) fd.append("itemId", itemId);
        if (variationId) fd.append("variationId", variationId);

        const res = await fetch("/api/update-item-image", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.ok === false) {
          const msg =
            data?.error ||
            (data?.results && Array.isArray(data.results)
              ? data.results.filter(x => x.ok === false).map(x => x.error).join(" | ")
              : null) ||
            "Upload failed";
          throw new Error(msg);
        }

        // server should return a canonical URL if it has one
        if (data.firstImageUrl) img.src = data.firstImageUrl;

        img.classList.add("thumb-updated");
        setTimeout(() => img.classList.remove("thumb-updated"), 800);

        if (typeof onSuccess === "function") onSuccess(data);
      } catch (e) {
        console.error(e);
        alert("Image update failed: " + (e?.message || e));
        img.src = prevSrc || PLACEHOLDER_SVG;
      } finally {
        stopLoadingFallback();
        fileInput.value = "";
      }
    });

    wrap.appendChild(img);
    wrap.appendChild(fileInput);
    imgTd.appendChild(wrap);

    return imgTd;
  }

  window.createEditableThumb = createEditableThumb;
  window.THUMB_PLACEHOLDER = PLACEHOLDER_SVG;
})();