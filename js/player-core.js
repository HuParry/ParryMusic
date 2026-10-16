// Pure helpers shared by the browser player and dependency-free Node tests.
(function (root) {
  "use strict";
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const whole = Math.floor(seconds);
    return String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
  }

  function dominantColor(pixels) {
    if (!pixels || typeof pixels.length !== "number" || pixels.length < 4) return null;
    const buckets = new Map();
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const alpha = Number(pixels[i + 3]);
      if (!Number.isFinite(alpha) || alpha < 128) continue;
      const red = Number(pixels[i]);
      const green = Number(pixels[i + 1]);
      const blue = Number(pixels[i + 2]);
      if (![red, green, blue].every(Number.isFinite)) continue;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum ? (maximum - minimum) / maximum : 0;
      const brightness = (red + green + blue) / 3;
      // Favour meaningful colour over black letterboxing and white artwork,
      // while still returning a useful neutral tone for monochrome covers.
      const edgeWeight = brightness < 18 || brightness > 242 ? 0.12 : 1;
      const weight = edgeWeight * (0.45 + saturation * 1.55);
      const key = (red >> 5) + ":" + (green >> 5) + ":" + (blue >> 5);
      const bucket = buckets.get(key) || { score: 0, red: 0, green: 0, blue: 0 };
      bucket.score += weight;
      bucket.red += red * weight;
      bucket.green += green * weight;
      bucket.blue += blue * weight;
      buckets.set(key, bucket);
    }
    let winner = null;
    for (const bucket of buckets.values()) {
      if (!winner || bucket.score > winner.score) winner = bucket;
    }
    if (!winner || winner.score <= 0) return null;
    return [winner.red, winner.green, winner.blue].map(function (value) {
      return Math.round(value / winner.score);
    });
  }

  function ambientPalette(color) {
    if (!Array.isArray(color) || color.length < 3 || !color.slice(0, 3).every(Number.isFinite)) {
      return { primary: "rgb(57, 82, 94)", secondary: "rgb(37, 55, 65)", base: "rgb(30, 43, 51)" };
    }
    const source = color.slice(0, 3).map(function (value) { return clamp(value, 0, 255) / 255; });
    const maximum = Math.max.apply(null, source);
    const minimum = Math.min.apply(null, source);
    const delta = maximum - minimum;
    const lightness = (maximum + minimum) / 2;
    // Lifting near-black RGB values can exaggerate tiny channel differences.
    // Treat very dark or nearly neutral samples as gray rather than tinting them.
    const saturation = maximum >= 18 / 255 && delta >= 6 / 255 ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    let hue = 0;
    if (delta) {
      if (maximum === source[0]) hue = (source[1] - source[2]) / delta;
      else if (maximum === source[1]) hue = (source[2] - source[0]) / delta + 2;
      else hue = (source[0] - source[1]) / delta + 4;
      hue = (hue + 6) % 6;
    }
    function luminance(rgb) {
      const linear = rgb.map(function (value) { return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4); });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    function tone(level, limit) {
      const chroma = (1 - Math.abs(2 * level - 1)) * saturation;
      const x = chroma * (1 - Math.abs(hue % 2 - 1));
      const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
      const rgb = channels.map(function (value) { return value + level - chroma / 2; });
      // Keep the cover's hue, with a brightness ceiling for white text.
      let scale = 1;
      if (luminance(rgb) > limit) {
        let low = 0;
        let high = 1;
        for (let i = 0; i < 14; i += 1) {
          const middle = (low + high) / 2;
          if (luminance(rgb.map(function (value) { return value * middle; })) <= limit) low = middle;
          else high = middle;
        }
        scale = low;
      }
      return "rgb(" + rgb.map(function (value) { return Math.round(value * scale * 255); }).join(", ") + ")";
    }
    return {
      primary: tone(0.32, 0.085),
      secondary: tone(0.25, 0.055),
      base: tone(0.20, 0.035)
    };
  }

  // All media comes from this static site. Encode filenames containing #, ? or
  // % in the playlist; the generator handles this automatically.
  function assetURL(value, baseURL) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value.trim(), baseURL);
      const base = new URL(baseURL);
      if (!["https:", "http:", "file:"].includes(url.protocol)) return "";
      if (url.protocol !== base.protocol || url.host !== base.host) return "";
      if (url.username || url.password) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function bracketRanges(text) {
    const pairs = { "(": ")", "（": "）", "[": "]", "【": "】", "{": "}", "《": "》", "〈": "〉", "「": "」", "『": "』" };
    const stack = [];
    const ranges = [];
    for (let i = 0; i < text.length; i += 1) {
      if (pairs[text[i]]) stack.push({ start: i, end: pairs[text[i]] });
      else if (stack.length && text[i] === stack[stack.length - 1].end) ranges.push([stack.pop().start, i]);
    }
    return ranges;
  }

  function artistName(text) {
    // Filename annotations after a singer are not part of the API artist query.
    // Keep leading/internal brackets, e.g. (G)I-DLE.
    return text.split("&").map(function (part) {
      let name = part.trim();
      while (name) {
        const suffix = bracketRanges(name).filter(function (range) { return range[1] === name.length - 1; })
          .sort(function (a, b) { return a[0] - b[0]; })[0];
        if (!suffix || !name.slice(0, suffix[0]).trim()) break;
        name = name.slice(0, suffix[0]).trim();
      }
      return name;
    }).filter(Boolean).join("&");
  }

  function songMetadata(filename) {
    const stem = filename.replace(/\.[^.]+$/, "").trim();
    const ranges = bracketRanges(stem);
    // Artist comes first. Only a spaced hyphen outside brackets separates the
    // title, so hyphens within singer names (e.g. G-DRAGON) remain intact.
    for (let i = 0; i < stem.length; i += 1) {
      if (stem[i] !== "-" || !/\s/.test(stem[i - 1] || "") || !/\s/.test(stem[i + 1] || "") ||
          ranges.some(function (range) { return range[0] < i && i < range[1]; })) continue;
      const artist = artistName(stem.slice(0, i));
      const name = stem.slice(i + 1).trim();
      if (name && artist) return { name: name, artist: artist };
      break;
    }
    return { name: stem, artist: "未知歌手" };
  }

  function normalizePlaylist(entries, baseURL, defaultCover) {
    if (!Array.isArray(entries)) throw new TypeError("歌单必须是数组");
    const tracks = [];
    let invalidCount = 0;
    for (const entry of entries) {
      const url = entry && assetURL(entry.url, baseURL);
      if (!url) {
        invalidCount += 1;
        continue;
      }
      let filename = new URL(url).pathname.split("/").pop();
      try { filename = decodeURIComponent(filename); } catch { /* Keep malformed names readable. */ }
      const metadata = songMetadata(filename);
      tracks.push({
        id: typeof entry.id === "string" && /^[0-9a-f]{12}$/.test(entry.id) ? entry.id : "",
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : metadata.name,
        artist: typeof entry.artist === "string" && entry.artist.trim() ? entry.artist.trim() : metadata.artist,
        album: typeof entry.album === "string" ? entry.album : "",
        url: url,
        cover: assetURL(entry.cover, baseURL) || defaultCover,
        lrc: assetURL(entry.lrc, baseURL)
      });
    }
    const ids = new Map();
    for (const track of tracks) if (track.id) ids.set(track.id, (ids.get(track.id) || 0) + 1);
    for (const track of tracks) if (ids.get(track.id) > 1) track.id = "";
    return { tracks: tracks, invalidCount: invalidCount };
  }

  function parseLrc(source) {
    const lines = [];
    const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(source);
    const offset = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
    for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const pattern = /\[(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
      const matches = Array.from(raw.matchAll(pattern));
      if (!matches.length) continue;
      const text = raw.replace(pattern, "").trim();
      if (!text) continue;
      for (const match of matches) {
        const fraction = match[3] ? Number("0." + match[3]) : 0;
        lines.push({ time: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + fraction + offset), text: text });
      }
    }
    return lines.sort(function (a, b) { return a.time - b.time; });
  }

  function lyricIndex(lines, time) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle].time <= time) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  function buildPlayOrder(length, current, shuffle, random) {
    const order = Array.from({ length: length }, function (_, i) { return i; });
    if (!shuffle || length < 2) return order;
    const others = order.filter(function (i) { return i !== current; });
    const nextRandom = random || Math.random;
    for (let i = others.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextRandom() * (i + 1));
      const temp = others[i];
      others[i] = others[j];
      others[j] = temp;
    }
    return [current].concat(others);
  }

  function advanceQueue(position, length, direction, loop, automatic) {
    if (!length) return -1;
    const next = position + direction;
    if (automatic && loop === "off" && next >= length) return -1;
    return (next + length) % length;
  }

  const core = {
    clamp: clamp, formatTime: formatTime, assetURL: assetURL,
    dominantColor: dominantColor, ambientPalette: ambientPalette,
    songMetadata: songMetadata,
    normalizePlaylist: normalizePlaylist, parseLrc: parseLrc, lyricIndex: lyricIndex,
    buildPlayOrder: buildPlayOrder, advanceQueue: advanceQueue
  };
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.ParryMusicCore = core;
})(typeof globalThis === "object" ? globalThis : this);
