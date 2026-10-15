// Native audio timeline: rendering, drag preview and pending seeks live here.
(function (root) {
  "use strict";
  const core = typeof module === "object" && module.exports ? require("./player-core.js") : root.ParryMusicCore;

  function createController(options) {
    const audio = options.audio;
    const slider = options.slider;
    let dragging = false;
    let preview = null;
    let pending = null;

    function duration() {
      return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    }

    function render() {
      const length = duration();
      const actual = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
      const percent = preview === null ? (length ? core.clamp(actual / length * 100, 0, 100) : 0) : preview;
      const position = preview === null ? actual : percent / 100 * length;
      slider.disabled = length === 0;
      if (!dragging) slider.value = percent;
      slider.style.setProperty("--progress", percent + "%");
      options.currentTime.textContent = core.formatTime(position);
      options.durationTime.textContent = core.formatTime(length);
      slider.setAttribute("aria-valuetext", core.formatTime(position) + " / " + core.formatTime(length));
      if (options.onUpdate) options.onUpdate();
    }

    function applyPending() {
      const length = duration();
      if (pending === null || !length || audio.readyState < 1) return;
      const target = core.clamp(pending, 0, length);
      try {
        // Avoid issuing the same seek again for the native input/change pair.
        if (audio.currentTime !== target) audio.currentTime = target;
      } catch { return; /* Retry when metadata/data becomes available. */ }
      pending = null;
      if (options.onSeek) options.onSeek();
    }

    function seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      dragging = false;
      preview = null;
      pending = Math.max(0, seconds);
      applyPending();
      render();
    }

    function commit() {
      const value = Number(slider.value);
      const length = duration();
      dragging = false;
      preview = null;
      if (Number.isFinite(value) && length) seek(core.clamp(value, 0, 100) / 100 * length);
      else render();
    }

    slider.addEventListener("pointerdown", function (event) {
      if (slider.disabled || (event.button !== undefined && event.button !== 0)) return;
      dragging = true;
      preview = core.clamp(Number(slider.value), 0, 100);
    });
    slider.addEventListener("input", function () {
      const value = Number(slider.value);
      if (!Number.isFinite(value)) return;
      if (dragging) {
        preview = core.clamp(value, 0, 100);
        render();
      } else commit();
    });
    slider.addEventListener("change", commit);
    options.window.addEventListener("pointerup", function () { if (dragging) commit(); });
    options.window.addEventListener("pointercancel", function () {
      dragging = false;
      preview = null;
      render();
    });
    ["loadedmetadata", "durationchange", "loadeddata", "canplay"].forEach(function (event) {
      audio.addEventListener(event, function () { applyPending(); render(); });
    });
    audio.addEventListener("timeupdate", render);
    audio.addEventListener("seeked", function () {
      render();
      if (options.onSeek) options.onSeek();
    });
    audio.addEventListener("emptied", function () {
      dragging = false;
      preview = null;
      render();
    });

    return {
      render: render,
      seek: seek,
      // Preserve a deferred seek when saving before metadata has loaded.
      position: function () { return pending === null ? audio.currentTime : pending; },
      reset: function () { dragging = false; preview = null; pending = null; render(); }
    };
  }

  if (typeof module === "object" && module.exports) module.exports = { createController: createController };
  else root.ParryMusicProgress = { createController: createController };
})(typeof globalThis === "object" ? globalThis : this);
