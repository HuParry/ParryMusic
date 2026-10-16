(function () {
  "use strict";
  const core = window.ParryMusicCore;
  const get = function (id) { return document.getElementById(id); };
  const audio = get("audio");
  const baseURL = new URL("./", document.baseURI).href;
  const config = window.PARRY_MUSIC_CONFIG || {};
  const siteTitle = typeof config.title === "string" && config.title.trim() ? config.title : "ParryMusic";
  const defaultCover = core.assetURL(config.defaultCover, baseURL) || new URL("./img/default-cover.svg", baseURL).href;
  const storageKey = "parrymusic:preferences:" + new URL(baseURL).pathname;
  const playbackKey = "parrymusic:playback:" + new URL(baseURL).pathname;
  const modes = ["sequence", "single", "random"];
  const modeLabels = { sequence: "顺序播放", single: "单曲循环", random: "随机播放" };
  const modeIcons = { sequence: "#i-order", single: "#i-repeat", random: "#i-shuffle" };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* Storage may be disabled. */ }
  let savedPlayback = {};
  try { savedPlayback = JSON.parse(localStorage.getItem(playbackKey)) || {}; } catch { /* Storage may be disabled. */ }
  let volume = Number(saved.volume ?? config.volume ?? 0.8);
  volume = Number.isFinite(volume) ? core.clamp(volume, 0, 1) : 0.8;
  function legacyMode(preferences) {
    return preferences.loop === "one" ? "single" : preferences.shuffle === true ? "random" : "sequence";
  }
  const configuredMode = modes.includes(config.playMode) ? config.playMode : legacyMode(config);
  const hasLegacyMode = Object.prototype.hasOwnProperty.call(saved, "loop") || Object.prototype.hasOwnProperty.call(saved, "shuffle");
  let playMode = modes.includes(saved.playMode) ? saved.playMode : hasLegacyMode ? legacyMode(saved) : configuredMode;
  let tracks = [];
  let index = -1;
  let queue = [];
  let queuePosition = 0;
  let songVersion = 0;
  let loadingTrack = false;
  let lastPlaybackSave = 0;
  let lyricsRequest = null;
  let lyrics = [];
  let activeLyric = -1;
  let manualScrollUntil = 0;
  let progress;
  let unmutedVolume = volume || 0.8;
  let scrollTimer = null;
  let lyricScrollFrame = 0;
  let lyricScrollTarget = null;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mobileViewport = window.matchMedia("(max-width: 760px)");
  let hintAnimation = null;
  let hintAnimationKey = "";
  const controlTooltip = get("control-tooltip");
  let tooltipButton = null;
  let activeAmbientTone = 0;
  let ambientTransition = 0;

  function ambientGradient(color) {
    const palette = core.ambientPalette(color);
    return "radial-gradient(ellipse at 18% 8%, " + palette.primary + " 0, transparent 62%), " +
      "radial-gradient(ellipse at 88% 88%, " + palette.secondary + " 0, transparent 68%), " +
      "linear-gradient(" + palette.base + ", " + palette.base + ")";
  }

  function applyAmbientColor(color) {
    const nextTone = activeAmbientTone === 0 ? 1 : 0;
    const current = get(activeAmbientTone === 0 ? "ambient-tone-a" : "ambient-tone-b");
    const next = get(nextTone === 0 ? "ambient-tone-a" : "ambient-tone-b");
    const transition = ++ambientTransition;
    next.style.background = ambientGradient(color);
    const reveal = function () {
      if (transition !== ambientTransition) return;
      next.classList.add("active");
      current.classList.remove("active");
      activeAmbientTone = nextTone;
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(reveal);
    else reveal();
  }

  function updateAmbientFromCover() {
    const image = get("cover");
    try {
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("封面尚未加载");
      const canvas = document.createElement("canvas");
      canvas.width = 36;
      canvas.height = 36;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("浏览器不支持画布取色");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      applyAmbientColor(core.dominantColor(context.getImageData(0, 0, canvas.width, canvas.height).data));
    } catch {
      applyAmbientColor(null);
    }
  }

  function hideControlTooltip() {
    controlTooltip.hidden = true;
    if (tooltipButton) tooltipButton.removeAttribute("aria-describedby");
    tooltipButton = null;
  }

  function showControlTooltip(button) {
    if (tooltipButton && tooltipButton !== button) tooltipButton.removeAttribute("aria-describedby");
    tooltipButton = button;
    controlTooltip.textContent = button.dataset.tooltip;
    controlTooltip.hidden = false;
    button.setAttribute("aria-describedby", "control-tooltip");
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    controlTooltip.style.maxWidth = Math.max(1, width - 16) + "px";
    // Measure at the viewport edge so the previous position cannot constrain
    // the new label's width and change its wrapping after positioning.
    controlTooltip.style.left = left + "px";
    controlTooltip.style.top = top + "px";
    const bounds = button.getBoundingClientRect();
    const tip = controlTooltip.getBoundingClientRect();
    const x = core.clamp(bounds.left + (bounds.width - tip.width) / 2, left + 8, Math.max(left + 8, left + width - tip.width - 8));
    const y = bounds.top - tip.height - 8 >= top + 8 ? bounds.top - tip.height - 8 : bounds.bottom + 8;
    controlTooltip.style.left = x + "px";
    controlTooltip.style.top = core.clamp(y, top + 8, Math.max(top + 8, top + height - tip.height - 8)) + "px";
  }

  function setControlLabel(id, label, tooltip = label) {
    const button = get(id);
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = tooltip;
    button.removeAttribute("title");
    if (tooltipButton === button && !controlTooltip.hidden) showControlTooltip(button);
  }

  function initializeControlTooltips() {
    ["play-mode", "share", "previous", "play", "next", "mute", "list-toggle", "help-button"].forEach(function (id) {
      const button = get(id);
      button.dataset.tooltip = button.title || button.getAttribute("aria-label") || "";
      button.removeAttribute("title");
      button.addEventListener("pointerenter", function (event) { if (event.pointerType !== "touch") showControlTooltip(button); });
      button.addEventListener("pointerleave", function () { if (tooltipButton === button) hideControlTooltip(); });
      button.addEventListener("focus", function () { showControlTooltip(button); });
      button.addEventListener("blur", function () { if (tooltipButton === button) hideControlTooltip(); });
    });
    window.addEventListener("resize", hideControlTooltip);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", hideControlTooltip);
      window.visualViewport.addEventListener("scroll", hideControlTooltip);
    }
    document.addEventListener("scroll", hideControlTooltip, true);
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") hideControlTooltip(); });
  }

  function updateViewport() {
    const viewport = window.visualViewport;
    // Preserve pinch zoom; only adapt the layout when it is at its normal scale.
    if (viewport && viewport.scale !== 1) return;
    const height = viewport ? viewport.height : window.innerHeight;
    const root = document.documentElement;
    if (!root || !Number.isFinite(height) || height <= 0) return;
    root.style.setProperty("--app-height", height + "px");
    root.style.setProperty("--app-top", (viewport ? Math.max(0, viewport.offsetTop) : 0) + "px");
    root.classList.toggle("compact-viewport", height <= 640);
    root.classList.toggle("low-viewport", height <= 540);
    root.classList.toggle("short-viewport", height <= 440);
  }
  window.addEventListener("resize", updateViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewport);
    window.visualViewport.addEventListener("scroll", updateViewport);
  }
  updateViewport();

  function updateLyricsHintMarquee() {
    const hint = get("lyrics-hint");
    const text = get("lyrics-hint-text");
    if (typeof text.animate !== "function") return;
    const width = hint.clientWidth;
    const distance = text.scrollWidth - width;
    const shouldScroll = mobileViewport.matches && !reduceMotion.matches && width > 0 && distance > 1;
    const key = shouldScroll ? width + ":" + distance + ":" + text.textContent : "";
    if (key === hintAnimationKey) return;
    if (hintAnimation) hintAnimation.cancel();
    hintAnimation = null;
    hintAnimationKey = key;
    hint.classList.toggle("is-scrolling", shouldScroll);
    if (!shouldScroll) return;
    // Travel at about 20px per second, with a pause at each end.
    const pause = 1200;
    const travel = Math.max(1500, distance / 20 * 1000);
    const duration = 2 * (pause + travel);
    const start = "translateX(0)";
    const end = "translateX(-" + distance + "px)";
    hintAnimation = text.animate([
      { transform: start, offset: 0 },
      { transform: start, offset: pause / duration },
      { transform: end, offset: (pause + travel) / duration },
      { transform: end, offset: (2 * pause + travel) / duration },
      { transform: start, offset: 1 }
    ], { duration: duration, iterations: Infinity, easing: "linear" });
  }

  function setStatus(message) {
    get("status-message").textContent = message;
  }

  function savePreferences() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ volume: audio.volume, playMode: playMode }));
    } catch { /* Playback still works without localStorage. */ }
  }

  function savePlayback(force) {
    if (index < 0 || loadingTrack || !progress) return;
    const now = Date.now();
    if (!force && now - lastPlaybackSave < 5000) return;
    const time = progress.position();
    if (!Number.isFinite(time) || time < 0) return;
    try {
      localStorage.setItem(playbackKey, JSON.stringify({ url: tracks[index].url, time: time }));
      lastPlaybackSave = now;
    } catch { /* Playback still works without localStorage. */ }
  }

  function setVolume(value) {
    audio.volume = core.clamp(value, 0, 1);
    if (audio.volume > 0) unmutedVolume = audio.volume;
    get("volume").value = audio.volume;
    get("volume").style.setProperty("--progress", audio.volume * 100 + "%");
    get("volume-icon").setAttribute("href", audio.volume ? "#i-volume" : "#i-muted");
    setControlLabel("mute", audio.volume ? "静音" : "取消静音");
    savePreferences();
  }

  function updateMode() {
    setControlLabel("play-mode", modeLabels[playMode]);
    get("play-mode-icon").setAttribute("href", modeIcons[playMode]);
    get("play-mode-one").hidden = playMode !== "single";
  }

  function buildQueue(start) {
    queue = core.buildPlayOrder(tracks.length, start, playMode === "random");
    queuePosition = queue.indexOf(start);
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", name);
    svg.append(use);
    return svg;
  }

  function renderPlaylist() {
    const query = get("search").value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let visible = 0;
    tracks.forEach(function (track, position) {
      if (query && !(track.name + " " + track.artist).toLocaleLowerCase().includes(query)) return;
      visible += 1;
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.className = "track-button";
      button.dataset.index = position;
      button.title = track.name + " · " + track.artist;
      button.setAttribute("aria-label", "播放 " + track.name + " · " + track.artist);
      button.setAttribute("aria-current", String(position === index));
      const number = document.createElement("span");
      number.className = "track-number";
      number.textContent = String(position + 1).padStart(2, "0");
      const details = document.createElement("span");
      details.className = "track-details";
      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = track.name;
      const artist = document.createElement("span");
      artist.className = "track-author";
      artist.textContent = track.artist;
      details.append(name, artist);
      button.append(number, details, icon("#i-play"));
      row.append(button);
      fragment.append(row);
    });
    get("playlist").replaceChildren(fragment);
    get("list-empty").hidden = visible > 0;
    get("list-empty").textContent = tracks.length ? "没有找到匹配的歌曲" : "还没有添加音乐";
    if (!query) revealCurrentTrack();
  }

  function updateTrackSelection() {
    let selected = null;
    get("playlist").querySelectorAll(".track-button").forEach(function (button) {
      button.setAttribute("aria-current", String(Number(button.dataset.index) === index));
      if (Number(button.dataset.index) === index) selected = button;
    });
    revealCurrentTrack(selected);
  }

  function revealCurrentTrack(selected) {
    const playlist = get("playlist");
    if (!playlist.clientHeight) return; // The library can be hidden on mobile.
    if (!selected) {
      playlist.querySelectorAll(".track-button").forEach(function (button) {
        if (Number(button.dataset.index) === index) selected = button;
      });
    }
    if (!selected) return; // A search can filter the current song out.
    const bounds = playlist.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    const top = bounds.top + 6;
    const bottom = bounds.bottom - 6;
    const offset = row.top < top ? row.top - top : row.bottom > bottom ? row.bottom - bottom : 0;
    if (offset) playlist.scrollTo({
      top: core.clamp(playlist.scrollTop + offset, 0, Math.max(0, playlist.scrollHeight - playlist.clientHeight)),
      behavior: "instant"
    });
  }

  function updatePlaying() {
    const playing = index >= 0 && !audio.paused && !audio.ended;
    document.body.classList.toggle("is-playing", playing);
    get("play-icon").setAttribute("href", playing ? "#i-pause" : "#i-play");
    setControlLabel("play", playing ? "暂停" : "播放", (playing ? "暂停" : "播放") + "（空格）");
    get("play-state").textContent = index < 0 ? "等待音乐" : playing ? "正在播放" : "已暂停";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function updateProgress() {
    progress.render();
  }

  function updateMediaPosition() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: duration, playbackRate: audio.playbackRate,
          position: core.clamp(audio.currentTime, 0, duration)
        });
      } catch { /* Older browsers may not support position state. */ }
    }
  }

  function cancelLyricScroll() {
    if (lyricScrollFrame) window.cancelAnimationFrame(lyricScrollFrame);
    lyricScrollFrame = 0;
    lyricScrollTarget = null;
  }

  function lyricScrollEase(progress) {
    // Match the reference's cubic-bezier(0.49, 0.21, 0.22, 0.84).
    function coordinate(t, first, second) {
      const inverse = 1 - t;
      return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
    }
    let low = 0;
    let high = 1;
    for (let i = 0; i < 14; i += 1) {
      const middle = (low + high) / 2;
      if (coordinate(middle, 0.49, 0.22) < progress) low = middle;
      else high = middle;
    }
    return coordinate((low + high) / 2, 0.21, 0.84);
  }

  function scrollToLyric() {
    if (activeLyric < 0) return;
    const line = get("lyrics-content").children[activeLyric];
    const container = get("lyrics-scroll");
    if (!line) return;
    const offset = line.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const target = core.clamp(container.scrollTop + offset - container.clientHeight * 0.3,
      0, Math.max(0, container.scrollHeight - container.clientHeight));
    if (lyricScrollFrame && Math.abs(target - lyricScrollTarget) < 1) return;
    cancelLyricScroll();
    const start = container.scrollTop;
    const distance = target - start;
    if (reduceMotion.matches || Math.abs(distance) < 1) {
      container.scrollTo({ top: target, behavior: "instant" });
      return;
    }
    lyricScrollTarget = target;
    let startedAt = null;
    function frame(timestamp) {
      if (startedAt === null) startedAt = timestamp;
      const progress = core.clamp((timestamp - startedAt) / 500, 0, 1);
      const finished = progress === 1 || reduceMotion.matches;
      container.scrollTo({ top: finished ? target : start + distance * lyricScrollEase(progress), behavior: "instant" });
      if (finished) {
        lyricScrollFrame = 0;
        lyricScrollTarget = null;
      } else lyricScrollFrame = window.requestAnimationFrame(frame);
    }
    lyricScrollFrame = window.requestAnimationFrame(frame);
  }

  function updateLyrics(forceScroll) {
    const next = core.lyricIndex(lyrics, audio.currentTime);
    if (next !== activeLyric) {
      const children = get("lyrics-content").children;
      if (children[activeLyric]) children[activeLyric].classList.remove("current");
      if (children[next]) children[next].classList.add("current");
      activeLyric = next;
      if (Date.now() >= manualScrollUntil) scrollToLyric();
    } else if (forceScroll) {
      scrollToLyric();
    }
  }

  function lyricPlaceholder(title, message) {
    get("lyrics-content").replaceChildren();
    const box = document.createElement("div");
    box.className = "lyric-placeholder";
    const heading = document.createElement("p");
    heading.className = "placeholder-title";
    heading.textContent = title;
    const description = document.createElement("p");
    description.textContent = message;
    box.append(heading, description);
    get("lyrics-content").append(box);
  }

  async function loadLyrics(track, version) {
    cancelLyricScroll();
    if (lyricsRequest) lyricsRequest.abort();
    lyricsRequest = null;
    lyrics = [];
    activeLyric = -1;
    manualScrollUntil = 0;
    clearTimeout(scrollTimer);
    get("lyrics-scroll").scrollTop = 0;
    if (!track.lrc) {
      lyricPlaceholder(track.name, "这首歌没有歌词，静静听一会儿。");
      return;
    }
    if (location.protocol === "file:") {
      lyricPlaceholder(track.name, "通过网站地址或本地 HTTP 预览访问，即可显示歌词。");
      return;
    }
    lyricPlaceholder("正在加载歌词…", track.name + " · " + track.artist);
    const controller = new AbortController();
    lyricsRequest = controller;
    const timeout = setTimeout(function () { controller.abort(); }, 12000);
    try {
      const response = await fetch(track.lrc, { signal: controller.signal });
      if (!response.ok) throw new Error("歌词请求失败");
      const text = await response.text();
      if (version !== songVersion) return;
      lyrics = core.parseLrc(text);
      if (!lyrics.length) {
        lyricPlaceholder(track.name, "歌词没有有效的 LRC 时间戳。");
        return;
      }
      const fragment = document.createDocumentFragment();
      lyrics.forEach(function (line, position) {
        const button = document.createElement("button");
        button.className = "lyric-line";
        button.dataset.lyric = position;
        button.textContent = line.text;
        button.setAttribute("aria-label", "跳转到 " + core.formatTime(line.time) + "，" + line.text);
        fragment.append(button);
      });
      get("lyrics-content").replaceChildren(fragment);
      updateLyrics(true);
    } catch {
      if (version === songVersion) lyricPlaceholder(track.name, "歌词暂时无法加载，音乐仍可播放。");
    } finally {
      clearTimeout(timeout);
      if (lyricsRequest === controller) lyricsRequest = null;
    }
  }

  async function playAudio() {
    if (index < 0) return;
    const version = songVersion;
    if (audio.error) audio.load();
    if (audio.ended) audio.currentTime = 0;
    setStatus("");
    try {
      await audio.play();
    } catch (error) {
      if (version !== songVersion || error.name === "AbortError") return;
      setStatus(error.name === "NotAllowedError" ? "请点击播放按钮，允许浏览器开始播放。" : "当前歌曲无法播放，请检查音乐文件或切换下一曲。");
      updatePlaying();
    }
  }

  function togglePlay() {
    if (index < 0) return;
    if (audio.paused) void playAudio();
    else audio.pause();
  }

  function setMediaMetadata(track) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name, artist: track.artist, album: track.album,
        artwork: [{ src: track.cover }]
      });
      if (navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState();
    } catch { /* OS metadata is optional. */ }
  }

  function loadTrack(position, shouldPlay, resumeTime = 0) {
    if (!tracks[position]) return;
    loadingTrack = true;
    songVersion += 1;
    audio.pause();
    index = position;
    progress.reset();
    const track = tracks[index];
    get("share").disabled = !track.id || !["https:", "http:"].includes(location.protocol);
    audio.src = track.url;
    audio.load();
    get("track-title").textContent = track.name;
    get("track-title").title = track.name;
    get("track-artist").textContent = track.artist;
    get("track-artist").title = track.artist;
    get("cover").src = track.cover;
    get("cover").alt = track.name + " 的封面";
    get("ambient-cover").src = track.cover;
    get("empty-state").hidden = true;
    get("lyrics-content").hidden = false;
    get("lyrics-hint-text").textContent = track.name + " · " + track.artist;
    get("lyrics-hint").title = track.name + " · " + track.artist;
    updateLyricsHintMarquee();
    document.title = track.name + " - " + track.artist + " | " + siteTitle;
    setStatus("");
    updateTrackSelection();
    updatePlaying();
    updateProgress();
    setMediaMetadata(track);
    void loadLyrics(track, songVersion);
    if (resumeTime > 0) progress.seek(resumeTime);
    loadingTrack = false;
    savePlayback(true);
    if (shouldPlay) void playAudio();
  }

  function changeTrack(direction, automatic) {
    if (index < 0) return;
    const loop = playMode === "single" ? "one" : playMode === "random" ? "all" : "off";
    if (automatic && loop === "one") {
      seekTo(0);
      void playAudio();
      return;
    }
    const next = core.advanceQueue(queuePosition, queue.length, direction, loop, automatic);
    if (next === -1) {
      updatePlaying();
      setStatus("歌单已播放完毕。");
      return;
    }
    if (playMode === "random" && automatic && next === 0) {
      // Begin a new shuffled round with the previous track at the end,
      // so the next song never repeats the one that just finished.
      queue = core.buildPlayOrder(tracks.length, index, true);
      if (queue.length > 1) queue.push(queue.shift());
    }
    queuePosition = next;
    loadTrack(queue[queuePosition], true);
  }

  function seekTo(seconds) {
    if (index >= 0) progress.seek(seconds);
  }

  get("playlist").addEventListener("click", function (event) {
    const button = event.target.closest(".track-button");
    if (!button) return;
    const position = Number(button.dataset.index);
    if (position === index) void playAudio();
    else {
      buildQueue(position);
      loadTrack(position, true);
    }
    get("parryMusic-page").classList.remove("show-library");
    get("list-toggle").setAttribute("aria-expanded", "false");
    setControlLabel("list-toggle", "打开播放列表");
  });
  get("search").addEventListener("input", renderPlaylist);
  get("play").addEventListener("click", togglePlay);
  get("share").addEventListener("click", async function () {
    const track = tracks[index];
    if (!track || !track.id || !["https:", "http:"].includes(location.protocol)) return;
    const url = new URL(baseURL);
    url.searchParams.set("s", track.id);
    const version = songVersion;
    try {
      await navigator.clipboard.writeText(url.href);
      if (version === songVersion) setStatus("歌曲链接已复制。");
    } catch {
      if (version !== songVersion) return;
      hideControlTooltip();
      const input = get("share-url");
      input.value = url.href;
      if (!get("share-dialog").open) get("share-dialog").showModal();
      input.focus();
      input.select();
    }
  });
  get("close-share").addEventListener("click", function () { get("share-dialog").close(); });
  get("previous").addEventListener("click", function () { changeTrack(-1, false); });
  get("next").addEventListener("click", function () { changeTrack(1, false); });
  get("play-mode").addEventListener("click", function () {
    playMode = modes[(modes.indexOf(playMode) + 1) % modes.length];
    updateMode();
    buildQueue(index);
    savePreferences();
  });
  get("volume").addEventListener("input", function (event) { setVolume(Number(event.target.value)); });
  get("mute").addEventListener("click", function () { setVolume(audio.volume ? 0 : unmutedVolume); });
  get("lyrics-content").addEventListener("click", function (event) {
    const button = event.target.closest(".lyric-line");
    if (!button) return;
    const line = lyrics[Number(button.dataset.lyric)];
    if (line) {
      seekTo(line.time);
      void playAudio();
    }
  });
  ["wheel", "touchmove"].forEach(function (name) {
    get("lyrics-scroll").addEventListener(name, function () {
      cancelLyricScroll();
      manualScrollUntil = Date.now() + 4000;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        manualScrollUntil = 0;
        scrollToLyric();
      }, 4100);
    }, { passive: true });
  });
  get("list-toggle").addEventListener("click", function () {
    const expanded = get("parryMusic-page").classList.toggle("show-library");
    get("list-toggle").setAttribute("aria-expanded", String(expanded));
    setControlLabel("list-toggle", expanded ? "关闭播放列表" : "打开播放列表");
    if (expanded) revealCurrentTrack();
  });
  get("help-button").addEventListener("click", function () { hideControlTooltip(); get("help-dialog").showModal(); });
  get("close-help").addEventListener("click", function () { get("help-dialog").close(); });
  get("help-dialog").addEventListener("click", function (event) {
    if (event.target !== get("help-dialog")) return;
    const bounds = get("help-dialog").getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) get("help-dialog").close();
  });

  get("cover").addEventListener("load", updateAmbientFromCover);
  if (get("cover").complete) updateAmbientFromCover();
  [get("cover"), get("ambient-cover")].forEach(function (image) {
    image.addEventListener("error", function () {
      const fallback = new URL("./img/default-cover.svg", baseURL).href;
      if (image.src !== fallback) image.src = fallback;
    });
  });
  audio.addEventListener("play", updatePlaying);
  audio.addEventListener("pause", updatePlaying);
  audio.addEventListener("pause", function () { savePlayback(true); });
  audio.addEventListener("timeupdate", function () { savePlayback(false); });
  window.addEventListener("pagehide", function () { savePlayback(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") savePlayback(true);
  });
  audio.addEventListener("playing", updatePlaying);
  audio.addEventListener("waiting", function () {
    if (index >= 0 && !audio.paused) get("play-state").textContent = "正在缓冲…";
  });
  audio.addEventListener("ended", function () { changeTrack(1, true); });
  audio.addEventListener("error", function () {
    if (index < 0) return;
    audio.pause();
    setStatus("当前歌曲无法播放，请检查文件是否已上传、可公开读取以及格式是否受浏览器支持。");
    get("play-state").textContent = "播放失败";
  });
  document.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || get("help-dialog").open) return;
    if (get("share-dialog").open || event.target.closest("input, textarea, select, button, a, [contenteditable], #playlist, #lyrics-scroll")) return;
    const actions = {
      Space: togglePlay,
      ArrowLeft: function () { changeTrack(-1, false); },
      ArrowRight: function () { changeTrack(1, false); },
      ArrowUp: function () { setVolume(audio.volume + 0.1); },
      ArrowDown: function () { setVolume(audio.volume - 0.1); }
    };
    if (actions[event.code] && tracks.length) {
      event.preventDefault();
      actions[event.code]();
    }
  });
  if ("mediaSession" in navigator) {
    const actions = {
      play: playAudio, pause: function () { audio.pause(); },
      previoustrack: function () { changeTrack(-1, false); },
      nexttrack: function () { changeTrack(1, false); },
      seekto: function (details) { seekTo(details.seekTime); },
      seekbackward: function (details) { seekTo(audio.currentTime - (details.seekOffset || 10)); },
      seekforward: function (details) { seekTo(audio.currentTime + (details.seekOffset || 10)); }
    };
    Object.entries(actions).forEach(function (entry) {
      try { navigator.mediaSession.setActionHandler(entry[0], entry[1]); } catch { /* Unsupported OS action. */ }
    });
  }

  progress = window.ParryMusicProgress.createController({
    audio: audio, slider: get("seek"),
    currentTime: get("current-time"), durationTime: get("duration"), window: window,
    onUpdate: function () { updateMediaPosition(); updateLyrics(false); },
    onSeek: function () { manualScrollUntil = 0; updateLyrics(true); savePlayback(true); }
  });
  initializeControlTooltips();
  window.addEventListener("resize", updateLyricsHintMarquee);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", updateLyricsHintMarquee);
  if (typeof window.ResizeObserver === "function") {
    const observer = new window.ResizeObserver(updateLyricsHintMarquee);
    observer.observe(get("lyrics-hint"));
    observer.observe(get("lyrics-hint-text"));
  }
  if (document.fonts) document.fonts.ready.then(updateLyricsHintMarquee);
  get("site-title").textContent = siteTitle;
  get("site-subtitle").textContent = typeof config.subtitle === "string" ? config.subtitle : "用音乐，留住片刻。";
  document.title = siteTitle + " - " + get("site-subtitle").textContent;
  setVolume(volume);
  updateMode();
  try {
    if (typeof window.PARRY_MUSIC_PLAYLIST === "undefined") throw new Error("找不到歌单，请检查 music/playlist.js 是否已上传且内容正确。");
    const result = core.normalizePlaylist(window.PARRY_MUSIC_PLAYLIST, baseURL, defaultCover);
    tracks = result.tracks;
    get("track-count").textContent = tracks.length;
    renderPlaylist();
    const sharedId = new URL(location.href).searchParams.get("s");
    const sharedIndex = typeof sharedId === "string" && /^[0-9a-f]{12}$/i.test(sharedId) ?
      tracks.findIndex(function (track) { return track.id === sharedId.toLowerCase(); }) : -1;
    if (tracks.length) {
      ["play", "previous", "next", "play-mode"].forEach(function (id) { get(id).disabled = false; });
      const restoredIndex = tracks.findIndex(function (track) { return track.url === savedPlayback.url; });
      const start = sharedIndex >= 0 ? sharedIndex : restoredIndex >= 0 ? restoredIndex : 0;
      const resumeTime = sharedIndex < 0 && restoredIndex >= 0 && Number.isFinite(savedPlayback.time) && savedPlayback.time > 0 ? savedPlayback.time : 0;
      buildQueue(start);
      loadTrack(start, false, resumeTime);
    }
    const messages = [];
    if (sharedId !== null && sharedIndex < 0) messages.push("分享的歌曲不存在或链接无效。");
    if (result.invalidCount) messages.push("已跳过 " + result.invalidCount + " 条无效歌曲，请检查歌单路径；音乐应来自本站。");
    if (messages.length) setStatus(messages.join(" "));
  } catch (error) {
    setStatus(error.message || "歌单格式错误，请检查 music/playlist.js。");
  }
  // The initial song and list are ready; media and lyrics can continue loading.
  if (window.ParryMusicStartup) window.ParryMusicStartup.ready();
})();
