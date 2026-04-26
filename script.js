/**
 * ============================================
 *  CMOS Bayer Filter & Demosaicing Simulator
 *  script.js — All application logic
 * ============================================
 */

(function () {
  'use strict';

  // ── Constants ──
  const MAX_DIM = 1200;

  // ── DOM References ──
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  const resizeNotice = document.getElementById('resize-notice');
  const resizeText = document.getElementById('resize-text');

  const pipelineSection = document.getElementById('pipeline-section');

  const canvasOriginal = document.getElementById('canvas-original');
  const canvasBayer = document.getElementById('canvas-bayer');
  const canvasDemosaic = document.getElementById('canvas-demosaic');

  const ctxOriginal = canvasOriginal.getContext('2d', { willReadFrequently: true });
  const ctxBayer = canvasBayer.getContext('2d');
  const ctxDemosaic = canvasDemosaic.getContext('2d');

  const phOriginal = document.getElementById('ph-original');
  const phBayer = document.getElementById('ph-bayer');
  const phDemosaic = document.getElementById('ph-demosaic');

  const procBayer = document.getElementById('proc-bayer');
  const procDemosaic = document.getElementById('proc-demosaic');

  const cardOriginal = document.getElementById('card-original');
  const cardBayer = document.getElementById('card-bayer');
  const cardDemosaic = document.getElementById('card-demosaic');

  const statsPanel = document.getElementById('stats-panel');
  const statDim = document.getElementById('stat-dim');
  const statPixels = document.getElementById('stat-pixels');
  const statP1 = document.getElementById('stat-p1');
  const statP2 = document.getElementById('stat-p2');
  const statTotal = document.getElementById('stat-total');

  const errorToast = document.getElementById('error-toast');

  // ── Event Listeners ──

  // Click to upload
  uploadArea.addEventListener('click', () => fileInput.click());

  // File selected via dialog
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  });

  // Drag & Drop
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.add('drag-over');
  });

  uploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('drag-over');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // ── Main Pipeline ──

  /**
   * Validate and load the uploaded file.
   */
  function handleFile(file) {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      showError('Please upload a valid image file (JPG, PNG, or WebP).');
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => showError('Failed to read the file. Please try again.');
    reader.onload = (e) => loadImage(e.target.result, file.name);
    reader.readAsDataURL(file);
  }

  /**
   * Load the image, cap its dimensions, and kick off the processing pipeline.
   */
  function loadImage(src, fileName) {
    const img = new Image();
    img.onerror = () => showError('Could not decode the image. Please try a different file.');
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      const originalW = w;
      const originalH = h;

      // Cap at MAX_DIM × MAX_DIM (maintain aspect ratio)
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
      }

      // Ensure even dimensions for clean 2×2 Bayer tiling
      w = w - (w % 2);
      h = h - (h % 2);

      // Show resize notice if resized
      if (w !== originalW || h !== originalH) {
        resizeText.textContent = `Resized from ${originalW}×${originalH} → ${w}×${h}`;
        resizeNotice.classList.remove('hidden');
        resizeNotice.classList.add('flex');
      } else {
        resizeNotice.classList.add('hidden');
        resizeNotice.classList.remove('flex');
      }

      // Size all three canvases
      canvasOriginal.width = w;
      canvasOriginal.height = h;
      canvasBayer.width = w;
      canvasBayer.height = h;
      canvasDemosaic.width = w;
      canvasDemosaic.height = h;

      // Draw original image to Canvas 1
      ctxOriginal.drawImage(img, 0, 0, w, h);

      // Show the pipeline section
      pipelineSection.classList.remove('hidden');

      // Reveal cards with staggered animation
      revealCard(cardOriginal, 0);
      revealCard(cardBayer, 150);
      revealCard(cardDemosaic, 300);

      // Hide placeholders for original
      phOriginal.classList.add('hidden');

      // Start processing pipeline with a slight delay for visual feedback
      const originalData = ctxOriginal.getImageData(0, 0, w, h);

      showOverlay(procBayer);

      // Phase 1: Bayer Mask (allow UI to paint the overlay first)
      setTimeout(() => {
        const t1Start = performance.now();
        const bayerData = applyBayerMask(originalData);
        const t1End = performance.now();

        ctxBayer.putImageData(bayerData, 0, 0);
        phBayer.classList.add('hidden');
        hideOverlay(procBayer);
        showOverlay(procDemosaic);

        // Phase 2: Demosaic (allow UI to update between phases)
        setTimeout(() => {
          const t2Start = performance.now();
          const demosaicData = demosaic(bayerData);
          const t2End = performance.now();

          ctxDemosaic.putImageData(demosaicData, 0, 0);
          phDemosaic.classList.add('hidden');
          hideOverlay(procDemosaic);

          // Update stats
          updateStats(w, h, t1End - t1Start, t2End - t2Start);
        }, 60);

      }, 60);
    };
    img.src = src;
  }

  // ── Phase 1: RGGB Bayer Mask ──

  /**
   * Apply the RGGB Bayer color filter array mask.
   *
   * Pattern (repeating 2×2):
   *   (even x, even y) → keep R only
   *   (odd  x, even y) → keep G only  (Gr — green on red row)
   *   (even x, odd  y) → keep G only  (Gb — green on blue row)
   *   (odd  x, odd  y) → keep B only
   *
   * All non-kept channels are set to 0. Alpha stays 255.
   */
  function applyBayerMask(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const src = imageData.data;
    const dst = new Uint8ClampedArray(src.length);

    for (let y = 0; y < h; y++) {
      const yEven = (y & 1) === 0;
      const rowOffset = y * w;

      for (let x = 0; x < w; x++) {
        const i = (rowOffset + x) << 2; // × 4
        const xEven = (x & 1) === 0;

        if (yEven) {
          if (xEven) {
            // Red position: keep R
            dst[i] = src[i];     // R
            dst[i + 1] = 0;          // G → 0
            dst[i + 2] = 0;          // B → 0
          } else {
            // Green (Gr) position: keep G
            dst[i] = 0;          // R → 0
            dst[i + 1] = src[i + 1]; // G
            dst[i + 2] = 0;          // B → 0
          }
        } else {
          if (xEven) {
            // Green (Gb) position: keep G
            dst[i] = 0;          // R → 0
            dst[i + 1] = src[i + 1]; // G
            dst[i + 2] = 0;          // B → 0
          } else {
            // Blue position: keep B
            dst[i] = 0;          // R → 0
            dst[i + 1] = 0;          // G → 0
            dst[i + 2] = src[i + 2]; // B
          }
        }

        dst[i + 3] = 255; // Alpha
      }
    }

    return new ImageData(dst, w, h);
  }

  // ── Phase 2: Bilinear Interpolation Demosaicing ──

  /**
   * Reconstruct full-color image from the Bayer-masked data.
   *
   * For each pixel, the known channel is copied directly.
   * Missing channels are estimated by averaging immediate neighbors
   * that hold that channel value in the Bayer grid:
   *   - Orthogonal (NSEW) for Green
   *   - Diagonal for Red/Blue when interpolating across color
   *   - Horizontal/Vertical for Red/Blue at Green sites
   */
  function demosaic(maskedImageData) {
    const w = maskedImageData.width;
    const h = maskedImageData.height;
    const src = maskedImageData.data;
    const dst = new Uint8ClampedArray(src.length);

    const lastX = w - 1;
    const lastY = h - 1;

    for (let y = 0; y < h; y++) {
      const yEven = (y & 1) === 0;
      const rowOff = y * w;

      // Pre-compute neighbor row existence
      const hasTop = y > 0;
      const hasBottom = y < lastY;
      const topRowOff = (y - 1) * w;
      const botRowOff = (y + 1) * w;

      for (let x = 0; x < w; x++) {
        const i = (rowOff + x) << 2;
        const xEven = (x & 1) === 0;

        // Pre-compute neighbor column existence
        const hasLeft = x > 0;
        const hasRight = x < lastX;

        let r, g, b;

        if (yEven && xEven) {
          // ── Red pixel: has R, needs G (orthogonal) and B (diagonal) ──
          r = src[i];

          // Green: average of up to 4 orthogonal neighbors
          let gSum = 0, gCnt = 0;
          if (hasTop) { gSum += src[(topRowOff + x) * 4 + 1]; gCnt++; }
          if (hasBottom) { gSum += src[(botRowOff + x) * 4 + 1]; gCnt++; }
          if (hasLeft) { gSum += src[(rowOff + x - 1) * 4 + 1]; gCnt++; }
          if (hasRight) { gSum += src[(rowOff + x + 1) * 4 + 1]; gCnt++; }
          g = gCnt > 0 ? (gSum / gCnt + 0.5) | 0 : 0;

          // Blue: average of up to 4 diagonal neighbors
          let bSum = 0, bCnt = 0;
          if (hasTop && hasLeft) { bSum += src[(topRowOff + x - 1) * 4 + 2]; bCnt++; }
          if (hasTop && hasRight) { bSum += src[(topRowOff + x + 1) * 4 + 2]; bCnt++; }
          if (hasBottom && hasLeft) { bSum += src[(botRowOff + x - 1) * 4 + 2]; bCnt++; }
          if (hasBottom && hasRight) { bSum += src[(botRowOff + x + 1) * 4 + 2]; bCnt++; }
          b = bCnt > 0 ? (bSum / bCnt + 0.5) | 0 : 0;

        } else if (yEven && !xEven) {
          // ── Green-on-Red-row (Gr): has G, needs R (horizontal) and B (vertical) ──
          g = src[i + 1];

          // Red: left and right neighbors (horizontal)
          let rSum = 0, rCnt = 0;
          if (hasLeft) { rSum += src[(rowOff + x - 1) * 4]; rCnt++; }
          if (hasRight) { rSum += src[(rowOff + x + 1) * 4]; rCnt++; }
          r = rCnt > 0 ? (rSum / rCnt + 0.5) | 0 : 0;

          // Blue: top and bottom neighbors (vertical)
          let bSum = 0, bCnt = 0;
          if (hasTop) { bSum += src[(topRowOff + x) * 4 + 2]; bCnt++; }
          if (hasBottom) { bSum += src[(botRowOff + x) * 4 + 2]; bCnt++; }
          b = bCnt > 0 ? (bSum / bCnt + 0.5) | 0 : 0;

        } else if (!yEven && xEven) {
          // ── Green-on-Blue-row (Gb): has G, needs R (vertical) and B (horizontal) ──
          g = src[i + 1];

          // Red: top and bottom neighbors (vertical)
          let rSum = 0, rCnt = 0;
          if (hasTop) { rSum += src[(topRowOff + x) * 4]; rCnt++; }
          if (hasBottom) { rSum += src[(botRowOff + x) * 4]; rCnt++; }
          r = rCnt > 0 ? (rSum / rCnt + 0.5) | 0 : 0;

          // Blue: left and right neighbors (horizontal)
          let bSum = 0, bCnt = 0;
          if (hasLeft) { bSum += src[(rowOff + x - 1) * 4 + 2]; bCnt++; }
          if (hasRight) { bSum += src[(rowOff + x + 1) * 4 + 2]; bCnt++; }
          b = bCnt > 0 ? (bSum / bCnt + 0.5) | 0 : 0;

        } else {
          // ── Blue pixel: has B, needs R (diagonal) and G (orthogonal) ──
          b = src[i + 2];

          // Red: average of up to 4 diagonal neighbors
          let rSum = 0, rCnt = 0;
          if (hasTop && hasLeft) { rSum += src[(topRowOff + x - 1) * 4]; rCnt++; }
          if (hasTop && hasRight) { rSum += src[(topRowOff + x + 1) * 4]; rCnt++; }
          if (hasBottom && hasLeft) { rSum += src[(botRowOff + x - 1) * 4]; rCnt++; }
          if (hasBottom && hasRight) { rSum += src[(botRowOff + x + 1) * 4]; rCnt++; }
          r = rCnt > 0 ? (rSum / rCnt + 0.5) | 0 : 0;

          // Green: average of up to 4 orthogonal neighbors
          let gSum = 0, gCnt = 0;
          if (hasTop) { gSum += src[(topRowOff + x) * 4 + 1]; gCnt++; }
          if (hasBottom) { gSum += src[(botRowOff + x) * 4 + 1]; gCnt++; }
          if (hasLeft) { gSum += src[(rowOff + x - 1) * 4 + 1]; gCnt++; }
          if (hasRight) { gSum += src[(rowOff + x + 1) * 4 + 1]; gCnt++; }
          g = gCnt > 0 ? (gSum / gCnt + 0.5) | 0 : 0;
        }

        dst[i] = r;
        dst[i + 1] = g;
        dst[i + 2] = b;
        dst[i + 3] = 255;
      }
    }

    return new ImageData(dst, w, h);
  }

  // ── Stats ──

  function updateStats(w, h, t1, t2) {
    statDim.textContent = `${w} × ${h}`;
    statPixels.textContent = (w * h).toLocaleString();
    statP1.textContent = `${t1.toFixed(1)} ms`;
    statP2.textContent = `${t2.toFixed(1)} ms`;
    statTotal.textContent = `${(t1 + t2).toFixed(1)} ms`;

    statsPanel.classList.add('visible');
  }

  // ── UI Helpers ──

  function revealCard(card, delay) {
    setTimeout(() => card.classList.add('visible'), delay);
  }

  function showOverlay(el) {
    el.classList.add('active');
  }

  function hideOverlay(el) {
    el.classList.remove('active');
  }

  let errorTimer = null;
  function showError(message) {
    errorToast.textContent = message;
    errorToast.classList.add('show');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorToast.classList.remove('show');
    }, 4000);
  }

})();
