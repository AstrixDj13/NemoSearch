// NemoSearch frontend: Multi-Agent Deep Research on NVIDIA Nemotron
// Features: Focus modes, Citation hover-to-verify popover, Interactive follow-up Q&A, Slide deck modal, PDF export.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  depth: "quick",
  focus: "web",
  es: null,
  report: "",
  think: "",
  sources: {},
  notes: [],
  t0: 0,
  timer: null,
  renderQueued: false,
  question: "",
  thread: []
};

// ---------------------------------------------------------------- health
fetch("/api/health").then(r => r.json()).then(h => {
  const pill = $("#mode-pill");
  pill.textContent = h.mock ? "DEMO MODE" : "LIVE · Nemotron 3";
  pill.classList.add(h.mock ? "demo" : "live");
  pill.title = h.mock ? "No NEBIUS_API_KEY set: simulated model output" : Object.values(h.models).join("\n");
  $("#scout-tier").textContent = h.search_provider === "tavily" ? "Tavily" : "Wikipedia";
  const scoutBadge = $("#scout-badge");
  if (scoutBadge) scoutBadge.textContent = h.search_provider === "tavily" ? "Tavily Active" : "Wikipedia Fallback";
}).catch(() => { $("#mode-pill").textContent = "offline"; });

// ---------------------------------------------------------------- input & controls
const input = $("#question-input");
const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; };
input.addEventListener("input", autosize);
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask-form").requestSubmit(); } });

// Focus selector
$$(".focus-btn").forEach(b => b.addEventListener("click", () => {
  $$(".focus-btn").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  state.focus = b.dataset.focus;
}));

// Depth toggle
$$(".seg-btn").forEach(b => b.addEventListener("click", () => {
  $$(".seg-btn").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  state.depth = b.dataset.depth;
}));

// Example questions
$$(".ex").forEach(b => b.addEventListener("click", () => {
  input.value = b.textContent;
  if (b.dataset.focus) {
    const fb = $(`button[data-focus="${b.dataset.focus}"]`);
    if (fb) fb.click();
  }
  autosize();
  input.focus();
}));

$("#ask-form").addEventListener("submit", e => {
  e.preventDefault();
  const q = input.value.trim();
  if (q.length >= 3) start(q);
});

$("#new-btn").addEventListener("click", () => reset(true));

$("#copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(withRefs());
  toast("Research Brief copied with references");
});

$("#download-btn").addEventListener("click", () => {
  const blob = new Blob([withRefs()], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: slug(state.question) + ".md"
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// PDF Export (uses browser print stylesheet)
$("#pdf-btn").addEventListener("click", () => {
  window.print();
});

// Slide Deck Generation
$("#slides-btn").addEventListener("click", async () => {
  if (!state.report) { toast("Run an investigation first", true); return; }
  toast("Synthesizing 5-Slide Executive Deck...");
  try {
    const res = await fetch("/api/slides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: state.question, report: state.report })
    });
    const deck = await res.json();
    renderSlideModal(deck);
  } catch (err) {
    toast("Failed to generate slides: " + err, true);
  }
});

// ---------------------------------------------------------------- research pipeline
function start(q) {
  reset(false);
  state.question = q;
  $("#hero").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#report-title").textContent = q;
  $("#run-btn").disabled = true;
  state.t0 = performance.now();
  state.timer = setInterval(() => {
    $("#timer").textContent = ((performance.now() - state.t0) / 1000).toFixed(1) + "s";
  }, 100);
  window.scrollTo({ top: 0, behavior: "smooth" });

  const url = `/api/research?q=${encodeURIComponent(q)}&depth=${state.depth}&focus=${state.focus}`;
  const es = new EventSource(url);
  state.es = es;
  es.onmessage = m => handle(JSON.parse(m.data));
  es.addEventListener("end", finish);
  es.onerror = () => {
    if (state.es) {
      toast("Research stream finished or interrupted");
      finish();
    }
  };
}

function finish() {
  if (state.es) { state.es.close(); state.es = null; }
  clearInterval(state.timer);
  $("#run-btn").disabled = false;
  $("#reasoning").classList.remove("live");
  renderReport(true);
  $("#thread-section").classList.remove("hidden");
}

function reset(showHero = true) {
  if (state.es) { state.es.close(); state.es = null; }
  clearInterval(state.timer);
  Object.assign(state, { report: "", think: "", sources: {}, notes: [], thread: [] });
  $$(".node").forEach(n => { n.className = "node"; $(".nd", n).textContent = "Waiting"; });
  $("#plan-angle").textContent = "";
  $("#plan-queries").innerHTML = "";
  $("#critic-card").classList.add("hidden");
  $("#gaps").innerHTML = "";
  $("#sources").innerHTML = "";
  $("#src-count").textContent = "0";
  $("#think").textContent = "";
  $("#think-count").textContent = "";
  $("#reasoning").open = false;
  $("#report").innerHTML = '<div class="skeleton"><div></div><div></div><div></div><div></div><div></div></div>';
  $("#thread-section").classList.add("hidden");
  $("#thread-messages").innerHTML = "";
  $("#kpis").innerHTML = "";
  $("#model-ids").innerHTML = "";
  $("#timer").textContent = "0.0s";
  $$(".mrow").forEach(r => { $(".bar i", r).style.width = "0"; $(".mval", r).textContent = "–"; });
  $("#run-btn").disabled = false;
  hideCitationPopover();
  if (showHero) {
    $("#workspace").classList.add("hidden");
    $("#hero").classList.remove("hidden");
    input.focus();
  }
}

// ---------------------------------------------------------------- event stream handler
function handle(ev) {
  switch (ev.type) {
    case "init":
      $("#model-ids").innerHTML = Object.entries(ev.models).map(([r, m]) => `${r}: ${esc(m)}`).join("<br>");
      break;
    case "stage": {
      const n = $(`.node[data-agent="${ev.agent}"]`);
      if (!n) break;
      n.classList.remove("running", "done");
      n.classList.add(ev.status);
      $(".nd", n).textContent = ev.detail || ev.status;
      if (ev.agent === "writer" && ev.status === "running") {
        $("#reasoning").classList.add("live");
      }
      break;
    }
    case "plan":
      if (ev.angle && !ev.followup) $("#plan-angle").textContent = ev.angle;
      ev.sub_queries.forEach((q, i) => {
        const li = document.createElement("li");
        li.textContent = q;
        li.style.animationDelay = (i * 70) + "ms";
        if (ev.followup) li.classList.add("followup");
        $("#plan-queries").appendChild(li);
      });
      break;
    case "source":
      addSource(ev.source);
      break;
    case "note":
      state.notes.push(ev);
      updateSource(ev);
      break;
    case "critique":
      $("#critic-card").classList.remove("hidden");
      $("#coverage").textContent = `coverage ${ev.coverage}/10`;
      $("#gaps").innerHTML = ev.gaps.map(g => `<li>${esc(g)}</li>`).join("") || "<li>No major gaps found</li>";
      break;
    case "think":
      state.think += ev.delta;
      const pre = $("#think");
      pre.textContent = state.think;
      pre.scrollTop = pre.scrollHeight;
      $("#think-count").textContent = `· ${state.think.split(/\s+/).length} words`;
      if (!state.report) $("#reasoning").open = true;
      break;
    case "report":
      if (!state.report) $("#reasoning").open = false;
      state.report += ev.delta;
      queueRender();
      break;
    case "done":
      if (ev.sources) {
        for (const [id, s] of Object.entries(ev.sources)) {
          if (state.sources[id]) Object.assign(state.sources[id], s);
        }
      }
      showMetrics(ev);
      break;
    case "error":
      toast(ev.message, true);
      $("#report").innerHTML = `<blockquote>${esc(ev.message)}</blockquote>`;
      break;
  }
}

function addSource(s) {
  state.sources[s.id] = s;
  const li = document.createElement("li");
  li.className = "src reading";
  li.id = `src-${s.id}`;
  li.innerHTML = `
    <div class="src-top">
      <span class="src-id">${s.id}</span>
      <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
    </div>
    <div class="src-meta">
      <span>${esc(s.domain)}</span>
      <span class="rel"><span></span><div class="rel-bar"><i></i></div></span>
    </div>`;
  $("#sources").appendChild(li);
  $("#src-count").textContent = Object.keys(state.sources).length;
}

function updateSource(n) {
  const s = state.sources[n.id];
  if (s) {
    s.relevance = n.relevance;
    s.summary = n.summary;
    s.quote = n.quote;
  }
  const li = $(`#src-${n.id}`);
  if (!li) return;
  li.classList.remove("reading");
  $(".rel span", li).textContent = `${n.relevance}/10`;
  requestAnimationFrame(() => {
    $(".rel-bar i", li).style.width = (n.relevance * 10) + "%";
  });
  if (n.summary) {
    const d = document.createElement("div");
    d.className = "src-sum";
    d.textContent = n.summary;
    li.appendChild(d);
  }
  if (n.relevance < 3) li.style.opacity = 0.45;
  li.classList.add("flash");
  setTimeout(() => li.classList.remove("flash"), 700);
}

// ---------------------------------------------------------------- report rendering & citations
function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderReport(false);
  });
}

function renderReport(final) {
  if (!state.report) return;
  let html = DOMPurify.sanitize(marked.parse(state.report));
  html = html.replace(/\[(\d{1,3})\]/g, (m, id) => {
    if (!state.sources[id]) return m;
    return `<a class="cite" href="#src-${id}" data-id="${id}">${id}</a>`;
  });
  $("#report").innerHTML = html + (final ? "" : '<span class="caret"></span>');
  const h1 = $("#report h1");
  if (h1) $("#report-title").textContent = h1.textContent;
}

// Click to jump to source
$("#report").addEventListener("click", e => {
  const c = e.target.closest(".cite");
  if (!c) return;
  e.preventDefault();
  const li = $(`#src-${c.dataset.id}`);
  if (li) {
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    li.classList.add("flash");
    setTimeout(() => li.classList.remove("flash"), 1200);
  }
});

// ---------------------------------------------------------------- Citation Hover Card Popover
const popover = $("#citation-popover");
let popoverTimeout = null;

document.addEventListener("mouseover", e => {
  const c = e.target.closest(".cite");
  if (!c) return;
  const id = c.dataset.id;
  const s = state.sources[id];
  if (!s) return;

  clearTimeout(popoverTimeout);
  $("#pop-id").textContent = id;
  $("#pop-domain").textContent = s.domain || "web";
  $("#pop-rel").textContent = (s.relevance || 8) + "/10 relevance";
  $("#pop-title").textContent = s.title || "Source Reference";
  $("#pop-quote").textContent = s.quote ? `“${s.quote}”` : (s.summary || s.snippet || "Verified document fact extracted during Reader stage.");
  $("#pop-link").href = s.url || "#";

  const rect = c.getBoundingClientRect();
  popover.style.top = (window.scrollY + rect.bottom + 8) + "px";
  popover.style.left = Math.max(10, Math.min(window.innerWidth - 360, window.scrollX + rect.left - 40)) + "px";
  popover.classList.remove("hidden");
});

document.addEventListener("mouseout", e => {
  const c = e.target.closest(".cite");
  if (!c) return;
  popoverTimeout = setTimeout(() => {
    if (!popover.matches(":hover")) hideCitationPopover();
  }, 250);
});

popover.addEventListener("mouseleave", () => hideCitationPopover());

function hideCitationPopover() {
  popover.classList.add("hidden");
}

// ---------------------------------------------------------------- Interactive Q&A Thread
$("#thread-form").addEventListener("submit", async e => {
  e.preventDefault();
  const qInput = $("#thread-input");
  const q = qInput.value.trim();
  if (!q) return;
  qInput.value = "";

  const container = $("#thread-messages");
  // User bubble
  const userDiv = document.createElement("div");
  userDiv.className = "thread-msg user";
  userDiv.textContent = q;
  container.appendChild(userDiv);

  // Assistant bubble
  const asstDiv = document.createElement("div");
  asstDiv.className = "thread-msg assistant";
  const statusDiv = document.createElement("div");
  statusDiv.className = "thread-status";
  statusDiv.textContent = "Nemotron-3 is reasoning...";
  const bodyDiv = document.createElement("div");
  asstDiv.appendChild(statusDiv);
  asstDiv.appendChild(bodyDiv);
  container.appendChild(asstDiv);
  userDiv.scrollIntoView({ behavior: "smooth" });

  let answerText = "";
  try {
    const res = await fetch("/api/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: q,
        prior_question: state.question,
        prior_report: state.report,
        sources: state.sources
      })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "followup_status") {
          statusDiv.textContent = ev.status;
        } else if (ev.type === "followup_delta") {
          if (ev.kind === "text") {
            statusDiv.remove();
            answerText += ev.delta;
            let h = DOMPurify.sanitize(marked.parse(answerText));
            h = h.replace(/\[(\d{1,3})\]/g, (m, id) =>
              state.sources[id] ? `<a class="cite" href="#src-${id}" data-id="${id}">${id}</a>` : m);
            bodyDiv.innerHTML = h;
          }
        }
      }
    }
  } catch (err) {
    statusDiv.textContent = "Error: " + err;
  }
});

// ---------------------------------------------------------------- Slide Deck Modal
function renderSlideModal(deck) {
  $("#modal-deck-title").textContent = deck.title || "Executive Presentation Outline";
  $("#modal-deck-sub").textContent = deck.subtitle || "Synthesized by NVIDIA Nemotron-3 from verified research";
  const grid = $("#deck-grid");
  grid.innerHTML = "";

  (deck.slides || []).forEach(s => {
    const card = document.createElement("div");
    card.className = "slide-card";
    const bulletsHtml = (s.bullets || []).map(b => `<li>${esc(b)}</li>`).join("");
    card.innerHTML = `
      <span class="slide-num">SLIDE ${s.slide_number}</span>
      <h4 class="slide-title">${esc(s.title)}</h4>
      <ul class="slide-bullets">${bulletsHtml}</ul>
      <div class="slide-takeaway"><b>Key Takeaway:</b> ${esc(s.takeaway)}</div>
    `;
    grid.appendChild(card);
  });

  $("#slides-modal").classList.remove("hidden");
}

$("#close-modal-btn").addEventListener("click", () => {
  $("#slides-modal").classList.add("hidden");
});

$("#copy-deck-btn").addEventListener("click", async () => {
  const cards = $$(".slide-card");
  let md = `# ${$("#modal-deck-title").textContent}\n\n`;
  cards.forEach(c => {
    md += `## ${$(".slide-title", c).textContent}\n`;
    $$("li", c).forEach(li => md += `- ${li.textContent}\n`);
    md += `> ${$(".slide-takeaway", c).textContent}\n\n`;
  });
  await navigator.clipboard.writeText(md);
  toast("Slide deck markdown copied");
});

// ---------------------------------------------------------------- metrics telemetry
function showMetrics(ev) {
  const roles = ev.stats;
  const max = Math.max(1, ...Object.values(roles).map(r => r.prompt_tokens + r.completion_tokens));
  for (const [role, r] of Object.entries(roles)) {
    const row = $(`.mrow[data-role="${role}"]`);
    if (!row) continue;
    const tot = r.prompt_tokens + r.completion_tokens;
    $(".bar i", row).style.width = (tot / max) * 100 + "%";
    $(".mval", row).textContent = `${r.calls}× · ${fmt(tot)} tok`;
    $(".mval", row).title = `${r.latency}s cumulative latency`;
  }
  const calls = Object.values(roles).reduce((a, r) => a + r.calls, 0);
  const u = roles.ultra;
  const tps = u.latency ? Math.round(u.completion_tokens / u.latency) : 0;
  $("#kpis").innerHTML = [
    [ev.elapsed + "s", "end-to-end"],
    [calls, "model calls"],
    [`${ev.n_used}/${ev.n_sources}`, "sources cited"],
    [tps ? tps + " t/s" : ev.ttft_writer + "s", tps ? "Ultra throughput" : "Ultra TTFT"],
  ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
}

// ---------------------------------------------------------------- helpers
function withRefs() {
  const refs = Object.values(state.sources).map(s => `[${s.id}] ${s.title}: ${s.url}`).join("\n");
  return `${state.report.trim()}\n\n---\n## References\n${refs}\n`;
}
function esc(s = "") { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "report"; }
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = "toast", 3200);
}
