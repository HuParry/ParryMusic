import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const songs = [0, 1, 2].map(index => ({ id: String(index + 1).repeat(12), name: "Song " + index,
  artist: "Singer", url: "./music/" + index + ".mp3", extra: { retained: true } }));
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(reducedMotion = false, rowGap = 0) {
  const animations = [];
  const frames = new Map();
  const saved = [];
  let frame = 0;
  let scrollCalls = 0;
  class Events {
    constructor() { this.events = new Map(); }
    addEventListener(name, handler) { const handlers = this.events.get(name) || []; handlers.push(handler); this.events.set(name, handlers); }
    emit(name, event = {}) {
      event.target ||= this;
      event.preventDefault ||= () => {};
      for (const handler of this.events.get(name) || []) handler(event);
    }
  }
  function matches(element, selector) {
    if (selector === "li") return element.tagName === "LI";
    if (selector === "button[data-action]") return element.tagName === "BUTTON" && element.dataset.action;
    if (selector.startsWith(".")) return element.className.split(" ").includes(selector.slice(1));
    const attribute = /^\[data-(key|action)="([^"]+)"\]$/.exec(selector);
    return attribute && String(element.dataset[attribute[1]]) === attribute[2];
  }
  class Element extends Events {
    constructor(tag = "div") {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
      this.className = ""; this.attributes = new Map(); this.disabled = false;
      const change = (values, add) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const value of values) add ? classes.add(value) : classes.delete(value);
        this.className = [...classes].join(" ");
      };
      this.classList = { add: (...values) => change(values, true), remove: (...values) => change(values, false),
        toggle: (value, force) => change([value], force) };
    }
    append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
    replaceChildren(fragment) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...fragment.children);
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); if (name === "data-key") delete this.dataset.key; }
    querySelector(selector) {
      for (const child of this.children) {
        if (matches(child, selector)) return child;
        const result = child.querySelector(selector);
        if (result) return result;
      }
      return null;
    }
    closest(selector) { return matches(this, selector) ? this : this.parent?.closest(selector); }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    getBoundingClientRect() {
      const top = this.parent?.id === "songs" ? 100 + this.parent.children.indexOf(this) * (78 + rowGap) : 0;
      return { top, left: 10, width: 300, height: 78, bottom: top + 78 };
    }
    cloneNode(deep) {
      const clone = new Element(this.tagName);
      clone.className = this.className; clone.dataset = { ...this.dataset }; clone.textContent = this.textContent;
      if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
      return clone;
    }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    setPointerCapture() {}
    focus() { document.activeElement = this; }
    scrollIntoView() { scrollCalls += 1; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    animate(keyframes, options) {
      let finish, reject;
      const animation = { element: this, keyframes, options, cancelled: false,
        finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
        finish() { finish(); }, cancel() { this.cancelled = true; reject(new Error("cancelled")); } };
      animations.push(animation);
      return animation;
    }
  }
  const ids = new Map();
  const get = id => { if (!ids.has(id)) { const element = new Element(); element.id = id; ids.set(id, element); } return ids.get(id); };
  const document = new Events();
  Object.assign(document, { body: new Element("body"), getElementById: get, createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag), createDocumentFragment: () => new Element("fragment"),
    elementFromPoint: (_, y) => {
      const index = Math.floor((y - 100) / (78 + rowGap));
      const row = get("songs").children[index];
      return row ? y < row.getBoundingClientRect().bottom ? row : get("songs") : null;
    },
    querySelector: () => get("toolbar") });
  document.activeElement = document.body;
  const window = new Events();
  Object.assign(window, { scrollY: 0, innerHeight: 800, matchMedia: () => ({ matches: reducedMotion }), scrollBy: () => { scrollCalls += 1; } });
  vm.runInNewContext(readFileSync(new URL("../scripts/order-editor/editor.mjs", import.meta.url), "utf8"), {
    document, window, requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: id => frames.delete(id),
    fetch: async (_, options) => {
      if (options) {
        const payload = JSON.parse(options.body);
        saved.push(payload);
        return { ok: true, json: async () => ({ tracks: payload.order.map(key => songs[key]), revision: "saved", backup: "backup.js" }) };
      }
      return { ok: true, json: async () => ({ tracks: songs, revision: "original", token: "token" }) };
    }
  });
  await flush();
  const row = key => get("songs").querySelector('[data-key="' + key + '"]');
  function start(key, offsetY = 39) {
    const handle = row(key).querySelector(".drag-handle");
    get("songs").emit("pointerdown", { target: handle, pointerId: 1, button: 0, clientX: 20, clientY: row(key).getBoundingClientRect().top + offsetY });
  }
  function drag(key, y, x = 40, offsetY = 39) {
    start(key, offsetY);
    window.emit("pointermove", { pointerId: 1, clientX: x, clientY: y });
    window.emit("pointerup", { pointerId: 1, clientX: x, clientY: y });
  }
  return { document, window, get, row, start, drag, animations, frames, saved, scrollCalls: () => scrollCalls,
    keys: () => get("songs").children.map(row => Number(row.dataset.key)) };
}

test("released card animates from the pointer into its destination without replaying its original position or scrolling", async () => {
  const f = await fixture();
  f.drag(0, 316);
  assert.deepEqual(f.keys(), [1, 2, 0]);
  const landing = f.animations.find(animation => animation.element.className.includes("drop-settling"));
  assert.ok(landing);
  assert.equal(landing.keyframes[0].transform, "translate3d(30px,277px,0)");
  assert.equal(landing.keyframes[1].transform, "translate3d(10px,256px,0)");
  assert.equal(f.animations.some(animation => animation.element.dataset.key === 0), false);
  assert.equal(f.row(0).style.visibility, "hidden");
  assert.equal(f.scrollCalls(), 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.get("save").disabled, false);
  assert.equal(f.document.activeElement, f.document.body);
  landing.finish();
  await flush();
  assert.equal(f.row(0).style.visibility, "");
  assert.equal(f.document.body.children.length, 0);
});

test("dropping outside the list returns the card to its original slot without changing order", async () => {
  const f = await fixture();
  f.drag(0, 80);
  assert.deepEqual(f.keys(), [0, 1, 2]);
  assert.equal(f.get("save").disabled, true);
  const landing = f.animations.find(animation => animation.element.className.includes("drop-settling"));
  assert.equal(landing.keyframes[1].transform, "translate3d(10px,100px,0)");
  landing.finish();
  await flush();
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.scrollCalls(), 0);
});

test("saving during a landing animation cleans up the card and preserves the reordered song fields", async () => {
  const f = await fixture();
  f.drag(0, 316);
  const landing = f.animations.find(animation => animation.element.className.includes("drop-settling"));
  f.get("save").emit("click");
  await flush();
  assert.equal(landing.cancelled, true);
  assert.equal(f.document.body.children.length, 0);
  assert.deepEqual(f.saved[0].order, [1, 2, 0]);
  assert.deepEqual(f.get("songs").children.map(row => row.querySelector(".song-name").textContent), ["Song 1", "Song 2", "Song 0"]);
  assert.equal(f.get("save").disabled, true);
  assert.match(f.get("notice").textContent, /顺序已保存/);
});

test("reduced motion skips landing animation and keyboard moves still retain focus", async () => {
  const f = await fixture(true);
  f.drag(0, 316);
  assert.deepEqual(f.keys(), [1, 2, 0]);
  assert.equal(f.animations.length, 0);
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.scrollCalls(), 0);
  const button = f.row(0).querySelector('[data-action="up"]');
  f.get("songs").emit("click", { target: button, detail: 0 });
  assert.deepEqual(f.keys(), [1, 0, 2]);
  assert.equal(f.document.activeElement.dataset.action, "up");
  assert.equal(f.scrollCalls(), 1);
});

test("dropping into the gap between cards inserts the song instead of returning it to its old position", async () => {
  const f = await fixture(false, 6);
  f.drag(0, 265);
  assert.deepEqual(f.keys(), [1, 0, 2]);
  const landing = f.animations.find(animation => animation.element.className.includes("drop-settling"));
  assert.equal(landing.keyframes[1].transform, "translate3d(10px,184px,0)");
  assert.equal(f.scrollCalls(), 0);
  landing.finish();
  await flush();
  assert.equal(f.document.body.children.length, 0);
});

test("insertion lines activate only when the floating card approaches the target edge", async () => {
  for (const [key, earlyY, nearY, className, expected] of [
    [0, 185, 209, "drop-after", [1, 0, 2]],
    [2, 250, 225, "drop-before", [0, 2, 1]]
  ]) {
    const premature = await fixture(true);
    premature.drag(key, earlyY);
    assert.deepEqual(premature.keys(), [0, 1, 2]);
    assert.equal(premature.get("save").disabled, true);
    const f = await fixture(true);
    f.start(key);
    f.window.emit("pointermove", { pointerId: 1, clientX: 40, clientY: earlyY });
    assert.equal(f.row(1).className.includes("drop-"), false);
    f.window.emit("pointermove", { pointerId: 1, clientX: 40, clientY: nearY });
    assert.equal(f.row(1).className.includes(className), true);
    f.window.emit("pointerup", { pointerId: 1, clientX: 40, clientY: nearY });
    assert.deepEqual(f.keys(), expected);
    assert.equal(f.get("save").disabled, false);
    assert.equal(f.scrollCalls(), 0);
  }
});

test("grabbing different parts of the handle uses the same floating card edge for matching", async () => {
  for (const [offsetY, y] of [[10, 180], [65, 235]]) {
    const f = await fixture(true);
    f.drag(0, y, 40, offsetY);
    assert.deepEqual(f.keys(), [1, 0, 2]);
  }
});

test("drops accept small list margins but reject distant edges", async () => {
  for (const [x, y] of [[-10, 316], [330, 316], [40, 345]]) {
    const f = await fixture(true);
    f.drag(0, y, x);
    assert.deepEqual(f.keys(), [1, 2, 0]);
    assert.equal(f.document.body.children.length, 0);
  }
  for (const [x, y] of [[-30, 316], [350, 316], [40, 365], [40, 400]]) {
    const f = await fixture(true);
    f.drag(0, y, x);
    assert.deepEqual(f.keys(), [0, 1, 2]);
    assert.equal(f.get("save").disabled, true);
  }
});
