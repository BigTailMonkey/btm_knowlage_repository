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
  chatFilter: "",
  chatEvidence: null,
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
  ingestDocumentId: null,
  aclOptions: null,
  jobs: [],
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

// Keep infrastructure identifiers in requests and stored records; use product names in the interface.
function runtimeText(value) {
  return String(value ?? "")
    .replace(/@deepseek-ai\/dsh(?:-sdk-client)?/gi, "知织智能引擎")
    .replace(/deepseek[-_ ]harness(?:[-_ ]sdk)?/gi, "知织智能引擎")
    .replace(/deepseek[-_ ]official/gi, "模型服务")
    .replace(/deepseek[-_ ]api/gi, "模型接口")
    .replace(/deepseek/gi, "对话模型")
    .replace(/\bdsh\b/gi, "智能引擎")
    .replace(/\bharness\b/gi, "智能引擎");
}

function modelLabel(value) {
  const model = String(value ?? "");
  if (/^deepseek[-_]/i.test(model)) {
    const variant = model.replace(/^deepseek[-_]/i, "");
    const label = { chat: "标准", reasoner: "推理" }[variant] || variant;
    return `对话模型 · ${runtimeText(label)}`;
  }
  return runtimeText(model || "无");
}

function featureLabel(value) {
  return FEATURE_LABEL[value] || runtimeText(value);
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
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
}

function dayOnly(value) {
  if (!value) return "无";
  return String(value).slice(0, 10);
}

function statusPill(status, map = TRACE_STATUS, fallback = "neutral") {
  const [label, tone] = map[status] || [status || "无", fallback];
  return `<span class="pill ${tone}">${esc(runtimeText(label))}</span>`;
}

function factPill(status) {
  const [label, tone] = FACT_STATUS[status] || [status || "无", ""];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = runtimeText(message);
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
    const error = new Error(runtimeText(detail));
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
  const clock = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
  el.textContent = `${clock} 更新`; // taste-skill-ignore
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
  $("#sheet").scrollTop = 0;
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  closeSidebar();
  loadPage(page);
}

function loadPage(page) {
  if (page === "chat") loadChat();
  if (page === "dashboard") loadDashboard();
  if (page === "library") { loadDocs(); loadIngestJobs(); }
  if (page === "ask") loadAsk();
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
    adapter: runtimeText(primary.adapter || health.adapter || "无"),
    model: modelLabel(primary.model || state.meta?.model),
    mode: primary.mode === "sdk/sdk-profile" ? "托管服务" : runtimeText(primary.mode || "无"),
    profile: primary.profile === "sdk" ? "标准" : runtimeText(primary.profile || "无"),
    lastUsed: runtimeText(health.lastUsed || health.last_used || primary.lastUsed || primary.last_used || "无"),
    lastError: runtimeText(primary.lastError || primary.last_error || health.lastError || health.last_error || health.fallback?.lastError || health.fallback?.last_error || "")
      .split("\n").map((line) => line.trim()).find((line) => line && !/^[\^~]+$/.test(line)) || "",
  };
}

function renderRuntime() {
  const view = runtimeView();
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
    ["嵌入模型", modelLabel(state.meta?.embedding_model)],
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
      <span class="rank-label">${esc(featureLabel(key))}</span>
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
        <span class="row-title">${esc(trace.question || trace.answer || featureLabel(trace.feature))}</span>
        <span class="row-sub">${esc(featureLabel(trace.feature))} · ${num(trace.latency_ms)} ms · ${shortDate(trace.created_at)}</span>
      </span>
      ${statusPill(trace.status)}
    </button>`).join("");
  $$("#recent-traces [data-trace]").forEach((row) => row.addEventListener("click", () => openTrace(row.dataset.trace)));
}

/* ============ Library ============ */
function docQuery() {
  return $("#doc-search")?.value.trim() || "";
}

const JOB_POLL_MS = 1500;
let jobPollTimer = null;
let jobStatusCache = null;

function stopJobPoll() {
  if (jobPollTimer) {
    clearTimeout(jobPollTimer);
    jobPollTimer = null;
  }
}

function scheduleJobPoll() {
  if (jobPollTimer) return;
  jobPollTimer = setTimeout(() => {
    jobPollTimer = null;
    loadIngestJobs();
  }, JOB_POLL_MS);
}

function trackIngestJob(job) {
  if (!job?.job_id) return;
  jobStatusCache = jobStatusCache || new Map();
  jobStatusCache.set(job.job_id, job.status);
  state.jobs = state.jobs.filter((item) => item.job_id !== job.job_id);
  state.jobs.unshift(job);
  renderIngestJobs();
  scheduleJobPoll();
}

async function loadIngestJobs() {
  if (state.page !== "library") {
    stopJobPoll();
    return;
  }
  try {
    const data = await api("/documents/jobs");
    state.jobs = data.items;
    renderIngestJobs();
    const current = new Map(state.jobs.map((job) => [job.job_id, job.status]));
    if (jobStatusCache) {
      current.forEach((status, id) => {
        const previous = jobStatusCache.get(id);
        if (previous !== status && (status === "done" || status === "failed")) {
          const job = state.jobs.find((item) => item.job_id === id);
          if (!job) return;
          if (status === "done") {
            toast(job.duplicate ? "内容与已有版本相同，未重复入库" : `已接入 ${num(job.chunks)} 个检索单元 · v${job.version}`);
            loadDocs();
            loadDashboard();
          } else {
            toast(`处理失败：${job.error || "未知错误"}`);
          }
        }
      });
    }
    jobStatusCache = current;
    const hasActive = state.jobs.some((job) => job.status === "pending" || job.status === "running");
    if (hasActive) scheduleJobPoll();
    else stopJobPoll();
  } catch (error) {
    stopJobPoll();
  }
}

function renderIngestJobs() {
  const box = $("#ingest-jobs");
  if (!box) return;
  const jobs = state.jobs.filter((job) => ["pending", "running", "failed"].includes(job.status));
  box.hidden = !jobs.length;
  if (!jobs.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = jobs.map((job) => {
    const failed = job.status === "failed";
    const percent = failed ? 100 : Math.max(3, Number(job.percent) || 3);
    const stage = runtimeText(failed ? job.error || "处理失败" : job.stage || "排队中");
    return `
      <div class="job-card${failed ? " failed" : ""}">
        <div class="job-line">
          <span class="job-title">${esc(job.title)}</span>
          <span class="job-stage" title="${esc(stage)}">${esc(stage)}</span>
          <span class="job-percent">${failed ? "失败" : `${percent}%`}</span>
        </div>
        ${failed ? `<div class="job-actions"><button class="text-btn" data-retry-job="${esc(job.job_id)}">重试解析</button><button class="text-btn" data-correct-job="${esc(job.job_id)}">人工修正文</button></div>` : ""}
        <div class="job-progress"><i style="width:${percent}%"></i></div>
      </div>`;
  }).join("");
  box.querySelectorAll("[data-retry-job], [data-correct-job]").forEach((button) => {
    button.addEventListener("click", async () => {
      const corrected = button.dataset.correctJob ? prompt("输入人工修正后的文档正文，提交后重新索引：") : null;
      if (button.dataset.correctJob && !corrected?.trim()) return;
      button.disabled = true;
      try {
        const id = button.dataset.retryJob || button.dataset.correctJob;
        const job = await api(`/documents/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: corrected ? { corrected_text: corrected, stage: "index" } : { stage: "parse" } });
        trackIngestJob(job);
      } catch (error) { toast(error.message); button.disabled = false; }
    });
  });
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

function citationNumber(citation, position = 0) {
  const index = Number(citation?.index ?? citation?.rank);
  return Number.isInteger(index) && index > 0 ? index : position + 1;
}

function findCitation(citations, number) {
  return (citations || []).find((citation, position) => citationNumber(citation, position) === Number(number));
}

function sourceRanges(data, citation) {
  const source = String(data.source?.text ?? "");
  const chunk = (data.chunks || []).find((item) => item.id === citation?.chunk_id);
  const spans = chunk?.spans || citation?.spans || [];
  const ranges = spans.map((span) => [Number(span.start), Number(span.end)])
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= source.length)
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length && citation?.quote) {
    const quote = String(citation.quote).replace(/…$/, "").trim();
    const start = quote ? source.indexOf(quote) : -1;
    if (start >= 0) ranges.push([start, start + quote.length]);
  }
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range.slice());
  }
  return merged;
}

function sourceHtml(text, ranges = []) {
  const source = String(text ?? "");
  let cursor = 0;
  const output = [];
  ranges.forEach(([start, end], index) => {
    output.push(esc(source.slice(cursor, start)));
    output.push(`<mark class="source-highlight"${index === 0 ? ' id="source-highlight-target" tabindex="-1"' : ""}>${esc(source.slice(start, end))}</mark>`);
    cursor = end;
  });
  output.push(esc(source.slice(cursor)));
  return output.join("");
}

function openCitation(citation) {
  if (citation?.doc_id) return openDoc(citation.doc_id, citation);
}

let docOpenRequest = 0;

async function openDoc(docId, citation = null) {
  const request = ++docOpenRequest;
  const dialog = $("#doc-dialog");
  $("#doc-dialog-title").textContent = "文档";
  $("#doc-dialog-body").innerHTML = loadingLines();
  if (!dialog.open) dialog.showModal();
  try {
    const selectedVersion = citation?.version_id;
    const data = await api(`/documents/${encodeURIComponent(docId)}${selectedVersion ? `?version_id=${encodeURIComponent(selectedVersion)}` : ""}`);
    if (request !== docOpenRequest) return;
    const doc = data.document;
    const ranges = sourceRanges(data, citation);
    const version = data.source?.version ?? doc.version;
    const locating = Boolean(citation?.chunk_id || citation?.quote || citation?.spans?.length);
    $("#doc-dialog-title").textContent = doc.title;
    $("#doc-dialog-body").innerHTML = `
      <div class="detail-head">
        <div style="min-width:0">
          <div class="detail-pills">
            <span class="pill ${doc.acl_label === "全员可见" ? "" : "warn"}">${esc(doc.acl_label)}</span>
            <span class="pill">v${esc(version)}</span>
            <span class="pill">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)}</span>
            <span class="pill">${num(data.chunks.length)} 个检索单元</span>
            <span class="pill">质量 ${esc(doc.quality)}</span>
            <span class="pill">可信度 ${esc(doc.source_trust ?? 0.5)}${doc.is_core ? ' · 核心' : ''}</span>
          </div>
          ${doc.summary ? `<p class="detail-summary">${esc(plain(doc.summary))}</p>` : ""}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn primary" data-doc-action="update" data-doc-id="${esc(doc.id)}">更新内容</button>
        <button class="btn" data-doc-action="reprocess" data-doc-id="${esc(doc.id)}">重新抽取事实</button>
        <button class="btn" data-doc-action="reindex" data-doc-id="${esc(doc.id)}">重建检索索引</button>
        <button class="btn" data-doc-action="policy" data-doc-id="${esc(doc.id)}" data-trust="${esc(doc.source_trust ?? 0.5)}" data-core="${doc.is_core ? 'true' : 'false'}">来源与核心标记</button>
        <button class="btn danger" data-doc-action="delete" data-doc-id="${esc(doc.id)}">移入回收站</button>
      </div>

      <div class="section source-section">
        <h3>原文 · v${esc(version)}</h3>
        ${locating ? `<p class="muted small">${ranges.length ? "已定位引用的原文片段。" : "该引用暂无精确坐标，可在下方原文中核对。"}</p>` : ""}
        <pre class="doc-source">${sourceHtml(data.source?.text ?? "", ranges) || '<span class="muted">暂无原文</span>'}</pre>
      </div>

      <div class="section">
        <h3>版本</h3>
        ${data.versions.map((version) => `
          <button type="button" class="version-row version-link" data-doc-version="${esc(version.id)}"${version.id === data.source?.version_id ? ' aria-current="true"' : ""}>
            <span>v${esc(version.version)} · ${esc(version.parser)}</span>
            <span class="meta">${num(version.chars)} 字符 · ${esc(version.hash)} · ${shortDate(version.created_at)}</span>
          </button>`).join("") || `<div class="empty-block">暂无版本</div>`}
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
            <div class="quote-block${chunk.id === citation?.chunk_id ? " is-target" : ""}">
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
      button.addEventListener("click", () => {
        if (button.dataset.docAction === "update") {
          dialog.close();
          openIngest(doc);
        } else handleDocAction(button.dataset.docAction, button.dataset.docId, button);
      });
    });
    $$("[data-doc-version]", $("#doc-dialog-body")).forEach((button) => {
      button.addEventListener("click", () => openDoc(docId, { version_id: button.dataset.docVersion }));
    });
    const highlight = $("#source-highlight-target", $("#doc-dialog-body"));
    highlight?.scrollIntoView({ behavior: "smooth", block: "center" });
    highlight?.focus({ preventScroll: true });
  } catch (error) {
    if (request === docOpenRequest) $("#doc-dialog-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
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
  if (action === "reindex" || action === "policy") {
    let payload;
    if (action === "policy") {
      const value = prompt("来源可信度（0–1）；追加 core 标记为核心文档，例如：0.8 core", `${button.dataset.trust}${button.dataset.core === 'true' ? ' core' : ''}`);
      if (value === null) return;
      const source_trust = Number(value.trim().split(/\s+/)[0]);
      if (!Number.isFinite(source_trust) || source_trust < 0 || source_trust > 1) { toast("可信度需为0–1"); return; }
      payload = { source_trust, is_core: /\bcore\b/i.test(value) };
    }
    setBusy(button, true, "处理中");
    try {
      await api(`/documents/${docId}/${action === 'policy' ? 'policy' : 'reprocess'}`, { method: action === 'policy' ? 'PATCH' : 'POST', body: payload || { scope: 'index' } });
      toast(action === 'policy' ? "文档来源策略已保存" : "所有存储版本的检索索引已重建");
      await openDoc(docId);
    } catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
  }
}

const aclPickerState = new WeakMap();
let aclOptionsRequest = null;

function aclValues(picker) {
  const controller = picker && aclPickerState.get(picker);
  return controller ? Array.from(controller.selected) : [];
}

function ingestAcl(picker) {
  if (state.ingestDocumentId && !aclPickerState.get(picker)?.dirty) return null;
  return aclValues(picker);
}

function aclOptionLabel(value) {
  const option = (state.aclOptions || []).find((item) => item.value === value);
  if (option) return option.label;
  return value === "tenant:public" ? "全员可见" : value.replace(/^[^:]+:/, "");
}

function fuzzyScore(text, query) {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const index = haystack.indexOf(needle);
  if (index >= 0) return index;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 100 + haystack.length;
  }
  return -1;
}

function loadAclOptions() {
  if (state.aclOptions) return Promise.resolve(state.aclOptions);
  if (!aclOptionsRequest) {
    aclOptionsRequest = api("/documents/acl-options")
      .then((data) => {
        state.aclOptions = [
          { value: "tenant:public", label: "全员可见", kind: "范围" },
          ...(data.groups || []).map((name) => ({ value: `group:${name}`, label: name, kind: "组" })),
        ];
        return state.aclOptions;
      })
      .catch((error) => {
        aclOptionsRequest = null;
        throw error;
      });
  }
  return aclOptionsRequest;
}

function setupAclPicker(picker) {
  const input = $("[data-acl-input]", picker);
  const tagBox = $("[data-acl-tags]", picker);
  const menu = $("[data-acl-menu]", picker);
  const selected = new Set(["tenant:public"]);
  let dirty = false;
  let filtered = [];
  let activeIndex = 0;

  function renderTags() {
    tagBox.innerHTML = Array.from(selected).map((value) => {
      const label = aclOptionLabel(value);
      return `<span class="acl-tag">${esc(label)}<button type="button" data-remove="${esc(value)}" aria-label="移除 ${esc(label)}">×</button></span>`;
    }).join("");
  }

  function renderMenu() {
    const query = input.value.trim();
    if (!state.aclOptions) {
      filtered = [];
      menu.innerHTML = `<div class="acl-empty">加载中</div>`;
      return;
    }
    const matches = state.aclOptions
      .map((option) => ({ option, score: fuzzyScore(`${option.label} ${option.value}`, query) }))
      .filter((item) => item.score >= 0);
    if (query) {
      matches.sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label, "zh-CN"));
    }
    filtered = matches.map((item) => item.option);
    if (!filtered.length) {
      menu.innerHTML = `<div class="acl-empty">没有匹配的权限组</div>`;
      return;
    }
    activeIndex = Math.min(activeIndex, filtered.length - 1);
    menu.innerHTML = filtered.map((option, index) => `
      <div class="acl-option${index === activeIndex ? " is-active" : ""}" role="option" data-value="${esc(option.value)}" aria-selected="${selected.has(option.value)}">
        <span>${esc(option.label)}</span>
        <span class="acl-option-kind">${esc(option.kind)}</span>
      </div>`).join("");
  }

  function open() {
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close() {
    menu.hidden = true;
    activeIndex = 0;
    input.setAttribute("aria-expanded", "false");
  }

  function toggle(value) {
    dirty = true;
    if (value === "tenant:public") {
      selected.clear();
      selected.add(value);
    } else {
      selected.delete("tenant:public");
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
    }
    input.value = "";
    activeIndex = 0;
    renderTags();
    renderMenu();
  }

  input.addEventListener("focus", () => {
    open();
    renderMenu();
    loadAclOptions().then(renderMenu).catch((error) => toast(error.message));
  });
  input.addEventListener("input", () => {
    activeIndex = 0;
    open();
    renderMenu();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (menu.hidden) open();
      activeIndex = filtered.length ? (activeIndex + 1) % filtered.length : 0;
      renderMenu();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) open();
      activeIndex = filtered.length ? (activeIndex - 1 + filtered.length) % filtered.length : 0;
      renderMenu();
    } else if (event.key === "Enter") {
      if (menu.hidden) return;
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) toggle(option.value);
    } else if (event.key === "Escape") {
      close();
    } else if (event.key === "Backspace" && !input.value) {
      const values = Array.from(selected);
      if (values.length) {
        dirty = true;
        selected.delete(values[values.length - 1]);
        renderTags();
        renderMenu();
      }
    }
  });
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = event.target.closest(".acl-option");
    if (option) toggle(option.dataset.value);
  });
  tagBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    dirty = true;
    selected.delete(button.dataset.remove);
    renderTags();
    renderMenu();
    input.focus();
    open();
  });

  aclPickerState.set(picker, {
    selected,
    get dirty() { return dirty; },
    close,
    reset() {
      dirty = false;
      selected.clear();
      selected.add("tenant:public");
      input.value = "";
      close();
      renderTags();
    },
  });
  renderTags();
}

function selectIngestTab(type) {
  $$("#ingest-tabs .tab").forEach((item) => {
    const active = item.dataset.ingest === type;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#ingest-file-form").hidden = type !== "file";
  $("#ingest-text-form").hidden = type !== "text";
  $("#ingest-url-form").hidden = type !== "url";
}

function resetIngest() {
  state.ingestDocumentId = null;
  state.file = null;
  $("#ingest-title").textContent = "添加文档";
  for (const type of ["file", "text", "url"]) $("#ingest-" + type + "-form").reset();
  $$("[data-acl-picker]").forEach((picker) => aclPickerState.get(picker)?.reset());
  $("#file-drop-label").textContent = "选择文件";
}

function openIngest(doc = null) {
  resetIngest();
  state.ingestDocumentId = doc?.id || null;
  $("#ingest-title").textContent = doc ? "更新文档" : "添加文档";
  for (const type of ["file", "text", "url"]) $("#" + type + "-title").value = doc?.title || "";
  if (doc?.source_type === "web") $("#url-input").value = doc.uri || "";
  selectIngestTab(doc?.source_type === "web" ? "url" : doc?.source_type === "text" ? "text" : "file");
  $("#ingest-dialog").showModal();
  loadAclOptions().catch((error) => toast(error.message));
}

function setupIngest() {
  $$("[data-acl-picker]").forEach(setupAclPicker);
  document.addEventListener("click", (event) => {
    $$("[data-acl-picker]").forEach((picker) => {
      if (!picker.contains(event.target)) aclPickerState.get(picker)?.close();
    });
  });

  $$("#ingest-tabs .tab").forEach((button) => {
    button.addEventListener("click", () => selectIngestTab(button.dataset.ingest));
  });

  $("#open-ingest").addEventListener("click", () => openIngest());
  $("#ingest-dialog").addEventListener("close", resetIngest);

  const fileInput = $("#file-input");
  const dropLabel = $("#file-drop-label");
  const applyFileTitle = (file) => {
    const name = file?.name || "";
    const dot = name.lastIndexOf(".");
    $("#file-title").value = dot > 0 ? name.slice(0, dot) : name;
  };
  fileInput.addEventListener("change", () => {
    state.file = fileInput.files?.[0] || null;
    dropLabel.textContent = state.file ? state.file.name : "选择文件";
    if (state.file) applyFileTitle(state.file);
  });
  ["dragenter", "dragover"].forEach((event) => $("#file-drop").addEventListener(event, (e) => { e.preventDefault(); }));
  $("#file-drop").addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    state.file = file;
    fileInput.files = event.dataTransfer.files;
    dropLabel.textContent = file.name;
    applyFileTitle(file);
  });

  $("#ingest-file-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.file) { toast("先选择文件"); return; }
    const button = event.submitter;
    const form = new FormData();
    if (state.ingestDocumentId) form.append("doc_id", state.ingestDocumentId);
    const title = $("#file-title").value.trim();
    const acl = (ingestAcl($("#file-acl")) || []).join(",");
    if (title) form.append("title", title);
    if (acl) form.append("acl", acl);
    form.append("file", state.file);
    setBusy(button, true, "提交中");
    try {
      const result = await api("/documents/upload", { method: "POST", body: form });
      closeIngest();
      toast("已提交，正在后台处理");
      trackIngestJob(result);
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
    setBusy(button, true, "提交中");
    const acl = ingestAcl($("#text-acl"));
    try {
      const result = await api("/documents/text", {
        method: "POST",
        body: {
          text,
          ...(state.ingestDocumentId ? { doc_id: state.ingestDocumentId } : {}),
          title: $("#text-title").value.trim() || null,
          acl: acl?.length ? acl : null,
        },
      });
      closeIngest();
      toast("已提交，正在后台处理");
      trackIngestJob(result);
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
    setBusy(button, true, "提交中");
    const acl = ingestAcl($("#url-acl"));
    try {
      const result = await api("/documents/url", {
        method: "POST",
        body: {
          url,
          ...(state.ingestDocumentId ? { doc_id: state.ingestDocumentId } : {}),
          title: $("#url-title").value.trim() || null,
          acl: acl?.length ? acl : null,
        },
      });
      closeIngest();
      toast("已提交，正在后台处理");
      trackIngestJob(result);
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
  resetIngest();
}

/* ============ Chat ============ */
const CHAT_MODE_LABEL = {
  quick: "快速",
  deep: "深度",
  graph: "图谱",
  timeline: "时间线",
  compare: "对比",
};

const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M3 9c4.5 0 4.5-5 9-5s4.5 5 9 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M3 15c4.5 0 4.5 5 9 5s4.5-5 9-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

function chatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderChatList() {
  const list = $("#chat-list");
  if (!state.conversations.length) {
    list.innerHTML = `<div class="rail-empty">暂无会话</div>`;
    return;
  }
  const query = state.chatFilter.trim().toLowerCase();
  const items = query
    ? state.conversations.filter((conversation) => (conversation.title || "未命名会话").toLowerCase().includes(query))
    : state.conversations;
  if (!items.length) {
    list.innerHTML = `<div class="rail-empty">没有匹配的会话</div>`;
    return;
  }
  list.innerHTML = items.map((conversation) => `
    <button class="chat-item ${conversation.id === state.chatConversationId ? "active" : ""}" type="button" data-chat="${esc(conversation.id)}">
      <span class="chat-item-top">
        <span class="chat-item-title">${esc(conversation.title || "未命名会话")}</span>
        <span class="chat-item-time">${chatWhen(conversation.created_at)}</span>
      </span>
      <span class="chat-item-sub">${num(conversation.messages)} 条消息</span>
    </button>`).join("");
  $$("#chat-list [data-chat]").forEach((item) => {
    item.addEventListener("click", () => openChatConversation(item.dataset.chat));
  });
}

async function fetchChatList() {
  const data = await api("/conversations?limit=30");
  state.conversations = data.items;
  renderChatList();
  return data.items;
}

function lastAssistantIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}

async function loadChat() {
  try {
    const items = await fetchChatList();
    if (!items.length) {
      state.chatConversationId = null;
      state.chatMessages = [];
      state.chatEvidence = null;
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
    state.chatEvidence = lastAssistantIndex(state.chatMessages);
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
  state.chatEvidence = null;
  renderChatThread();
  renderChatList();
  $("#chat-input").value = "";
  resizeChatInput();
  $("#chat-input").focus();
}

function setChatMode(mode) {
  state.chatMode = CHAT_MODE_LABEL[mode] ? mode : "quick";
  $$("#chat-modes .seg").forEach((button) => {
    const active = button.dataset.mode === state.chatMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function chatMessageHtml(message, id) {
  if (message.role === "user") {
    return `<article class="msg msg-user" data-msg="${id}">
      <div class="msg-body">${esc(message.content).replace(/\n/g, "<br>")}</div>
    </article>`;
  }
  const refused = message.refused ?? /^现有资料不足/.test(message.content || "");
  const citations = message.citations || [];
  const modeLabel = CHAT_MODE_LABEL[message.mode] || message.mode || "";
  const body = message.pending
    ? loadingLines()
    : message.failed
      ? `<p class="msg-error">${esc(message.content)}</p>`
      : answerHtml(message.content, refused);
  const foot = [];
  if (!message.pending) {
    if (message.failed) foot.push(`<span class="pill bad">失败</span>`);
    else if (refused) foot.push(`<span class="pill warn">证据不足</span>`);
    if (citations.length) foot.push(`<button class="text-btn" type="button" data-evidence="${id}">查看 ${num(citations.length)} 条引用</button>`);
    if (Number(message.confidence) > 0) foot.push(`<span>置信度 ${Math.round(Number(message.confidence) * 100)}%</span>`);
    if (message.latency_ms) foot.push(`<span>${message.latency_ms >= 1000 ? `${(message.latency_ms / 1000).toFixed(1)} s` : `${num(message.latency_ms)} ms`}</span>`);
    if (message.trace_id) foot.push(`<button class="text-btn push" type="button" data-trace="${esc(message.trace_id)}">轨迹</button>`);
  }
  return `<article class="msg msg-assistant" data-msg="${id}">
    <header class="msg-head">
      <span class="msg-author">${BRAND_MARK}<span>知织</span></span>
      ${modeLabel ? `<span class="msg-dot">·</span><span class="msg-mode">${esc(modeLabel)}</span>` : ""}
    </header>
    <div class="msg-body">${body}</div>
    ${citations.length ? `<details class="msg-cites">
      <summary>${num(citations.length)} 条引用</summary>
      <div class="cite-list">${citations.map((citation, index) => `
        <button type="button" class="cite-item cite-source" data-cite-item="${citationNumber(citation, index)}">
          <span class="cite-num">${citationNumber(citation, index)}</span>
          <span class="cite-copy">
            <span class="cite-quote">${esc(plain(citation.quote))}</span>
            <span class="cite-meta">${citation.doc_title ? `${esc(citation.doc_title)} · ` : ""}${citation.page ? `第 ${esc(citation.page)} 页` : "正文"} · 查看原文</span>
          </span>
        </button>`).join("")}</div>
    </details>` : ""}
    ${foot.length ? `<div class="msg-foot">${foot.join("")}</div>` : ""}
  </article>`;
}

function evidenceIndex() {
  if (Number.isInteger(state.chatEvidence) && state.chatMessages[state.chatEvidence]?.role === "assistant") {
    return state.chatEvidence;
  }
  return lastAssistantIndex(state.chatMessages);
}

function renderChatEvidence() {
  const body = $("#chat-evidence-body");
  const countEl = $("#chat-evidence-count");
  if (!body || !countEl) return;
  const index = evidenceIndex();
  if (index < 0) {
    countEl.textContent = "";
    body.innerHTML = `<div class="rail-empty">暂无引用</div>`;
    return;
  }
  const message = state.chatMessages[index];
  if (message.pending) {
    countEl.textContent = "";
    body.innerHTML = loadingLines();
    return;
  }
  const citations = message.citations || [];
  if (!citations.length) {
    countEl.textContent = "";
    const note = message.failed ? "回答失败，没有引用" : message.refused ? "证据不足，没有引用原文" : "这条回答没有引用";
    body.innerHTML = `<div class="rail-empty">${note}</div>`;
    return;
  }
  countEl.textContent = `${num(citations.length)} 条`;
  body.innerHTML = citations.map((citation, indexNumber) => `
    <button class="evr-item" type="button" data-ev-index="${citationNumber(citation, indexNumber)}">
      <span class="evr-head">
        <span class="evr-num">${citationNumber(citation, indexNumber)}</span>
        <span class="evr-doc">${esc(citation.doc_title || "未命名文档")}</span>
      </span>
      <span class="evr-quote">${esc(plain(citation.quote))}</span>
      <span class="evr-meta">${citation.page ? `第 ${esc(citation.page)} 页` : "正文"} · 查看原文</span>
    </button>`).join("");
}

function renderChatHeading() {
  const conversation = state.conversations.find((item) => item.id === state.chatConversationId);
  const firstQuestion = state.chatMessages.find((message) => message.role === "user");
  const title = state.chatConversationId ? (conversation?.title || firstQuestion?.content || "对话") : "新对话";
  $("#chat-main-head").hidden = !state.chatMessages.length;
  $("#chat-title").textContent = title;
  $("#chat-title-meta").textContent = state.chatMessages.length ? `${num(state.chatMessages.length)} 条消息` : "";
}

function renderChatThread() {
  const thread = $("#chat-thread");
  renderChatHeading();
  if (!state.chatMessages.length) {
    thread.innerHTML = `<div class="chat-empty">
      <span class="mark">${BRAND_MARK}</span>
      <h2>向知识库提问</h2>
      <p>回答标注原文引用，可逐条核对。</p>
    </div>`;
  } else {
    thread.innerHTML = state.chatMessages.map((message, index) => chatMessageHtml(message, index)).join("");
    thread.scrollTop = thread.scrollHeight;
  }
  renderChatEvidence();
}

function focusChatEvidence(index, number) {
  state.chatEvidence = index;
  renderChatEvidence();
  if (number == null) return;
  const body = $("#chat-evidence-body");
  const item = body?.querySelector(`[data-ev-index="${number}"]`);
  if (!item) return;
  $$(".evr-item", body).forEach((row) => row.classList.toggle("is-target", row === item));
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  const mode = state.chatMode || "quick";
  state.chatBusy = true;
  $("#chat-send").disabled = true;
  input.value = "";
  resizeChatInput();
  state.chatMessages.push({ role: "user", content: question });
  const pending = { role: "assistant", content: "", mode, pending: true };
  state.chatMessages.push(pending);
  const pendingIndex = state.chatMessages.length - 1;
  state.chatEvidence = pendingIndex;
  renderChatThread();
  try {
    const payload = { question, mode, top_k: 6 };
    if (state.chatConversationId) payload.conversation_id = state.chatConversationId;
    const result = await api("/ask", { method: "POST", body: payload });
    state.chatConversationId = result.conversation_id;
    state.chatDraft = false;
    state.chatMessages[pendingIndex] = {
      role: "assistant",
      content: result.answer,
      mode: result.mode,
      confidence: result.confidence,
      latency_ms: result.latency_ms,
      trace_id: result.trace_id,
      refused: result.refused,
      citations: result.citations || [],
    };
  } catch (error) {
    state.chatMessages[pendingIndex] = { role: "assistant", content: error.message, mode, failed: true };
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
  $("#chat-filter").addEventListener("input", (event) => {
    state.chatFilter = event.target.value;
    renderChatList();
  });
  $("#chat-modes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (button) setChatMode(button.dataset.mode);
  });
  $("#chat-evidence-body").addEventListener("click", (event) => {
    const item = event.target.closest("[data-ev-index]");
    if (!item) return;
    const index = evidenceIndex();
    const article = $(`.msg-assistant[data-msg="${index}"]`);
    const cite = article?.querySelector(`[data-cite="${Number(item.dataset.evIndex)}"]`);
    $$(".evr-item", $("#chat-evidence-body")).forEach((row) => row.classList.toggle("is-target", row === item));
    article?.scrollIntoView({ behavior: "smooth", block: "center" });
    openCitation(findCitation(state.chatMessages[index]?.citations, item.dataset.evIndex));
    if (!cite) return;
    $$(".cite.is-target").forEach((target) => target.classList.remove("is-target"));
    cite.classList.add("is-target");
    setTimeout(() => cite.classList.remove("is-target"), 1600);
  });
  $("#chat-thread").addEventListener("click", (event) => {
    const source = event.target.closest("[data-cite-item]");
    if (source) {
      const article = source.closest(".msg-assistant");
      const message = state.chatMessages[Number(article?.dataset.msg)];
      openCitation(findCitation(message?.citations, source.dataset.citeItem));
      return;
    }
    const evidence = event.target.closest("[data-evidence]");
    if (evidence) {
      const article = evidence.closest(".msg-assistant");
      const details = article?.querySelector(".msg-cites");
      if ($("#chat-evidence").offsetParent === null && details) {
        details.open = !details.open;
        return;
      }
      focusChatEvidence(Number(evidence.dataset.evidence), null);
      $("#chat-evidence-body").scrollTop = 0;
      return;
    }
    const cite = event.target.closest("[data-cite]");
    if (cite) {
      const article = cite.closest(".msg-assistant");
      if (!article) return;
      const citation = findCitation(state.chatMessages[Number(article.dataset.msg)]?.citations, cite.dataset.cite);
      if (citation?.doc_id) {
        focusChatEvidence(Number(article.dataset.msg), Number(cite.dataset.cite));
        openCitation(citation);
        return;
      }
      if ($("#chat-evidence").offsetParent === null) {
        const details = article.querySelector(".msg-cites");
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
      focusChatEvidence(Number(article.dataset.msg), Number(cite.dataset.cite));
      return;
    }
    const trace = event.target.closest("[data-trace]");
    if (trace) openTrace(trace.dataset.trace);
  });
  setChatMode(state.chatMode);
  resizeChatInput();
}

/* ============ Tour ============ */
const TOUR_STEPS = [
  { page: "chat", title: "对话", body: "在知织对话中输入问题，会话自动保存。" },
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
  $$("#mode-tabs [data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$("#mode-tabs [data-mode]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", active ? "true" : "false");
      });
    });
  });
  $("#ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runAsk();
  });
  $("#question").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runAsk();
  });
  $("#question").addEventListener("input", resizeAskInput);
  resizeAskInput();
}

function resizeAskInput() {
  const input = $("#question");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function latencyLabel(value) {
  const ms = Number(value) || 0;
  if (!ms) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${num(ms)} ms`;
}

function askPayload(question, conversationId = null) {
  const payload = { question, mode: state.mode, top_k: 6 };
  const asOf = $("#as-of")?.value;
  if (asOf) payload.as_of = asOf;
  if (conversationId) payload.conversation_id = conversationId;
  return payload;
}

async function runAsk() {
  const input = $("#question");
  const question = input.value.trim();
  if (!question) { toast("问题不能为空"); return; }
  const button = $("#ask-btn");
  $(".ask-layout").classList.remove("is-empty");
  setBusy(button, true, "检索中");
  $("#ask-result").innerHTML = `<article class="answer answer-loading">${loadingLines()}</article>`;
  $("#evidence-gate").innerHTML = "";
  $("#evidence-count").textContent = "";
  $("#evidence-body").innerHTML = loadingLines();
  try {
    const result = await api("/ask", { method: "POST", body: askPayload(question, state.conversationId) });
    state.lastAsk = result;
    state.conversationId = result.conversation_id;
    renderAsk(result, question);
    input.value = "";
    resizeAskInput();
    loadConversations();
    loadDashboard();
  } catch (error) {
    $("#ask-result").innerHTML = `<article class="answer"><div class="answer-error">${esc(error.message)}</div></article>`;
    $("#evidence-body").innerHTML = `<div class="rail-empty">暂无证据</div>`;
    $(".ask-layout").classList.add("is-empty");
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

function askEmptyHtml() {
  const stats = state.stats || {};
  const documents = Number(stats.documents || 0);
  const scope = documents
    ? `可检索 ${num(documents)} 份文档 · ${num(stats.chunks || 0)} 个检索单元 · ${num(stats.entities || 0)} 个实体 · ${num(stats.facts_active || 0)} 条事实`
    : "";
  return scope ? `<div class="ask-empty"><div class="ask-empty-intro"><div class="ask-scope">${esc(scope)}</div></div></div>` : "";
}

function renderAsk(result, question = $("#question").value.trim() || "检索结果") {
  $(".ask-layout").classList.remove("is-empty");
  const refused = Boolean(result.refused);
  const compact = refused || String(result.answer || "").length < 220;
  const modeName = state.meta?.modes?.find((mode) => mode.id === result.mode)?.name || result.mode || "";
  const confidence = Number(result.confidence) > 0 ? Math.round(Number(result.confidence) * 100) : 0;
  $("#ask-result").innerHTML = `
    <article class="answer ${compact ? "is-compact" : ""}">
      <header class="answer-head">
        <h2 class="answer-question" title="${esc(question)}">${esc(question)}</h2>
        <div class="answer-meta">
          <span>${esc(modeName)}</span>
          <span class="pill ${refused ? "warn" : "ok"}">${refused ? "证据不足" : "已回答"}</span>
          ${confidence ? `<span>置信度 ${confidence}%</span>` : ""}
          ${result.latency_ms ? `<span>${latencyLabel(result.latency_ms)}</span>` : ""}
        </div>
      </header>
      <div class="answer-body">${answerHtml(result.answer, refused)}</div>
      <footer class="answer-foot">
        <div class="answer-actions">
          <button class="text-btn" type="button" data-feedback="1">有帮助</button>
          <button class="text-btn" type="button" data-feedback="-1">需改进</button>
          ${result.trace_id ? `<button class="text-btn" type="button" data-open-trace="${esc(result.trace_id)}">查看轨迹</button>` : ""}
        </div>
      </footer>
    </article>`;
  $$("[data-feedback]", $("#ask-result")).forEach((button) => {
    button.addEventListener("click", () => sendFeedback(result.message_id, Number(button.dataset.feedback)));
  });
  $$("[data-open-trace]", $("#ask-result")).forEach((button) => {
    button.addEventListener("click", () => openTrace(button.dataset.openTrace));
  });
  $$("[data-cite]", $("#ask-result")).forEach((link) => {
    link.addEventListener("click", () => {
      const number = Number(link.dataset.cite);
      focusEvidence(number);
      openCitation(findCitation(result.citations, number) || result.evidence?.[number - 1]);
    });
  });
  renderEvidence(result);
  renderRecentState();
  stampNow();
}

function gateHtml(stats) {
  const top = Math.min(1, Math.max(0, Number(stats.top_score) || 0));
  const threshold = Math.min(1, Math.max(0, Number(stats.threshold) || 0));
  if (!top || !threshold) return "";
  return `<div class="gate" role="img" aria-label="最高检索分 ${top.toFixed(3)}，检索阈值 ${threshold.toFixed(3)}">
    <div class="gate-head"><span>检索阈值</span><span><b>最高 ${top.toFixed(3)}</b> · 阈值 ${threshold.toFixed(3)}</span></div>
    <div class="gate-track">
      <span class="gate-fill" style="width:${(top * 100).toFixed(2)}%"></span>
      <span class="gate-tick" style="left:${(threshold * 100).toFixed(2)}%"></span>
    </div>
  </div>`;
}

function renderEvidence(result) {
  const evidence = result.evidence || [];
  const facts = result.facts || [];
  const stats = result.stats || {};
  const gate = $("#evidence-gate");
  const body = $("#evidence-body");
  const countEl = $("#evidence-count");
  gate.innerHTML = gateHtml(stats);
  if (!evidence.length) {
    countEl.textContent = "";
    body.innerHTML = facts.length ? factsHtml(facts) : `<div class="rail-empty">暂无证据</div>`;
    return;
  }
  const rejected = Number(stats.rejected_candidates) || 0;
  countEl.textContent = stats.top_score != null
    ? `入选 ${num(evidence.length)} · 淘汰 ${num(rejected)}`
    : `${num(evidence.length)} 条`;
  body.innerHTML = evidence.map((item, index) => {
    const score = Number(item.scores?.rerank);
    const path = (item.heading_path || []).slice(-2).join(" / ");
    const meta = [item.page ? `第 ${esc(item.page)} 页` : "正文", path ? esc(path) : ""].filter(Boolean).join(" · ");
    return `<button class="evr-item" type="button" data-evidence-index="${index + 1}">
      <span class="evr-head">
        <span class="evr-num">${index + 1}</span>
        <span class="evr-doc">${esc(item.doc_title || "未命名文档")}</span>
        ${Number.isFinite(score) ? `<span class="evr-score">${score.toFixed(3)}</span>` : ""}
      </span>
      <span class="evr-quote">${esc(plain(item.quote || item.text || ""))}</span>
      <span class="evr-meta">${meta} · 查看原文</span>
    </button>`;
  }).join("") + factsHtml(facts);
  $$("#evidence-body [data-evidence-index]").forEach((item) => {
    item.addEventListener("click", () => {
      $$("#evidence-body [data-evidence-index]").forEach((row) => row.classList.toggle("is-target", row === item));
      flashAskCite(Number(item.dataset.evidenceIndex));
      openCitation(evidence[Number(item.dataset.evidenceIndex) - 1]);
    });
  });
}

function factsHtml(facts) {
  if (!facts.length) return "";
  return `<div class="facts-block">
    <div class="facts-head"><span>事实层</span><span>${num(facts.length)} 条</span></div>
    ${facts.slice(0, 6).map((fact) => `<div class="fact"><span>${esc(fact.subject)}</span> · ${esc(fact.predicate)} <span class="fact-object">${esc(fact.object || "")}</span></div>`).join("")}
  </div>`;
}

function flashAskCite(index) {
  const cite = $(`#ask-result [data-cite="${index}"]`);
  if (!cite) return;
  $$(".cite.is-target").forEach((el) => el.classList.remove("is-target"));
  cite.classList.add("is-target");
  cite.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => cite.classList.remove("is-target"), 1600);
}

function focusEvidence(index) {
  const item = $(`#evidence-body [data-evidence-index="${index}"]`);
  if (!item) return;
  $$("#evidence-body [data-evidence-index]").forEach((el) => el.classList.remove("is-target"));
  item.classList.add("is-target");
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

async function loadAsk() {
  loadConversations();
  if ($("#ask-result .answer")) return;
  $(".ask-layout").classList.add("is-empty");
  $("#ask-result").innerHTML = askEmptyHtml();
  try {
    state.stats = await api("/stats");
  } catch (_) {
    return;
  }
  if (!$("#ask-result .answer")) $("#ask-result").innerHTML = askEmptyHtml();
}

async function loadConversations() {
  try {
    const data = await api("/conversations?limit=8");
    state.conversations = data.items;
    renderRecentState();
  } catch (_) { /* ignore */ }
}

function renderRecentState() {
  const target = $("#conversation-list");
  if (!target) return;
  const items = state.conversations.slice(0, 8);
  if (!items.length) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }
  target.hidden = false;
  target.innerHTML = `<span class="recent-label">最近</span>` + items.map((conversation) => `
    <button class="recent-item ${conversation.id === state.conversationId ? "active" : ""}" type="button" data-conversation="${esc(conversation.id)}" title="${esc(conversation.title || "未命名会话")}">
      <span class="recent-title">${esc(conversation.title || "未命名会话")}</span>
      <span class="recent-time">${chatWhen(conversation.created_at)}</span>
    </button>`).join("");
  $$("#conversation-list [data-conversation]").forEach((row) => {
    row.addEventListener("click", () => continueConversation(row.dataset.conversation));
  });
}

function continueConversation(conversationId) {
  state.chatConversationId = conversationId;
  state.chatDraft = false;
  state.chatMessages = [];
  state.chatEvidence = null;
  showPage("chat");
  openChatConversation(conversationId);
}

const NODE_TYPE_LABEL = { concept: "概念", org: "机构", person: "人物", location: "地点", event: "事件", literal: "字面值" };

function nodeTypeLabel(type) {
  return NODE_TYPE_LABEL[type] || type || "实体";
}

function setEntitySub() {
  const nodes = state.graph?.nodes?.length ?? state.entities.length;
  const edges = state.graph?.edges?.length;
}

/* ============ Entities ============ */
async function loadEntities(q = "") {
  try {
    const data = await api(`/entities?limit=80${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const items = [...data.items].sort((a, b) => (b.facts || 0) - (a.facts || 0) || a.name.localeCompare(b.name, "zh"));
    state.entities = items;
    setEntitySub();
    const target = $("#entity-list");
    $("#entity-count").textContent = `${num(items.length)} 个`;
    if (!items.length) {
      target.innerHTML = `<div class="empty-block">暂无实体</div>`;
      return;
    }
    target.innerHTML = items.map((entity) => `
      <button class="row ${state.activeEntity === entity.id ? "selected" : ""}" type="button" data-entity="${esc(entity.id)}">
        <span class="row-main">
          <span class="row-title">${esc(entity.name)}</span>
          <span class="row-sub">${esc(nodeTypeLabel(entity.type))} · ${num(entity.facts)} 条事实</span>
        </span>
      </button>`).join("");
    $$("#entity-list [data-entity]").forEach((row) => row.addEventListener("click", () => selectEntity(row.dataset.entity)));
    const hasActive = items.some((entity) => entity.id === state.activeEntity);
    if (!hasActive && items[0]) selectEntity(items[0].id);
  } catch (error) {
    toast(error.message);
  }
}

async function selectEntity(entityId) {
  state.activeEntity = entityId;
  $$("#entity-list [data-entity]").forEach((row) => row.classList.toggle("selected", row.dataset.entity === entityId));
  drawGraph(entityId);
  const target = $("#entity-detail");
  target.innerHTML = loadingLines();
  try {
    const data = await api(`/entities/${entityId}`);
    const entity = data.entity;
    const facts = data.facts || [];
    const documents = data.documents || [];
    target.innerHTML = `
      <div class="entity-head"><h2>${esc(entity.name)}</h2></div>
      <div class="entity-tags">
        <span class="pill">${esc(nodeTypeLabel(entity.type))}</span>
        <span class="pill ${entity.acl_label === "全员可见" ? "" : "warn"}">${esc(entity.acl_label)}</span>
      </div>
      ${entity.description ? `<p class="entity-desc">${esc(plain(entity.description))}</p>` : ""}

      <div class="entity-section">
        <div class="entity-section-head"><h3>事实</h3><span>${num(facts.length)} 条</span></div>
        ${facts.length ? `<div class="entity-facts">${facts.map(entityFactHtml).join("")}</div>` : `<div class="rail-empty">暂无事实</div>`}
      </div>

      <div class="entity-section">
        <div class="entity-section-head"><h3>相关文档</h3><span>${num(documents.length)} 份</span></div>
        <div class="doc-links">
          ${documents.map((doc) => `<button class="doc-link" type="button" data-doc="${esc(doc.id)}">${esc(doc.title)}</button>`).join("") || `<div class="rail-empty">暂无</div>`}
        </div>
      </div>`;
    $$("#entity-detail [data-doc]").forEach((button) => button.addEventListener("click", () => openDoc(button.dataset.doc)));
  } catch (error) {
    target.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

function entityFactHtml(fact) {
  const object = fact.object || fact.object_literal || "";
  const status = fact.status && fact.status !== "active" ? factPill(fact.status) : "";
  const date = fact.valid_from
    ? `${dayOnly(fact.valid_from)} → ${fact.valid_to ? dayOnly(fact.valid_to) : "至今"}`
    : (fact.recorded_at ? `记录于 ${dayOnly(fact.recorded_at)}` : "");
  const quote = fact.evidence?.[0]?.quote ? `<div class="fact-quote">${esc(plain(fact.evidence[0].quote))}</div>` : "";
  return `<div class="entity-fact">
    <div class="fact-triple">
      <span class="fact-pred">${esc(fact.predicate)}</span>
      ${object ? `<span class="fact-arrow">→</span><span class="fact-obj">${esc(object)}</span>` : ""}
    </div>
    <div class="fact-meta">
      ${status}
      ${fact.confidence != null ? `<span>置信度 ${esc(fact.confidence)}</span>` : ""}
      ${date ? `<span>${esc(date)}</span>` : ""}
    </div>
    ${quote}
  </div>`;
}

async function loadGraph() {
  try {
    const data = await api("/graph?limit=80");
    state.graph = data;
    setEntitySub();
    drawGraph(state.activeEntity);
  } catch (error) {
    toast(error.message);
  }
}

function graphTextLabel(text, limit) {
  const chars = Array.from(text || "");
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

function graphTextWidth(text) {
  return Array.from(text || "").reduce((width, ch) => width + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 11.2 : 6.4), 0);
}

function splitGraph(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  edges.forEach((edge) => {
    (adjacency.get(edge.source) || []).push(edge.target);
    (adjacency.get(edge.target) || []).push(edge.source);
  });
  const seen = new Set();
  const components = [];
  nodes.forEach((node) => {
    if (seen.has(node.id)) return;
    const stack = [node.id];
    const ids = [];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      ids.push(id);
      (adjacency.get(id) || []).forEach((other) => {
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      });
    }
    const idSet = new Set(ids);
    components.push({
      nodes: ids.map((id) => byId.get(id)),
      edges: edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target)),
    });
  });
  return components.sort((a, b) => b.nodes.length - a.nodes.length || a.nodes[0].name.localeCompare(b.nodes[0].name, "zh"));
}

function localComponent(component, radiusOf, compact) {
  const degree = new Map(component.nodes.map((node) => [node.id, 0]));
  component.edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });
  const hub = component.nodes.reduce((best, node) => (degree.get(node.id) > degree.get(best.id) ? node : best), component.nodes[0]);
  const positions = new Map([[hub.id, { x: 0, y: 0 }]]);
  const others = component.nodes.filter((node) => node.id !== hub.id);
  const radius = compact ? 34 : 48;
  if (others.length === 1) {
    positions.set(others[0].id, { x: radius, y: 0 });
  } else {
    const step = (Math.PI * 2) / Math.max(1, others.length);
    others.forEach((node, index) => {
      const angle = -Math.PI / 2 + index * step;
      positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  component.nodes.forEach((node) => {
    const point = positions.get(node.id);
    const nodeRadius = radiusOf(node);
    minX = Math.min(minX, point.x - nodeRadius);
    maxX = Math.max(maxX, point.x + nodeRadius);
    minY = Math.min(minY, point.y - nodeRadius);
    maxY = Math.max(maxY, point.y + nodeRadius);
  });
  return { positions, minX, maxX, minY, maxY };
}

function graphLayout(nodes, edges, width, height, radiusOf, centerId, compact, gridMode) {
  const components = splitGraph(nodes, edges);
  const selected = components.find((component) => component.nodes.some((node) => node.id === centerId)) || components[0];
  const rest = components.filter((component) => component !== selected);
  const layouts = new Map(components.map((component) => [component, localComponent(component, radiusOf, compact)]));
  const centers = new Map();
  if (gridMode) {
    const ordered = [selected, ...rest];
    const cols = 2;
    const rows = Math.max(1, Math.ceil(ordered.length / cols));
    const cellW = width / cols;
    const cellH = height / rows;
    ordered.forEach((component, index) => {
      centers.set(component, {
        x: cellW * ((index % cols) + 0.5),
        y: cellH * (Math.floor(index / cols) + 0.5),
      });
    });
  } else {
    centers.set(selected, { x: width / 2, y: height / 2 });
    const radiusX = Math.max(70, width / 2 - 108);
    const radiusY = Math.max(60, height / 2 - 100);
    rest.forEach((component, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, rest.length);
      centers.set(component, {
        x: width / 2 + Math.cos(angle) * radiusX,
        y: height / 2 + Math.sin(angle) * radiusY,
      });
    });
  }
  const points = new Map();
  components.forEach((component) => {
    const layout = layouts.get(component);
    const center = centers.get(component);
    const offsetX = center.x - (layout.minX + layout.maxX) / 2;
    const offsetY = center.y - (layout.minY + layout.maxY) / 2;
    component.nodes.forEach((node) => {
      const point = layout.positions.get(node.id);
      points.set(node.id, { id: node.id, node, x: point.x + offsetX, y: point.y + offsetY });
    });
  });
  return points;
}

function drawGraph(centerId) {
  const svg = $("#graph-canvas");
  if (!svg) return;
  const legend = $("#graph-legend");
  const allNodes = state.graph?.nodes || [];
  const allEdges = state.graph?.edges || [];
  const width = Math.max(300, Math.round(svg.clientWidth || 600));
  const height = Math.max(220, Math.round(svg.clientHeight || 460));
  const NS = "http://www.w3.org/2000/svg";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  if (legend) legend.innerHTML = "";
  if (!allNodes.length) {
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", String(width / 2));
    text.setAttribute("y", String(height / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--muted)");
    text.setAttribute("font-size", "12");
    text.textContent = "暂无实体关系";
    svg.appendChild(text);
    return;
  }

  let nodes = allNodes.slice(0, 40);
  if (!nodes.some((node) => node.id === centerId)) {
    const active = allNodes.find((node) => node.id === centerId);
    if (active) nodes = [...nodes.slice(0, 39), active];
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const center = nodes.find((node) => node.id === centerId) || nodes[0];
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });
  const compact = width < 420;
  const gridMode = width < 560;
  const radiusOf = (node) => {
    if (node.id === center.id) return compact ? 19 : 24;
    return (compact ? 8 : 9) + Math.min(compact ? 6 : 8, (degree.get(node.id) || 0) * (compact ? 1.6 : 2));
  };
  const points = graphLayout(nodes, edges, width, height, radiusOf, center.id, compact, gridMode);

  const types = [...new Set(nodes.map((node) => node.type).filter(Boolean))];
  if (legend) {
    legend.innerHTML = types.map((type) => {
      const typeClass = String(type).replace(/[^a-z]/gi, "").toLowerCase();
      return `<span class="graph-legend-item"><i class="graph-mark ${typeClass}"></i>${esc(nodeTypeLabel(type))}</span>`;
    }).join("");
  }

  svg.innerHTML = "";

  edges.forEach((edge) => {
    const a = points.get(edge.source);
    const b = points.get(edge.target);
    if (!a || !b) return;
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    if (distance < radiusOf(source) + radiusOf(target) + 6) return;
    const ux = dx / distance;
    const uy = dy / distance;
    const incident = edge.source === center.id || edge.target === center.id;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(a.x + ux * (radiusOf(source) + 1)));
    line.setAttribute("y1", String(a.y + uy * (radiusOf(source) + 1)));
    line.setAttribute("x2", String(b.x - ux * (radiusOf(target) + 3)));
    line.setAttribute("y2", String(b.y - uy * (radiusOf(target) + 3)));
    line.setAttribute("class", `g-link${incident ? " strong" : ""}${edge.status === "disputed" ? " disputed" : ""}`);
    const title = document.createElementNS(NS, "title");
    title.textContent = `${source.name} — ${edge.label || "关系"} → ${target.name}`;
    line.appendChild(title);
    svg.appendChild(line);
  });

  const labelBoxes = [];
  const nodeLabels = new Map();
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.id === center.id) return -1;
    if (b.id === center.id) return 1;
    return (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
  });
  sortedNodes.forEach((node) => {
    const point = points.get(node.id);
    const limit = node.id === center.id ? (compact ? 8 : 10) : (compact ? 6 : 8);
    const labelText = graphTextLabel(node.name, limit);
    const labelWidth = graphTextWidth(labelText);
    const radius = radiusOf(node);
    const half = labelWidth / 2 + 2;
    const belowY = point.y + radius + 15;
    const aboveY = point.y - radius - 8;
    const sideY = point.y + 4;
    const candidates = [
      { x: point.x, y: belowY, anchor: "middle", box: { x1: point.x - half, x2: point.x + half, y1: belowY - 10, y2: belowY + 4 } },
      { x: point.x, y: aboveY, anchor: "middle", box: { x1: point.x - half, x2: point.x + half, y1: aboveY - 10, y2: aboveY + 4 } },
      { x: point.x + radius + 7, y: sideY, anchor: "start", box: { x1: point.x + radius + 5, x2: point.x + radius + 7 + labelWidth, y1: sideY - 10, y2: sideY + 4 } },
      { x: point.x - radius - 7, y: sideY, anchor: "end", box: { x1: point.x - radius - 7 - labelWidth, x2: point.x - radius - 5, y1: sideY - 10, y2: sideY + 4 } },
      { x: point.x, y: belowY + 14, anchor: "middle", box: { x1: point.x - half, x2: point.x + half, y1: belowY + 4, y2: belowY + 18 } },
      { x: point.x, y: aboveY - 14, anchor: "middle", box: { x1: point.x - half, x2: point.x + half, y1: aboveY - 24, y2: aboveY - 10 } },
    ];
    let label = null;
    for (const candidate of candidates) {
      if (candidate.box.x1 < 6 || candidate.box.x2 > width - 6 || candidate.box.y1 < 6 || candidate.box.y2 > height - 6) continue;
      const hitsLabel = labelBoxes.some((other) => candidate.box.x2 > other.x1 && candidate.box.x1 < other.x2 && candidate.box.y2 > other.y1 && candidate.box.y1 < other.y2);
      const hitsNode = nodes.some((other) => {
        if (other.id === node.id) return false;
        const otherPoint = points.get(other.id);
        const otherRadius = radiusOf(other) + 2;
        return candidate.box.x2 > otherPoint.x - otherRadius && candidate.box.x1 < otherPoint.x + otherRadius && candidate.box.y2 > otherPoint.y - otherRadius && candidate.box.y1 < otherPoint.y + otherRadius;
      });
      if (!hitsLabel && !hitsNode) {
        label = candidate;
        break;
      }
    }
    if (!label) {
      if (node.id !== center.id) return;
      label = candidates[0];
    }
    labelBoxes.push(label.box);
    nodeLabels.set(node.id, { text: labelText, x: label.x, y: label.y, anchor: label.anchor });
  });

  nodes.forEach((node) => {
    const point = points.get(node.id);
    const radius = radiusOf(node);
    const typeClass = String(node.type || "").replace(/[^a-z]/gi, "").toLowerCase();
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", `g-node${node.id === center.id ? " selected" : ""}${typeClass === "literal" ? " literal" : ""}`);
    group.setAttribute("transform", `translate(${point.x},${point.y})`);
    let shape;
    if (typeClass === "org") {
      shape = document.createElementNS(NS, "rect");
      shape.setAttribute("x", String(-radius));
      shape.setAttribute("y", String(-radius));
      shape.setAttribute("width", String(radius * 2));
      shape.setAttribute("height", String(radius * 2));
      shape.setAttribute("rx", "4");
    } else if (typeClass === "literal") {
      shape = document.createElementNS(NS, "path");
      shape.setAttribute("d", `M0,${-radius} L${radius},0 L0,${radius} L${-radius},0 Z`);
    } else {
      shape = document.createElementNS(NS, "circle");
      shape.setAttribute("r", String(radius));
    }
    shape.setAttribute("class", "g-shape");
    group.appendChild(shape);
    const label = nodeLabels.get(node.id);
    if (label) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("text-anchor", label.anchor);
      text.setAttribute("x", String(label.x - point.x));
      text.setAttribute("y", String(label.y - point.y));
      text.textContent = label.text;
      group.appendChild(text);
    }
    const title = document.createElementNS(NS, "title");
    title.textContent = `${node.name} · ${nodeTypeLabel(node.type)}`;
    group.appendChild(title);
    if (node.id !== center.id) {
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `选择实体 ${node.name}`);
      group.addEventListener("click", () => selectEntity(node.id));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectEntity(node.id);
        }
      });
    } else {
      group.style.cursor = "default";
    }
    svg.appendChild(group);
  });

  edges.forEach((edge) => {
    if (!edge.label) return;
    const a = points.get(edge.source);
    const b = points.get(edge.target);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    if (distance < 100) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const textValue = graphTextLabel(edge.label, compact ? 7 : 9);
    const textWidth = graphTextWidth(textValue);
    const box = { x1: mx - textWidth / 2 - 5, x2: mx + textWidth / 2 + 5, y1: my - 9, y2: my + 4 };
    const hitsLabel = labelBoxes.some((other) => box.x2 > other.x1 && box.x1 < other.x2 && box.y2 > other.y1 && box.y1 < other.y2);
    const hitsNode = nodes.some((node) => {
      const point = points.get(node.id);
      const nodeRadius = radiusOf(node) + 4;
      return box.x2 > point.x - nodeRadius && box.x1 < point.x + nodeRadius && box.y2 > point.y - nodeRadius && box.y1 < point.y + nodeRadius;
    });
    if (hitsLabel || hitsNode) return;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("pointer-events", "none");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("class", "g-edge-bg");
    bg.setAttribute("x", String(box.x1));
    bg.setAttribute("y", String(box.y1));
    bg.setAttribute("width", String(box.x2 - box.x1));
    bg.setAttribute("height", String(box.y2 - box.y1));
    bg.setAttribute("rx", "2");
    group.appendChild(bg);
    const text = document.createElementNS(NS, "text");
    text.setAttribute("class", "g-edge-label");
    text.setAttribute("x", String(mx));
    text.setAttribute("y", String(my));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = textValue;
    group.appendChild(text);
    svg.appendChild(group);
  });
}

let graphResizeTimer = 0;
window.addEventListener("resize", () => {
  if (document.body.dataset.page !== "entities") return;
  window.clearTimeout(graphResizeTimer);
  graphResizeTimer = window.setTimeout(() => drawGraph(state.activeEntity), 180);
});

/* ============ Review ============ */
async function loadReview() {
  const target = $("#review-list");
  target.innerHTML = loadingLines();
  try {
    const data = await api("/review?status=open");
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
          ${item.kind === 'parse_failure' ? `<button class="btn primary" data-review-job="${esc(item.payload?.job_id)}">修正文并重试</button>` : `
          <button class="btn primary" data-review="${esc(item.id)}" data-action="accept_new">采纳本次</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="reject_new">保留既有</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="merge">合并证据</button>
          <button class="btn" data-review="${esc(item.id)}" data-action="dispute">维持争议</button>`}
        </div>
      </article>`).join("");
    $$("[data-review]").forEach((button) => {
      button.addEventListener("click", () => resolveReview(button.dataset.review, button.dataset.action, button));
    });
    $$("[data-review-job]").forEach(button => button.addEventListener('click',async()=>{
      const corrected_text=prompt('输入人工核对后的文档正文：');
      if (!corrected_text?.trim()) return;
      setBusy(button,true,'提交中');
      try { trackIngestJob(await api(`/documents/jobs/${encodeURIComponent(button.dataset.reviewJob)}/retry`,{method:'POST',body:{corrected_text,stage:'index'}}));toast('修正文已提交，入库成功后自动关闭待审项'); }
      catch(error){toast(error.message);}
      finally{setBusy(button,false);}
    }));
  } catch (error) {
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
              <td>${esc(featureLabel(trace.feature))}</td>
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
    $("#trace-dialog-title").textContent = `轨迹 · ${featureLabel(trace.feature)}`;
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
            <div class="fact-line">${esc(runtimeText(span.stage))} <span class="pred">${num(span.latency_ms)} ms · ${esc(runtimeText(span.status))}</span></div>
            <div class="fact-quote">${esc(runtimeText(JSON.stringify(span.output || {})).slice(0, 280))}</div>
          </div>`).join("") || `<div class="empty-block">暂无阶段</div>`}
      </div>
      <div class="section">
        <h3>成本</h3>
        ${data.usage.length ? data.usage.map((row) => `
          <div class="version-row">
            <span>${esc(modelLabel(row.model))}</span>
            <span class="meta">${num(row.tokens_in)} / ${num(row.tokens_out)} tokens · ${money(row.amount)}</span>
          </div>`).join("") : `<span class="muted small">无模型调用</span>`}
      </div>
      <div class="detail-actions">
        <button class="btn primary" data-replay="${esc(trace.id)}">回放检索阶段</button>
      </div>
      <div id="replay-result"></div>
      <div class="section">
        <h3>Meta</h3>
        <pre class="code">${esc(runtimeText(JSON.stringify(trace.meta || {}, null, 2)))}</pre>
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
              <span class="rank-label">${esc(featureLabel(key))}</span>
              <div class="rank-track"><div class="rank-fill" style="width:${(value.amount / maxAmount) * 100}%"></div></div>
              <span class="rank-value">${money(value.amount)}</span>
            </div>`).join("") || `<div class="empty-block">暂无成本记录</div>`}
        </div>
      </section>
      <div class="table-wrap" style="margin-top:16px">
        <table class="table">
          <thead><tr><th scope="col">模型</th><th scope="col" class="num">调用</th><th scope="col" class="num">金额</th></tr></thead>
          <tbody>${models.map(([key, value]) => `
            <tr><td>${esc(modelLabel(key))}</td><td class="num">${num(value.calls)}</td><td class="num">${money(value.amount)}</td></tr>`).join("") || `<tr><td colspan="3"><div class="empty-block">暂无模型调用</div></td></tr>`}</tbody>
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
    $("#ops-body").innerHTML = `<section class="block">
      <div class="block-head" style="margin-bottom:10px">
        <h2>评测集</h2>
        <button class="btn" id="import-eval">导入用例</button><button class="btn primary" id="run-eval">运行评测</button>
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
              <td>${String(item.source || "").startsWith("failure-candidate:") ? `<button class="text-btn" data-approve-case="${esc(item.id)}">校对并批准</button>` : ""}${item.should_refuse ? `<span class="pill warn">应拒答</span>` : `<span class="pill ok">应回答</span>`}</td>
            </tr>`).join("") || `<tr><td colspan="4"><div class="empty-block">暂无评测题</div></td></tr>`}</tbody>
        </table>
      </div>
    </section>`;
    $("#run-eval").addEventListener("click", runEvals);
    $("#import-eval").addEventListener("click", async () => {
      const text = prompt("粘贴评测用例JSON数组（question、expected_docs、expected_keywords、should_refuse）：");
      if (!text) return;
      try { const payload = JSON.parse(text); await api("/evals/cases", {method:"POST",body:{cases:Array.isArray(payload)?payload:payload.cases}}); await loadEvals(); }
      catch(error) { toast(error.message); }
    });
    $$("[data-approve-case]", $("#ops-body")).forEach(button => button.addEventListener("click", async () => {
      const item = data.items.find(row => row.id === button.dataset.approveCase);
      const text = prompt("请核对预期结果后再批准。自动收集的失败题尚未进入黄金集：", JSON.stringify({expected_docs:item.expected_docs,expected_keywords:item.expected_keywords,should_refuse:item.should_refuse}));
      if(!text)return;
      try { await api(`/evals/cases/${encodeURIComponent(item.id)}`,{method:"PATCH",body:JSON.parse(text)});await api(`/evals/cases/${encodeURIComponent(item.id)}/approve`,{method:"POST"});await loadEvals(); }
      catch(error) { toast(error.message); }
    }));
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
        <div class="metric"><span class="metric-label">Recall@10</span><div class="metric-value">${pct(metrics.doc_recall)}</div></div>
        <div class="metric"><span class="metric-label">关键词召回</span><div class="metric-value">${pct(metrics.keyword_recall)}</div></div>
        <div class="metric"><span class="metric-label">拒答准确率</span><div class="metric-value">${pct(metrics.refusal_accuracy)}</div></div>
        <div class="metric"><span class="metric-label">整体通过</span><div class="metric-value">${pct(metrics.pass_rate)}</div></div>
      </div>
      <div class="metrics">
        <div class="metric"><span class="metric-label">上下文精度</span><div class="metric-value">${metrics.context_precision == null ? "—" : pct(metrics.context_precision)}</div></div>
        <div class="metric"><span class="metric-label">引用原文匹配</span><div class="metric-value">${metrics.citation_accuracy == null ? "—" : pct(metrics.citation_accuracy)}</div></div>
        <div class="metric"><span class="metric-label">规则覆盖</span><div class="metric-value">${metrics.rule_groundedness == null ? "—" : pct(metrics.rule_groundedness)}</div></div>
        <div class="metric"><span class="metric-label">P95耗时</span><div class="metric-value">${latencyLabel(metrics.p95_latency_ms)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th scope="col">问题</th><th scope="col" class="num">Top score</th><th scope="col">拒答</th><th scope="col">结果</th></tr></thead>
          <tbody>${data.results.map((result) => `
            <tr>
              <td>${esc(result.question)}</td>
              <td class="num">${Number(result.top_score ?? 0).toFixed(3)}</td>
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
    $("#settings-prices").innerHTML = data.items.map((price) => `
      <tr>
        <td><strong style="font-weight:500">${esc(modelLabel(price.model))}</strong> <span class="muted small">${esc(runtimeText(price.provider))}</span></td>
        <td class="num">¥${Number(price.input_per_1m).toFixed(2)}</td>
        <td class="num">¥${Number(price.output_per_1m).toFixed(2)}</td>
        <td class="date">${esc(price.effective_from)}</td>
      </tr>`).join("") || `<tr><td colspan="4"><div class="empty-block">暂无单价</div></td></tr>`;
  } catch (_) { /* ignore */ }
  $("#settings-mcp").textContent = `curl -s -X POST ${location.origin}/api/v1/mcp \\
  -H "Authorization: Bearer ${state.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"kb_ask","arguments":{"question":"知识库的架构约束是什么？"}}}'`;
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
    state.chatEvidence = null;
    state.chatFilter = "";
    $("#chat-filter").value = "";
    $("#chat-list").innerHTML = "";
    renderChatThread();
    $("#ask-result").innerHTML = askEmptyHtml();
    $(".ask-layout").classList.add("is-empty");
    $("#evidence-gate").innerHTML = "";
    $("#evidence-body").innerHTML = `<div class="rail-empty">暂无证据</div>`;
    $("#evidence-count").textContent = "";
    $("#conversation-list").innerHTML = "";
    $("#conversation-list").hidden = true;
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
  $("#runtime-refresh").addEventListener("click", async () => {
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
