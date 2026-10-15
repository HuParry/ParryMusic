const get = id => document.getElementById(id);
let tracks = [];
let order = [];
let revision = "";
let token = "";
let busy = true;
let conflict = false;
let dragging = null;
let settling = null;
let confirmAction = null;

const dirty = () => order.some((key, position) => key !== position);
function message(text, type = "") {
  get("notice").textContent = text;
  get("notice").className = "notice" + (type ? " " + type : "");
}
function updateControls() {
  get("save").disabled = busy || conflict || !dirty();
  get("discard").disabled = busy || !dirty();
  get("reload").disabled = busy;
  get("dirty-state").textContent = busy ? "正在处理" : !revision ? "读取失败" : conflict ? "需要重新读取" : dirty() ? "有未保存修改" : "已与文件同步";
  get("dirty-state").classList.toggle("dirty", dirty());
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
function title(key) {
  const track = tracks[key];
  return track && typeof track.name === "string" && track.name.trim() ? track.name : track && typeof track.url === "string" ? track.url : "未命名歌曲";
}
function render(focusKey, focusAction, animate = false, keyboardFocus = false, pointerDrop = false) {
  finishSettling();
  const positions = new Map();
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const row of get("songs").children) positions.set(Number(row.dataset.key), row.getBoundingClientRect().top + window.scrollY);
  }
  const locked = busy || conflict || !revision;
  const fragment = document.createDocumentFragment();
  order.forEach((key, position) => {
    const track = tracks[key];
    const row = document.createElement("li");
    row.className = "song";
    row.dataset.key = key;
    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.disabled = locked;
    handle.dataset.action = "drag";
    handle.setAttribute("aria-label", "拖动排序：" + title(key));
    handle.title = "拖动排序；也可使用上下按钮";
    handle.append(icon("grip"));
    const number = document.createElement("span");
    number.className = "song-number";
    number.textContent = String(position + 1).padStart(2, "0");
    const details = document.createElement("div");
    details.className = "song-details";
    const name = document.createElement("span");
    name.className = "song-name";
    name.textContent = title(key);
    name.title = title(key);
    const artist = document.createElement("span");
    artist.className = "song-artist";
    artist.textContent = track && typeof track.artist === "string" ? track.artist : "未知歌手";
    details.append(name, artist);
    const actions = document.createElement("div");
    actions.className = "song-actions";
    for (const direction of ["up", "down"]) {
      const button = document.createElement("button");
      button.className = "move-button";
      button.dataset.action = direction;
      button.disabled = locked || (direction === "up" ? position === 0 : position === order.length - 1);
      button.setAttribute("aria-label", (direction === "up" ? "上移：" : "下移：") + title(key));
      button.title = direction === "up" ? "上移" : "下移";
      button.append(icon(direction));
      actions.append(button);
    }
    row.append(handle, number, details, actions);
    fragment.append(row);
  });
  get("songs").replaceChildren(fragment);
  get("count").textContent = tracks.length;
  get("empty").hidden = busy || tracks.length > 0 || !revision;
  updateControls();
  if (focusKey !== undefined) {
    const row = get("songs").querySelector('[data-key="' + focusKey + '"]');
    row.classList.add("moved");
    const button = row.querySelector('[data-action="' + focusAction + '"]');
    if (keyboardFocus) (button && !button.disabled ? button : row.querySelector(".drag-handle")).focus({ preventScroll: true });
    if (!pointerDrop) row.scrollIntoView({ block: "nearest" });
  }
  for (const row of get("songs").children) {
    // The floating card settles from the pointer position, not its old slot.
    if (pointerDrop && Number(row.dataset.key) === focusKey) continue;
    const before = positions.get(Number(row.dataset.key));
    const offset = before === undefined ? 0 : before - row.getBoundingClientRect().top - window.scrollY;
    if (offset && typeof row.animate === "function") row.animate([
      { transform: "translateY(" + offset + "px)" }, { transform: "translateY(0)" }
    ], { duration: 180, easing: "cubic-bezier(.2,.7,.3,1)" });
  }
}
function move(key, destination, action = "drag", keyboardFocus = false, pointerDrop = false) {
  if (busy || conflict) return;
  const from = order.indexOf(key);
  if (from < 0 || destination < 0 || destination >= order.length || from === destination) return;
  order.splice(from, 1);
  order.splice(destination, 0, key);
  render(key, action, true, keyboardFocus, pointerDrop);
  message(dirty() ? "已移到第 " + (destination + 1) + " 位，保存后生效。" : "已恢复为文件中的顺序。");
}
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败，请重试。"), { status: response.status });
  return data;
}
async function load() {
  if (busy && revision) return;
  busy = true;
  render();
  message("正在读取歌单…");
  try {
    const data = await request("/api/playlist");
    tracks = data.tracks;
    order = tracks.map((_, index) => index);
    revision = data.revision;
    token = data.token;
    conflict = false;
    message(tracks.length ? "拖动排序，或点击上下按钮。" : "");
  } catch (error) { message(error.message, "error"); }
  finally { busy = false; render(); }
}
async function save() {
  if (busy || conflict || !dirty()) return;
  busy = true;
  render();
  message("正在保存顺序…");
  try {
    const data = await request("/api/order", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Order-Token": token },
      body: JSON.stringify({ revision, order })
    });
    tracks = data.tracks;
    order = tracks.map((_, index) => index);
    revision = data.revision;
    message("顺序已保存。" + (data.backup ? "原歌单已备份。" : ""), "success");
  } catch (error) {
    if (error.status === 409) conflict = true;
    message(error.message, "error");
  } finally { busy = false; render(); }
}
function confirmDiscard(action, reload = false) {
  if (!dirty()) return action();
  confirmAction = action;
  get("confirm-description").textContent = reload ? "重新读取会放弃当前调整，并加载文件中的最新顺序。" : "这会恢复本次读取时的歌曲顺序，文件不会改变。";
  get("confirm-dialog").showModal();
}
get("save").addEventListener("click", save);
get("reload").addEventListener("click", () => confirmDiscard(load, true));
get("discard").addEventListener("click", () => confirmDiscard(() => {
  order = tracks.map((_, index) => index);
  render();
  message(conflict ? "歌单已被其他程序修改，请点击“重新读取”。" : "已放弃尚未保存的调整。", conflict ? "error" : "");
}));
get("keep-editing").addEventListener("click", () => get("confirm-dialog").close());
get("confirm-discard").addEventListener("click", () => {
  get("confirm-dialog").close();
  if (confirmAction) confirmAction();
  confirmAction = null;
});
get("songs").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled || button.dataset.action === "drag") return;
  const key = Number(button.closest("li").dataset.key);
  move(key, order.indexOf(key) + (button.dataset.action === "up" ? -1 : 1), button.dataset.action, event.detail === 0);
});
function clearDrop() {
  for (const row of get("songs").children) row.classList.remove("drop-before", "drop-after");
}
function dragTarget() {
  clearDrop();
  dragging.target = null;
  const list = get("songs");
  const rows = Array.from(list.children);
  if (!rows.length) return;
  const first = rows[0].getBoundingClientRect();
  const last = rows[rows.length - 1].getBoundingClientRect();
  if (dragging.x < first.left - 24 || dragging.x > first.left + first.width + 24 ||
      dragging.y < first.top - 16 || dragging.y > last.bottom + 16) return;
  const from = order.indexOf(dragging.key);
  const previewTop = dragging.y - dragging.offsetY;
  const previewBottom = previewTop + dragging.height;
  let row = null;
  // Use the floating card's leading edge, with only 8px of tolerance.
  // Entering a target card alone must not highlight the line beyond it.
  for (let index = 0; index < rows.length; index += 1) {
    const bounds = rows[index].getBoundingClientRect();
    if (index < from && previewTop <= bounds.top + 8 && !row) row = rows[index];
    if (index > from && previewBottom >= bounds.bottom - 8) row = rows[index];
  }
  if (!row) return;
  dragging.target = Number(row.dataset.key);
  dragging.after = from < order.indexOf(dragging.target);
  row.classList.add(dragging.after ? "drop-after" : "drop-before");
}
function positionPreview() {
  if (dragging?.preview) dragging.preview.style.transform = "translate3d(" +
    (dragging.x - dragging.offsetX) + "px," + (dragging.y - dragging.offsetY) + "px,0)";
}
function dragScroll() {
  if (!dragging || !dragging.active) return;
  const top = document.querySelector(".toolbar").getBoundingClientRect().bottom + 30;
  if (dragging.y < top) window.scrollBy(0, -10);
  else if (dragging.y > window.innerHeight - 44) window.scrollBy(0, 10);
  dragTarget();
  dragging.frame = requestAnimationFrame(dragScroll);
}
function cancelDrag() {
  if (dragging?.frame) cancelAnimationFrame(dragging.frame);
  dragging?.preview?.remove();
  dragging = null;
  clearDrop();
  for (const row of get("songs").children) row.classList.remove("dragging");
}
function finishSettling(state = settling) {
  if (!state || settling !== state) return;
  settling = null;
  state.row.style.visibility = "";
  state.preview.remove();
  state.animation.cancel();
}
function settleDrop(state, destination) {
  const preview = state.preview;
  // Stop pointer tracking without removing the card at the release position.
  state.preview = null;
  cancelDrag();
  move(state.key, destination, "drag", false, true);
  const row = get("songs").querySelector('[data-key="' + state.key + '"]');
  if (!preview || !row || window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof preview.animate !== "function") {
    preview?.remove();
    return;
  }
  const bounds = row.getBoundingClientRect();
  preview.classList.add("drop-settling");
  preview.querySelector(".song-number").textContent = row.querySelector(".song-number").textContent;
  row.style.visibility = "hidden";
  const animation = preview.animate([
    { transform: preview.style.transform },
    { transform: "translate3d(" + bounds.left + "px," + bounds.top + "px,0)", boxShadow: "0 0 0 #0000", borderColor: "transparent" }
  ], { duration: 220, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
  settling = { preview, row, animation };
  const current = settling;
  animation.finished.then(() => finishSettling(current), () => finishSettling(current));
}
get("songs").addEventListener("pointerdown", event => {
  const handle = event.target.closest(".drag-handle");
  if (!handle || handle.disabled || event.button !== 0 || dragging) return;
  finishSettling();
  event.preventDefault();
  dragging = { key: Number(handle.closest("li").dataset.key), pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null };
  handle.setPointerCapture(event.pointerId);
});
window.addEventListener("pointermove", event => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  dragging.x = event.clientX;
  dragging.y = event.clientY;
  if (!dragging.active && Math.hypot(dragging.x - dragging.startX, dragging.y - dragging.startY) < 5) return;
  event.preventDefault();
  if (!dragging.active) {
    dragging.active = true;
    const row = get("songs").querySelector('[data-key="' + dragging.key + '"]');
    const bounds = row.getBoundingClientRect();
    dragging.offsetX = dragging.startX - bounds.left;
    dragging.offsetY = dragging.startY - bounds.top;
    dragging.height = bounds.height;
    dragging.preview = row.cloneNode(true);
    dragging.preview.className = "song drag-preview";
    dragging.preview.removeAttribute("data-key");
    dragging.preview.setAttribute("aria-hidden", "true");
    dragging.preview.setAttribute("inert", "");
    dragging.preview.style.width = bounds.width + "px";
    document.body.append(dragging.preview);
    row.classList.add("dragging");
    dragging.frame = requestAnimationFrame(dragScroll);
  }
  positionPreview();
  dragTarget();
}, { passive: false });
window.addEventListener("pointerup", event => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  const state = dragging;
  if (!state.active) { cancelDrag(); return; }
  state.x = event.clientX;
  state.y = event.clientY;
  positionPreview();
  dragTarget();
  const from = order.indexOf(state.key);
  let destination = from;
  if (state.target !== null) {
    destination = order.indexOf(state.target) + (state.after ? 1 : 0);
    if (from < destination) destination -= 1;
  }
  settleDrop(state, destination);
});
window.addEventListener("pointercancel", event => { if (dragging?.pointerId === event.pointerId) cancelDrag(); });
window.addEventListener("lostpointercapture", event => { if (dragging?.pointerId === event.pointerId) cancelDrag(); });
window.addEventListener("blur", () => { cancelDrag(); finishSettling(); });
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!get("confirm-dialog").open) void save();
  }
});
void load();
