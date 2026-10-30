// Runway Studio: a front end for ComfyUI workflows.
// Loads API-format workflows from /studio/workflows, fills {{PLACEHOLDERS}},
// queues them on /api/prompt, tracks progress over the websocket and shows results from /api/view.

const $ = (sel, el = document) => el.querySelector(sel);

const PRESETS = {
  woman: [
    ["Studio model", "Full-length fashion photo of a young woman standing straight and facing the camera, arms relaxed at her sides, wearing a plain fitted white tank top and white shorts and simple nude pointed high heels, neutral confident expression, long dark hair, plain light grey studio backdrop, soft even lighting, sharp focus, entire body visible from head to toe"],
    ["Editorial", "Full-length editorial photo of a tall woman with short platinum hair standing in a relaxed pose facing the camera, wearing a simple black bodysuit, minimal makeup, clean seamless beige backdrop, soft diffused fashion lighting, full body from head to toe, high detail"],
    ["Street", "Full-length photo of a young woman with curly hair standing on a quiet city sidewalk facing the camera, wearing a plain grey fitted t-shirt and leggings, white sneakers, natural daylight, shallow depth of field, full body from head to toe"],
  ],
  dress: [
    ["Red gown", "Product photo of an elegant red silk evening gown with thin straps, a fitted bodice and a long flowing skirt with a thigh-high slit, shown on an invisible mannequin, full length visible, plain white background, soft studio lighting, detailed fabric texture"],
    ["Floral sundress", "Product photo of a light summer sundress with a small yellow and blue floral print, square neckline, puff sleeves and a flared knee-length skirt, on an invisible mannequin, full length visible, plain white background, studio lighting"],
    ["Black cocktail", "Product photo of a sleek black satin cocktail dress with a one-shoulder neckline and a fitted knee-length silhouette, on an invisible mannequin, full length visible, plain white background, studio lighting, crisp detail"],
    ["Gold sequin", "Product photo of a floor-length gold sequin gown with a deep V neckline and long sleeves, sparkling under studio light, on an invisible mannequin, full length visible, plain dark grey background"],
  ],
  tryon: [
    ["Try-on", "Dress the woman from image 1 in the dress from image 2. Keep her face, hair, skin tone, body shape and pose exactly the same as image 1. Reproduce the dress from image 2 accurately: same color, fabric, pattern, neckline and cut, fitted naturally to her body with realistic folds. She wears elegant high-heeled shoes that match the dress, clearly visible. Full-length photo, entire body visible from head to toe including her shoes, clean studio background, photorealistic."],
    ["Try-on + runway setting", "Dress the woman from image 1 in the dress from image 2, keeping her face, hair and body exactly the same and copying the dress design accurately. She wears elegant high-heeled shoes that match the dress. Place her at the start of a fashion show runway with dramatic spotlights and a dark audience in the background. Full-length photo, entire body visible including her shoes, photorealistic."],
  ],
  runway: [
    ["Fashion show runway", "A fashion model walks confidently toward the camera down a brightly lit fashion show runway, the dress flowing and moving naturally with each step, audience seated on both sides with camera flashes going off, smooth tracking shot at eye level, cinematic lighting, high-end fashion week atmosphere. Sound: upbeat electronic runway music, audience murmurs and camera shutters."],
    ["Red carpet", "The woman walks slowly along a red carpet at a glamorous evening premiere, turning gently to pose for photographers, the dress catching the light, bursts of camera flashes, velvet ropes and a cheering crowd in the background, smooth cinematic camera move. Sound: crowd cheering, photographers calling out, flashes popping."],
    ["Turn & pose", "The woman takes two steps forward, does a slow elegant turn to show the back of the dress, then faces the camera and strikes a pose, fabric swinging naturally, clean studio backdrop, soft fashion lighting, static camera. Sound: soft lounge music."],
  ],
};

// ---------- settings (kept in this browser only) ----------
const SETTINGS_KEY = "runway-studio.settings";
// Served by ComfyUI at /studio/ -> same origin. Hosted elsewhere (GitHub Pages) -> the visitor's local ComfyUI.
function defaultLocalUrl() {
  return location.pathname.startsWith("/studio") ? location.origin : "http://127.0.0.1:8188";
}
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch {}
  return {
    mode: s.mode === "cloud" ? "cloud" : "local",
    localUrl: s.localUrl || defaultLocalUrl(),
    cloudUrl: s.cloudUrl || "https://cloud.comfy.org",
    apiKey: s.apiKey || "",
  };
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

// ---------- ComfyUI client ----------
class Comfy {
  constructor(settings) {
    this.settings = settings;
    this.clientId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    this.listeners = new Map();
    this.ws = null;
  }
  get cloud() { return this.settings.mode === "cloud"; }
  get root() { return (this.cloud ? this.settings.cloudUrl : this.settings.localUrl).replace(/\/+$/, ""); }
  get api() { return `${this.root}/api`; }
  // Comfy Cloud v1 reads X-API-Key, v2 reads a bearer token; send both.
  headers() {
    const key = this.settings.apiKey;
    return this.cloud && key ? { "X-API-Key": key, Authorization: `Bearer ${key}` } : {};
  }

  reconnect() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.connect();
  }
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    let url;
    try {
      const u = new URL(this.root);
      url = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/ws?clientId=${encodeURIComponent(this.clientId)}`;
      if (this.cloud && this.settings.apiKey) url += `&token=${encodeURIComponent(this.settings.apiKey)}`;
    } catch { setConn(false, "Bad URL"); return; }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => setConn(true, this.cloud ? "Comfy Cloud" : "Local ComfyUI");
    ws.onclose = () => { setConn(false, "Reconnecting…"); setTimeout(() => this.connect(), 2500); };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary previews
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const pid = msg.data && msg.data.prompt_id;
      const fn = pid && this.listeners.get(pid);
      if (fn) fn(msg);
    };
  }

  async queue(workflow) {
    const r = await fetch(`${this.api}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(describeError(j) || `ComfyUI returned HTTP ${r.status}`);
    return j.prompt_id;
  }

  async history(pid) {
    const r = await fetch(`${this.api}/history/${pid}`, { headers: this.headers() });
    if (!r.ok) return null;
    const j = await r.json();
    return j[pid] || null;
  }

  // Resolves with the output files once the prompt finishes. Websocket drives progress;
  // a slow history poll is the fallback in case a websocket message is missed.
  wait(pid, workflow, onStatus) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = async (err) => {
        if (done) return;
        done = true;
        this.listeners.delete(pid);
        clearInterval(poll);
        if (err) return reject(err);
        try { resolve(collectFiles(await this.history(pid))); } catch (e) { reject(e); }
      };
      const label = (id) => (workflow[id] && ((workflow[id]._meta && workflow[id]._meta.title) || workflow[id].class_type)) || id;
      let current = "";
      this.listeners.set(pid, (msg) => {
        const d = msg.data || {};
        switch (msg.type) {
          case "execution_start": onStatus("Starting…"); break;
          case "executing":
            if (d.node == null) finish();
            else { current = label(d.node); onStatus(`${current}…`); }
            break;
          case "progress":
            onStatus(`${current || label(d.node)}: step ${d.value} of ${d.max}`, d.max ? d.value / d.max : null);
            break;
          case "execution_success": finish(); break;
          case "execution_error": finish(new Error(`${d.node_type || "A node"} failed: ${d.exception_message || "unknown error"}`)); break;
          case "execution_interrupted": finish(new Error("Stopped")); break;
        }
      });
      const poll = setInterval(async () => {
        try {
          const h = await this.history(pid);
          if (!h || !h.status) return;
          if (h.status.status_str === "error") {
            const m = (h.status.messages || []).find((x) => x[0] === "execution_error");
            finish(new Error(m ? `${m[1].node_type} failed: ${m[1].exception_message}` : "Run failed"));
          } else if (h.status.completed) finish();
        } catch {}
      }, 4000);
    });
  }

  viewUrl(f) {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" });
    return `${this.api}/view?${q}`;
  }
  async blob(f) {
    const r = await fetch(this.viewUrl(f), { headers: this.headers() });
    if (!r.ok) throw new Error(`Could not fetch ${f.filename}`);
    return r.blob();
  }
  // Cloud needs the key header, so media is loaded as a blob there.
  async mediaUrl(f) {
    return this.cloud ? URL.createObjectURL(await this.blob(f)) : this.viewUrl(f);
  }
  async upload(blob, name) {
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const r = await fetch(`${this.api}/upload/image`, { method: "POST", body: fd, headers: this.headers() });
    if (!r.ok) throw new Error(`Upload failed (HTTP ${r.status})`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }
}

function collectFiles(h) {
  const files = [];
  for (const out of Object.values((h && h.outputs) || {})) {
    for (const key of ["images", "videos", "gifs", "video"]) {
      for (const f of out[key] || []) if (f && f.filename) files.push(f);
    }
  }
  return files;
}

function describeError(j) {
  if (!j || !j.error) return "";
  const parts = [j.error.message || String(j.error)];
  for (const [id, ne] of Object.entries(j.node_errors || {})) {
    for (const e of ne.errors || []) parts.push(`${ne.class_type} (#${id}): ${e.message}${e.details ? ` (${e.details})` : ""}`);
  }
  return parts.join("\n");
}

// ---------- workflow templates ----------
async function loadWorkflow(name) {
  const r = await fetch(`workflows/${name}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Workflow ${name} not found in the workflows folder`);
  return r.json();
}

// Replaces "{{KEY}}" strings. A value that is exactly "{{KEY}}" keeps the variable's type (numbers stay numbers).
function fill(node, vars) {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((x) => fill(x, vars));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  }
  return node;
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 48);

// ---------- UI helpers ----------
// The red banner only shows after a few seconds offline, so a quick reconnect doesn't flash it.
let offlineTimer = null;
function setConn(on, text) {
  const el = $("#conn");
  el.classList.toggle("on", on);
  $("span", el).textContent = text;
  clearTimeout(offlineTimer);
  if (on) { $("#offline").hidden = true; checkSetup(); checkVideoModel(); return; }
  offlineTimer = setTimeout(() => {
    $("#offline-url").textContent = comfy.root;
    $("#offline").hidden = false;
  }, 4000);
}

function statusUI(panel) {
  const box = $(".status", panel);
  const bar = $(".bar b", box);
  const text = $("span", box);
  return {
    busy(msg, pct) {
      box.className = "status busy";
      text.textContent = msg;
      if (pct == null) { bar.classList.add("indet"); }
      else { bar.classList.remove("indet"); bar.style.width = `${Math.round(pct * 100)}%`; }
    },
    ok(msg) { box.className = "status ok"; text.textContent = msg; bar.style.width = "100%"; },
    err(msg) { box.className = "status err"; text.textContent = msg; },
  };
}

function setupChips(panel, presets) {
  const chips = $(".chips", panel);
  const ta = $("textarea", panel);
  presets.forEach(([label, text], i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.onclick = () => {
      ta.value = text;
      chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
    };
    chips.appendChild(b);
    if (i === 0) b.click();
  });
  ta.addEventListener("input", () => chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active")));
}

// Each slot is an image that can feed a later stage: { url, file?, input? }.
// file = ComfyUI output reference, input = name in ComfyUI's input folder (uploaded lazily).
const slots = { woman: null, dress: null, look: null };

function setSlot(name, value) {
  slots[name] = value;
  document.querySelectorAll(`figure[data-slot="${name}"] .thumb`).forEach((t) => {
    t.classList.remove("empty");
    t.innerHTML = "";
    const img = new Image();
    img.src = value.url;
    t.appendChild(img);
  });
}

async function slotInput(name) {
  const s = slots[name];
  if (!s) throw new Error(`No ${name === "look" ? "look" : name} yet. Finish the previous stage first.`);
  if (!s.input) {
    const blob = await comfy.blob(s.file);
    s.input = await comfy.upload(blob, `runway_${name}_${Date.now()}.png`);
  }
  return s.input;
}

function showOutput(container, url, file, { video = false, seed, seconds } = {}) {
  container.innerHTML = "";
  const media = video ? Object.assign(document.createElement("video"), { src: url, controls: true, autoplay: true, loop: true, playsInline: true }) : Object.assign(new Image(), { src: url });
  container.appendChild(media);
  const meta = document.createElement("div");
  meta.className = "meta";
  const info = document.createElement("span");
  info.textContent = `seed ${seed} · ${seconds}s`;
  const dl = Object.assign(document.createElement("a"), { href: url, download: file.filename, textContent: "Download", className: "link" });
  meta.append(info, dl);
  container.appendChild(meta);
}

// Runs one stage end to end. Resolves true on success so the one-click pipeline can chain stages.
async function runStage({ panel, button, workflow, vars, outEl, video, onDone }) {
  const ui = statusUI(panel);
  button.disabled = true;
  const t0 = performance.now();
  const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1);
  let last = "Preparing…";
  let lastPct = null;
  const busy = (msg, pct = null) => { last = msg; lastPct = pct; ui.busy(`${msg}  ·  ${elapsed()}s`, pct); };
  const tick = setInterval(() => busy(last, lastPct), 100);
  busy("Preparing…");
  try {
    const seed = randomSeed();
    const wf = fill(await loadWorkflow(workflow), { SEED: seed, ...(await vars()) });
    const left = JSON.stringify(wf).match(/\{\{(\w+)\}\}/);
    if (left) throw new Error(`Workflow ${workflow} still has {{${left[1]}}} with no value`);
    comfy.connect();
    busy("Queued…");
    const pid = await comfy.queue(wf);
    const files = await comfy.wait(pid, wf, busy);
    const file = files[files.length - 1];
    if (!file) throw new Error("Finished, but no output came back");
    const seconds = elapsed();
    const url = await comfy.mediaUrl(file);
    clearInterval(tick);
    showOutput(outEl, url, file, { video, seed, seconds });
    ui.ok(`Done in ${seconds}s`);
    if (onDone) onDone({ url, file });
    return true;
  } catch (e) {
    console.error(e);
    clearInterval(tick);
    ui.err(e.message);
    return false;
  } finally {
    clearInterval(tick);
    button.disabled = false;
  }
}

// ---------- surprise me ----------
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const SURPRISE = {
  woman: () => `Full-length fashion photo of a ${pick(["young", "twenty-something", "thirty-something"])} ${pick(["East Asian", "Black", "South Asian", "Latina", "Scandinavian", "Middle Eastern", "mixed-race", "Mediterranean"])} woman with ${pick(["long dark wavy hair", "a short platinum bob", "curly auburn hair", "a sleek black ponytail", "long braids", "shoulder-length honey blonde hair", "a pixie cut"])}, standing straight and facing the camera, arms relaxed at her sides, wearing a ${pick(["plain fitted white tank top and white shorts", "simple black bodysuit", "fitted neutral beige t-shirt and leggings"])} with simple nude pointed high heels, confident neutral expression, ${pick(["plain light grey studio backdrop", "clean warm beige seamless backdrop", "soft white cyclorama"])}, soft even lighting, sharp focus, entire body visible from head to toe`,
  dress: () => `Product photo of ${pick(["an emerald green", "a midnight blue", "a blush pink", "an ivory", "a crimson", "a lavender", "a champagne gold", "a black", "a cobalt blue", "a sunflower yellow", "a silver"])} ${pick(["silk satin", "chiffon", "velvet", "sequined", "tulle", "lace", "organza"])} ${pick(["off-the-shoulder ball gown with a full skirt", "one-shoulder column gown", "mermaid gown with a dramatic train", "wrap midi dress", "halter-neck cocktail dress", "corset bodice gown with a high slit", "puff-sleeve tea dress", "strapless A-line gown"])} ${pick(["with delicate floral embroidery", "with a plunging V neckline", "with crystal beading", "with a ruffled hem", "with a thin belt at the waist", "with a sheer cape", "with an open back"])}, shown on an invisible mannequin, full length visible, plain white background, soft studio lighting, detailed fabric texture`,
};

function surprise(id) {
  const panel = $(`#${id}`);
  $("textarea", panel).value = SURPRISE[id]();
  panel.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  $(".chip.dice", panel).classList.add("active");
}

function addSurpriseChip(id) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip dice";
  b.textContent = "🎲 Surprise me";
  b.onclick = () => surprise(id);
  $(`#${id} .chips`).prepend(b);
}

// ---------- wiring ----------
const settings = loadSettings();
const comfy = new Comfy(settings);
const runners = {}; // stage id -> () => Promise<boolean>

function wireGenerator(id, label) {
  const panel = $(`#${id}`);
  setupChips(panel, PRESETS[id]);
  addSurpriseChip(id);
  const button = $(".gen", panel);
  runners[id] = () => runStage({
    panel, button, workflow: "klein_generate.json", outEl: $(".out", panel),
    vars: async () => {
      const prompt = $("textarea", panel).value.trim();
      if (!prompt) throw new Error(`Write a ${label} prompt or pick a preset`);
      return { PROMPT: prompt, WIDTH: 832, HEIGHT: 1216 };
    },
    onDone: ({ url, file }) => setSlot(id, { url, file }),
  });
  button.onclick = runners[id];
  $(".upload input", panel).onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const ui = statusUI(panel);
    ui.busy("Uploading…");
    try {
      const input = await comfy.upload(f, `runway_${id}_${Date.now()}_${f.name.replace(/[^\w.-]/g, "_")}`);
      const url = URL.createObjectURL(f);
      const out = $(".out", panel);
      out.innerHTML = "";
      out.appendChild(Object.assign(new Image(), { src: url }));
      setSlot(id, { url, input });
      ui.ok("Photo ready");
    } catch (e) { ui.err(e.message); }
    ev.target.value = "";
  };
}

wireGenerator("woman", "model");
wireGenerator("dress", "dress");

// The try-on LoRA expects its trigger word and reference order person, top, bottom (a dress fills both).
const LORA_PROMPT = "TRYON a full-body photo of a person. Replace the outfit with the top and bottom as shown in the reference images. She wears elegant high-heeled shoes that match the outfit. The final image is a full body shot.";

{
  const panel = $("#tryon");
  setupChips(panel, PRESETS.tryon);
  const button = $(".gen", panel);
  const useLora = $(".use-lora", panel);
  useLora.onchange = () => {
    if (useLora.checked) {
      $("textarea", panel).value = LORA_PROMPT;
      panel.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    } else {
      $(".chip", panel).click();
    }
  };
  runners.tryon = () => runStage({
    panel, button, workflow: useLora.checked ? "klein_tryon_lora.json" : "klein_merge.json", outEl: $("#tryon-out .out"),
    vars: async () => ({
      PROMPT: $("textarea", panel).value.trim(),
      IMAGE_1: await slotInput("woman"),
      IMAGE_2: await slotInput("dress"),
    }),
    onDone: ({ url, file }) => setSlot("look", { url, file }),
  });
  button.onclick = runners.tryon;
}

{
  const panel = $("#runway");
  setupChips(panel, PRESETS.runway);
  const button = $(".gen", panel);
  runners.runway = () => runStage({
    panel, button, workflow: "ltx_runway.json", outEl: $("#runway-out .out"), video: true,
    vars: async () => {
      const fps = 24;
      const secs = Number($(".duration", panel).value);
      const [w, h] = $(".size", panel).value.split("x").map(Number);
      return {
        PROMPT: $("textarea", panel).value.trim(),
        IMAGE_1: await slotInput("look"),
        WIDTH: w, HEIGHT: h, FPS: fps,
        FRAMES: Math.round((secs * fps) / 8) * 8 + 1, // LTX wants 8n+1 frames
      };
    },
  });
  button.onclick = runners.runway;
}

// ---------- one click: model + dress -> try-on -> runway ----------
{
  const btn = $("#one-click");
  const steps = $("#pipeline");
  const total = $("#total");
  const mark = (step, state) => { steps.querySelector(`[data-step="${step}"]`).className = state; };
  const focus = (sel) => $(sel).scrollIntoView({ behavior: "smooth", block: "center" });

  btn.onclick = async () => {
    btn.disabled = true;
    steps.querySelectorAll("span").forEach((s) => (s.className = ""));
    const t0 = performance.now();
    const tick = setInterval(() => (total.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`), 100);
    try {
      if ($("#auto-surprise").checked) { surprise("woman"); surprise("dress"); }
      mark("woman", "run"); mark("dress", "run");
      focus("#woman");
      const [a, b] = await Promise.all([runners.woman(), runners.dress()]);
      mark("woman", a ? "ok" : "err"); mark("dress", b ? "ok" : "err");
      if (!a || !b) return;
      mark("tryon", "run"); focus("#tryon");
      const c = await runners.tryon();
      mark("tryon", c ? "ok" : "err");
      if (!c || !$("#auto-video").checked) return;
      mark("runway", "run"); focus("#runway");
      mark("runway", (await runners.runway()) ? "ok" : "err");
    } finally {
      clearInterval(tick);
      total.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s total`;
      btn.disabled = false;
    }
  };
}

// ---------- setup panel: models, launch commands, live check ----------
const HF = "https://huggingface.co";
const MODELS = [
  { file: "flux-2-klein-4b-fp8.safetensors", label: "FLUX.2 Klein 4B", dir: "diffusion_models", size: "3.8 GB",
    url: `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors`, node: "UNETLoader", field: "unet_name" },
  { file: "qwen_3_4b.safetensors", label: "Qwen3 4B (text encoder)", dir: "text_encoders", size: "7.5 GB",
    url: `${HF}/Comfy-Org/flux2-klein/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`, node: "CLIPLoader", field: "clip_name" },
  { file: "flux2-vae.safetensors", label: "FLUX.2 VAE", dir: "vae", size: "0.3 GB",
    url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors`, node: "VAELoader", field: "vae_name" },
  { file: "tryon-klein-4b.safetensors", label: "Try-on LoRA (optional)", dir: "loras", size: "0.1 GB",
    url: `${HF}/xocialize/tryon-FLUX.2-klein-4B-lora/resolve/main/tryon-klein-4b.safetensors`, node: "LoraLoaderModelOnly", field: "lora_name" },
  { file: "ltx-2.3-22b-distilled-fp8.safetensors", label: "LTX-2.3 22B (video)", dir: "checkpoints", size: "27.5 GB",
    url: `${HF}/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors`, node: "CheckpointLoaderSimple", field: "ckpt_name" },
  { file: "gemma_3_12B_it_fp4_mixed.safetensors", label: "Gemma 3 12B (video text encoder)", dir: "text_encoders", size: "8.8 GB",
    url: `${HF}/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors`, node: "LTXAVTextEncoderLoader", field: "text_encoder" },
];
const hosted = !location.pathname.startsWith("/studio"); // e.g. GitHub Pages

function renderModels(installed) {
  $("#model-rows").innerHTML = MODELS.map((m) => {
    const status = !installed ? "—" : installed.has(m.file) ? '<span class="ok">✓ Installed</span>' : '<span class="miss">Missing</span>';
    return `<tr><td>${status}</td><td><a href="${m.url}" target="_blank" rel="noopener">${m.label} ⬇</a></td><td><code>models/${m.dir}</code></td><td>${m.size}</td></tr>`;
  }).join("");
}

function setupPanel() {
  const origin = hosted && location.protocol.startsWith("http") ? location.origin : "https://<your-site>.github.io";
  $("#cmd-win").textContent = `.\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --enable-cors-header ${origin}`;
  $("#cmd-mac").textContent = `python main.py --enable-cors-header ${origin}`;
  document.querySelectorAll("#setup .origin").forEach((el) => (el.textContent = origin));
  document.querySelectorAll("#setup .copy").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent); b.textContent = "Copied"; } catch { b.textContent = "Select & copy"; }
      setTimeout(() => (b.textContent = "Copy"), 1500);
    };
  });
  renderModels(null);
  $("#setup").open = hosted;
  $("#setup-status").textContent = "· not connected yet";
}

// Runs whenever ComfyUI connects: which models are installed, and which GPU it has.
async function checkSetup() {
  if (comfy.cloud) { $("#setup-status").textContent = "· running on Comfy Cloud"; return; }
  try {
    const installed = new Set();
    for (const node of [...new Set(MODELS.map((m) => m.node))]) {
      const r = await fetch(`${comfy.api}/object_info/${node}`);
      if (!r.ok) continue;
      const spec = (await r.json())[node].input.required;
      for (const m of MODELS.filter((x) => x.node === node)) {
        const list = spec[m.field] && spec[m.field][0];
        if (Array.isArray(list)) list.forEach((n) => installed.add(n));
      }
    }
    renderModels(installed);
    const missing = MODELS.filter((m) => !installed.has(m.file) && !m.label.includes("optional")).length;
    $("#setup-status").textContent = missing ? `· ${missing} model${missing > 1 ? "s" : ""} missing` : "· all set ✓";
    if (missing && hosted) $("#setup").open = true;
    const stats = await (await fetch(`${comfy.api}/system_stats`)).json();
    const gpu = stats.devices && stats.devices[0];
    $("#gpu-info").textContent = gpu ? `Connected to ComfyUI ${stats.system.comfyui_version} · ${gpu.name.replace(/^cuda:\d+ /, "").replace(/ : .*$/, "")} · ${Math.round(gpu.vram_total / 2 ** 30)} GB VRAM` : "";
  } catch {}
}

// Untick "include video" while the LTX model isn't installed yet.
async function checkVideoModel() {
  if (comfy.cloud) return;
  try {
    const r = await fetch(`${comfy.api}/object_info/CheckpointLoaderSimple`);
    const names = (await r.json()).CheckpointLoaderSimple.input.required.ckpt_name[0];
    const ready = names.some((n) => n.startsWith("ltx-2.3"));
    $("#auto-video").checked = ready;
    $("#video-note").textContent = ready ? "" : "(video model still downloading)";
  } catch {}
}

// ---------- settings dialog ----------
{
  const dlg = $("#settings");
  const form = $("form", dlg);
  $("#open-settings").onclick = () => {
    form.mode.value = settings.mode;
    form.localUrl.value = settings.localUrl;
    form.cloudUrl.value = settings.cloudUrl;
    form.apiKey.value = settings.apiKey;
    dlg.showModal();
  };
  $("#clear-key").onclick = () => { form.apiKey.value = ""; };
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    Object.assign(settings, {
      mode: form.mode.value === "cloud" ? "cloud" : "local",
      localUrl: form.localUrl.value.trim() || defaultLocalUrl(),
      cloudUrl: form.cloudUrl.value.trim() || "https://cloud.comfy.org",
      apiKey: form.apiKey.value.trim(),
    });
    saveSettings(settings);
    comfy.reconnect();
  });
}

// ---------- Comfy Cloud panel (same settings as the dialog) ----------
{
  const key = $("#cloud-key");
  const on = $("#cloud-on");
  const status = $("#cloud-status");
  key.value = settings.apiKey;
  on.checked = settings.mode === "cloud";
  $("#cloud-save").onclick = () => {
    if (on.checked && !key.value.trim()) { status.textContent = "Add your API key first."; return; }
    settings.apiKey = key.value.trim();
    settings.mode = on.checked ? "cloud" : "local";
    saveSettings(settings);
    comfy.reconnect();
    status.textContent = on.checked ? "Saved. Running on Comfy Cloud." : "Saved. Running locally.";
  };
}

setupPanel();
comfy.connect();
