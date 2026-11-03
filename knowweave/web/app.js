/* KnoWeave Web UI — zero framework, same-origin REST. */
const API = "/api/v1";

const state = {
  token: localStorage.getItem("kw_token") || "owner-token",
  meta: null,
  me: null,
  page: "dashboard",
  mode: "quick",
  docs: [],
  stats: null,
  conversations: [],
  entities: [],
  graph: { nodes: [], edges: [] },
  activeEntity: null,
  opsTab: "traces",
  harness: null,
  file: null,
  lastAsk: null,
  conversationId: null,
  traceCache: {},
};

const PAGE_META = {
  dashboard: "概览",
  library: "知识库",
  ask: "研究台",
  entities: "实体图谱",
  review: "审阅队列",
  ops: "运维台",
  settings: "设置",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function num(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function money(value) {
  const amount = Number(value || 0);
  return amount < 0.01 && amount > 0 ? `¥${amount.toFixed(5)}` : `¥${amount.toFixed(2)}`;
}

function shortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dayOnly(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

let toastTimer = null;
function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 4200);
}

async function api(path, options = {}) {
  const headers = Object.assign({ Authorization: `Bearer ${state.token}` }, options.headers || {});
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(`${API}${path}`, { ...options, headers, body });
  if (!response.ok) {
    let detail = `请求失败 (${response.status})`;
    try {
      const payload = await response.json();
      detail = payload.detail || payload.error?.message || detail;
      if (Array.isArray(detail)) detail = detail.map((item) => item.msg || item).join("；");
    } catch (_) { /* ignore */ }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return {};
  return response.json();
}

function setBusy(button, busy, label = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

/* ============ Shell ============ */
function showPage(page) {
  state.page = page;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $("#page-title").textContent = PAGE_META[page] || page;
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  loadPage(page);
}

function loadPage(page) {
  if (page === "dashboard") loadDashboard();
  if (page === "library") loadDocs();
  if (page === "ask") loadConversations();
  if (page === "entities") { loadEntities(); loadGraph(); }
  if (page === "review") loadReview();
  if (page === "ops") loadOps(state.opsTab);
  if (page === "settings") loadSettings();
}

async function refreshShell() {
  try {
    state.me = await api("/auth/me");
    $("#settings-role").textContent = state.me.role;
  } catch (error) {
    toast(error.message, "err");
  }
}

async function loadMetaAndHealth() {
  try {
    state.meta = await api("/meta");
    $("#harness-kv").innerHTML = `<span>正在读取运行时…</span>`;
  } catch (_) { /* ignore */ }
  try {
    state.harness = await api("/harness/health");
    renderHarness();
  } catch (error) {
    $("#harness-label").textContent = "运行时不可用";
    $("#harness-dot").className = "dot err";
  }
}

function renderHarness() {
  const health = state.harness || {};
  const primary = health.primary || health;
  const available = Boolean(primary.available);
  $("#harness-dot").className = `dot ${available ? "ok" : "warn"}`;
  $("#harness-label").textContent = available
    ? `${primary.adapter || "DSH"} · ${primary.mode || "ready"}`
    : "模型运行时降级";
  const rows = {
    "适配器": health.adapter || primary.adapter || "—",
    "DSH 可用": available ? "是" : "否",
    "最近使用": health.last_used || primary.last_used || "—",
    "模型": primary.model || state.meta?.model || "—",
    "模式": primary.mode || "—",
    "配置文件": primary.profile || "—",
    "最近错误": primary.last_error || health.fallback?.last_error || "无",
  };
  $("#harness-kv").innerHTML = Object.entries(rows)
    .map(([key, value]) => `<div><span>${esc(key)}</span><strong>${esc(value)}</strong></div>`)
    .join("");
  $("#settings-harness").innerHTML = $("#harness-kv").innerHTML;
}

/* ============ Dashboard ============ */
async function loadDashboard() {
  try {
    state.stats = await api("/stats");
    renderStats();
    const [docs, traces] = await Promise.all([api("/documents?limit=5"), api("/traces?limit=6")]);
    renderRecentDocs(docs.items);
    renderRecentTraces(traces.items);
  } catch (error) {
    toast(error.message, "err");
  }
}

function renderStats() {
  const stats = state.stats || {};
  $$("[data-stat]").forEach((el) => {
    const key = el.dataset.stat;
    let value = stats[key] ?? 0;
    if (key === "refusal_rate_7d") value = pct(value);
    else if (key === "spend_cny") value = money(value);
    else value = num(value);
    el.textContent = value;
  });
  const reviews = Number(stats.reviews_open || 0);
  $("#nav-review-count").textContent = reviews;
  $("#nav-review-count").hidden = reviews === 0;
  const healthScore = Math.max(32, Math.min(98, 94 - reviews * 3 - Number(stats.gaps_open || 0) * 2));
  $("#health-score").textContent = healthScore;
  $("#health-ring").style.setProperty("--p", healthScore / 100);
  $("#leg-evidence").textContent = `${num(stats.facts_active || 0)} 条`;
  const budget = stats.budget || {};
  const ratio = budget.limit ? Math.min(1, Number(budget.used || 0) / Number(budget.limit)) : 0;
  $("#budget-bar-fill").style.width = `${ratio * 100}%`;
  $("#budget-copy").textContent = `本月已用 ${money(budget.used || 0)} / ${money(budget.limit || 0)}（${pct(ratio)}）`;
  $("#budget-pill").textContent = ratio > 0.8 ? "预算预警" : "预算正常";
  $("#budget-pill").className = `pill ${ratio > 0.8 ? "warn" : "teal"}`;
}

function renderRecentDocs(docs) {
  const target = $("#recent-docs");
  if (!docs.length) {
    target.innerHTML = `<div class="empty">暂无文档</div>`;
    return;
  }
  target.innerHTML = docs.map((doc) => `
    <div class="list-row" data-doc="${esc(doc.id)}">
      <span class="row-icon">${esc((doc.source_type || "?").slice(0, 4))}</span>
      <div class="row-main">
        <strong>${esc(doc.title)}</strong>
        <small>${esc(doc.source_type)} · ${doc.chunks} chunks · ${esc(doc.acl_label)}</small>
      </div>
      <span class="row-tag">v${doc.version}</span>
    </div>`).join("");
  $$("#recent-docs [data-doc]").forEach((row) => row.addEventListener("click", () => openDoc(row.dataset.doc)));
}

function renderRecentTraces(traces) {
  const target = $("#recent-traces");
  if (!traces.length) {
    target.innerHTML = `<div class="empty">暂无轨迹</div>`;
    return;
  }
  target.innerHTML = traces.map((trace) => `
    <div class="list-row" data-trace="${esc(trace.id)}">
      <span class="row-icon">${trace.feature === "ask" ? "⌕" : trace.feature === "search" ? "▤" : "⌁"}</span>
      <div class="row-main">
        <strong>${esc(trace.question || trace.answer || trace.feature)}</strong>
        <small>${esc(trace.feature)} · ${trace.latency_ms}ms · ${shortDate(trace.created_at)}</small>
      </div>
      <span class="trace-status ${esc(trace.status)}">${esc(trace.status)}</span>
    </div>`).join("");
  $$("#recent-traces [data-trace]").forEach((row) => row.addEventListener("click", () => openTrace(row.dataset.trace)));
}

/* ============ Library ============ */
async function loadDocs() {
  const q = $("#doc-search")?.value.trim() || "";
  const source = $("#doc-source-filter")?.value || "";
  const params = new URLSearchParams({ limit: "100" });
  if (q) params.set("q", q);
  if (source) params.set("source_type", source);
  try {
    const data = await api(`/documents?${params}`);
    state.docs = data.items;
    renderDocs();
    const totalChunks = data.items.reduce((sum, doc) => sum + Number(doc.chunks || 0), 0);
    $("#library-summary").innerHTML = `<span>共 <strong>${data.items.length}</strong> 篇可见文档</span><span>·</span><span><strong>${num(totalChunks)}</strong> 个检索单元</span><span>·</span><span>当前身份 <strong>${esc(state.me?.name || "—")}</strong></span>`;
  } catch (error) {
    toast(error.message, "err");
  }
}

function renderDocs() {
  const target = $("#doc-list");
  if (!state.docs.length) {
    target.innerHTML = `<div class="empty">暂无文档</div>`;
    return;
  }
  target.innerHTML = state.docs.map((doc) => `
    <article class="doc-card" data-doc="${esc(doc.id)}">
      <div class="doc-card-top">
        <span class="doc-type">${esc((doc.source_type || "?").slice(0, 4))}</span>
        <span class="pill ${doc.acl_label === "全员可见" ? "teal" : "warn"}">${esc(doc.acl_label)}</span>
      </div>
      <h4>${esc(doc.title)}</h4>
      <p class="doc-summary">${esc(doc.summary || "—")}</p>
      <div class="doc-meta">
        <span>v${doc.version}</span><span>·</span><span>${doc.chunks} chunks</span><span>·</span>
        <span>${esc(doc.enrichment_status)}</span><span>·</span><span>${shortDate(doc.updated_at)}</span>
      </div>
    </article>`).join("");
  $$("#doc-list [data-doc]").forEach((card) => card.addEventListener("click", () => openDoc(card.dataset.doc)));
}

async function openDoc(docId) {
  const dialog = $("#doc-dialog");
  $("#dialog-title").textContent = "正在读取文档…";
  $("#dialog-body").innerHTML = `<div class="empty">加载中…</div>`;
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/documents/${docId}`);
    const doc = data.document;
    $("#dialog-title").textContent = doc.title;
    $("#dialog-body").innerHTML = `
      <div class="answer-top">
        <span class="pill ${doc.acl_label === "全员可见" ? "teal" : "warn"}">${esc(doc.acl_label)}</span>
        <span class="pill muted">v${doc.version}</span>
        <span class="pill muted">${esc(doc.source_type)}</span>
        <span class="pill muted">${doc.chunks} chunks</span>
        <span class="pill muted">质量 ${doc.quality}</span>
      </div>
      <p class="tiny">${esc(doc.summary || "")}</p>
      <div class="button-row" style="margin:14px 0">
        <button class="btn small" data-doc-action="reprocess" data-doc-id="${esc(doc.id)}">重新抽取事实</button>
        <button class="btn small danger" data-doc-action="delete" data-doc-id="${esc(doc.id)}">移入回收站</button>
      </div>
      <div class="hr"></div>
      <h4>版本</h4>
      <div class="list-stack">${data.versions.map((version) => `
        <div class="list-row" style="cursor:default">
          <span class="row-icon">v${version.version}</span>
          <div class="row-main"><strong>${esc(version.parser)}</strong><small>${version.chars} 字符 · ${esc(version.hash)} · ${shortDate(version.created_at)}</small></div>
        </div>`).join("")}</div>
      <div class="hr"></div>
      <h4>事实层（${data.facts.length}）</h4>
      ${data.facts.length ? data.facts.map((fact) => `
        <div class="chunk-block">
          <header><span>${esc(fact.subject)} · ${esc(fact.predicate)} · ${esc(fact.object || "")}</span><span>${esc(fact.status)} · ${fact.confidence}</span></header>
          <p>${esc(fact.evidence?.[0]?.quote || "")}</p>
        </div>`).join("") : `<div class="empty">暂无事实</div>`}
      <div class="hr"></div>
      <h4>检索单元（展示前 ${data.chunks.length} 个）</h4>
      ${data.chunks.map((chunk) => `
        <div class="chunk-block">
          <header><span>#${chunk.seq} · ${esc(chunk.block_type)} · ${chunk.tokens} tokens</span><span>${esc(chunk.heading_path?.join(" / ") || "正文")} ${chunk.page ? `· p.${chunk.page}` : ""}</span></header>
          <p>${esc(chunk.text)}</p>
        </div>`).join("")}
      <div class="hr"></div>
      <h4>关联实体</h4>
      <div class="button-row">${data.entities.length ? data.entities.map((entity) => `<span class="pill teal">${esc(entity.name)}</span>`).join("") : `<span class="tiny">暂无</span>`}</div>
    `;
    $$("[data-doc-action]", $("#dialog-body")).forEach((button) => {
      button.addEventListener("click", () => handleDocAction(button.dataset.docAction, button.dataset.docId, button));
    });
  } catch (error) {
    $("#dialog-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function handleDocAction(action, docId, button) {
  if (action === "delete") {
    if (!confirm("确认移入回收站？")) return;
    setBusy(button, true, "删除中…");
    try {
      await api(`/documents/${docId}`, { method: "DELETE" });
      toast("文档已移入回收站", "ok");
      $("#doc-dialog").close();
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(button, false);
    }
  }
  if (action === "reprocess") {
    setBusy(button, true, "排队中…");
    try {
      await api(`/documents/${docId}/reprocess`, { method: "POST" });
      toast("已排入事实抽取队列", "ok");
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(button, false);
    }
  }
}

function setupIngest() {
  $$("#ingest-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      $$("#ingest-tabs button").forEach((item) => item.classList.toggle("active", item === button));
      $$(".ingest-form").forEach((pane) => { pane.hidden = pane.dataset.pane !== button.dataset.ingest; });
    });
  });

  const fileInput = $("#file-input");
  const dropzone = $("#dropzone");
  const uploadBtn = $("#upload-btn");
  fileInput.addEventListener("change", () => {
    state.file = fileInput.files?.[0] || null;
    uploadBtn.disabled = !state.file;
    if (state.file) $("strong", dropzone).textContent = state.file.name;
  });
  ["dragenter", "dragover"].forEach((event) => dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((event) => dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    state.file = file;
    uploadBtn.disabled = false;
    $("strong", dropzone).textContent = file.name;
  });

  uploadBtn.addEventListener("click", async () => {
    if (!state.file) return;
    const form = new FormData();
    form.append("file", state.file);
    const title = $("#upload-title").value.trim();
    const acl = $("#upload-acl").value.trim();
    if (title) form.append("title", title);
    if (acl) form.append("acl", acl);
    setBusy(uploadBtn, true, "解析中…");
    try {
      const result = await api("/documents/upload", { method: "POST", body: form });
      toast(result.duplicate ? result.message : `已接入：${result.chunks} 个检索单元，v${result.version}`, "ok");
      state.file = null;
      fileInput.value = "";
      $("strong", dropzone).textContent = "拖拽文件到这里，或点击选择";
      uploadBtn.disabled = true;
      $("#upload-title").value = "";
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(uploadBtn, false);
    }
  });

  $("#text-btn").addEventListener("click", async () => {
    const text = $("#text-body").value.trim();
    if (!text) { toast("请先粘贴内容", "err"); return; }
    const button = $("#text-btn");
    setBusy(button, true, "写入中…");
    try {
      const result = await api("/documents/text", {
        method: "POST",
        body: { text, title: $("#text-title").value.trim() || null, acl: $("#text-acl").value.trim() ? [$("#text-acl").value.trim()] : null },
      });
      toast(result.duplicate ? result.message : `已写入：${result.chunks} 个检索单元`, "ok");
      $("#text-body").value = ""; $("#text-title").value = ""; $("#text-acl").value = "";
      loadDocs(); loadDashboard();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(button, false);
    }
  });

  $("#url-btn").addEventListener("click", async () => {
    const url = $("#url-body").value.trim();
    if (!url) { toast("请输入 URL", "err"); return; }
    const button = $("#url-btn");
    setBusy(button, true, "抓取中…");
    try {
      const result = await api("/documents/url", {
        method: "POST",
        body: { url, title: $("#url-title").value.trim() || null, acl: $("#url-acl").value.trim() ? [$("#url-acl").value.trim()] : null },
      });
      toast(result.duplicate ? result.message : `已抓取：${result.chunks} 个检索单元`, "ok");
      $("#url-body").value = ""; $("#url-title").value = ""; $("#url-acl").value = "";
      loadDocs(); loadDashboard();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(button, false);
    }
  });

  $("#refresh-docs").addEventListener("click", loadDocs);
  $("#doc-search").addEventListener("keydown", (event) => { if (event.key === "Enter") loadDocs(); });
  $("#doc-source-filter").addEventListener("change", loadDocs);
}

/* ============ Ask ============ */
function setupAsk() {
  $$("#mode-row .mode-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.mode = chip.dataset.mode;
      $$("#mode-row .mode-chip").forEach((item) => item.classList.toggle("active", item === chip));
    });
  });
  $$("[data-suggest]").forEach((button) => {
    button.addEventListener("click", () => { $("#question").value = button.dataset.suggest; $("#question").focus(); });
  });
  $("#ask-btn").addEventListener("click", runAsk);
  $("#question").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runAsk();
  });
  $("#refresh-conversations").addEventListener("click", loadConversations);
}

function askPayload(question, conversationId = null) {
  const payload = { question, mode: state.mode, top_k: 6 };
  const asOf = $("#as-of")?.value;
  if (asOf) payload.as_of = asOf;
  if (conversationId) payload.conversation_id = conversationId;
  return payload;
}

async function runAsk() {
  const question = $("#question").value.trim();
  if (!question) { toast("先输入一个问题", "err"); return; }
  const button = $("#ask-btn");
  setBusy(button, true, "检索中…");
  $("#ask-result").innerHTML = `<div class="panel ask-skeleton"><div class="sk-line w80"></div><div class="sk-line"></div><div class="sk-line w60"></div><div class="sk-line w40"></div></div>`;
  try {
    const result = await api("/ask", { method: "POST", body: askPayload(question, state.conversationId) });
    state.lastAsk = result;
    state.conversationId = result.conversation_id;
    renderAsk(result);
    loadConversations();
    loadDashboard();
  } catch (error) {
    $("#ask-result").innerHTML = `<div class="panel refused-card"><div class="answer-body">${esc(error.message)}</div></div>`;
    toast(error.message, "err");
  } finally {
    setBusy(button, false);
  }
}

function linkifyCitations(text) {
  return esc(text).replace(/\[(\d{1,2})\]/g, (match, number) => `<span class="cite-link" data-cite="${number}">${number}</span>`);
}

function renderAsk(result) {
  const refused = result.refused;
  const modeName = state.meta?.modes?.find((mode) => mode.id === result.mode)?.name || result.mode;
  const answer = linkifyCitations(result.answer);
  const citations = result.citations || [];
  const facts = result.facts || [];
  $("#ask-result").innerHTML = `
    <article class="panel answer-card ${refused ? "refused-card" : ""}">
      <div class="answer-top">
        <span class="pill ${refused ? "warn" : "teal"}">${refused ? "证据不足 · 已拒答" : "已回答"}</span>
        <span class="pill muted">${esc(modeName)}</span>
        <span class="pill muted">置信度 ${result.confidence}</span>
        <span class="pill muted">${result.latency_ms} ms</span>
        <span class="pill muted">${citations.length} 条引用</span>
      </div>
      <div class="answer-body">${answer}</div>
      ${facts.length ? `<div class="hr"></div><div class="tiny">图谱事实：${facts.slice(0, 4).map((fact) => `<span class="pill teal" style="margin:2px">${esc(fact.subject)} ${esc(fact.predicate)} ${esc(fact.object || "")}</span>`).join("")}</div>` : ""}
      <div class="answer-foot">
        <span>top score ${(result.stats?.top_score ?? 0).toFixed(3)} / 阈值 ${(result.stats?.threshold ?? 0).toFixed(3)}</span>
        <span>·</span>
        <span>证据 ${result.stats?.evidence_count || 0} · 拒绝 ${result.stats?.rejected_candidates || 0}</span>
        <button class="btn small" data-feedback="1">有帮助</button>
        <button class="btn small" data-feedback="-1">需改进</button>
        <button class="btn small ghost" data-open-trace="${esc(result.trace_id)}">查看轨迹</button>
      </div>
    </article>`;
  $$("[data-feedback]", $("#ask-result")).forEach((button) => {
    button.addEventListener("click", () => sendFeedback(result.message_id, Number(button.dataset.feedback)));
  });
  $$("[data-open-trace]", $("#ask-result")).forEach((button) => {
    button.addEventListener("click", () => openTrace(button.dataset.openTrace));
  });
  $$("[data-cite]", $("#ask-result")).forEach((link) => {
    link.addEventListener("click", () => focusEvidence(Number(link.dataset.cite)));
  });
  renderEvidence(result);
}

function renderEvidence(result) {
  const evidence = result.evidence || [];
  const facts = result.facts || [];
  $("#evidence-count").textContent = `${evidence.length} 条`;
  if (!evidence.length && !facts.length) {
    $("#evidence-body").innerHTML = `<div class="empty">${esc(result.answer)}</div>`;
    return;
  }
  $("#evidence-body").innerHTML = evidence.map((item, index) => `
    <div class="evidence-item" data-evidence-index="${index + 1}">
      <header>
        <strong>${esc(item.doc_title)}</strong>
        <span class="score">${Number(item.scores?.rerank || 0).toFixed(3)}</span>
      </header>
      <p>${esc(item.text)}</p>
      <div class="ev-meta">
        <span>${item.page ? `p.${item.page}` : "—"}</span>
        <span>${esc(item.heading_path?.join(" / ") || "正文")}</span>
        <span>${esc(item.source)}</span>
        <span>RRF ${Number(item.scores?.rrf || 0).toFixed(3)}</span>
      </div>
    </div>`).join("") + (facts.length ? `<div class="hr"></div><h4 style="margin:0 0 8px;font-size:12px">事实层</h4>${facts.slice(0, 8).map((fact) => `
      <div class="evidence-item" style="cursor:default">
        <header><strong>${esc(fact.subject)} ${esc(fact.predicate)}</strong><span class="score">${fact.confidence}</span></header>
        <p>${esc(fact.object || "")} ${fact.valid_from ? `· 自 ${esc(fact.valid_from)}` : ""}${fact.valid_to ? ` · 至 ${esc(fact.valid_to)}` : ""}</p>
        <div class="ev-meta"><span>${esc(fact.status)}</span><span>${esc(fact.valid_to ? "历史" : "当前")}</span></div>
      </div>`).join("")}` : "");
}

function focusEvidence(index) {
  const item = $(`[data-evidence-index="${index}"]`);
  if (!item) return;
  $$(".evidence-item").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
  item.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function sendFeedback(messageId, value) {
  try {
    await api("/feedback", { method: "POST", body: { target_type: "message", target_id: messageId, value, comment: value > 0 ? "有帮助" : "需改进" } });
    toast("反馈已记录", "ok");
  } catch (error) {
    toast(error.message, "err");
  }
}

async function loadConversations() {
  try {
    const data = await api("/conversations?limit=12");
    state.conversations = data.items;
    const target = $("#conversation-list");
    if (!data.items.length) { target.innerHTML = `<div class="empty">暂无会话</div>`; return; }
    target.innerHTML = data.items.map((conversation) => `
      <div class="conv-row" data-conversation="${esc(conversation.id)}">
        <div><strong>${esc(conversation.title || "未命名会话")}</strong><br/><small>${conversation.messages} 条消息 · ${shortDate(conversation.created_at)}</small></div>
        <span class="row-tag">打开</span>
      </div>`).join("");
    $$("#conversation-list [data-conversation]").forEach((row) => {
      row.addEventListener("click", () => loadConversation(row.dataset.conversation));
    });
  } catch (_) { /* ignore */ }
}

async function loadConversation(conversationId) {
  try {
    const data = await api(`/conversations/${conversationId}`);
    state.conversationId = conversationId;
    const messages = data.messages || [];
    $("#ask-result").innerHTML = `<article class="panel answer-card">
      <div class="answer-top"><span class="pill muted">会话</span><strong style="font-size:15px">${esc(data.title)}</strong><button class="link-btn" id="back-to-ask">新提问 →</button></div>
      ${messages.map((message) => `
        <div style="padding:12px 0;border-bottom:1px dashed var(--line)">
          <div class="tiny" style="margin-bottom:5px">${message.role === "user" ? "你" : "知织"} · ${shortDate(message.created_at)} ${message.role === "assistant" ? ` · 置信度 ${message.confidence}` : ""}</div>
          <div class="answer-body">${message.role === "assistant" ? linkifyCitations(message.content) : esc(message.content)}</div>
          ${message.citations?.length ? `<div class="button-row" style="margin-top:6px">${message.citations.map((citation) => `<span class="pill">${esc(citation.quote?.slice(0, 40) || "")}…</span>`).join("")}</div>` : ""}
        </div>`).join("")}
    </article>`;
    $("#back-to-ask").addEventListener("click", () => {
      state.conversationId = null;
      $("#ask-result").innerHTML = `<div class="empty" style="margin-top:16px">输入问题开始检索</div>`;
    });
    $$("[data-cite]", $("#ask-result")).forEach((link) => {
      link.addEventListener("click", () => {
        const citation = messages.flatMap((message) => message.citations || [])[Number(link.dataset.cite) - 1];
        if (citation) toast(citation.quote || "引用片段", "ok");
      });
    });
  } catch (error) {
    toast(error.message, "err");
  }
}

/* ============ Entities ============ */
async function loadEntities(q = "") {
  try {
    const data = await api(`/entities?limit=80${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    state.entities = data.items;
    const target = $("#entity-list");
    if (!data.items.length) { target.innerHTML = `<div class="empty">暂无实体</div>`; return; }
    target.innerHTML = data.items.map((entity, index) => `
      <div class="entity-row ${state.activeEntity === entity.id ? "active" : ""}" data-entity="${esc(entity.id)}">
        <span class="entity-dot">${esc((entity.name || "?")[0])}</span>
        <div><strong>${esc(entity.name)}</strong><small>${esc(entity.type)} · ${entity.facts} 条事实</small></div>
      </div>`).join("");
    $$("#entity-list [data-entity]").forEach((row) => row.addEventListener("click", () => selectEntity(row.dataset.entity)));
    if (!state.activeEntity && data.items[0]) selectEntity(data.items[0].id);
  } catch (error) {
    toast(error.message, "err");
  }
}

async function selectEntity(entityId) {
  state.activeEntity = entityId;
  $$("#entity-list [data-entity]").forEach((row) => row.classList.toggle("active", row.dataset.entity === entityId));
  const target = $("#entity-detail");
  target.innerHTML = `<div class="empty">加载实体详情…</div>`;
  try {
    const data = await api(`/entities/${entityId}`);
    const entity = data.entity;
    const facts = data.facts || [];
    target.innerHTML = `
      <div class="entity-hero">
        <div>
          <span class="eyebrow">${esc(entity.type)}</span>
          <h2>${esc(entity.name)}</h2>
          ${entity.description ? `<p>${esc(entity.description)}</p>` : ""}
        </div>
        <span class="pill ${entity.acl_label === "全员可见" ? "teal" : "warn"}">${esc(entity.acl_label)}</span>
      </div>
      <h4 style="margin:0 0 14px;font-size:12px">事实时间线（${facts.length}）</h4>
      ${facts.length ? `<div class="timeline">${facts.map((fact) => `
        <div class="timeline-item ${esc(fact.status)}">
          <div class="tl-date">${fact.valid_from ? `有效 ${dayOnly(fact.valid_from)}` : "未标注起始"}${fact.valid_to ? ` → ${dayOnly(fact.valid_to)}` : " → 至今"}</div>
          <h4>${esc(fact.subject)} <span>${esc(fact.predicate)}</span> ${esc(fact.object || "")}</h4>
          <p>状态 ${esc(fact.status)} · 置信度 ${fact.confidence} · 来源 ${esc(fact.source_doc_id || "—")}</p>
          ${fact.evidence?.[0]?.quote ? `<div class="quote">${esc(fact.evidence[0].quote)}</div>` : ""}
        </div>`).join("")}</div>` : `<div class="empty">暂无事实</div>`}
      <div class="hr"></div>
      <h4 style="margin:0 0 8px;font-size:12px">相关文档</h4>
      <div class="button-row">${(data.documents || []).map((doc) => `<button class="btn small" data-doc="${esc(doc.id)}">${esc(doc.title)}</button>`).join("") || `<span class="tiny">暂无</span>`}</div>`;
    $$("#entity-detail [data-doc]").forEach((button) => button.addEventListener("click", () => openDoc(button.dataset.doc)));
    drawGraph(entityId);
  } catch (error) {
    target.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function loadGraph() {
  try {
    const data = await api("/graph?limit=80");
    state.graph = data;
    drawGraph(state.activeEntity);
  } catch (error) {
    toast(error.message, "err");
  }
}

function drawGraph(centerId) {
  const svg = $("#graph-canvas");
  if (!svg) return;
  const nodes = (state.graph.nodes || []).slice(0, 30);
  const edges = (state.graph.edges || []).filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target));
  svg.innerHTML = "";
  if (!nodes.length) {
    svg.innerHTML = `<text x="320" y="210" text-anchor="middle" fill="#9a9d94" font-size="12">暂无图谱数据</text>`;
    return;
  }
  const center = nodes.find((node) => node.id === centerId) || nodes[0];
  const others = nodes.filter((node) => node.id !== center.id);
  const width = 640, height = 420, cx = 320, cy = 210;
  const positions = { [center.id]: { x: cx, y: cy } };
  others.forEach((node, index) => {
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = 130 + (index % 3) * 28;
    positions[node.id] = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
  const NS = "http://www.w3.org/2000/svg";
  edges.forEach((edge) => {
    const a = positions[edge.source], b = positions[edge.target];
    if (!a || !b) return;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.setAttribute("class", "graph-link");
    line.dataset.status = edge.status;
    line.setAttribute("stroke-opacity", "0.8");
    svg.appendChild(line);
  });
  nodes.forEach((node) => {
    const position = positions[node.id];
    if (!position) return;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", `graph-node ${node.type === "literal" ? "literal" : ""}`);
    group.setAttribute("transform", `translate(${position.x},${position.y})`);
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", node.id === center.id ? 26 : 18);
    group.appendChild(circle);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("y", node.id === center.id ? 4 : 3);
    label.textContent = (node.name || "").slice(0, 12);
    group.appendChild(label);
    if (node.id !== center.id && !node.id.startsWith("lit_")) {
      group.style.cursor = "pointer";
      group.addEventListener("click", () => selectEntity(node.id));
    }
    svg.appendChild(group);
  });
}

/* ============ Review ============ */
async function loadReview() {
  const target = $("#review-list");
  try {
    const data = await api("/review?status=open");
    if (!data.items.length) {
      target.innerHTML = `<div class="panel empty">暂无待审项</div>`;
      return;
    }
    target.innerHTML = data.items.map((item) => `
      <article class="panel review-card">
        <div>
          <div class="answer-top"><span class="pill warn">${esc(item.kind)}</span><span class="pill muted">${shortDate(item.created_at)}</span></div>
          <h3>${esc(item.title)}</h3>
          <p>${esc(item.payload?.reason || "需要人工确认")}</p>
          ${item.payload?.new_object !== undefined ? `<div class="conflict-grid">
            <div class="conflict-side"><small>本次候选</small><strong>${esc(item.payload.new_object || "—")}</strong><small>${esc(item.payload.quote || "")}</small></div>
            <div class="conflict-side"><small>既有事实</small><strong>${esc((item.payload.old_objects || []).join(" / ") || "—")}</strong></div>
          </div>` : ""}
          ${item.payload?.text ? `<div class="chunk-block"><p>${esc(item.payload.text)}</p></div>` : ""}
        </div>
        <div class="review-actions">
          <button class="btn primary small" data-review="${esc(item.id)}" data-action="accept_new">采纳本次</button>
          <button class="btn small" data-review="${esc(item.id)}" data-action="reject_new">保留既有</button>
          <button class="btn small ghost" data-review="${esc(item.id)}" data-action="merge">合并证据</button>
          <button class="btn small ghost" data-review="${esc(item.id)}" data-action="dispute">维持争议</button>
        </div>
      </article>`).join("");
    $$("[data-review]").forEach((button) => {
      button.addEventListener("click", () => resolveReview(button.dataset.review, button.dataset.action, button));
    });
  } catch (error) {
    target.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function resolveReview(reviewId, action, button) {
  const labels = { accept_new: "采纳中…", reject_new: "保留中…", merge: "合并中…", dispute: "标记中…" };
  setBusy(button, true, labels[action] || "处理中…");
  try {
    await api(`/review/${reviewId}/resolve`, { method: "POST", body: { action, note: "" } });
    toast("审阅项已处理", "ok");
    loadReview();
    loadDashboard();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    setBusy(button, false);
  }
}

/* ============ Ops ============ */
function setupOps() {
  $$("#ops-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      state.opsTab = button.dataset.ops;
      $$("#ops-tabs button").forEach((item) => item.classList.toggle("active", item === button));
      loadOps(state.opsTab);
    });
  });
}

async function loadOps(tab) {
  if (tab === "traces") return loadTraces();
  if (tab === "costs") return loadCosts();
  if (tab === "gaps") return loadGaps();
  if (tab === "eval") return loadEval();
}

async function loadTraces() {
  $("#ops-body").innerHTML = `<div class="panel"><div class="empty">读取轨迹…</div></div>`;
  try {
    const data = await api("/traces?limit=50");
    $("#ops-body").innerHTML = `<section class="panel">
      <header class="panel-head"><h3>请求轨迹</h3><span class="pill muted">${data.items.length} 条</span></header>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>功能</th><th>问题 / 目标</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead>
        <tbody>${data.items.map((trace) => `
          <tr class="clickable" data-trace="${esc(trace.id)}">
            <td>${esc(trace.feature)}</td>
            <td>${esc(trace.question || trace.answer || "—")}</td>
            <td><span class="trace-status ${esc(trace.status)}">${esc(trace.status)}</span></td>
            <td>${trace.latency_ms} ms</td>
            <td>${shortDate(trace.created_at)}</td>
          </tr>`).join("") || `<tr><td colspan="5"><div class="empty">暂无轨迹</div></td></tr>`}</tbody>
      </table></div></section>`;
    $$("#ops-body [data-trace]").forEach((row) => row.addEventListener("click", () => openTrace(row.dataset.trace)));
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="panel empty">${esc(error.message)}</div>`;
  }
}

async function openTrace(traceId) {
  const dialog = $("#doc-dialog");
  $("#dialog-title").textContent = "轨迹回放";
  $("#dialog-body").innerHTML = `<div class="empty">读取轨迹…</div>`;
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/traces/${traceId}`);
    const trace = data.trace;
    $("#dialog-title").textContent = `轨迹 · ${trace.feature}`;
    $("#dialog-body").innerHTML = `
      <div class="answer-top">
        <span class="trace-status ${esc(trace.status)}">${esc(trace.status)}</span>
        <span class="pill muted">${trace.latency_ms} ms</span>
        <span class="pill muted">${esc(trace.id)}</span>
      </div>
      <p class="tiny"><strong>问题：</strong>${esc(trace.question || "—")}</p>
      <p class="tiny"><strong>回答：</strong>${esc(trace.answer || "—")}</p>
      <div class="hr"></div>
      <h4 style="font-size:12px;margin:0 0 10px">阶段</h4>
      ${data.spans.map((span) => `
        <div class="span-row">
          <strong>${esc(span.stage)}</strong>
          <small>${span.latency_ms} ms · ${esc(span.status)}</small>
          <div class="mono">${esc(JSON.stringify(span.output || {}).slice(0, 320))}</div>
        </div>`).join("")}
      <div class="hr"></div>
      <h4 style="font-size:12px;margin:0 0 10px">成本</h4>
      ${data.usage.length ? data.usage.map((row) => `<div class="span-row"><strong>${esc(row.model)}</strong><small>${row.tokens_in}/${row.tokens_out} tokens</small><div class="mono">${money(row.amount)} · ${esc(row.provider)}</div></div>`).join("") : `<p class="tiny">无模型调用</p>`}
      <div class="hr"></div>
      <div class="button-row">
        <button class="btn small" data-replay="${esc(trace.id)}">回放检索阶段</button>
      </div>
      <div id="replay-result"></div>
      <div class="hr"></div>
      <h4 style="font-size:12px;margin:0 0 10px">Meta</h4>
      <pre class="code-block">${esc(JSON.stringify(trace.meta || {}, null, 2))}</pre>`;
    $$("[data-replay]").forEach((button) => {
      button.addEventListener("click", () => replayTrace(button.dataset.replay, button));
    });
  } catch (error) {
    $("#dialog-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function replayTrace(traceId, button) {
  setBusy(button, true, "回放中…");
  try {
    const data = await api(`/traces/${traceId}/replay`, { method: "POST", body: { target_stage: "retrieve", top_k: 8 } });
    $("#replay-result").innerHTML = `<div class="chunk-block" style="margin-top:12px">
      <header><span>检索回放</span><span>top score ${Number(data.diff.top_score || 0).toFixed(3)}</span></header>
      <p>新增 ${data.diff.added.length} 条，移除 ${data.diff.removed.length} 条。</p>
      ${data.hits.slice(0, 4).map((hit) => `<p><strong>${esc(hit.doc_title)}</strong> · ${Number(hit.scores.rerank).toFixed(3)} · ${esc(hit.quote)}</p>`).join("")}
    </div>`;
    toast("回放完成", "ok");
  } catch (error) {
    toast(error.message, "err");
  } finally {
    setBusy(button, false);
  }
}

async function loadCosts() {
  $("#ops-body").innerHTML = `<div class="panel"><div class="empty">读取成本…</div></div>`;
  try {
    const data = await api("/costs/summary?days=30");
    const features = Object.entries(data.by_feature || {});
    const maxAmount = Math.max(0.00001, ...features.map(([, value]) => value.amount));
    $("#ops-body").innerHTML = `<section class="panel">
      <header class="panel-head"><h3>30 日成本</h3><span class="pill teal">${money(data.total_amount)}</span></header>
      <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        <div class="stat-card"><span class="stat-label">金额</span><strong>${money(data.total_amount)}</strong></div>
        <div class="stat-card"><span class="stat-label">Tokens</span><strong>${num(data.total_tokens)}</strong></div>
        <div class="stat-card"><span class="stat-label">模型</span><strong>${Object.keys(data.by_model || {}).length}</strong></div>
      </div>
      <div class="cost-bars">${features.map(([key, value]) => `
        <div class="cost-bar-row"><span>${esc(key)}</span><div class="cost-bar"><span style="width:${(value.amount / maxAmount) * 100}%"></span></div><strong>${money(value.amount)}</strong></div>`).join("") || `<div class="empty">暂无成本记录</div>`}</div>
      <div class="hr"></div>
      <h4 style="font-size:12px">按模型</h4>
      <div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>模型</th><th>调用</th><th>金额</th></tr></thead><tbody>
        ${Object.entries(data.by_model || {}).map(([key, value]) => `<tr><td>${esc(key)}</td><td>${value.calls}</td><td>${money(value.amount)}</td></tr>`).join("") || `<tr><td colspan="3"><div class="empty">暂无</div></td></tr>`}
      </tbody></table></div>
    </section>`;
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="panel empty">${esc(error.message)}</div>`;
  }
}

async function loadGaps() {
  $("#ops-body").innerHTML = `<div class="panel"><div class="empty">读取缺口…</div></div>`;
  try {
    const data = await api("/gaps?status=open");
    $("#ops-body").innerHTML = `<section class="panel">
      <header class="panel-head"><h3>知识缺口</h3><span class="pill muted">${data.items.length} 条</span></header>
      ${data.items.length ? data.items.map((gap) => `
        <div class="chunk-block">
          <header><span>出现 ${gap.count} 次</span><span>${shortDate(gap.updated_at)}</span></header>
          <p>${esc(gap.question)}</p>
          <div class="button-row" style="margin-top:6px">
            <button class="btn small ghost" data-gap="${esc(gap.id)}" data-status="resolved">已补充</button>
            <button class="btn small ghost" data-gap="${esc(gap.id)}" data-status="dismissed">忽略</button>
          </div>
        </div>`).join("") : `<div class="empty">暂无缺口</div>`}
    </section>`;
    $$("[data-gap]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api(`/gaps/${button.dataset.gap}/resolve`, { method: "POST", body: { status: button.dataset.status } });
          toast("缺口已更新", "ok");
          loadGaps(); loadDashboard();
        } catch (error) { toast(error.message, "err"); }
      });
    });
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="panel empty">${esc(error.message)}</div>`;
  }
}

async function loadEval() {
  $("#ops-body").innerHTML = `<div class="panel"><div class="empty">读取评测集…</div></div>`;
  try {
    const data = await api("/evals/cases");
    $("#ops-body").innerHTML = `<section class="panel">
      <header class="panel-head"><h3>黄金评测集</h3><div class="button-row"><span class="pill muted">${data.total} 题</span><button class="btn primary small" id="run-eval">运行评测</button></div></header>
      <div id="eval-result"></div>
      <div class="hr"></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>问题</th><th>期望文档</th><th>期望关键词</th><th>类型</th></tr></thead><tbody>
        ${data.items.map((item) => `<tr><td>${esc(item.question)}</td><td>${esc((item.expected_docs || []).join(" / ") || "—")}</td><td>${esc((item.expected_keywords || []).join(" / ") || "—")}</td><td>${item.should_refuse ? `<span class="pill warn">应拒答</span>` : `<span class="pill teal">应回答</span>`}</td></tr>`).join("")}
      </tbody></table></div>
    </section>`;
    $("#run-eval").addEventListener("click", runEval);
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="panel empty">${esc(error.message)}</div>`;
  }
}

async function runEval() {
  const button = $("#run-eval");
  setBusy(button, true, "评测中…");
  try {
    const data = await api("/evals/run", { method: "POST" });
    const metrics = data.metrics;
    $("#eval-result").innerHTML = `<div class="eval-metrics">
      <div class="eval-metric"><strong>${pct(metrics.doc_recall)}</strong><span>文档召回</span></div>
      <div class="eval-metric"><strong>${pct(metrics.keyword_recall)}</strong><span>关键词召回</span></div>
      <div class="eval-metric"><strong>${pct(metrics.refusal_accuracy)}</strong><span>拒答准确率</span></div>
      <div class="eval-metric"><strong>${pct(metrics.pass_rate)}</strong><span>整体通过</span></div>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr><th>问题</th><th>Top score</th><th>拒答</th><th>结果</th></tr></thead><tbody>
      ${data.results.map((result) => `<tr><td>${esc(result.question)}</td><td>${Number(result.top_score).toFixed(3)}</td><td>${result.refused ? "是" : "否"}</td><td>${result.pass ? `<span class="pill teal">通过</span>` : `<span class="pill warn">未通过</span>`}</td></tr>`).join("")}
    </tbody></table></div>`;
    toast(`评测完成：通过率 ${pct(metrics.pass_rate)}`, "ok");
  } catch (error) {
    toast(error.message, "err");
  } finally {
    setBusy(button, false);
  }
}

/* ============ Settings ============ */
async function loadSettings() {
  if (state.me) {
    $("#settings-identity").innerHTML = `
      <div><span>名称</span><strong>${esc(state.me.name)}</strong></div>
      <div><span>租户</span><strong>${esc(state.me.tenant_id)}</strong></div>
      <div><span>角色</span><strong>${esc(state.me.role)}</strong></div>
      <div><span>组</span><strong>${esc((state.me.groups || []).join("、"))}</strong></div>
      <div><span>主体集合</span><strong>${esc((state.me.principals || []).join("  "))}</strong></div>`;
  }
  if (state.harness) renderHarness();
  try {
    const data = await api("/prices");
    $("#price-table tbody").innerHTML = data.items.map((price) => `
      <tr><td>${esc(price.provider)}</td><td>${esc(price.model)}</td><td>¥${price.input_per_1m}</td><td>¥${price.output_per_1m}</td><td>${esc(price.effective_from)}</td></tr>`).join("") || `<tr><td colspan="5"><div class="empty">暂无单价</div></td></tr>`;
  } catch (_) { /* ignore */ }
  $("#mcp-example").textContent = `curl -s -X POST http://localhost:8000/api/v1/mcp \\
  -H "Authorization: Bearer owner-token" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"kb_ask","arguments":{"question":"KnoWeave 的架构铁律是什么？"}}}'`;
  $("#run-reflection").onclick = async () => {
    const button = $("#run-reflection");
    setBusy(button, true, "反思中…");
    try {
      const summary = await api("/reflection/run", { method: "POST" });
      toast(`反思完成：合并 ${summary.merged_entities} 个实体，标记 ${summary.conflicts_marked} 个冲突`, "ok");
      loadDashboard();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setBusy(button, false);
    }
  };
  $("#refresh-health").onclick = loadMetaAndHealth;
}

/* ============ Boot ============ */
async function boot() {
  $("#token-select").value = state.token;
  $("#token-select").addEventListener("change", async (event) => {
    state.token = event.target.value;
    localStorage.setItem("kw_token", state.token);
    state.me = null; state.stats = null; state.docs = []; state.entities = []; state.activeEntity = null; state.conversationId = null;
    $("#ask-result").innerHTML = "";
    await refreshShell();
    loadMetaAndHealth();
    loadPage(state.page);
  });
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));
  $$("[data-goto]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.goto)));
  $("#dialog-close").addEventListener("click", () => $("#doc-dialog").close());
  $("#doc-dialog").addEventListener("click", (event) => {
    if (event.target === $("#doc-dialog")) $("#doc-dialog").close();
  });
  $("#entity-search").addEventListener("input", (event) => {
    clearTimeout(window.__entityTimer);
    window.__entityTimer = setTimeout(() => loadEntities(event.target.value.trim()), 300);
  });
  setupIngest();
  setupAsk();
  setupOps();

  const initial = (location.hash || "#dashboard").replace("#", "");
  await refreshShell();
  await loadMetaAndHealth();
  showPage(PAGE_META[initial] ? initial : "dashboard");
  loadDashboard();
}

document.addEventListener("DOMContentLoaded", boot);
