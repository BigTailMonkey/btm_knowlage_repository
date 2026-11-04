const API = "/api/v1";

const state = {
  token: localStorage.getItem("kw_token") || "owner-token",
  meta: null,
  me: null,
  page: "chat",
  mode: "quick",
  chatMode: "quick",
  chatMessages: [],
  chatConversationId: null,
  chatBusy: false,
  chatDraft: false,
  tourIndex: 0,
  tourReturnPage: null,
  source: "",
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
};

const PAGE_META = {
  chat: "对话",
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

function setSub(page, text) {
  if (state.page === page) $("#page-sub").textContent = text;
}

const FEATURE_LABEL = {
  ask: "问答",
  search: "检索",
  ingest: "接入",
  eval: "评测",
  reflect: "反思",
};

const SOURCE_LABEL = {
  text: "文本",
  web: "网页",
  pdf: "PDF",
  docx: "DOCX",
};

const FACT_STATUS = {
  active: ["当前", "ok"],
  disputed: ["争议", "warn"],
  superseded: ["已替代", ""],
  retracted: ["已撤回", "bad"],
};

const TRACE_STATUS = {
  ok: ["已完成", "ok"],
  refused: ["已拒答", "warn"],
  error: ["失败", "bad"],
  running: ["进行中", "info"],
};

const REVIEW_KIND = {
  fact_conflict: "事实冲突",
  acl_conflict: "权限冲突",
  low_quality: "低质量",
  duplicate: "重复文档",
};

function plain(value) {
  return String(value ?? "").replace(/[#*_`>]+/g, " ").replace(/\s+/g, " ").trim();
}

function plainLines(value) {
  return String(value ?? "").replace(/^#{1,6}\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

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
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dayOnly(value) {
  if (!value) return "无";
  return String(value).slice(0, 10);
}

function statusPill(status, map = TRACE_STATUS, fallback = "neutral") {
  const [label, tone] = map[status] || [status || "无", fallback];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

function factPill(status) {
  const [label, tone] = FACT_STATUS[status] || [status || "无", ""];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
}

function setBusy(button, busy, label = "处理中") {
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

function loadingLines() {
  return `<div class="loading-block"><i></i><i></i><i></i></div>`;
}

function stampNow() {
  const el = $("#freshness");
  if (!el) return;
  const now = new Date();
  el.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} 更新`; // taste-skill-ignore
}

/* ============ Shell ============ */
function showPage(page) {
  if (!PAGE_META[page]) page = "chat";
  state.page = page;
  document.body.dataset.page = page;
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.page === page;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $("#topbar-title").textContent = PAGE_META[page];
  $("#page-title").textContent = PAGE_META[page];
  $("#page-sub").textContent = "";
  $("#open-ingest").hidden = page !== "library";
  $("#sheet").scrollTop = 0;
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  closeSidebar();
  loadPage(page);
}

function loadPage(page) {
  if (page === "chat") loadChat();
  if (page === "dashboard") loadDashboard();
  if (page === "library") loadDocs();
  if (page === "ask") loadConversations();
  if (page === "entities") { loadEntities(); loadGraph(); }
  if (page === "review") loadReview();
  if (page === "ops") loadOps(state.opsTab);
  if (page === "settings") loadSettings();
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#nav-toggle").setAttribute("aria-expanded", "true");
  $("#scrim").hidden = false;
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#nav-toggle").setAttribute("aria-expanded", "false");
  $("#scrim").hidden = true;
}

async function refreshShell() {
  try {
    state.me = await api("/auth/me");
    const name = state.me.name || "知";
    $("#who-avatar").textContent = Array.from(name)[0];
    const option = $(`#token-select option[value="${state.token}"]`);
    if (option) option.textContent = `${state.me.name} · ${state.me.role}`;
    if (state.page === "settings") renderIdentity();
  } catch (error) {
    toast(error.message);
  }
}

async function loadMetaAndHealth() {
  try {
    state.meta = await api("/meta");
  } catch (_) { /* ignore */ }
  try {
    state.harness = await api("/harness/health");
  } catch (_) {
    state.harness = null;
  }
  renderRuntime();
  renderDashboardConfig();
}

function runtimeView() {
  const health = state.harness || {};
  const primary = health.primary || health;
  return {
    available: Boolean(primary.available),
    adapter: primary.adapter || health.adapter || "无",
    model: primary.model || state.meta?.model || "无",
    mode: primary.mode || "无",
    profile: primary.profile || "无",
    lastUsed: health.last_used || primary.last_used || "无",
    lastError: String(primary.last_error || health.fallback?.last_error || "")
      .split("\n").map((line) => line.trim()).find((line) => line && !/^[\^~]+$/.test(line)) || "",
  };
}

function renderRuntime() {
  const view = runtimeView();
  const summary = $("#setting-runtime-summary");
  if (summary) summary.textContent = view.available ? `${view.adapter} · ${view.mode}` : "运行时降级";
  const target = $("#settings-runtime");
  if (!target) return;
  const rows = [
    ["适配器", view.adapter],
    ["状态", view.available ? "可用" : "不可用"],
    ["模型", view.model],
    ["模式", view.mode],
    ["配置文件", view.profile],
    ["最近使用", view.lastUsed],
    ["最近错误", view.lastError || "无"],
  ];
  target.innerHTML = rows.map(([key, value]) => `<div class="kv-row"><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("");
}

function renderDashboardConfig() {
  const target = $("#dash-config");
  if (!target) return;
  const view = runtimeView();
  const rows = [
    ["对话模型", view.model],
    ["嵌入模型", state.meta?.embedding_model || "无"],
    ["重排阈值", state.meta?.rerank_threshold != null ? Number(state.meta.rerank_threshold).toFixed(2) : "无"],
    ["运行时", view.available ? `${view.adapter} · ${view.mode}` : "降级"],
  ];
  target.innerHTML = rows.map(([key, value]) => `<div class="kv-row"><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("");
}

/* ============ Dashboard ============ */
async function loadDashboard() {
  try {
    state.stats = await api("/stats");
    renderStats();
    const [docs, traces, costs] = await Promise.all([
      api("/documents?limit=5"),
      api("/traces?limit=5"),
      api("/costs/summary?days=30").catch(() => null),
    ]);
    renderRecentDocs(docs.items);
    renderRecentTraces(traces.items);
    renderBudgetBreakdown(costs?.by_feature);
    stampNow();
  } catch (error) {
    toast(error.message);
  }
}

function renderStats() {
  const stats = state.stats || {};
  const documents = Number(stats.documents || 0);
  const chunks = Number(stats.chunks || 0);
  const entities = Number(stats.entities || 0);

  $("#stat-reviews").textContent = num(stats.reviews_open || 0);
  $("#stat-disputed").textContent = num(stats.facts_disputed || 0);
  $("#stat-gaps").textContent = num(stats.gaps_open || 0);
  $("#stat-asks").textContent = num(stats.asks_7d || 0);
  $("#stat-documents").textContent = num(documents);
  $("#stat-chunks").textContent = num(chunks);
  $("#stat-entities").textContent = num(entities);
  $("#stat-facts").textContent = num(stats.facts_active || 0);
  $("#stat-refusal").textContent = pct(stats.refusal_rate_7d || 0);

  setSub("dashboard", `${num(documents)} 篇文档 · ${num(chunks)} 个检索单元 · ${num(entities)} 个实体`);

  const reviews = Number(stats.reviews_open || 0);
  const badge = $("#nav-review-count");
  badge.textContent = reviews;
  badge.hidden = reviews === 0;

  const budget = stats.budget || {};
  const used = Number(budget.used || 0);
  const limit = Number(budget.limit || 0);
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  $("#budget-used").textContent = money(used);
  $("#budget-limit").textContent = limit > 0 ? `/ ${money(limit)}` : "";
  $("#budget-bar").style.width = `${ratio * 100}%`;
  $("#budget-note").textContent = limit > 0
    ? `已用 ${pct(ratio)} · 剩余 ${money(Math.max(0, limit - used))}`
    : "未设置预算上限";

  renderDashboardConfig();
}

function renderBudgetBreakdown(byFeature) {
  const target = $("#budget-breakdown");
  if (!target) return;
  const entries = Object.entries(byFeature || {}).sort((a, b) => b[1].amount - a[1].amount).slice(0, 3);
  if (!entries.length) {
    target.innerHTML = "";
    return;
  }
  const max = Math.max(0.00001, ...entries.map(([, item]) => item.amount));
  target.innerHTML = `<div class="rank-list">${entries.map(([key, item]) => `
    <div class="rank-row">
      <span class="rank-label">${esc(FEATURE_LABEL[key] || key)}</span>
      <div class="rank-track"><div class="rank-fill" style="width:${(item.amount / max) * 100}%"></div></div>
      <span class="rank-value">${money(item.amount)}</span>
    </div>`).join("")}</div>`;
}

function renderRecentDocs(docs) {
  const target = $("#recent-docs");
  if (!docs.length) {
    target.innerHTML = `<div class="empty-block">暂无文档</div>`;
    return;
  }
  target.innerHTML = docs.map((doc) => `
    <button class="row" type="button" data-doc="${esc(doc.id)}">
      <span class="row-main">
        <span class="row-title">${esc(doc.title)}</span>
        <span class="row-sub">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)} · ${num(doc.chunks)} 个检索单元 · ${esc(doc.acl_label)}</span>
      </span>
      <span class="row-end">${shortDate(doc.updated_at)}</span>
    </button>`).join("");
  $$("#recent-docs [data-doc]").forEach((row) => row.addEventListener("click", () => openDoc(row.dataset.doc)));
}

function renderRecentTraces(traces) {
  const target = $("#recent-traces");
  if (!traces.length) {
    target.innerHTML = `<div class="empty-block">暂无轨迹</div>`;
    return;
  }
  target.innerHTML = traces.map((trace) => `
    <button class="row" type="button" data-trace="${esc(trace.id)}">
      <span class="row-main">
        <span class="row-title">${esc(trace.question || trace.answer || FEATURE_LABEL[trace.feature] || trace.feature)}</span>
        <span class="row-sub">${esc(FEATURE_LABEL[trace.feature] || trace.feature)} · ${num(trace.latency_ms)} ms · ${shortDate(trace.created_at)}</span>
      </span>
      ${statusPill(trace.status)}
    </button>`).join("");
  $$("#recent-traces [data-trace]").forEach((row) => row.addEventListener("click", () => openTrace(row.dataset.trace)));
}

/* ============ Library ============ */
function docQuery() {
  return $("#doc-search")?.value.trim() || "";
}

async function loadDocs() {
  const params = new URLSearchParams({ limit: "100" });
  const q = docQuery();
  if (q) params.set("q", q);
  if (state.source) params.set("source_type", state.source);
  try {
    const data = await api(`/documents?${params}`);
    state.docs = data.items;
    renderDocs();
    const totalChunks = data.items.reduce((sum, doc) => sum + Number(doc.chunks || 0), 0);
    setSub("library", `共 ${num(data.items.length)} 篇 · ${num(totalChunks)} 个检索单元`);
    $("#doc-count").textContent = `${num(data.items.length)} 篇`;
    stampNow();
  } catch (error) {
    toast(error.message);
  }
}

function renderDocs() {
  const target = $("#doc-table-body");
  const empty = $("#doc-empty");
  empty.hidden = Boolean(state.docs.length);
  if (!state.docs.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = state.docs.map((doc) => `
    <tr data-doc="${esc(doc.id)}" tabindex="0">
      <td>
        <div class="cell-title">
          <strong>${esc(doc.title)}</strong>
          <span>${esc(plain(doc.summary) || "无")}</span>
          <span class="cell-inline">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)} · ${num(doc.chunks)} 个检索单元 · ${shortDate(doc.updated_at)}</span>
        </div>
      </td>
      <td class="type">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)}</td>
      <td class="num">${num(doc.chunks)}</td>
      <td><span class="pill ${doc.acl_label === "全员可见" ? "" : "warn"}">${esc(doc.acl_label)}</span></td>
      <td class="ver">v${esc(doc.version)}</td>
      <td class="date">${shortDate(doc.updated_at)}</td>
    </tr>`).join("");
  $$("#doc-table-body [data-doc]").forEach((row) => {
    const open = () => openDoc(row.dataset.doc);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

async function openDoc(docId) {
  const dialog = $("#doc-dialog");
  $("#doc-dialog-title").textContent = "文档";
  $("#doc-dialog-body").innerHTML = loadingLines();
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/documents/${docId}`);
    const doc = data.document;
    $("#doc-dialog-title").textContent = doc.title;
    $("#doc-dialog-body").innerHTML = `
      <div class="detail-head">
        <div style="min-width:0">
          <div class="detail-pills">
            <span class="pill ${doc.acl_label === "全员可见" ? "" : "warn"}">${esc(doc.acl_label)}</span>
            <span class="pill">v${esc(doc.version)}</span>
            <span class="pill">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)}</span>
            <span class="pill">${num(doc.chunks)} 个检索单元</span>
            <span class="pill">质量 ${esc(doc.quality)}</span>
          </div>
          ${doc.summary ? `<p class="detail-summary">${esc(plain(doc.summary))}</p>` : ""}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn" data-doc-action="reprocess" data-doc-id="${esc(doc.id)}">重新抽取事实</button>
        <button class="btn danger" data-doc-action="delete" data-doc-id="${esc(doc.id)}">移入回收站</button>
      </div>

      <div class="section">
        <h3>版本</h3>
        ${data.versions.map((version) => `
          <div class="version-row">
            <span>v${esc(version.version)} · ${esc(version.parser)}</span>
            <span class="meta">${num(version.chars)} 字符 · ${esc(version.hash)} · ${shortDate(version.created_at)}</span>
          </div>`).join("") || `<div class="empty-block">暂无版本</div>`}
      </div>

      <div class="section">
        <h3>事实层</h3>
        ${data.facts.length ? data.facts.map((fact) => `
          <div class="fact-item">
            <div class="fact-line">${esc(fact.subject)} <span class="pred">${esc(fact.predicate)}</span> <span class="obj">${esc(fact.object || "")}</span></div>
            <div class="fact-meta">${factPill(fact.status)}<span>置信度 ${esc(fact.confidence)}</span><span>${esc(fact.acl_label)}</span></div>
            ${fact.evidence?.[0]?.quote ? `<div class="fact-quote">${esc(plain(fact.evidence[0].quote))}</div>` : ""}
          </div>`).join("") : `<div class="empty-block">暂无事实</div>`}
      </div>

      <div class="section">
        <h3>检索单元</h3>
        <div class="quote-list">
          ${data.chunks.map((chunk) => `
            <div class="quote-block">
              ${esc(plainLines(chunk.text))}
              <span class="quote-meta">#${esc(chunk.seq)} · ${esc(chunk.block_type)} · ${num(chunk.tokens)} tokens · ${esc(chunk.heading_path?.join(" / ") || "正文")}${chunk.page ? ` · p.${esc(chunk.page)}` : ""}</span>
            </div>`).join("") || `<div class="empty-block">暂无检索单元</div>`}
        </div>
      </div>

      <div class="section">
        <h3>关联实体</h3>
        <div class="pill-row">${data.entities.length ? data.entities.map((entity) => `<span class="pill">${esc(entity.name)}</span>`).join("") : `<span class="muted small">暂无</span>`}</div>
      </div>`;
    $$("[data-doc-action]", $("#doc-dialog-body")).forEach((button) => {
      button.addEventListener("click", () => handleDocAction(button.dataset.docAction, button.dataset.docId, button));
    });
  } catch (error) {
    $("#doc-dialog-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function handleDocAction(action, docId, button) {
  if (action === "delete") {
    if (!confirm("确认移入回收站？")) return;
    setBusy(button, true, "删除中");
    try {
      await api(`/documents/${docId}`, { method: "DELETE" });
      toast("文档已移入回收站");
      $("#doc-dialog").close();
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  }
  if (action === "reprocess") {
    setBusy(button, true, "排队中");
    try {
      await api(`/documents/${docId}/reprocess`, { method: "POST" });
      toast("已排入事实抽取队列");
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  }
}

function setupIngest() {
  $$("#ingest-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => {
      $$("#ingest-tabs .tab").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      $("#ingest-file-form").hidden = button.dataset.ingest !== "file";
      $("#ingest-text-form").hidden = button.dataset.ingest !== "text";
      $("#ingest-url-form").hidden = button.dataset.ingest !== "url";
    });
  });

  $("#open-ingest").addEventListener("click", () => $("#ingest-dialog").showModal());

  const fileInput = $("#file-input");
  const dropLabel = $("#file-drop-label");
  fileInput.addEventListener("change", () => {
    state.file = fileInput.files?.[0] || null;
    dropLabel.textContent = state.file ? state.file.name : "选择文件";
  });
  ["dragenter", "dragover"].forEach((event) => $("#file-drop").addEventListener(event, (e) => { e.preventDefault(); }));
  $("#file-drop").addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    state.file = file;
    fileInput.files = event.dataTransfer.files;
    dropLabel.textContent = file.name;
  });

  $("#ingest-file-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.file) { toast("先选择文件"); return; }
    const button = event.submitter;
    const form = new FormData();
    form.append("file", state.file);
    const title = $("#file-title").value.trim();
    const acl = $("#file-acl").value.trim();
    if (title) form.append("title", title);
    if (acl) form.append("acl", acl);
    setBusy(button, true, "解析中");
    try {
      const result = await api("/documents/upload", { method: "POST", body: form });
      toast(result.duplicate ? result.message : `已接入 ${num(result.chunks)} 个检索单元 · v${result.version}`);
      closeIngest();
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  });

  $("#ingest-text-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#text-input").value.trim();
    if (!text) { toast("内容不能为空"); return; }
    const button = event.submitter;
    setBusy(button, true, "写入中");
    try {
      const result = await api("/documents/text", {
        method: "POST",
        body: {
          text,
          title: $("#text-title").value.trim() || null,
          acl: $("#text-acl").value.trim() ? [$("#text-acl").value.trim()] : null,
        },
      });
      toast(result.duplicate ? result.message : `已写入 ${num(result.chunks)} 个检索单元`);
      closeIngest();
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  });

  $("#ingest-url-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = $("#url-input").value.trim();
    if (!url) { toast("网址不能为空"); return; }
    const button = event.submitter;
    setBusy(button, true, "抓取中");
    try {
      const result = await api("/documents/url", {
        method: "POST",
        body: {
          url,
          title: $("#url-title").value.trim() || null,
          acl: $("#url-acl").value.trim() ? [$("#url-acl").value.trim()] : null,
        },
      });
      toast(result.duplicate ? result.message : `已抓取 ${num(result.chunks)} 个检索单元`);
      closeIngest();
      loadDocs();
      loadDashboard();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  });

  $("#doc-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); loadDocs(); }
  });
  let searchTimer = null;
  $("#doc-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadDocs, 320);
  });
  $$("#doc-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.source = button.dataset.source || "";
      $$("#doc-tabs .tab").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      loadDocs();
    });
  });
}

function closeIngest() {
  $("#ingest-dialog").close();
  $("#ingest-file-form").reset();
  $("#ingest-text-form").reset();
  $("#ingest-url-form").reset();
  state.file = null;
  $("#file-drop-label").textContent = "选择文件";
}

/* ============ Chat ============ */
const CHAT_MODE_LABEL = {
  quick: "快速",
  deep: "深度",
  graph: "图谱",
  timeline: "时间线",
  compare: "对比",
};

function renderChatList() {
  const list = $("#chat-list");
  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-block">暂无会话</div>`;
    return;
  }
  list.innerHTML = state.conversations.map((conversation) => `
    <button class="chat-item ${conversation.id === state.chatConversationId ? "active" : ""}" type="button" data-chat="${esc(conversation.id)}">
      <span class="chat-item-title">${esc(conversation.title || "未命名会话")}</span>
      <span class="chat-item-sub">${num(conversation.messages)} 条 · ${shortDate(conversation.created_at)}</span>
    </button>`).join("");
  $$("#chat-list [data-chat]").forEach((item) => {
    item.addEventListener("click", () => openChatConversation(item.dataset.chat));
  });
}

async function fetchChatList() {
  const data = await api("/conversations?limit=30");
  state.conversations = data.items;
  renderChatList();
  setSub("chat", data.items.length ? `${num(data.items.length)} 个会话` : "");
  return data.items;
}

async function loadChat() {
  try {
    const items = await fetchChatList();
    if (!items.length) {
      state.chatConversationId = null;
      state.chatMessages = [];
      renderChatThread();
      return;
    }
    const exists = items.some((item) => item.id === state.chatConversationId);
    if (!exists && !state.chatDraft && !state.chatMessages.length) await openChatConversation(items[0].id);
  } catch (error) {
    toast(error.message);
  }
}

async function openChatConversation(conversationId) {
  if (state.chatBusy) return;
  try {
    const data = await api(`/conversations/${conversationId}`);
    state.chatConversationId = conversationId;
    state.chatDraft = false;
    state.chatMessages = (data.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      mode: message.mode,
      confidence: message.confidence,
      trace_id: message.trace_id,
      citations: message.citations || [],
    }));
    renderChatThread();
    renderChatList();
  } catch (error) {
    toast(error.message);
  }
}

function newChat() {
  if (state.chatBusy) return;
  state.chatConversationId = null;
  state.chatDraft = true;
  state.chatMessages = [];
  renderChatThread();
  renderChatList();
  $("#chat-input").value = "";
  resizeChatInput();
  $("#chat-input").focus();
}

function chatMessageHtml(message, id) {
  if (message.role === "user") {
    return `<article class="msg msg-user" data-msg="${id}">
      <div class="msg-body">${esc(message.content).replace(/\n/g, "<br>")}</div>
    </article>`;
  }
  const refused = message.refused ?? /^现有资料不足/.test(message.content || "");
  const citations = message.citations || [];
  const body = message.pending
    ? loadingLines()
    : message.failed
      ? `<p class="msg-error">${esc(message.content)}</p>`
      : answerHtml(message.content, refused);
  const status = [];
  if (message.pending) status.push(`<span class="pill">${esc(CHAT_MODE_LABEL[message.mode] || message.mode || "快速")}</span>`);
  else {
    if (message.mode) status.push(`<span class="pill">${esc(CHAT_MODE_LABEL[message.mode] || message.mode)}</span>`);
    if (message.failed) status.push(`<span class="pill bad">失败</span>`);
    else if (refused) status.push(`<span class="pill warn">证据不足</span>`);
    if (Number(message.confidence) > 0) status.push(`<span>置信度 ${esc(message.confidence)}</span>`);
    if (message.latency_ms) status.push(`<span>${num(message.latency_ms)} ms</span>`);
    if (message.trace_id) status.push(`<button class="text-btn" type="button" data-trace="${esc(message.trace_id)}">轨迹</button>`);
  }
  return `<article class="msg msg-assistant" data-msg="${id}">
    <div class="msg-body">${body}</div>
    ${citations.length ? `<details class="msg-cites">
      <summary>${num(citations.length)} 条引用</summary>
      <div class="cite-list">${citations.map((citation, index) => `
        <div class="cite-item" data-cite-item="${index + 1}">
          <span class="cite-num">${index + 1}</span>
          <div>
            <div class="cite-quote">${esc(plain(citation.quote))}</div>
            <div class="cite-meta">${citation.doc_title ? `${esc(citation.doc_title)} · ` : ""}${citation.page ? `p.${esc(citation.page)}` : "正文"}</div>
          </div>
        </div>`).join("")}</div>
    </details>` : ""}
    ${status.length ? `<div class="msg-status">${status.join("")}</div>` : ""}
  </article>`;
}

function renderChatThread() {
  const thread = $("#chat-thread");
  if (!state.chatMessages.length) {
    thread.innerHTML = `<div class="empty-block">暂无消息</div>`;
    return;
  }
  thread.innerHTML = state.chatMessages.map((message, index) => chatMessageHtml(message, index)).join("");
  thread.scrollTop = thread.scrollHeight;
}

function resizeChatInput() {
  const input = $("#chat-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

async function sendChat() {
  if (state.chatBusy) return;
  const input = $("#chat-input");
  const question = input.value.trim();
  if (!question) return;
  const mode = $("#chat-mode-select").value || "quick";
  state.chatBusy = true;
  $("#chat-send").disabled = true;
  input.value = "";
  resizeChatInput();
  state.chatMessages.push({ role: "user", content: question });
  const pending = { role: "assistant", content: "", mode, pending: true };
  state.chatMessages.push(pending);
  renderChatThread();
  try {
    const payload = { question, mode, top_k: 6 };
    if (state.chatConversationId) payload.conversation_id = state.chatConversationId;
    const result = await api("/ask", { method: "POST", body: payload });
    state.chatConversationId = result.conversation_id;
    state.chatDraft = false;
    const index = state.chatMessages.indexOf(pending);
    if (index >= 0) {
      state.chatMessages[index] = {
        role: "assistant",
        content: result.answer,
        mode: result.mode,
        confidence: result.confidence,
        latency_ms: result.latency_ms,
        trace_id: result.trace_id,
        refused: result.refused,
        citations: (result.citations || []).map((citation) => ({
          quote: citation.quote,
          page: citation.page,
          doc_title: citation.doc_title,
        })),
      };
    }
  } catch (error) {
    const index = state.chatMessages.indexOf(pending);
    if (index >= 0) {
      state.chatMessages[index] = { role: "assistant", content: error.message, mode, failed: true };
    }
    toast(error.message);
  } finally {
    state.chatBusy = false;
    $("#chat-send").disabled = false;
    renderChatThread();
    $("#chat-input").focus();
  }
  fetchChatList().catch(() => {});
}

function setupChat() {
  $("#chat-new").addEventListener("click", newChat);
  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat();
  });
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChat();
    }
  });
  $("#chat-input").addEventListener("input", resizeChatInput);
  $("#chat-mode-select").addEventListener("change", (event) => {
    state.chatMode = event.target.value;
  });
  $("#chat-thread").addEventListener("click", (event) => {
    const cite = event.target.closest("[data-cite]");
    if (cite) {
      const article = cite.closest(".msg-assistant");
      const details = article?.querySelector(".msg-cites");
      if (!details) return;
      details.open = true;
      const item = details.querySelector(`[data-cite-item="${Number(cite.dataset.cite)}"]`);
      if (item) {
        $$(".cite-item", details).forEach((row) => row.classList.remove("is-target"));
        item.classList.add("is-target");
        item.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return;
    }
    const trace = event.target.closest("[data-trace]");
    if (trace) openTrace(trace.dataset.trace);
  });
  resizeChatInput();
}

/* ============ Tour ============ */
const TOUR_STEPS = [
  { page: "chat", title: "对话", body: "直接输入问题。回答带引用编号，点开可查看原文；支持连续追问，会话自动保存。" },
  { page: "dashboard", title: "概览", body: "汇总待审内容、争议事实、知识缺口与近 7 日问答量。" },
  { page: "library", title: "知识库", body: "添加文档，查看切片数量、权限与接入状态。" },
  { page: "ask", title: "研究台", body: "单次检索入口，提供快速、深度、图谱、时间线、对比五种模式。" },
  { page: "entities", title: "实体图谱", body: "查看实体之间的关联，以及支撑关联的文档与事实。" },
  { page: "review", title: "审阅队列", body: "处理事实冲突、权限冲突、低质量与重复内容；左侧数量为待处理项。" },
  { page: "ops", title: "运维台", body: "查看检索轨迹、成本消耗与评测结果。" },
  { page: "settings", title: "设置", body: "查看当前身份与模型运行时；切换身份后可见的数据范围随之变化。" },
];

function tourKey() {
  return `kw_tour_seen_${state.token}`;
}

function openTour(index = 0) {
  state.tourReturnPage = state.page;
  $("#tour").hidden = false;
  goTourStep(index);
  $("#tour-next").focus();
}

function goTourStep(index) {
  state.tourIndex = Math.max(0, Math.min(index, TOUR_STEPS.length - 1));
  const page = TOUR_STEPS[state.tourIndex].page;
  if (state.page !== page) showPage(page);
  renderTourStep();
}

function renderTourStep() {
  const step = TOUR_STEPS[state.tourIndex];
  $("#tour-title").textContent = step.title;
  $("#tour-body").textContent = step.body;
  $("#tour-dots").innerHTML = TOUR_STEPS.map((_, index) => `<i class="${index === state.tourIndex ? "on" : ""}"></i>`).join("");
  $("#tour-prev").disabled = state.tourIndex === 0;
  $("#tour-next").textContent = state.tourIndex === TOUR_STEPS.length - 1 ? "开始使用" : "下一步";
  placeTourStep(step.page);
}

function placeTourStep(page) {
  const hole = $("#tour-hole");
  const card = $("#tour-card");
  const shade = $(".tour-shade");
  const bands = ["top", "bottom", "left", "right"].map((side) => $(`#tour-band-${side}`));
  card.style.transform = "";
  card.style.left = "";
  card.style.top = "";
  bands.forEach((band) => band.classList.remove("show"));
  shade.classList.remove("solid");
  if (window.innerWidth <= 1100) {
    hole.classList.remove("show");
    shade.classList.add("solid");
    card.style.width = "min(340px, calc(100vw - 32px))";
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
    return;
  }
  const item = $(`.nav-item[data-page="${page}"]`);
  if (!item) {
    hole.classList.remove("show");
    shade.classList.add("solid");
    card.style.width = "320px";
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
    return;
  }
  const rect = item.getBoundingClientRect();
  const pad = 5;
  const x = rect.left - pad;
  const y = rect.top - pad;
  const width = rect.width + pad * 2;
  const height = rect.height + pad * 2;
  hole.style.left = `${x}px`;
  hole.style.top = `${y}px`;
  hole.style.width = `${width}px`;
  hole.style.height = `${height}px`;
  hole.classList.add("show");
  const [top, bottom, left, right] = bands;
  const topEdge = Math.max(0, y);
  top.style.left = "0";
  top.style.top = "0";
  top.style.width = "100%";
  top.style.height = `${topEdge}px`;
  bottom.style.left = "0";
  bottom.style.top = `${y + height}px`;
  bottom.style.width = "100%";
  bottom.style.height = `calc(100% - ${y + height}px)`;
  left.style.left = "0";
  left.style.top = `${topEdge}px`;
  left.style.width = `${Math.max(0, x)}px`;
  left.style.height = `${height}px`;
  right.style.left = `${x + width}px`;
  right.style.top = `${topEdge}px`;
  right.style.width = `calc(100% - ${x + width}px)`;
  right.style.height = `${height}px`;
  bands.forEach((band) => band.classList.add("show"));
  card.style.width = "320px";
  const cardWidth = 320;
  const cardHeight = card.offsetHeight || 190;
  const leftEdge = Math.min(rect.right + 16, window.innerWidth - cardWidth - 12);
  const topEdgeCard = Math.max(16, Math.min(rect.top - 12, window.innerHeight - cardHeight - 16));
  card.style.left = `${leftEdge}px`;
  card.style.top = `${topEdgeCard}px`;
}

function closeTour() {
  const returnPage = state.tourReturnPage || state.page;
  state.tourReturnPage = null;
  $("#tour").hidden = true;
  $("#tour-hole").classList.remove("show");
  localStorage.setItem(tourKey(), "1");
  if (state.page !== returnPage) showPage(returnPage);
}

function setupTour() {
  $("#open-tour").addEventListener("click", () => openTour());
  $("#tour-skip").addEventListener("click", closeTour);
  $("#tour-prev").addEventListener("click", () => goTourStep(state.tourIndex - 1));
  $("#tour-next").addEventListener("click", () => {
    if (state.tourIndex >= TOUR_STEPS.length - 1) closeTour();
    else goTourStep(state.tourIndex + 1);
  });
  window.addEventListener("resize", () => {
    if (!$("#tour").hidden) placeTourStep(TOUR_STEPS[state.tourIndex].page);
  });
  document.addEventListener("keydown", (event) => {
    if ($("#tour").hidden) return;
    if (event.key === "Escape") closeTour();
    if (event.key === "Tab") {
      const focusables = $$("button:not([disabled])", $("#tour-card"));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

/* ============ Ask ============ */
function cleanAnswer(text, refused) {
  let value = String(text || "").replace(/（注：模型未逐句标注引用，以上依据按相关度附上。）/g, "").trim();
  if (refused) {
    value = value.split("。").filter((sentence) => !/建议|可以调整|请补充/.test(sentence)).join("。");
    if (!value.endsWith("。") && value) value += "。";
  }
  return value;
}

function linkifyCitations(text, refused) {
  const safe = esc(cleanAnswer(text, refused));
  return safe.replace(/\[(\d{1,2})\]/g, (match, number) => `<button type="button" class="cite" data-cite="${number}" aria-label="证据 ${number}">${number}</button>`);
}

function answerHtml(text, refused) {
  const linked = linkifyCitations(text, refused);
  return linked.split(/\n{2,}/).map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
}

function setupAsk() {
  $$("#mode-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$("#mode-tabs .tab").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
    });
  });
  $("#ask-btn").addEventListener("click", runAsk);
  $("#question").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runAsk();
  });
  $("#conversations-refresh").addEventListener("click", loadConversations);
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
  if (!question) { toast("问题不能为空"); return; }
  const button = $("#ask-btn");
  setBusy(button, true, "检索中");
  $("#ask-result").innerHTML = `<div class="answer">${loadingLines()}</div>`;
  $("#evidence-body").innerHTML = loadingLines();
  try {
    const result = await api("/ask", { method: "POST", body: askPayload(question, state.conversationId) });
    state.lastAsk = result;
    state.conversationId = result.conversation_id;
    renderAsk(result);
    loadConversations();
    loadDashboard();
  } catch (error) {
    $("#ask-result").innerHTML = `<div class="answer"><div class="empty-block">${esc(error.message)}</div></div>`;
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

function renderAsk(result) {
  const refused = Boolean(result.refused);
  const modeName = state.meta?.modes?.find((mode) => mode.id === result.mode)?.name || result.mode;
  const citations = result.citations || [];
  const facts = result.facts || [];
  $("#ask-result").innerHTML = `
    <article class="answer">
      <div class="answer-status">
        <span class="pill ${refused ? "warn" : "ok"}">${refused ? "证据不足" : "已回答"}</span>
        <span class="pill">${esc(modeName)}</span>
        <span class="pill">置信度 ${esc(result.confidence)}</span>
        <span class="pill">${num(result.latency_ms)} ms</span>
        <span class="pill">${num(citations.length)} 条引用</span>
      </div>
      <div class="answer-body">${answerHtml(result.answer, refused)}</div>
      ${facts.length ? `<div class="answer-facts"><span class="caption">事实</span>${facts.slice(0, 6).map((fact) => `
        <div class="answer-fact"><b>${esc(fact.subject)}</b> ${esc(fact.predicate)} ${esc(fact.object || "")}</div>`).join("")}</div>` : ""}
      <div class="answer-foot">
        <div class="answer-metrics">
          <span>top ${(result.stats?.top_score ?? 0).toFixed(3)} / 阈值 ${(result.stats?.threshold ?? 0).toFixed(3)}</span>
          <span>证据 ${num(result.stats?.evidence_count || 0)} · 淘汰 ${num(result.stats?.rejected_candidates || 0)}</span>
        </div>
        <div class="answer-actions">
          <button class="btn" data-feedback="1">有帮助</button>
          <button class="btn" data-feedback="-1">需改进</button>
          <button class="btn" data-open-trace="${esc(result.trace_id)}">查看轨迹</button>
        </div>
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
  stampNow();
}

function renderEvidence(result) {
  const evidence = result.evidence || [];
  const facts = result.facts || [];
  $("#evidence-count").textContent = `${evidence.length} 条`;
  if (!evidence.length && !facts.length) {
    $("#evidence-body").innerHTML = `<div class="empty-block">暂无证据</div>`;
    return;
  }
  $("#evidence-body").innerHTML = evidence.map((item, index) => `
    <div class="evidence-item" data-evidence-index="${index + 1}">
      <div class="ev-head"><span class="ev-num">${index + 1}</span><span class="ev-title">${esc(item.doc_title)}</span></div>
      <div class="ev-quote">${esc(plain(item.quote || item.text || ""))}</div>
      <div class="ev-meta">${item.page ? `p.${esc(item.page)}` : "正文"} · ${esc(item.heading_path?.join(" / ") || "")} · ${Number(item.scores?.rerank || 0).toFixed(3)}</div>
    </div>`).join("") + (facts.length ? `<div class="evidence-item"><div class="ev-head"><span class="ev-num">·</span><span class="ev-title">事实层</span></div>${facts.slice(0, 6).map((fact) => `
      <div class="ev-meta" style="margin-top:4px">${esc(fact.subject)} ${esc(fact.predicate)} <b style="color:var(--text);font-weight:500">${esc(fact.object || "")}</b></div>`).join("")}</div>` : "");
}

function focusEvidence(index) {
  const item = $(`[data-evidence-index="${index}"]`);
  if (!item) return;
  $$(".evidence-item").forEach((el) => el.classList.remove("is-target"));
  item.classList.add("is-target");
  item.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function sendFeedback(messageId, value) {
  try {
    await api("/feedback", {
      method: "POST",
      body: { target_type: "message", target_id: messageId, value, comment: value > 0 ? "有帮助" : "需改进" },
    });
    toast("反馈已记录");
  } catch (error) {
    toast(error.message);
  }
}

async function loadConversations() {
  try {
    const data = await api("/conversations?limit=12");
    state.conversations = data.items;
    const target = $("#conversation-list");
    if (!data.items.length) {
      target.innerHTML = `<div class="empty-block">暂无会话</div>`;
      return;
    }
    target.innerHTML = data.items.map((conversation) => `
      <button class="row" type="button" data-conversation="${esc(conversation.id)}">
        <span class="row-main">
          <span class="row-title">${esc(conversation.title || "未命名会话")}</span>
          <span class="row-sub">${num(conversation.messages)} 条消息 · ${shortDate(conversation.created_at)}</span>
        </span>
        <span class="row-end">打开</span>
      </button>`).join("");
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
    $("#ask-result").innerHTML = `
      <article class="answer">
        <div class="answer-status">
          <span class="pill">会话</span>
          <button class="text-btn" id="back-to-ask">新提问</button>
        </div>
        <div class="answer-body">
          ${messages.map((message) => `
            <div style="padding:10px 0;border-top:1px solid var(--rule)">
              <div class="ev-meta" style="margin:0 0 4px">${message.role === "user" ? "你" : "知织"} · ${shortDate(message.created_at)}${message.role === "assistant" && message.confidence != null ? ` · 置信度 ${esc(message.confidence)}` : ""}</div>
              ${message.role === "assistant" ? linkifyCitations(message.content, false).replace(/\n/g, "<br>") : esc(message.content)}
            </div>`).join("")}
        </div>
      </article>`;
    $("#back-to-ask").addEventListener("click", () => {
      state.conversationId = null;
      $("#ask-result").innerHTML = `<div class="empty-block">尚无检索结果</div>`;
    });
    $$("[data-cite]", $("#ask-result")).forEach((link) => {
      link.addEventListener("click", () => {
        const citation = messages.flatMap((message) => message.citations || [])[Number(link.dataset.cite) - 1];
        if (citation) toast(plain(citation.quote) || "引用片段");
      });
    });
    $("#evidence-body").innerHTML = `<div class="empty-block">暂无证据</div>`;
    $("#evidence-count").textContent = "";
  } catch (error) {
    toast(error.message);
  }
}

/* ============ Entities ============ */
async function loadEntities(q = "") {
  try {
    const data = await api(`/entities?limit=80${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    state.entities = data.items;
    setSub("entities", `${num(data.items.length)} 个实体`);
    const target = $("#entity-list");
    $("#entity-count").textContent = `${num(data.items.length)} 个`;
    if (!data.items.length) {
      target.innerHTML = `<div class="empty-block">暂无实体</div>`;
      return;
    }
    target.innerHTML = data.items.map((entity) => `
      <button class="row ${state.activeEntity === entity.id ? "selected" : ""}" type="button" data-entity="${esc(entity.id)}">
        <span class="row-main">
          <span class="row-title">${esc(entity.name)}</span>
          <span class="row-sub">${esc(entity.type)} · ${num(entity.facts)} 条事实</span>
        </span>
      </button>`).join("");
    $$("#entity-list [data-entity]").forEach((row) => row.addEventListener("click", () => selectEntity(row.dataset.entity)));
    if (!state.activeEntity && data.items[0]) selectEntity(data.items[0].id);
  } catch (error) {
    toast(error.message);
  }
}

async function selectEntity(entityId) {
  state.activeEntity = entityId;
  $$("#entity-list [data-entity]").forEach((row) => row.classList.toggle("selected", row.dataset.entity === entityId));
  const target = $("#entity-detail");
  target.innerHTML = loadingLines();
  try {
    const data = await api(`/entities/${entityId}`);
    const entity = data.entity;
    const facts = data.facts || [];
    target.innerHTML = `
      <div class="entity-head">
        <h2>${esc(entity.name)}</h2>
        <span class="pill">${esc(entity.type)}</span>
        <span class="pill ${entity.acl_label === "全员可见" ? "" : "warn"}">${esc(entity.acl_label)}</span>
      </div>
      ${entity.description ? `<p class="entity-desc">${esc(plain(entity.description))}</p>` : ""}

      <div class="section">
        <h3>事实时间线</h3>
        ${facts.length ? `<ol class="timeline">${facts.map((fact) => `
          <li class="tl-item">
            <span class="tl-date">${fact.valid_from ? dayOnly(fact.valid_from) : "无"}</span>
            <div class="tl-body">
              <div class="tl-triple">${esc(fact.subject)} <span class="pred">${esc(fact.predicate)}</span> <span class="obj">${esc(fact.object || "")}</span></div>
              ${fact.evidence?.[0]?.quote ? `<div class="tl-quote">${esc(plain(fact.evidence[0].quote))}</div>` : ""}
              <div class="tl-meta">${factPill(fact.status)}<span>置信度 ${esc(fact.confidence)}</span><span>${fact.valid_to ? `截至 ${dayOnly(fact.valid_to)}` : "至今"}</span></div>
            </div>
          </li>`).join("")}</ol>` : `<div class="empty-block">暂无事实</div>`}
      </div>

      <div class="section">
        <h3>相关文档</h3>
        <div class="doc-links">
          ${(data.documents || []).map((doc) => `<button class="doc-link" type="button" data-doc="${esc(doc.id)}">${esc(doc.title)}</button>`).join("") || `<span class="muted small">暂无</span>`}
        </div>
      </div>`;
    $$("#entity-detail [data-doc]").forEach((button) => button.addEventListener("click", () => openDoc(button.dataset.doc)));
    drawGraph(entityId);
  } catch (error) {
    target.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function loadGraph() {
  try {
    const data = await api("/graph?limit=80");
    state.graph = data;
    drawGraph(state.activeEntity);
  } catch (error) {
    toast(error.message);
  }
}

function drawGraph(centerId) {
  const svg = $("#graph-canvas");
  if (!svg) return;
  const nodes = (state.graph.nodes || []).slice(0, 30);
  const edges = (state.graph.edges || []).filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target));
  $("#graph-meta").textContent = `${num(nodes.length)} 个节点 · ${num(edges.length)} 条关系`;
  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const width = Math.max(280, svg.clientWidth || 960);
  const height = Math.max(180, svg.clientHeight || 320);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const cx = width / 2, cy = height / 2;
  if (!nodes.length) {
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(cy));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#6d7478");
    text.setAttribute("font-size", "12");
    text.textContent = "暂无图谱";
    svg.appendChild(text);
    return;
  }
  const center = nodes.find((node) => node.id === centerId) || nodes[0];
  const others = nodes.filter((node) => node.id !== center.id);
  const spanX = width / 2 - 64;
  const spanY = height / 2 - (width < 480 ? 46 : 52);
  const positions = { [center.id]: { x: cx, y: cy } };
  others.forEach((node, index) => {
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    const scale = 0.74 + (index % 3) * 0.12;
    positions[node.id] = { x: cx + Math.cos(angle) * spanX * scale, y: cy + Math.sin(angle) * spanY * scale };
  });
  edges.forEach((edge) => {
    const a = positions[edge.source];
    const b = positions[edge.target];
    if (!a || !b) return;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("class", `g-link ${edge.status === "disputed" ? "disputed" : ""}`);
    svg.appendChild(line);
  });
  nodes.forEach((node) => {
    const position = positions[node.id];
    if (!position) return;
    const group = document.createElementNS(NS, "g");
    const classes = ["g-node"];
    if (node.type === "literal") classes.push("literal");
    if (node.id === center.id) classes.push("center");
    group.setAttribute("class", classes.join(" "));
    group.setAttribute("transform", `translate(${position.x},${position.y})`);
    if (node.id !== center.id && !node.id.startsWith("lit_")) group.style.cursor = "pointer";
    const radius = node.id === center.id ? (width < 480 ? 21 : 27) : (width < 480 ? 13 : 17);
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", radius);
    group.appendChild(circle);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("y", String(radius + 15));
    const chars = Array.from(node.name || "");
    const limit = node.id === center.id ? (width < 480 ? 8 : 12) : (width < 480 ? 7 : 9);
    label.textContent = chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : chars.join("");
    group.appendChild(label);
    const title = document.createElementNS(NS, "title");
    title.textContent = node.name || "";
    group.appendChild(title);
    if (node.id !== center.id && !node.id.startsWith("lit_")) {
      group.addEventListener("click", () => selectEntity(node.id));
    }
    svg.appendChild(group);
  });
}

/* ============ Review ============ */
async function loadReview() {
  const target = $("#review-list");
  target.innerHTML = loadingLines();
  try {
    const data = await api("/review?status=open");
    setSub("review", `${num(data.items.length)} 项待审`);
    stampNow();
    if (!data.items.length) {
      target.innerHTML = `<div class="empty-block">暂无待审项</div>`;
      return;
    }
    target.innerHTML = data.items.map((item) => `
      <article class="review-card">
        <div>
          <div class="review-head">
            <span class="pill warn">${esc(REVIEW_KIND[item.kind] || item.kind)}</span>
            <span>${shortDate(item.created_at)}</span>
          </div>
          <h2 class="review-title">${esc(item.title)}</h2>
          <p class="review-reason">${esc(item.payload?.reason || "无")}</p>
          ${item.payload?.new_object !== undefined ? `<div class="conflict">
            <div class="conflict-cell">
              <span class="label">本次候选</span>
              <div class="conflict-value">${esc(item.payload.new_object || "无")}</div>
              <div class="conflict-quote">${esc(plain(item.payload.quote) || "")}</div>
            </div>
            <div class="conflict-cell">
              <span class="label">既有事实</span>
              <div class="conflict-value">${esc((item.payload.old_objects || []).join(" / ") || "无")}</div>
            </div>
          </div>` : ""}
          ${item.payload?.text ? `<div class="quote-block" style="margin-top:12px">${esc(plainLines(item.payload.text))}</div>` : ""}
        </div>
        <div class="review-actions">
          <button class="btn primary" data-review="${esc(item.id)}" data-action="accept_new">采纳本次</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="reject_new">保留既有</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="merge">合并证据</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="dispute">维持争议</button>
        </div>
      </article>`).join("");
    $$("[data-review]").forEach((button) => {
      button.addEventListener("click", () => resolveReview(button.dataset.review, button.dataset.action, button));
    });
  } catch (error) {
    setSub("review", "");
    target.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function resolveReview(reviewId, action, button) {
  const labels = { accept_new: "采纳中", reject_new: "保留中", merge: "合并中", dispute: "标记中" };
  setBusy(button, true, labels[action] || "处理中");
  try {
    await api(`/review/${reviewId}/resolve`, { method: "POST", body: { action, note: "" } });
    toast("审阅项已处理");
    loadReview();
    loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

/* ============ Ops ============ */
function setupOps() {
  $$("#ops-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.opsTab = button.dataset.ops;
      $$("#ops-tabs .tab").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      loadOps(state.opsTab);
    });
  });
}

async function loadOps(tab) {
  if (tab === "traces") return loadTraces();
  if (tab === "costs") return loadCosts();
  if (tab === "gaps") return loadGaps();
  if (tab === "evals") return loadEvals();
}

async function loadTraces() {
  $("#ops-body").innerHTML = `<div class="block">${loadingLines()}</div>`;
  try {
    const data = await api("/traces?limit=50");
    const total = data.items.length;
    const refused = data.items.filter((trace) => trace.status === "refused").length;
    const avg = total ? Math.round(data.items.reduce((sum, trace) => sum + Number(trace.latency_ms || 0), 0) / total) : 0;
    setSub("ops", `${num(total)} 条轨迹`);
    $("#ops-body").innerHTML = `
      <div class="metrics cols-3">
        <div class="metric"><span class="metric-label">轨迹</span><div class="metric-value">${num(total)}</div></div>
        <div class="metric"><span class="metric-label">拒答</span><div class="metric-value">${num(refused)}</div></div>
        <div class="metric"><span class="metric-label">平均耗时</span><div class="metric-value">${num(avg)} ms</div></div>
      </div>
      <div class="table-wrap" style="margin-top:16px">
        <table class="table">
          <thead><tr><th scope="col">功能</th><th scope="col">输入</th><th scope="col">状态</th><th scope="col" class="num">耗时</th><th scope="col">时间</th></tr></thead>
          <tbody>${data.items.map((trace) => `
            <tr data-trace="${esc(trace.id)}" tabindex="0">
              <td>${esc(FEATURE_LABEL[trace.feature] || trace.feature)}</td>
              <td><span class="truncate" style="display:block;max-width:460px">${esc(trace.question || trace.answer || "无")}</span></td>
              <td>${statusPill(trace.status)}</td>
              <td class="num">${num(trace.latency_ms)} ms</td>
              <td class="date">${shortDate(trace.created_at)}</td>
            </tr>`).join("") || `<tr><td colspan="5"><div class="empty-block">暂无轨迹</div></td></tr>`}</tbody>
        </table>
      </div>`;
    $$("#ops-body [data-trace]").forEach((row) => {
      const open = () => openTrace(row.dataset.trace);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
    });
    stampNow();
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function openTrace(traceId) {
  const dialog = $("#trace-dialog");
  $("#trace-dialog-title").textContent = "轨迹";
  $("#trace-dialog-body").innerHTML = loadingLines();
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/traces/${traceId}`);
    const trace = data.trace;
    $("#trace-dialog-title").textContent = `轨迹 · ${FEATURE_LABEL[trace.feature] || trace.feature}`;
    $("#trace-dialog-body").innerHTML = `
      <div class="detail-pills">
        ${statusPill(trace.status)}
        <span class="pill">${num(trace.latency_ms)} ms</span>
        <span class="pill mono">${esc(trace.id)}</span>
        <span class="pill">${shortDate(trace.created_at)}</span>
      </div>
      <div class="section">
        <h3>问题</h3>
        <p class="detail-summary" style="margin-top:0;color:var(--text)">${esc(trace.question || "无")}</p>
      </div>
      <div class="section">
        <h3>回答</h3>
        <p class="detail-summary" style="margin-top:0">${esc(trace.answer || "无")}</p>
      </div>
      <div class="section">
        <h3>阶段</h3>
        ${data.spans.map((span) => `
          <div class="fact-item">
            <div class="fact-line">${esc(span.stage)} <span class="pred">${num(span.latency_ms)} ms · ${esc(span.status)}</span></div>
            <div class="fact-quote">${esc(JSON.stringify(span.output || {}).slice(0, 280))}</div>
          </div>`).join("") || `<div class="empty-block">暂无阶段</div>`}
      </div>
      <div class="section">
        <h3>成本</h3>
        ${data.usage.length ? data.usage.map((row) => `
          <div class="version-row">
            <span>${esc(row.model)}</span>
            <span class="meta">${num(row.tokens_in)} / ${num(row.tokens_out)} tokens · ${money(row.amount)}</span>
          </div>`).join("") : `<span class="muted small">无模型调用</span>`}
      </div>
      <div class="detail-actions">
        <button class="btn primary" data-replay="${esc(trace.id)}">回放检索阶段</button>
      </div>
      <div id="replay-result"></div>
      <div class="section">
        <h3>Meta</h3>
        <pre class="code">${esc(JSON.stringify(trace.meta || {}, null, 2))}</pre>
      </div>`;
    $$("[data-replay]", $("#trace-dialog-body")).forEach((button) => {
      button.addEventListener("click", () => replayTrace(button.dataset.replay, button));
    });
  } catch (error) {
    $("#trace-dialog-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function replayTrace(traceId, button) {
  setBusy(button, true, "回放中");
  try {
    const data = await api(`/traces/${traceId}/replay`, { method: "POST", body: { target_stage: "retrieve", top_k: 8 } });
    $("#replay-result").innerHTML = `
      <div class="section">
        <h3>检索回放</h3>
        <div class="version-row">
          <span>新增 ${num(data.diff.added.length)} 条 · 移除 ${num(data.diff.removed.length)} 条</span>
          <span class="meta">top ${Number(data.diff.top_score || 0).toFixed(3)}</span>
        </div>
        ${data.hits.slice(0, 4).map((hit) => `
          <div class="fact-item">
            <div class="fact-line">${esc(hit.doc_title)} <span class="pred">${Number(hit.scores.rerank).toFixed(3)}</span></div>
            <div class="fact-quote">${esc(plain(hit.quote))}</div>
          </div>`).join("")}
      </div>`;
    toast("回放完成");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function loadCosts() {
  $("#ops-body").innerHTML = `<div class="block">${loadingLines()}</div>`;
  try {
    const data = await api("/costs/summary?days=30");
    const features = Object.entries(data.by_feature || {});
    const models = Object.entries(data.by_model || {});
    const days = data.by_day || [];
    const maxAmount = Math.max(0.00001, ...features.map(([, value]) => value.amount));
    setSub("ops", `近 30 日 · ${money(data.total_amount)}`);
    $("#ops-body").innerHTML = `
      <div class="metrics cols-3">
        <div class="metric"><span class="metric-label">金额</span><div class="metric-value">${money(data.total_amount)}</div></div>
        <div class="metric"><span class="metric-label">Tokens</span><div class="metric-value">${num(data.total_tokens)}</div></div>
        <div class="metric"><span class="metric-label">模型</span><div class="metric-value">${num(models.length)}</div></div>
      </div>
      <section class="chart-card">
        <div class="block-head"><h2>每日成本</h2><span class="muted">${days.length} 天</span></div>
        <div class="chart-wrap" id="cost-chart"></div>
      </section>
      <section class="chart-card">
        <div class="block-head"><h2>按功能</h2><span class="muted">${num(features.length)} 项</span></div>
        <div class="rank-list">
          ${features.map(([key, value]) => `
            <div class="rank-row">
              <span class="rank-label">${esc(FEATURE_LABEL[key] || key)}</span>
              <div class="rank-track"><div class="rank-fill" style="width:${(value.amount / maxAmount) * 100}%"></div></div>
              <span class="rank-value">${money(value.amount)}</span>
            </div>`).join("") || `<div class="empty-block">暂无成本记录</div>`}
        </div>
      </section>
      <div class="table-wrap" style="margin-top:16px">
        <table class="table">
          <thead><tr><th scope="col">模型</th><th scope="col" class="num">调用</th><th scope="col" class="num">金额</th></tr></thead>
          <tbody>${models.map(([key, value]) => `
            <tr><td>${esc(key)}</td><td class="num">${num(value.calls)}</td><td class="num">${money(value.amount)}</td></tr>`).join("") || `<tr><td colspan="3"><div class="empty-block">暂无模型调用</div></td></tr>`}</tbody>
        </table>
      </div>`;
    if (days.length && window.Charts) {
      const values = days.map((day) => day.amount);
      const maxIndex = values.indexOf(Math.max(...values));
      window.Charts.bars($("#cost-chart"), {
        labels: days.map((day) => day.date.slice(5)),
        values,
        highlight: maxIndex,
        height: 200,
        format: (value) => money(value),
        tickFormat: (value) => `¥${Number(value).toFixed(2)}`,
      });
    } else {
      $("#cost-chart").innerHTML = `<div class="empty-block">暂无按日成本</div>`;
    }
    stampNow();
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function loadGaps() {
  $("#ops-body").innerHTML = `<div class="block">${loadingLines()}</div>`;
  try {
    const data = await api("/gaps?status=open");
    setSub("ops", `${num(data.items.length)} 个缺口`);
    $("#ops-body").innerHTML = `<section class="block">
      ${data.items.length ? `<div class="gap-list">${data.items.map((gap) => `
        <div class="gap-row">
          <div class="gap-main">
            <div class="gap-q">${esc(gap.question)}</div>
            <div class="gap-meta">出现 ${num(gap.count)} 次 · ${shortDate(gap.updated_at)}</div>
          </div>
          <div class="gap-actions">
            <button class="btn" data-gap="${esc(gap.id)}" data-status="resolved">已补充</button>
            <button class="btn" data-gap="${esc(gap.id)}" data-status="dismissed">忽略</button>
          </div>
        </div>`).join("")}</div>` : `<div class="empty-block">暂无缺口</div>`}
    </section>`;
    $$("[data-gap]").forEach((button) => {
      button.addEventListener("click", async () => {
        setBusy(button, true, "处理中");
        try {
          await api(`/gaps/${button.dataset.gap}/resolve`, { method: "POST", body: { status: button.dataset.status } });
          toast("缺口已更新");
          loadGaps();
          loadDashboard();
        } catch (error) {
          toast(error.message);
        } finally {
          setBusy(button, false);
        }
      });
    });
    stampNow();
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function loadEvals() {
  $("#ops-body").innerHTML = `<div class="block">${loadingLines()}</div>`;
  try {
    const data = await api("/evals/cases");
    setSub("ops", `${num(data.total)} 道评测题`);
    $("#ops-body").innerHTML = `<section class="block">
      <div class="block-head" style="margin-bottom:10px">
        <h2>评测集</h2>
        <button class="btn primary" id="run-eval">运行评测</button>
      </div>
      <div id="eval-result"></div>
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th scope="col">问题</th><th scope="col">期望文档</th><th scope="col">期望关键词</th><th scope="col">类型</th></tr></thead>
          <tbody>${data.items.map((item) => `
            <tr>
              <td>${esc(item.question)}</td>
              <td class="muted">${esc((item.expected_docs || []).join(" / ") || "无")}</td>
              <td class="muted">${esc((item.expected_keywords || []).join(" / ") || "无")}</td>
              <td>${item.should_refuse ? `<span class="pill warn">应拒答</span>` : `<span class="pill ok">应回答</span>`}</td>
            </tr>`).join("") || `<tr><td colspan="4"><div class="empty-block">暂无评测题</div></td></tr>`}</tbody>
        </table>
      </div>
    </section>`;
    $("#run-eval").addEventListener("click", runEvals);
    stampNow();
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function runEvals() {
  const button = $("#run-eval");
  setBusy(button, true, "评测中");
  try {
    const data = await api("/evals/run", { method: "POST" });
    const metrics = data.metrics;
    $("#eval-result").innerHTML = `
      <div class="metrics" style="margin-top:2px">
        <div class="metric"><span class="metric-label">文档召回</span><div class="metric-value">${pct(metrics.doc_recall)}</div></div>
        <div class="metric"><span class="metric-label">关键词召回</span><div class="metric-value">${pct(metrics.keyword_recall)}</div></div>
        <div class="metric"><span class="metric-label">拒答准确率</span><div class="metric-value">${pct(metrics.refusal_accuracy)}</div></div>
        <div class="metric"><span class="metric-label">整体通过</span><div class="metric-value">${pct(metrics.pass_rate)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th scope="col">问题</th><th scope="col" class="num">Top score</th><th scope="col">拒答</th><th scope="col">结果</th></tr></thead>
          <tbody>${data.results.map((result) => `
            <tr>
              <td>${esc(result.question)}</td>
              <td class="num">${Number(result.top_score).toFixed(3)}</td>
              <td>${result.refused ? "是" : "否"}</td>
              <td>${result.pass ? `<span class="pill ok">通过</span>` : `<span class="pill warn">未通过</span>`}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
    toast(`评测完成 · 通过率 ${pct(metrics.pass_rate)}`);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

/* ============ Settings ============ */
function renderIdentity() {
  const me = state.me;
  if (!me) return;
  const summary = $("#setting-identity-summary");
  if (summary) summary.textContent = `${me.name} · ${me.role}`;
  const target = $("#settings-identity");
  if (!target) return;
  const rows = [
    ["名称", me.name],
    ["租户", me.tenant_id],
    ["角色", me.role],
    ["组", (me.groups || []).join("、") || "无"],
    ["主体集合", (me.principals || []).join("  ") || "无"],
  ];
  target.innerHTML = rows.map(([key, value]) => `<div class="kv-row"><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("");
}

async function loadSettings() {
  renderIdentity();
  renderRuntime();
  try {
    const data = await api("/prices");
    const summary = $("#setting-price-summary");
    if (summary) summary.textContent = `${num(data.items.length)} 个模型 · 当前 ${data.current_runtime?.model || "无"}`;
    $("#settings-prices").innerHTML = data.items.map((price) => `
      <tr>
        <td><strong style="font-weight:500">${esc(price.model)}</strong> <span class="muted small">${esc(price.provider)}</span></td>
        <td class="num">¥${Number(price.input_per_1m).toFixed(2)}</td>
        <td class="num">¥${Number(price.output_per_1m).toFixed(2)}</td>
        <td class="date">${esc(price.effective_from)}</td>
      </tr>`).join("") || `<tr><td colspan="4"><div class="empty-block">暂无单价</div></td></tr>`;
  } catch (_) { /* ignore */ }
  $("#settings-mcp").textContent = `curl -s -X POST http://localhost:8000/api/v1/mcp \\
  -H "Authorization: Bearer ${state.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"kb_ask","arguments":{"question":"知识库的架构约束是什么？"}}}'`;
  const mcpSummary = $("#setting-mcp-summary");
  if (mcpSummary) mcpSummary.textContent = `JSON-RPC · /api/v1/mcp`;
  stampNow();
}

/* ============ Boot ============ */
async function boot() {
  document.body.dataset.page = state.page;
  $("#token-select").value = state.token;
  $("#token-select").addEventListener("change", async (event) => {
    state.token = event.target.value;
    localStorage.setItem("kw_token", state.token);
    state.me = null;
    state.stats = null;
    state.docs = [];
    state.entities = [];
    state.activeEntity = null;
    state.conversationId = null;
    state.chatConversationId = null;
    state.chatDraft = false;
    state.chatMessages = [];
    state.chatBusy = false;
    $("#chat-thread").innerHTML = `<div class="empty-block">暂无消息</div>`;
    $("#chat-list").innerHTML = "";
    $("#ask-result").innerHTML = `<div class="empty-block">尚无检索结果</div>`;
    $("#evidence-body").innerHTML = `<div class="empty-block">暂无证据</div>`;
    $("#evidence-count").textContent = "";
    await refreshShell();
    await loadMetaAndHealth();
    loadPage(state.page);
  });

  window.addEventListener("hashchange", () => {
    const next = location.hash.replace("#", "");
    if (PAGE_META[next] && next !== state.page) showPage(next);
  });

  $$(".nav-item").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));
  $$("[data-goto]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.goto)));

  $("#nav-toggle").addEventListener("click", () => {
    if ($("#sidebar").classList.contains("open")) closeSidebar();
    else openSidebar();
  });
  $("#scrim").addEventListener("click", closeSidebar);

  $("#refresh-page").addEventListener("click", () => {
    refreshShell();
    loadMetaAndHealth();
    loadPage(state.page);
    toast("已刷新");
  });

  $("#global-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("#global-search-input").value.trim();
    if (!query) return;
    $("#doc-search").value = query;
    showPage("library");
    loadDocs();
  });

  $("#entity-search").addEventListener("input", (event) => {
    clearTimeout(window.__entityTimer);
    window.__entityTimer = setTimeout(() => loadEntities(event.target.value.trim()), 300);
  });

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  $$("[data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });

  $("#reflect-btn").addEventListener("click", async () => {
    const button = $("#reflect-btn");
    setBusy(button, true, "反思中");
    try {
      const summary = await api("/reflection/run", { method: "POST" });
      toast(`反思完成 · 合并 ${num(summary.merged_entities)} 个实体，标记 ${num(summary.conflicts_marked)} 个冲突`);
      loadDashboard();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  });
  $("#harness-refresh").addEventListener("click", async () => {
    await loadMetaAndHealth();
    toast("运行时状态已更新");
  });

  setupIngest();
  setupAsk();
  setupChat();
  setupTour();
  setupOps();

  const initial = (location.hash || "#chat").replace("#", "");
  await refreshShell();
  await loadMetaAndHealth();
  showPage(PAGE_META[initial] ? initial : "chat");
  if (!localStorage.getItem(tourKey())) openTour();
}

document.addEventListener("DOMContentLoaded", boot);
