const API = "/api/v1";

const state = {
  token: localStorage.getItem("kw_token") || "owner-token",
  meta: null,
  me: null,
  page: "chat",
  mode: "quick",
  tourIndex: 0,
  tourReturnPage: null,
  source: "",
  docs: [],
  document: null,
  stats: null,
  conversations: [],
  showArchivedConversations: false,
  entities: [],
  graph: { nodes: [], edges: [] },
  graphScope: "local",
  graphHops: 2,
  graphOverviewZoom: false,
  activeEntity: null,
  entityView: localStorage.getItem("kw_entity_view") === "graph" ? "graph" : "entity",
  libraryView: localStorage.getItem("kw_library_view") === "stack" ? "stack" : "flat",
  entityRail: localStorage.getItem("kw_entity_rail") === "shown",
  opsTab: "traces",
  harness: null,
  ingestFiles: [],
  ingestDocumentId: null,
  aclOptions: null,
  jobs: [],
  lastAsk: null,
  conversationId: null,
};

const PAGE_PATHS = {
  chat: "/",
  dashboard: "/dashboard",
  library: "/library",
  ask: "/ask",
  entities: "/entities",
  review: "/review",
  ops: "/ops",
  settings: "/settings",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
let accountPicker, entityTypePicker;


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
  doc: "DOC",
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
  fact_validation: "事实待核",
  acl_conflict: "权限冲突",
  low_quality: "低质量",
  duplicate: "重复文档",
  parse_failure: "解析失败",
  memory_promotion: "记忆晋升",
};

function plain(value) {
  return String(value ?? "").replace(/[#*_`>]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 把主谓宾拼成一句能直接读的话，去掉中文与数字之间因分词留下的空格。 */
function factSentence(subject, predicate, object) {
  const tidy = (value) => String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "")
    .replace(/(?<=\d)\s+(?=[\u4e00-\u9fa5])/g, "")
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=\d)/g, "")
    .trim();
  const glue = (left, right) => {
    if (!left) return right;
    if (!right) return left;
    return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : `${left}${right}`;
  };
  return glue(glue(tidy(subject), tidy(predicate)), tidy(object));
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

// 进度用的时长：不足一分钟给秒，其余给 m+补零的秒
function elapsedText(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${minutes}分`;
}

// 抽取进度：批次是底数，实际发出的请求数是进度（事前无法算出准确请求数）
function extractionStage(task) {
  if (task.status === "failed") return "抽取失败";
  if (task.status !== "running") return "等待抽取";
  const progress = task.progress;
  if (!progress) return "抽取中";
  const parts = ["抽取中"];
  if (progress.batches_total) parts.push(`${num(progress.batches_done)}/${num(progress.batches_total)} 批`);
  if (progress.requests) parts.push(`${num(progress.requests)} 次请求`);
  if (progress.elapsed_ms) parts.push(elapsedText(progress.elapsed_ms));
  return parts.join(" · ");
}

function extractionPercent(task) {
  const progress = task.progress;
  if (task.status !== "running" || !progress?.batches_total) return null;
  const ratio = Number(progress.batches_done || 0) / Number(progress.batches_total);
  return Math.min(100, Math.max(3, Math.round(ratio * 100)));
}

function money(value) {
  const amount = Number(value || 0);
  return amount < 0.01 && amount > 0 ? `¥${amount.toFixed(5)}` : `¥${amount.toFixed(2)}`;
}

function shortDate(value, { year } = {}) {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { year, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
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
function toast(message, { centered = false } = {}) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = runtimeText(message);
  el.classList.toggle("is-centered", centered);
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

async function api(path, { responseType, ...options } = {}) {
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
  if (responseType === "blob") return response.blob();
  return response.json();
}

function loadingLines() {
  return `<div class="loading-block"><i></i><i></i><i></i></div>`;
}

/* ============ Shell ============ */
function pageFromUrl(url) {
  if (url.pathname === "/") {
    const fragmentPage = url.hash.slice(1);
    if (Object.hasOwn(PAGE_PATHS, fragmentPage)) return fragmentPage;
    const queryPage = url.searchParams.get("page");
    if (Object.hasOwn(PAGE_PATHS, queryPage)) return queryPage;
  }
  return Object.keys(PAGE_PATHS).find((page) => PAGE_PATHS[page] === url.pathname) ?? "chat";
}

function documentFromUrl(url) {
  const match = /^\/library\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  try {
    return {
      doc_id: decodeURIComponent(match[1]),
      version_id: url.searchParams.get("version_id"),
      chunk_id: url.searchParams.get("chunk_id"),
    };
  } catch {
    return null;
  }
}

function documentPagePath(docId) {
  return `${PAGE_PATHS.library}/${encodeURIComponent(docId)}`;
}

function pageUrl(page, detail) {
  const url = new URL(location.href);
  if (detail || documentFromUrl(url)) {
    for (const key of ["version_id", "chunk_id"]) {
      if (detail?.[key]) url.searchParams.set(key, detail[key]);
      else url.searchParams.delete(key);
    }
  }
  url.pathname = detail ? documentPagePath(detail.doc_id) : PAGE_PATHS[page];
  url.searchParams.delete("page");
  url.hash = "";
  return url;
}

function navigateToPage(page, detail = null) {
  const url = pageUrl(page, detail);
  const excerpt = detail ? { quote: detail.quote, spans: detail.spans } : null;
  if (url.href !== location.href) history.pushState(excerpt, "", url);
  else if (detail) history.replaceState(excerpt, "", url);
  return showPage(page, detail);
}

function restorePageFromUrl() {
  const currentUrl = new URL(location.href);
  const params = documentFromUrl(currentUrl);
  const page = params ? "document" : pageFromUrl(currentUrl);
  const detail = params ? { ...history.state, ...params } : null;
  const url = pageUrl(page, detail);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  return showPage(page, detail);
}

function showPage(page, detail = null) {
  if (hoverTooltipTarget) hideHoverTooltip();
  if (state.page === "chat" && page !== "chat") closeChatCitation();
  if (state.page === "document") closeDocumentFile();
  state.page = page;
  state.document = detail;
  document.body.dataset.page = page;
  const navPage = detail ? "library" : page;
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.page === navPage;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $("#sheet").scrollTop = 0;
  closeSidebar();
  return loadPage(page);
}

function loadPage(page) {
  if (page === "chat") resumeNativeChat();
  if (page === "dashboard") loadDashboard();
  if (page === "library") { loadDocs(); loadIngestJobs(); }
  if (page === "document") return loadDocument(state.document);
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
    const identity = { value: state.token, label: `${state.me.name} · ${state.me.role}` };
    accountPicker.setOptions(state.token === "owner-token" ? [identity] : [identity, ownerIdentity], state.token);
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
  applyModeHints();
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
  applyReviewCount(reviews);

  const trashed = Number(stats.documents_trashed || 0);
  const trashButton = $("#open-trash");
  if (trashButton && !trashButton.dataset.label) trashButton.textContent = `回收站${trashed ? ` (${num(trashed)})` : ""}`;

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
let activeExtractions = new Set();
let extractionRetrying = false;

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
  const inLibrary = () => state.page === "library" || state.page === "document";
  if (!inLibrary()) {
    stopJobPoll();
    return;
  }
  const token = state.token;
  const [ingest, extraction] = await Promise.allSettled([api("/documents/jobs"), api("/documents/extractions")]);
  if (!inLibrary() || state.token !== token) return;
  let refreshDetail = false;
  if (ingest.status === "fulfilled") {
    state.jobs = ingest.value.items;
    renderIngestJobs();
    const current = new Map(state.jobs.map((job) => [job.job_id, job.status]));
    if (jobStatusCache) {
      current.forEach((status, id) => {
        const previous = jobStatusCache.get(id);
        if (previous !== status && status === "awaiting_duplicate") {
          const job = state.jobs.find((item) => item.job_id === id);
          toast(`发现重复文档：${job.title}`);
        }
        if (previous !== status && (status === "done" || status === "failed")) {
          const job = state.jobs.find((item) => item.job_id === id);
          if (!job) return;
          if (status === "done") {
            if (job.error) toast(`文档已入库，${job.error}`);
            else toast(job.duplicate ? "内容与已有版本相同，未重复入库" : `已接入 ${num(job.chunks)} 个检索单元 · v${job.version}`);
            loadDocs();
            loadDashboard();
            if (state.document && state.document.doc_id === job.doc_id) refreshDetail = true;
          } else {
            toast(`处理失败：${job.error || "未知错误"}`);
          }
        }
      });
    }
    jobStatusCache = current;
  }
  if (extraction.status === "fulfilled") {
    const extractions = extraction.value;
    const nextActive = new Set(extractions.items.filter(task => task.status !== "failed").map(task => task.id));
    if ([...activeExtractions].some(id => !nextActive.has(id))) loadDocs();
    const docId = state.document?.doc_id;
    if (activeExtractions.has(docId) && !nextActive.has(docId)) refreshDetail = true;
    activeExtractions = nextActive;
    renderExtractionJobs(extractions);
  } else {
    const box = $("#extraction-jobs");
    if (box) {
      box.hidden = false;
      box.textContent = `无法加载抽取任务：${extraction.reason.message}`;
    }
  }
  const hasActive = activeExtractions.size || state.jobs.some((job) => job.status === "pending" || job.status === "running");
  const transient = [ingest, extraction].some(result => result.status === "rejected" && (!result.reason.status || result.reason.status >= 500));
  if (hasActive || transient) scheduleJobPoll();
  else stopJobPoll();
  if (refreshDetail) refreshDocument(state.document);
}

function renderExtractionJobs({ items, can_retry }) {
  const box = $("#extraction-jobs");
  if (!box) return;
  box.hidden = !items.length;
  const failures = items.filter(task => task.status === "failed");
  box.innerHTML = items.length ? `
    <div class="toolbar">
      <strong>事实与实体抽取</strong>
      ${can_retry && failures.length ? `<button class="btn sm" data-extraction-retry="" ${extractionRetrying ? "disabled" : ""}>重试全部失败项（${num(failures.length)}）</button>` : ""}
    </div>
    ${items.map(task => {
      const percent = extractionPercent(task);
      const eta = task.status === "running" && task.progress?.eta_ms
        ? `<p class="muted small">按当前批次速度预计还需 ${elapsedText(task.progress.eta_ms)}</p>` : "";
      return `
      <div class="job-card${task.status === "failed" ? " failed" : ""}">
        <div class="job-line"><strong class="job-title">${esc(task.title)} · v${num(task.version)}</strong>
          <span class="job-stage">${esc(extractionStage(task))}</span>
        </div>
        ${task.status === "failed" ? `<p class="muted small">${esc(task.error || "上次抽取失败，可重试。")}</p>
          ${can_retry ? `<button class="text-btn" data-extraction-retry="${esc(task.id)}" ${extractionRetrying ? "disabled" : ""}>重试抽取</button>
            <button class="text-btn" data-extraction-reset="${esc(task.id)}" ${extractionRetrying ? "disabled" : ""} data-hover-tip="丢掉已有断点，从第一批重新抽取：更慢，但结果完全重算">从头重抽</button>` : ""}` : ""}
        ${percent === null ? "" : `<div class="job-progress"><i style="width:${percent}%"></i></div>`}
        ${task.status === "running" ? eta : ""}
      </div>`;
    }).join("")}` : "";
  $$("[data-extraction-retry], [data-extraction-reset]", box).forEach(button => button.addEventListener("click", async () => {
    if (extractionRetrying) return;
    extractionRetrying = true;
    // data-extraction-reset 存在时表示从头重抽：丢掉检查点，不续跑
    const reset = button.dataset.extractionReset !== undefined;
    const id = reset ? button.dataset.extractionReset : button.dataset.extractionRetry;
    renderExtractionJobs({ items, can_retry });
    try {
      const result = await api("/documents/extractions/retry", {
        method: "POST", body: id ? { document_ids: [id], reset } : { reset },
      });
      toast(result.queued
        ? `已提交 ${num(result.queued)} 项抽取${reset ? "从头重抽" : "重试"}`
        : "没有可重试的失败项");
    } catch (error) { toast(error.message); }
    finally {
      extractionRetrying = false;
      await loadIngestJobs();
    }
  }));
}

function renderIngestJobs() {
  const box = $("#ingest-jobs");
  if (!box) return;
  const jobs = state.jobs.filter((job) => ["pending", "running", "failed", "awaiting_duplicate"].includes(job.status));
  box.hidden = !jobs.length;
  if (!jobs.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = jobs.map((job) => {
    if (job.status === "awaiting_duplicate") {
      return `<div class="job-card">
        <div class="job-line">
          <span class="job-title">${esc(job.title)}</span>
          <span class="job-stage">发现重复文档</span>
        </div>
        <p class="muted small">${esc(job.message)}</p>
        <div class="job-actions">
          <button type="button" class="btn sm" data-duplicate-job="${esc(job.job_id)}" data-decision="continue">继续导入</button>
          <button type="button" class="btn sm" data-duplicate-job="${esc(job.job_id)}" data-decision="skip">跳过重复文档</button>
        </div>
      </div>`;
    }
    const failed = job.status === "failed";
    const percent = failed ? 100 : Math.max(3, Number(job.percent) || 3);
    const stage = runtimeText(failed ? job.error || "处理失败" : job.stage || "排队中");
    return `
      <div class="job-card${failed ? " failed" : ""}">
        <div class="job-line">
          <span class="job-title">${esc(job.title)}</span>
          <span class="job-stage" data-hover-tip="${esc(stage)}">${esc(stage)}</span>
          <span class="job-percent">${failed ? "失败" : `${percent}%`}</span>
        </div>
        ${failed ? `<div class="job-actions"><button class="text-btn" data-retry-job="${esc(job.job_id)}">重试入库</button><button class="text-btn" data-correct-job="${esc(job.job_id)}">人工修正文</button></div>` : ""}
        <div class="job-progress"><i style="width:${percent}%"></i></div>
      </div>`;
  }).join("");
  box.querySelectorAll("[data-duplicate-job]").forEach((button) => {
    button.addEventListener("click", async () => {
      const { duplicateJob: id, decision } = button.dataset;
      const buttons = button.parentElement.querySelectorAll("button");
      buttons.forEach((choice) => { choice.disabled = true; });
      try {
        const job = await api(`/documents/jobs/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: { action: decision } });
        trackIngestJob(job);
        toast(decision === "skip" ? "已跳过重复文档" : "已提交，继续导入");
      } catch (error) {
        toast(error.message);
        if (error.status === 409) await loadIngestJobs();
      } finally {
        buttons.forEach((choice) => { choice.disabled = false; });
      }
    });
  });
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
  // 沿革堆叠要先拿到整条链再按筛选收窄，所以筛选在前端做：
  // 服务端只按标题搜会把链上的其他文档挡在列表外，堆叠就断了。
  if (state.libraryView !== "stack") {
    if (q) params.set("q", q);
    if (state.source) params.set("source_type", state.source);
  }
  try {
    const data = await api(`/documents?${params}`);
    state.docs = data.items;
    renderDocs();
  } catch (error) {
    toast(error.message);
  }
}

function continuationStatus(doc) {
  const continuation = doc.continuation;
  if (!continuation) return { label: doc.status === "active" ? "现行" : "非现行", tone: doc.status === "active" ? "ok" : "warn" };
  if (continuation.role === "predecessor") {
    return continuation.in_force
      ? { label: "有后续", tone: "" }
      : { label: "已被延续", tone: "warn" };
  }
  return continuation.in_force
    ? { label: "延续生效", tone: "info" }
    : { label: `待生效 ${shortDate(continuation.effective_date)}`, tone: "warn" };
}

function continuationBadge(doc) {
  const status = continuationStatus(doc);
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`;
}

function docRowHtml(doc, { attributes = "", titleExtra = "" } = {}) {
  return `
    <tr data-doc="${esc(doc.id)}"${attributes}>
      <td>
        <div class="cell-title">
          <div class="doc-title-line">
            <strong><a href="${esc(documentPagePath(doc.id))}">${esc(doc.title)}</a></strong>
            ${doc.continuation ? continuationBadge(doc) : ""}
            ${titleExtra}
          </div>
          <span>${esc(plain(doc.summary) || "无")}</span>
          <span class="cell-inline">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)} · ${num(doc.chunks)} 个检索单元 · ${shortDate(doc.updated_at)}</span>
        </div>
      </td>
      <td class="type">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)}</td>
      <td class="num">${num(doc.chunks)}</td>
      <td><span class="pill ${doc.acl_label === "全员可见" ? "" : "warn"}">${esc(doc.acl_label)}</span></td>
      <td class="ver">v${esc(doc.version)}</td>
      <td class="date">${shortDate(doc.updated_at)}</td>
    </tr>`;
}

/**
 * 把已加载的文档按延续关系还原成沿革链。每个文档最多一前一后，
 * 所以从链首顺着 continuation.successor_doc_id 走就能得到时间顺序；
 * 相邻文档不在本次列表里时（超过一页或无法阅读）就各自成链，不猜测缺失的一代。
 */
function docStacks(docs) {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const next = new Map();
  const previous = new Map();
  for (const doc of docs) {
    const continuation = doc.continuation;
    if (!continuation) continue;
    const successor = continuation.successor_doc_id;
    const predecessor = continuation.predecessor_doc_id;
    if (successor && successor !== doc.id && byId.has(successor)) {
      next.set(doc.id, successor);
      previous.set(successor, doc.id);
    }
    if (predecessor && predecessor !== doc.id && byId.has(predecessor)) {
      previous.set(doc.id, predecessor);
      next.set(predecessor, doc.id);
    }
  }
  const stacks = [];
  const placed = new Set();
  for (const doc of docs) {
    if (placed.has(doc.id)) continue;
    let head = doc.id;
    const walked = new Set([head]);
    while (previous.has(head) && !walked.has(previous.get(head))) {
      head = previous.get(head);
      walked.add(head);
    }
    const chain = [];
    const seen = new Set();
    let cursor = head;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(byId.get(cursor));
      cursor = next.get(cursor);
    }
    chain.forEach((item) => placed.add(item.id));
    stacks.push({ key: head, docs: chain });
  }
  const newest = (chain) => chain.reduce((at, doc) => Math.max(at, new Date(doc.updated_at).getTime() || 0), 0);
  return stacks.sort((a, b) => newest(b.docs) - newest(a.docs));
}

const expandedDocStacks = new Set();

function toggleDocStack(button) {
  const key = button.dataset.stackToggle;
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = panel.hidden;
  if (expanded) expandedDocStacks.add(key);
  else expandedDocStacks.delete(key);
  panel.hidden = !expanded;
  button.setAttribute("aria-expanded", String(expanded));
  button.querySelector("[data-stack-label]").textContent = expanded ? "收起沿革" : "展开沿革";
}

function docMatchesFilter(doc, query, source) {
  if (source && doc.source_type !== source) return false;
  if (!query) return true;
  return String(doc.title ?? "").toLowerCase().includes(query.toLowerCase());
}

function docStackHistory(docs, panelId, expanded) {
  return `
    <tr class="doc-stack-history" id="${panelId}"${expanded ? "" : " hidden"}>
      <td colspan="6">
        <div class="doc-stack-panel">
          <div class="doc-stack-panel-head"><strong id="${panelId}-heading">文档沿革</strong><span>按延续顺序</span></div>
          <ol class="doc-stack-timeline" role="list" aria-labelledby="${panelId}-heading">
            ${docs.map((doc) => {
              const summary = plain(doc.summary);
              return `<li>
                <a class="doc-stack-card" data-doc="${esc(doc.id)}" href="${esc(documentPagePath(doc.id))}">
                  <span class="doc-stack-card-main">
                    <span class="doc-stack-card-title"><strong>${esc(doc.title)}</strong>${continuationBadge(doc)}</span>
                    ${summary ? `<span class="doc-stack-card-summary">${esc(summary)}</span>` : ""}
                    <span class="doc-stack-card-meta">
                      <span>${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)}</span>
                      <span>v${esc(doc.version)}</span>
                      <span>${num(doc.chunks)} 个检索单元</span>
                      <span>${esc(doc.acl_label)}</span>
                    </span>
                  </span>
                  ${doc.updated_at ? `<span class="doc-stack-card-date">更新于 <time datetime="${esc(doc.updated_at)}">${esc(shortDate(doc.updated_at, { year: "numeric" }))}</time></span>` : ""}
                  <span class="doc-stack-card-arrow" aria-hidden="true"></span>
                </a>
              </li>`;
            }).join("")}
          </ol>
        </div>
      </td>
    </tr>`;
}

/** 沿革堆叠：每条链只留当前生效的一篇，被延续的收在它下面，点开才显示。 */
function docStackRows() {
  const query = docQuery();
  const stacks = docStacks(state.docs)
    .filter((stack) => stack.docs.some((doc) => docMatchesFilter(doc, query, state.source)));
  const rows = [];
  let current = 0;
  let folded = 0;
  for (const stack of stacks) {
    const index = stack.docs.findIndex((doc) => doc.in_force);
    const active = stack.docs[index >= 0 ? index : stack.docs.length - 1];
    const rest = stack.docs.filter((doc) => doc !== active);
    current += 1;
    folded += rest.length;
    if (!rest.length) {
      rows.push(docRowHtml(active));
      continue;
    }
    const key = esc(stack.key);
    const panelId = `doc-stack-${esc(encodeURIComponent(stack.key))}`;
    const expanded = expandedDocStacks.has(stack.key);
    const toggle = `<button class="doc-stack-toggle" type="button" data-stack-toggle="${key}" aria-expanded="${expanded}" aria-controls="${panelId}">
      <span data-stack-label>${expanded ? "收起沿革" : "展开沿革"}</span><span class="doc-stack-count">${num(rest.length)} 篇</span><span class="doc-stack-chevron" aria-hidden="true"></span>
    </button>`;
    rows.push(docRowHtml(active, { attributes: ` data-stack-head="${key}"`, titleExtra: toggle }));
    rows.push(docStackHistory(rest, panelId, expanded));
  }
  return { rows, current, folded };
}

function renderDocs() {
  const target = $("#doc-table-body");
  const empty = $("#doc-empty");
  const stacked = state.libraryView === "stack" ? docStackRows() : null;
  const rows = stacked ? stacked.rows : state.docs.map((doc) => docRowHtml(doc));
  empty.hidden = Boolean(rows.length);
  empty.textContent = stacked ? "当前筛选下没有现行文档" : "暂无文档";
  $("#doc-count").textContent = stacked
    ? `${num(stacked.current)} 篇现行${stacked.folded ? ` · ${num(stacked.folded)} 篇沿革` : ""}`
    : `${num(state.docs.length)} 篇`;
  if (!rows.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = rows.join("");
  $$("#doc-table-body [data-stack-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDocStack(button);
    });
  });
  $$("#doc-table-body [data-doc]").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDoc(item.dataset.doc);
    });
  });
}

function applyLibraryViewUI() {
  $$("#doc-view [data-view]").forEach((button) => {
    const active = (button.dataset.view === "stack") === (state.libraryView === "stack");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function setupLibraryView() {
  applyLibraryViewUI();
  $$("#doc-view [data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      const view = button.dataset.view === "stack" ? "stack" : "flat";
      if (state.libraryView === view) return;
      state.libraryView = view;
      localStorage.setItem("kw_library_view", view);
      applyLibraryViewUI();
      await loadDocs();
    });
  });
}

/* ============ 回收站 ============ */
async function openTrash() {
  const dialog = $("#trash-dialog");
  $("#trash-list").innerHTML = `<div class="empty-block">加载中</div>`;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  await loadTrash();
}

async function loadTrash() {
  try {
    renderTrash(await api("/documents/trash"));
  } catch (error) {
    $("#trash-list").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

function renderTrash(data) {
  const retention = Number(data.retention_days || 0);
  $("#trash-note").textContent = retention > 0
    ? `回收站只保留文档本体（原文与版本），检索索引、事实与实体已清理，恢复时重新生成；超过 ${retention} 天的文档会被自动彻底删除。`
    : "回收站只保留文档本体（原文与版本），检索索引、事实与实体已清理，恢复时重新生成；当前未设置自动清除，需要手动彻底删除。";
  const items = data.items || [];
  if (!items.length) {
    $("#trash-list").innerHTML = `<div class="empty-block">回收站为空</div>`;
    return;
  }
  $("#trash-list").innerHTML = items.map((doc) => `
    <div class="trash-row">
      <div class="trash-main">
        <strong>${esc(doc.title)}</strong>
        <span class="trash-meta">${esc(SOURCE_LABEL[doc.source_type] || doc.source_type)} · v${esc(doc.version)} · 移入于 ${esc(shortDate(doc.deleted_at))}${doc.expires_at ? ` · ${esc(shortDate(doc.expires_at))} 自动清除` : ""}</span>
      </div>
      ${data.can_manage ? `<div class="trash-actions">
        <button class="btn" type="button" data-trash-restore="${esc(doc.id)}">恢复</button>
        <button class="btn danger" type="button" data-trash-purge="${esc(doc.id)}" data-trash-title="${esc(doc.title)}">彻底删除</button>
      </div>` : ""}
    </div>`).join("");
  $$("#trash-list [data-trash-restore]").forEach((button) => {
    button.addEventListener("click", () => restoreTrashedDocument(button.dataset.trashRestore, button));
  });
  $$("#trash-list [data-trash-purge]").forEach((button) => {
    button.addEventListener("click", () => purgeTrashedDocument(button.dataset.trashPurge, button.dataset.trashTitle, button));
  });
}

async function restoreTrashedDocument(docId, button) {
  setBusy(button, true, "恢复中");
  try {
    const result = await api(`/documents/${docId}/restore`, { method: "POST" });
    toast(result.message || "文档已恢复");
    await loadTrash();
    loadDocs();
    loadDashboard();
  } catch (error) {
    toast(error.message);
    setBusy(button, false);
  }
}

async function purgeTrashedDocument(docId, title, button) {
  if (!confirm(`彻底删除《${title}》？原始文件、版本、检索索引与派生事实都会被永久清除，无法恢复。`)) return;
  setBusy(button, true, "删除中");
  try {
    const result = await api(`/documents/${docId}/permanent`, { method: "DELETE" });
    toast(`已彻底删除（移除 ${num(result.removed_facts)} 条事实）`);
    await loadTrash();
    loadDocs();
    loadDashboard();
  } catch (error) {
    toast(error.message);
    setBusy(button, false);
  }
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

function sourceHtml(text, ranges = [], targetId = "source-highlight-target") {
  const source = String(text ?? "");
  let cursor = 0;
  const output = [];
  ranges.forEach(([start, end], index) => {
    output.push(esc(source.slice(cursor, start)));
    output.push(`<mark class="source-highlight"${index === 0 ? ` id="${esc(targetId)}" tabindex="-1"` : ""}>${esc(source.slice(start, end))}</mark>`);
    cursor = end;
  });
  output.push(esc(source.slice(cursor)));
  return output.join("");
}

function openCitation(citation) {
  if (citation?.doc_id) return openDoc(citation.doc_id, citation);
}

let docOpenRequest = 0;
let documentFile = null;

function closeDocumentFile() {
  if (!documentFile) return;
  documentFile.controller.abort();
  releasePdf(documentFile);
  documentFile.download.onclick = null;
  documentFile.download.disabled = false;
  documentFile = null;
}

function openDocumentFile(file, path, body, download) {
  const controller = new AbortController();
  const token = state.token;
  const preview = documentFile = {
    controller, path, download, data: {}, isCurrent: () => documentFile === preview && state.token === token,
  };
  download.onclick = async () => {
    download.disabled = true;
    try {
      const blob = await api(`${path}&format=original`, { signal: controller.signal, responseType: "blob" });
      if (!preview.isCurrent()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (preview.isCurrent()) toast(error.message);
    } finally {
      if (preview.isCurrent()) download.disabled = false;
    }
  };
  body.setAttribute("aria-busy", "true");
  body.innerHTML = loadingLines();
  void fetchPdfPreview(preview).then(() => renderPdfInto(preview, body, null)).catch((error) => {
    releasePdf(preview);
    if (!preview.isCurrent()) return;
    body.setAttribute("aria-busy", "false");
    body.innerHTML = `<p class="empty-block" role="status">${esc(error.message || "版式预览暂不可用")}</p>`;
  });
}

const ENRICHMENT_LABEL = {
  pending: "等待抽取事实与实体",
  running: "正在抽取事实与实体",
  deferred: "该文档尚未抽取，可点击「重新抽取事实」",
  empty: "未找到有原文依据的事实",
  failed: "抽取失败，可点击「重新抽取事实」重试",
};

// 关联实体由可见事实推导，列表为空时的说明要区分「还没抽」「抽完但无可展示实体」。
// empty 交给 ENRICHMENT_LABEL 解释，这里不再重复占位。
const ENTITY_EMPTY_LABEL = {
  pending: "尚未抽取到关联实体",
  running: "尚未抽取到关联实体",
  deferred: "尚未抽取到关联实体",
  failed: "尚未抽取到关联实体",
  done: "抽取完成，但事实未通过可见原文证据或实体名校验",
};

function entityPills(entities, enrichmentStatus) {
  if (entities.length) return `<div class="pill-row">${entities.map((entity) => `<span class="pill doc-entity-pill">${esc(entity.name)}</span>`).join("")}</div>`;
  const label = enrichmentStatus === "empty" ? "" : ENTITY_EMPTY_LABEL[enrichmentStatus] ?? ENTITY_EMPTY_LABEL.done;
  return label ? `<div class="pill-row"><span class="doc-hint">${esc(label)}</span></div>` : "";
}

function docTabButton(id, label, count, active) {
  return `<button class="tab${active ? " active" : ""}" type="button" role="tab" id="doc-tab-${id}" aria-controls="doc-panel-${id}" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" data-doc-tab="${id}">${label}${count === null ? "" : `<span class="doc-tab-count">${num(count)}</span>`}</button>`;
}

function docTabPanel(id, content, active) {
  return `<div class="doc-panel" id="doc-panel-${id}" role="tabpanel" aria-labelledby="doc-tab-${id}" data-doc-panel="${id}"${active ? "" : " hidden"}>${content}</div>`;
}

function openDoc(docId, citation = null) {
  return navigateToPage("document", { ...citation, doc_id: docId });
}

function refreshDocument(detail) {
  if (detail && state.document === detail) return loadDocument(detail, true);
}

async function loadDocument(citation, refresh = false) {
  const request = ++docOpenRequest;
  const token = state.token;
  const isCurrent = () => request === docOpenRequest && state.document === citation && state.token === token;
  const docId = citation.doc_id;
  const title = $("#doc-page-title");
  const badges = $("#doc-page-badges");
  const meta = $("#doc-page-meta");
  const status = $("#doc-page-status");
  const tabBar = $("#doc-page-tabbar");
  const tabList = $("#doc-page-tabs");
  const downloadOriginal = $("[data-download-original]", tabBar);
  const copySource = $("[data-copy-source]", tabBar);
  const body = $("#doc-page-body");
  const sourceFooter = $("#doc-source-footer");
  const rail = $("#doc-page-info");
  const infoLink = $("[data-doc-info]");
  if (!refresh) {
    title.textContent = "文档";
    badges.innerHTML = "";
    meta.innerHTML = "";
    status.hidden = true;
    status.innerHTML = "";
    tabBar.hidden = true;
    tabList.innerHTML = "";
    infoLink.hidden = true;
    rail.hidden = true;
    rail.innerHTML = "";
    sourceFooter.hidden = true;
    body.innerHTML = loadingLines();
    $(".doc-page-main").scrollTop = 0;
    title.focus({ preventScroll: true });
  }
  body.setAttribute("aria-busy", "true");
  try {
    const selectedVersion = citation.version_id;
    const data = await api(`/documents/${encodeURIComponent(docId)}${selectedVersion ? `?version_id=${encodeURIComponent(selectedVersion)}` : ""}`);
    if (!isCurrent()) return;
    const doc = data.document;
    const continuation = data.continuation;
    const enrichmentLabel = ENRICHMENT_LABEL[doc.enrichment_status];
    const ranges = sourceRanges(data, citation);
    const version = data.source?.version ?? doc.version;
    const sourceText = data.source?.text ?? "";
    const locating = Boolean(citation?.chunk_id || citation?.quote || citation?.spans?.length);
    const hasChain = Boolean(doc.continuation) || (continuation?.chain?.length ?? 0) > 1;
    const activeVersionId = data.source?.version_id;
    const file = data.source?.file;
    const sourceType = file?.type ?? doc.source_type;
    const sourceLabel = SOURCE_LABEL[sourceType] || sourceType;
    const hasFileTab = Boolean(file) || (version === doc.version && ["pdf", "doc", "docx"].includes(sourceType));
    const textTab = hasFileTab ? "text" : "source";
    title.textContent = doc.title;
    badges.innerHTML = `${continuationBadge(doc)}${version !== doc.version ? `<span class="pill warn">历史版本</span>` : ""}`;
    meta.innerHTML = `
      <span>${esc(sourceLabel)} · 更新于 ${esc(shortDate(doc.updated_at))}</span>
      <small>检索单元 ${num(data.chunks.length)}</small>
      <small>查看版本 v${esc(version)}</small>
      <small>原文长度 ${num(sourceText.length)} 字符</small>
      <small>解析质量 ${esc(doc.quality)}</small>
      <small>解析器 ${esc(data.source?.parser || "未知")}</small>`;
    status.innerHTML = `
      <div><dt>权限</dt><dd>${esc(doc.acl_label)}</dd></div>
      <div><dt>可信度</dt><dd>${esc(doc.source_trust ?? 0.5)}${doc.is_core ? " · 核心" : ""}</dd></div>
      <div><dt>内容哈希</dt><dd class="mono">${esc(doc.content_hash)}</dd></div>`;
    status.hidden = false;

    const textPanel = `
      ${locating ? `<div class="doc-panel-toolbar"><span class="pill info">已定位引用</span></div>` : ""}
      ${locating && !ranges.length ? `<p class="doc-hint">该引用暂无精确坐标，可在下方文字中核对。</p>` : ""}
      <pre class="doc-source">${sourceHtml(sourceText, ranges) || '<span class="muted">暂无内容文字</span>'}</pre>`;
    const filePanel = file
      ? `<div class="doc-file-preview" role="region" aria-label="${esc(sourceLabel)} 版式预览"></div>`
      : `<p class="empty-block" role="status">此版本未保存原文件。</p>`;

    const chunksPanel = data.chunks.length
      ? `<div class="doc-chunk-list">${data.chunks.map((chunk) => `
          <article class="doc-chunk${chunk.id === citation?.chunk_id ? " is-target" : ""}">
            <header class="doc-chunk-head">
              <span>#${esc(chunk.seq)} · ${esc(chunk.block_type)}</span>
              <span>${num(chunk.tokens)} tokens${chunk.page ? ` · p.${esc(chunk.page)}` : ""}</span>
            </header>
            <p class="doc-chunk-text">${esc(plainLines(chunk.text))}</p>
            <footer class="doc-chunk-meta">${esc(chunk.heading_path?.join(" / ") || "正文")}</footer>
          </article>`).join("")}</div>`
      : `<div class="empty-block">暂无检索单元</div>`;

    const versionsPanel = data.versions.length
      ? `<p class="doc-hint">同一文档的内容修订会新增版本；引用始终指向生成时的版本，历史版本不会被覆盖。</p>
        <div class="doc-version-list">${data.versions.map((item) => `
          <button type="button" class="doc-version-row${item.id === activeVersionId ? " is-active" : ""}" data-doc-version="${esc(item.id)}"${item.id === activeVersionId ? ' aria-current="true"' : ""}>
            <span class="doc-version-no">v${esc(item.version)}</span>
            <span class="doc-version-body">
              <strong>${esc(item.parser)}</strong>
              <small>${num(item.chars)} 字符 · <span class="mono">${esc(item.hash)}</span></small>
            </span>
            <span class="doc-version-date">${esc(shortDate(item.created_at))}</span>
            ${item.version === doc.version ? `<span class="pill info">当前</span>` : item.id === activeVersionId ? `<span class="doc-version-open">查看中</span>` : `<span class="doc-version-open">查看</span>`}
          </button>`).join("")}</div>`
      : `<div class="empty-block">暂无版本</div>`;

    const factsPanel = `
      ${data.review_only_facts ? `<p class="doc-hint">${num(data.review_only_facts)} 条低置信度候选仅供审阅，不进入默认回答。</p>` : ""}
      ${data.facts.length ? `<div class="doc-fact-list">${data.facts.map((fact) => `
        <div class="fact-item">
          <div class="fact-line">${esc(fact.subject)} <span class="pred">${esc(fact.predicate)}</span> <span class="obj">${esc(fact.object || "")}</span></div>
          <div class="fact-meta">${factPill(fact.status)}<span>置信度 ${esc(fact.confidence)}</span><span>${esc(fact.acl_label)}</span></div>
          ${fact.evidence?.[0]?.quote ? `<div class="fact-quote">${esc(plain(fact.evidence[0].quote))}</div>` : ""}
        </div>`).join("")}</div><p class="doc-hint">事实只在有可见原文证据时展示；低置信度候选只进入审阅队列，不进入默认回答。</p>` : `<div class="empty-block">暂无事实</div>`}`;

    const chain = continuation?.chain ?? [];
    const chainHtml = hasChain
      ? `<div class="doc-chain">${chain.map((node) => `
          <button type="button" class="doc-chain-node${node.id === doc.id ? " is-current" : ""}" data-open-doc="${esc(node.id)}"${node.id === doc.id ? ' aria-current="true"' : ""}>
            <span class="doc-chain-title">${esc(node.title)}</span>
            <span class="doc-chain-meta">${node.effective_date ? `自 ${esc(node.effective_date)} 起` : "链首"} · v${esc(node.version)} · ${node.in_force ? "现行" : "非现行"}</span>
          </button>`).join("")}</div>`
      : `<p class="doc-hint">还没有登记沿革。政策类文档更新后，把新旧两篇连起来，检索会按日期只取当时有效的一篇。</p>`;
    const predecessor = continuation?.predecessor;
    const successor = continuation?.successor;
    const canUnlink = (predecessor || successor)
      && (predecessor || !doc.continuation?.predecessor_doc_id)
      && (successor || !doc.continuation?.successor_doc_id);

    const selectedTab = refresh ? $('[data-doc-tab][aria-selected="true"]', tabList)?.dataset.docTab : null;
    const originalPath = file ? documentCitationPath(docId, activeVersionId) : null;
    const oldFilePanel = originalPath && documentFile?.path === originalPath ? $("#doc-panel-source", body) : null;
    if (!oldFilePanel) closeDocumentFile();
    tabList.innerHTML = `
      ${docTabButton("source", "原文", null, true)}
      ${hasFileTab ? docTabButton("text", "内容文字", null, false) : ""}
      ${docTabButton("chunks", "检索单元", data.chunks.length, false)}
      ${docTabButton("versions", "版本", data.versions.length, false)}
      ${docTabButton("facts", "事实", data.facts.length, false)}`;
    tabBar.hidden = false;
    body.innerHTML = `
      <section class="doc-main" aria-label="文档内容">
        ${docTabPanel("source", hasFileTab ? filePanel : textPanel, true)}
        ${hasFileTab ? docTabPanel("text", textPanel, false) : ""}
        ${docTabPanel("chunks", chunksPanel, false)}
        ${docTabPanel("versions", versionsPanel, false)}
        ${docTabPanel("facts", factsPanel, false)}
      </section>`;
    if (oldFilePanel) $("#doc-panel-source", body).replaceWith(oldFilePanel);

    rail.innerHTML = `
      <div class="doc-rail-content">
        <div class="doc-actions">
          <button class="btn primary block" data-doc-action="update">更新内容</button>
          <div class="doc-action-grid">
            <button class="btn" data-doc-action="reprocess">重新抽取事实</button>
            <button class="btn" data-doc-action="reindex">重建检索索引</button>
            <button class="btn span-2" type="button" data-doc-action="policy" aria-haspopup="dialog">来源与核心标记</button>
            <button class="btn span-2" type="button" data-continuation-open aria-haspopup="dialog">登记延续关系</button>
          </div>
        </div>

        <section class="doc-rail-section" id="doc-related-entities">
          <div class="doc-section-head"><h3>关联实体</h3><span class="doc-section-note">${num(data.entities.length)}</span></div>
          ${enrichmentLabel ? `<p class="doc-hint">${esc(enrichmentLabel)}</p>` : ""}
          ${doc.enrichment_status === "failed" && doc.enrichment_error ? `<p class="doc-hint danger-text">${esc(doc.enrichment_error)}</p>` : ""}
          ${entityPills(data.entities, doc.enrichment_status)}
        </section>

        <section class="doc-rail-section">
          <div class="doc-section-head"><h3>沿革</h3><span class="doc-section-note">${hasChain ? (chain.length > 1 ? `${chain.length} 代` : "已登记") : "未登记"}</span></div>
          ${chainHtml}
          ${canUnlink ? `<div><button class="text-btn danger" type="button" data-continuation-unlink aria-haspopup="dialog">解除延续</button></div>` : ""}
        </section>
      </div>

      <div class="doc-rail-danger">
        <button class="text-btn danger" data-doc-action="delete">移入回收站</button>
      </div>`;

    rail.hidden = false;
    infoLink.hidden = false;
    infoLink.onclick = (event) => {
      event.preventDefault();
      rail.scrollIntoView({ behavior: "smooth", block: "start" });
      rail.focus({ preventScroll: true });
    };
    const tabs = $$("[data-doc-tab]", tabList);
    const panels = $$("[data-doc-panel]", body);
    const activateTab = (id) => {
      for (const tab of tabs) {
        const active = tab.dataset.docTab === id;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.dataset.docPanel !== id;
      downloadOriginal.hidden = id !== "source" || !file;
      copySource.hidden = id !== textTab;
      sourceFooter.hidden = id !== textTab;
      if (id === "source" && file && !documentFile) {
        openDocumentFile(file, originalPath, $(".doc-file-preview", body), downloadOriginal);
      }
    };
    activateTab((selectedTab === "text" ? textTab : selectedTab) ?? (locating ? textTab : "source"));
    for (const tab of tabs) tab.addEventListener("click", () => activateTab(tab.dataset.docTab));
    tabList.onkeydown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next].dataset.docTab);
    };
    copySource.onclick = async () => {
      try {
        await navigator.clipboard.writeText(sourceText);
        toast("原文已复制");
      } catch {
        toast("复制失败，请手动选择原文");
      }
    };
    $$("[data-doc-action]", rail).forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.docAction === "update") {
          openIngest(doc);
        } else if (button.dataset.docAction === "policy") {
          openPolicyDialog(doc, citation);
        } else handleDocAction(button.dataset.docAction, citation, button);
      });
    });
    $$("[data-doc-version]", body).forEach((button) => {
      button.addEventListener("click", () => openDoc(docId, { version_id: button.dataset.docVersion }));
    });
    $$("[data-open-doc]", rail).forEach((button) => {
      button.addEventListener("click", () => openDoc(button.dataset.openDoc));
    });
    $("[data-continuation-unlink]", rail)?.addEventListener("click", () => openUnlinkContinuationDialog(doc, predecessor, successor, citation));
    $("[data-continuation-open]", rail).addEventListener("click", () => openContinuationDialog(doc, citation));
    if (!refresh) {
      const highlight = $("#source-highlight-target", body);
      highlight?.scrollIntoView({ behavior: "smooth", block: "center" });
      highlight?.focus({ preventScroll: true });
    }
  } catch (error) {
    if (isCurrent()) {
      closeDocumentFile();
      badges.innerHTML = "";
      meta.innerHTML = "";
      status.hidden = true;
      status.innerHTML = "";
      tabBar.hidden = true;
      tabList.innerHTML = "";
      infoLink.hidden = true;
      rail.hidden = true;
      rail.innerHTML = "";
      sourceFooter.hidden = true;
      body.innerHTML = `<div class="empty-block" role="status">${esc(error.message)}</div>`;
    }
  } finally {
    if (isCurrent()) body.removeAttribute("aria-busy");
  }
}

function openUnlinkContinuationDialog(doc, predecessor, successor, citation) {
  const dialog = $("#unlink-continuation-dialog");
  const error = $("#unlink-continuation-error", dialog);
  const separate = $("[data-unlink-confirm=separate]", dialog);
  const reconnect = $("[data-unlink-confirm=reconnect]", dialog);
  const canReconnect = Boolean(predecessor && successor);
  const buttons = $$("button", dialog);
  $("#unlink-continuation-document", dialog).textContent = doc.title;
  $("#unlink-continuation-note", dialog).textContent = canReconnect
    ? `当前文档将移出沿革。「仅解除」会拆分前后两段沿革。「解除并续接」会将「${successor.title}」设为「${predecessor.title}」的直接后继。`
    : "当前文档将移出这条沿革。";
  separate.textContent = canReconnect ? "仅解除" : "确认解除";
  reconnect.hidden = !canReconnect;
  error.textContent = "";
  dialog.oncancel = (event) => {
    if (separate.disabled) event.preventDefault();
  };
  const submit = async (button, shouldReconnect) => {
    if (button.disabled) return;
    const params = new URLSearchParams({
      reconnect: String(shouldReconnect),
      predecessor_id: predecessor?.id ?? "",
      successor_id: successor?.id ?? "",
    });
    error.textContent = "";
    setBusy(button, true, "解除中");
    buttons.forEach((control) => { control.disabled = true; });
    try {
      await api(`/documents/${encodeURIComponent(doc.id)}/continuation?${params}`, { method: "DELETE" });
      dialog.close();
      toast(shouldReconnect ? "延续关系已解除，前后文档已续接" : "延续关系已解除");
      refreshDocument(citation);
      loadDocs();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      buttons.forEach((control) => { control.disabled = false; });
      setBusy(button, false);
      if (dialog.open) button.focus();
    }
  };
  separate.onclick = () => submit(separate, false);
  reconnect.onclick = () => submit(reconnect, true);
  dialog.showModal();
}

async function openContinuationDialog(doc, citation) {
  const dialog = $("#continuation-dialog");
  const closeButton = $("[data-close]", dialog);
  const body = $("#continuation-dialog-body");
  body.innerHTML = `
    <form class="form continuation-form">
      <div class="continuation-order" role="group" aria-label="文档接续顺序">
        <div class="field continuation-related">
          <label id="continuation-other-label" for="continuation-other">前序文档</label>
          <div data-document-picker></div>
        </div>
        <div class="continuation-connector">
          <span class="continuation-arrow" aria-hidden="true">→</span>
          <button class="btn" type="button" data-continuation-swap>交换位置</button>
        </div>
        <p class="doc-form-current continuation-current">当前文档 <strong>${esc(doc.title)}</strong></p>
      </div>
      <p class="doc-hint" id="continuation-placement" hidden></p>
      <div class="field"><label id="continuation-date-label" for="continuation-date">生效日期</label><div data-date-picker></div></div>
      <div class="field"><label for="continuation-note">备注（选填）</label><input id="continuation-note" maxlength="500" /></div>
      <p class="continuation-status" role="status">正在加载可关联的文档…</p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-continuation-cancel>取消</button>
        <button class="btn primary" type="submit" data-continuation-link disabled>建立延续</button>
      </div>
    </form>`;
  const form = $("form", body);
  const status = $(".continuation-status", form);
  const save = $("[data-continuation-link]", form);
  const cancel = $("[data-continuation-cancel]", form);
  const order = $(".continuation-order", form);
  const relatedField = $(".continuation-related", order);
  const currentDocument = $(".continuation-current", order);
  const connector = $(".continuation-connector", order);
  const swap = $("[data-continuation-swap]", connector);
  const relatedLabel = $("#continuation-other-label", relatedField);
  const isPredecessor = () => order.firstElementChild === relatedField;
  const relatedDocument = KnowWeavePickers.choice($("[data-document-picker]", form), {
    id: "continuation-other", label: "前序文档", labelId: "continuation-other-label", placeholder: "选择文档",
    options: [],
  });
  const effective = KnowWeavePickers.date($("[data-date-picker]", form), {
    id: "continuation-date", label: "生效日期", labelId: "continuation-date-label",
  });
  const placement = $("#continuation-placement", form);
  const effectiveLabel = $("#continuation-date-label", form);
  const updatePlacement = () => {
    const before = isPredecessor();
    const label = before ? "前序文档" : "后继文档";
    relatedLabel.textContent = label;
    relatedDocument.setLabel(label);
    swap.setAttribute("aria-label", `交换位置，将所选文档设为${before ? "后继" : "前序"}`);
    const inserting = Boolean(before ? doc.continuation?.predecessor_doc_id : doc.continuation?.successor_doc_id);
    placement.hidden = !inserting;
    placement.textContent = inserting
      ? `所选文档将插入${before ? "原前序与当前文档" : "当前文档与原后续"}之间。`
      : "";
    effectiveLabel.textContent = before && !inserting ? "当前文档生效日期" : "关联文档生效日期";
  };
  swap.addEventListener("click", () => {
    const before = isPredecessor();
    relatedDocument.close();
    connector.before(before ? currentDocument : relatedField);
    connector.after(before ? relatedField : currentDocument);
    updatePlacement();
  });
  updatePlacement();
  const showError = (message) => {
    status.classList.add("danger-text");
    status.textContent = message;
  };
  cancel.onclick = () => dialog.close();
  dialog.oncancel = (event) => {
    if (closeButton.disabled) event.preventDefault();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const other = relatedDocument.trigger.value;
    const effectiveDate = effective.trigger.value;
    if (!other || !effectiveDate) {
      showError(other ? "请选择生效日期" : "请选择关联文档");
      (other ? effective : relatedDocument).trigger.focus();
      return;
    }
    const note = $("#continuation-note", form).value.trim();
    status.textContent = "";
    setBusy(save, true, "保存中");
    closeButton.disabled = cancel.disabled = swap.disabled = true;
    try {
      await api(`/documents/${encodeURIComponent(doc.id)}/continuation`, {
        method: "POST",
        body: { other_doc_id: other, relation: isPredecessor() ? "continues" : "continued_by", effective_date: effectiveDate, note },
      });
      dialog.close();
      toast("延续关系已建立");
      refreshDocument(citation);
      loadDocs();
    } catch (error) {
      showError(error.message);
    } finally {
      closeButton.disabled = cancel.disabled = swap.disabled = false;
      setBusy(save, false);
    }
  };

  dialog.showModal();
  swap.focus();
  try {
    const { items } = await api("/documents?limit=200");
    if (!form.isConnected || !dialog.open) return;
    const options = items.filter((item) => item.id !== doc.id).map(({ id, title }) => ({ value: id, label: title }));
    relatedDocument.setOptions(options, "");
    save.disabled = options.length === 0;
    status.textContent = options.length ? "" : "没有可关联的文档";
  } catch (error) {
    if (form.isConnected && dialog.open) showError(error.message);
  }
}

function openPolicyDialog(doc, citation) {
  const dialog = $("#policy-dialog");
  const form = $("#policy-form", dialog);
  const trust = $("#policy-trust", form);
  const core = $("#policy-core", form);
  const save = $("#policy-save", form);
  const error = $("#policy-error", form);
  const closeButtons = $$("[data-close]", dialog);

  $("#policy-document", form).textContent = doc.title;
  trust.value = String(doc.source_trust ?? 0.5);
  core.checked = Boolean(doc.is_core);
  error.textContent = "";
  trust.removeAttribute("aria-invalid");
  trust.oninput = () => {
    if (!trust.hasAttribute("aria-invalid")) return;
    trust.removeAttribute("aria-invalid");
    error.textContent = "";
  };
  dialog.oncancel = (event) => {
    if (save.disabled) event.preventDefault();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    if (!trust.validity.valid) {
      trust.setAttribute("aria-invalid", "true");
      error.textContent = "请输入 0 到 1 之间的来源可信度。";
      trust.focus();
      return;
    }
    const payload = { source_trust: trust.valueAsNumber, is_core: core.checked };
    error.textContent = "";
    setBusy(save, true, "保存中");
    [trust, core, ...closeButtons].forEach((control) => { control.disabled = true; });
    try {
      await api(`/documents/${encodeURIComponent(doc.id)}/policy`, { method: "PATCH", body: payload });
      dialog.close();
      toast("来源与核心标记已保存");
      refreshDocument(citation);
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      [trust, core, ...closeButtons].forEach((control) => { control.disabled = false; });
      setBusy(save, false);
      if (dialog.open) save.focus();
    }
  };
  dialog.showModal();
}

async function handleDocAction(action, detail, button) {
  const docId = encodeURIComponent(detail.doc_id);
  if (action === "delete") {
    if (!confirm("确认移入回收站？可在回收站中恢复。")) return;
    setBusy(button, true, "删除中");
    try {
      await api(`/documents/${docId}`, { method: "DELETE" });
      toast("文档已移入回收站，可到回收站恢复");
      if (state.document?.doc_id === detail.doc_id) navigateToPage("library");
      else loadDocs();
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
      void loadIngestJobs();
      await refreshDocument(detail);
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(button, false);
    }
  }
  if (action === "reindex") {
    setBusy(button, true, "处理中");
    try {
      await api(`/documents/${docId}/reprocess`, { method: "POST", body: { scope: "index" } });
      toast("所有存储版本的检索索引已重建");
      await refreshDocument(detail);
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
  menu.setAttribute("aria-multiselectable", "true");
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
    input.removeAttribute("aria-activedescendant");
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
      <div id="${menu.id}-option-${index}" class="acl-option${index === activeIndex ? " is-active" : ""}" role="option" data-value="${esc(option.value)}" aria-selected="${selected.has(option.value)}">
        <span>${esc(option.label)}</span>
        <span class="acl-option-kind">${esc(option.kind)}</span>
      </div>`).join("");
    if (!menu.hidden) input.setAttribute("aria-activedescendant", `${menu.id}-option-${activeIndex}`);
  }

  function open() {
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close() {
    menu.hidden = true;
    activeIndex = 0;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
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
    } else if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
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
  picker.addEventListener("focusout", (event) => {
    if (!picker.contains(event.relatedTarget)) close();
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

function renderIngestFiles() {
  const { ingestFiles, ingestDocumentId } = state;
  const count = ingestFiles.length;
  const list = $("#ingest-files");
  $("#file-drop-label").textContent = count ? `已选 ${num(count)} 份文件，点击重选` : "选择文件";
  $("#file-drop-hint").textContent = ingestDocumentId ? "选择或拖入一份文件" : "可多选或拖入多个文件";
  $("#file-title-field").hidden = count > 1;
  $("#file-batch-hint").hidden = count <= 1;
  list.hidden = count === 0;
  list.innerHTML = ingestFiles.map(({ file, error }) =>
    `<li>${esc(file.name)}${error ? `<span class="ingest-file-error">${esc(error)}</span>` : ""}</li>`
  ).join("");
  $("#file-submit").textContent = ingestFiles.some((item) => item.error) ? "重试提交" : count > 1 ? "批量接入" : "接入";
}

function setIngestFileStatus(message) {
  const status = $("#file-submit-status");
  status.textContent = message;
  status.hidden = !message;
}

function resetIngest() {
  state.ingestDocumentId = null;
  state.ingestFiles = [];
  $("#file-input").multiple = true;
  $("#ingest-title").textContent = "添加文档";
  for (const type of ["file", "text", "url"]) $("#ingest-" + type + "-form").reset();
  $$("[data-acl-picker]").forEach((picker) => aclPickerState.get(picker)?.reset());
  setIngestFileStatus("");
  renderIngestFiles();
}

function openIngest(doc = null) {
  resetIngest();
  state.ingestDocumentId = doc?.id || null;
  $("#file-input").multiple = !state.ingestDocumentId;
  renderIngestFiles();
  $("#ingest-title").textContent = doc ? "更新文档" : "添加文档";
  for (const type of ["file", "text", "url"]) $("#" + type + "-title").value = doc?.title || "";
  const fromUrl = doc?.source_type === "web" || (doc?.source_type === "pdf" && /^https?:\/\//i.test(doc.uri ?? ""));
  if (fromUrl) $("#url-input").value = doc.uri || "";
  selectIngestTab(fromUrl ? "url" : doc?.source_type === "text" ? "text" : "file");
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
  $("#open-trash").addEventListener("click", () => openTrash());
  const dialog = $("#ingest-dialog");
  const closeButton = $("[data-close]", dialog);
  const tabs = $("#ingest-tabs");
  const fileInput = $("#file-input");
  const fileDrop = $("#file-drop");
  const fileFields = $("#ingest-file-fields");
  const fileSubmit = $("#file-submit");

  dialog.addEventListener("close", resetIngest);
  dialog.addEventListener("cancel", (event) => {
    if (fileSubmit.disabled) event.preventDefault();
  });
  const selectFiles = (files) => {
    if (fileSubmit.disabled || !files?.length) return;
    if (state.ingestDocumentId && files.length > 1) {
      setIngestFileStatus("更新文档时请选择一份文件。");
      return;
    }
    state.ingestFiles = Array.from(files, (file) => ({ file }));
    const name = files.length === 1 ? files[0].name : "";
    $("#file-title").value = name.replace(/\.[^.]*$/, "") || name;
    setIngestFileStatus("");
    renderIngestFiles();
  };

  fileDrop.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    selectFiles(fileInput.files);
    fileInput.value = "";
  });
  dialog.addEventListener("dragover", (event) => event.preventDefault());
  dialog.addEventListener("drop", (event) => event.preventDefault());
  fileDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    selectFiles(event.dataTransfer.files);
  });

  $("#ingest-file-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (fileSubmit.disabled) return;
    const { ingestFiles, ingestDocumentId } = state;
    const count = ingestFiles.length;
    if (!count) { setIngestFileStatus("请先选择文件。"); return; }
    const title = count === 1 ? $("#file-title").value.trim() : "";
    const acl = (ingestAcl($("#file-acl")) || []).join(",");
    const failures = [];
    setBusy(fileSubmit, true, "提交中");
    fileFields.inert = tabs.inert = closeButton.disabled = true;
    try {
      for (const [index, { file }] of ingestFiles.entries()) {
        setIngestFileStatus(`正在提交 ${index + 1} / ${count} 份文件…`);
        let job;
        try {
          if (file.size === 0) throw new Error("文件为空");
          if (file.size > 30 * 1024 * 1024) throw new Error("文件超过 30 MB");
          const form = new FormData();
          if (ingestDocumentId) form.append("doc_id", ingestDocumentId);
          if (title) form.append("title", title);
          if (acl) form.append("acl", acl);
          form.append("file", file);
          job = await api("/documents/upload", { method: "POST", body: form });
        } catch (error) {
          failures.push({ file, error: error.message });
          continue;
        }
        trackIngestJob(job);
      }
    } finally {
      fileFields.inert = tabs.inert = closeButton.disabled = false;
      setBusy(fileSubmit, false);
    }
    if (!failures.length) {
      closeIngest();
      toast(count === 1 ? "已提交，正在后台处理" : `已提交 ${num(count)} 份文件，正在后台处理`);
      return;
    }
    state.ingestFiles = failures;
    renderIngestFiles();
    setIngestFileStatus(`已提交 ${num(count - failures.length)} 份，${num(failures.length)} 份提交失败。`);
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

// The complete DSH application owns sessions, streaming, tools and composer state.
// Keep the iframe mounted when navigating so an active turn is never interrupted.
const NATIVE_CHAT_BEAT_MS = 4000; // 与 branding/bootstrap.js 的心跳间隔一致
const NATIVE_CHAT_SILENT_MS = 12000; // 连续丢失心跳即判定画面失效
const NATIVE_CHAT_BOOT_MS = 20000; // 首次挂载、对话服务重启后的启动宽限
const NATIVE_CHAT_RESUME_MS = 15000; // 切回对话页、标签页重新可见后的宽限
const NATIVE_CHAT_WATCH_MS = 4000;
const NATIVE_CHAT_MISSES = 2; // 沉默需要连续两次判定：一次可能只是主线程卡顿
let nativeChatTimer = null;
let nativeChatLoading = false;
let nativeChatGeneration = 0;
// 外壳看不到 iframe 里的 WebSocket：画面是否还活着只能靠心跳和 /dsh-web 状态判断。
const nativeChat = { url: null, beatAt: 0, graceUntil: 0, misses: 0, reloads: 0, watcher: null, recovering: false };
let chatCitation = null;

function releasePdf(preview) {
  preview.observer?.disconnect();
  preview.observer = null;
  const task = preview.pdfTask;
  preview.pdfTask = null;
  preview.pdf = null;
  if (task) void task.destroy().catch(() => undefined);
  if (preview.url) URL.revokeObjectURL(preview.url);
  preview.url = null;
}

function closeChatCitation() {
  if (chatCitation) {
    chatCitation.controller.abort();
    releasePdf(chatCitation);
    chatCitation = null;
  }
  $("#chat-citation").hidden = true;
  $("#chat-citation-body").textContent = "";
}

let pdfjsModule = null;
function loadPdfjs() {
  pdfjsModule ??= import("/vendor/pdfjs/build/pdf.min.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";
    return lib;
  });
  return pdfjsModule;
}

async function fetchPdfPreview(preview) {
  const signal = preview.controller.signal;
  const blob = await api(`${preview.path}&format=pdf`, { signal, responseType: "blob" });
  if (blob.type !== "application/pdf") throw new Error("版式预览暂不可用");
  signal.throwIfAborted();
  preview.url = URL.createObjectURL(blob);
}

function pdfFlatText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function pdfMergeRects(rects) {
  const lines = [];
  for (const rect of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((item) => Math.abs(item.top - rect.top) <= Math.max(2, Math.min(item.height, rect.height) * 0.5));
    if (!line) {
      lines.push({ ...rect });
      continue;
    }
    const right = Math.max(line.left + line.width, rect.left + rect.width);
    line.left = Math.min(line.left, rect.left);
    line.top = Math.min(line.top, rect.top);
    line.height = Math.max(line.height, rect.height);
    line.width = right - line.left;
  }
  return lines;
}

// PDF 文本层按字符定位引用，不依赖解析器是否给出 bbox；同一行的字符合并为一条高亮。
function pdfHighlightRects(textContent, viewport, lib, quote) {
  const items = textContent.items.filter((item) => item.str && item.str.trim());
  if (!items.length || !quote) return [];
  let pageText = "";
  const owners = [];
  for (let index = 0; index < items.length; index += 1) {
    const value = pdfFlatText(items[index].str);
    pageText += value;
    for (let offset = 0; offset < value.length; offset += 1) owners.push(index);
  }
  for (const size of [60, 32, 16, 8]) {
    const needle = quote.slice(0, size);
    if (needle.length < 6) break;
    const at = pageText.indexOf(needle);
    if (at < 0) continue;
    const rects = [];
    for (const index of new Set(owners.slice(at, at + needle.length))) {
      const item = items[index];
      const tx = lib.Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]);
      rects.push({ left: tx[4], top: tx[5] - height, width: item.width * viewport.scale, height });
    }
    return pdfMergeRects(rects);
  }
  return [];
}

async function renderPdfPage(preview, entry, body) {
  if (entry.rendered) return;
  if (entry.rendering) return entry.rendering;
  entry.rendering = (async () => {
    const lib = await loadPdfjs();
    const page = await preview.pdf.getPage(entry.number);
    if (!preview.isCurrent()) return;
    const base = page.getViewport({ scale: 1 });
    const width = entry.page.clientWidth || body.clientWidth || 480;
    const scale = width / base.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    entry.canvas.width = Math.floor(viewport.width);
    entry.canvas.height = Math.floor(viewport.height);
    await page.render({ canvas: entry.canvas, viewport }).promise;
    if (!preview.isCurrent()) return;
    entry.page.style.aspectRatio = `${base.width} / ${base.height}`;
    entry.page.classList.add("is-rendered");
    entry.rendered = true;
    if (entry.number !== (Number(preview.data.page) || 0)) return;
    const cssViewport = page.getViewport({ scale });
    const quote = pdfFlatText(preview.data.chunks[0]?.text);
    const rects = pdfHighlightRects(await page.getTextContent(), cssViewport, lib, quote);
    if (!preview.isCurrent()) return;
    for (const rect of rects) {
      const mark = document.createElement("span");
      mark.className = "pdf-citation-highlight";
      mark.style.left = `${Math.max(0, rect.left)}px`;
      mark.style.top = `${Math.max(0, rect.top)}px`;
      mark.style.width = `${Math.max(2, rect.width)}px`;
      mark.style.height = `${Math.max(2, rect.height)}px`;
      entry.overlay.append(mark);
    }
    if (rects.length) {
      const bodyBox = body.getBoundingClientRect();
      const pageBox = entry.page.getBoundingClientRect();
      body.scrollTo({ top: body.scrollTop + pageBox.top - bodyBox.top + rects[0].top - 12, behavior: "smooth" });
    }
  })().catch(() => {
    entry.page.classList.add("is-failed");
  }).finally(() => {
    entry.rendering = null;
  });
  return entry.rendering;
}

async function renderPdfInto(preview, body, root = body) {
  const lib = await loadPdfjs();
  if (!preview.isCurrent()) return;
  preview.pdfTask ??= lib.getDocument({
    url: preview.url,
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
  });
  const pdf = await preview.pdfTask.promise;
  if (!preview.isCurrent()) return;
  preview.pdf = pdf;
  const first = await pdf.getPage(1);
  if (!preview.isCurrent() || preview.isVisible?.() === false) return;
  const base = first.getViewport({ scale: 1 });
  const cited = Number(preview.data.page) || 0;
  const pages = document.createElement("div");
  pages.className = "pdf-pages";
  const entries = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = document.createElement("div");
    page.className = "pdf-page";
    page.dataset.page = String(number);
    page.style.aspectRatio = `${base.width} / ${base.height}`;
    const canvas = document.createElement("canvas");
    const overlay = document.createElement("div");
    overlay.className = "pdf-highlights";
    page.append(canvas, overlay);
    pages.append(page);
    entries.push({ number, page, canvas, overlay, rendered: false, rendering: null });
  }
  if (cited) entries[cited - 1]?.page.classList.add("is-cited");
  body.replaceChildren(pages);
  body.setAttribute("aria-busy", "false");

  preview.observer?.disconnect();
  const observer = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const entry = entries[Number(record.target.dataset.page) - 1];
      if (entry) void renderPdfPage(preview, entry, body);
    }
  }, { root, rootMargin: "320px 0px" });
  preview.observer = observer;
  entries.forEach((entry) => observer.observe(entry.page));
  if (cited) entries[cited - 1]?.page.scrollIntoView({ block: "start" });
}

function showChatCitationText(preview, note = "") {
  preview.observer?.disconnect();
  preview.observer = null;
  const body = $("#chat-citation-body");
  const chunk = preview.data.chunks[0];
  const ranges = sourceRanges(preview.data, { chunk_id: chunk?.id, quote: chunk?.text });
  body.innerHTML = `${note ? `<p class="empty-block">${esc(note)}</p>` : ""}
    <pre class="doc-source">${sourceHtml(preview.data.source.text, ranges) || "暂无可读文本"}</pre>`;
  body.setAttribute("aria-busy", "false");
  $("#chat-citation-file").setAttribute("aria-pressed", "false");
  $("#chat-citation-text").setAttribute("aria-pressed", "true");
  $("#source-highlight-target", body)?.scrollIntoView({ block: "center" });
}

async function showChatCitationFile(preview) {
  const body = $("#chat-citation-body");
  $("#chat-citation-file").setAttribute("aria-pressed", "true");
  $("#chat-citation-text").setAttribute("aria-pressed", "false");
  body.setAttribute("aria-busy", "true");
  body.innerHTML = loadingLines();
  try {
    preview.file ??= fetchPdfPreview(preview);
    await preview.file;
    if (chatCitation !== preview || $("#chat-citation-file").getAttribute("aria-pressed") !== "true") return;
    await renderPdfInto(preview, body);
  } catch {
    preview.file = null;
    releasePdf(preview);
    if (chatCitation === preview && $("#chat-citation-file").getAttribute("aria-pressed") === "true") {
      showChatCitationText(preview, "版式预览暂不可用，已显示引用文本。");
    }
  }
}

function documentCitationPath(docId, versionId, chunkId) {
  const params = new URLSearchParams({ chunk_id: chunkId ?? "" });
  return `/documents/${encodeURIComponent(docId)}/citation/${encodeURIComponent(versionId)}?${params}`;
}

async function openChatCitation(docId, versionId, chunkId) {
  closeChatCitation();
  const path = documentCitationPath(docId, versionId, chunkId);
  const preview = chatCitation = {
    controller: new AbortController(), path,
    isCurrent: () => chatCitation === preview,
    isVisible: () => $("#chat-citation-file").getAttribute("aria-pressed") === "true",
  };
  const body = $("#chat-citation-body");
  $("#chat-citation").hidden = false;
  $("#chat-citation-title").textContent = "引用原文";
  $("#chat-citation-meta").textContent = "";
  $("#chat-citation-toolbar").hidden = true;
  body.setAttribute("aria-busy", "true");
  body.innerHTML = loadingLines();
  try {
    preview.data = await api(path, { signal: preview.controller.signal });
    if (chatCitation !== preview) return;
    const { title, version, page, file_type: fileType } = preview.data;
    $("#chat-citation-title").textContent = title;
    $("#chat-citation-meta").textContent = page ? `v${version} · 第 ${page} 页` : `v${version}`;
    $("#chat-citation-toolbar").hidden = !fileType;
    if (fileType) await showChatCitationFile(preview);
    else showChatCitationText(preview);
  } catch (error) {
    if (chatCitation !== preview) return;
    body.setAttribute("aria-busy", "false");
    body.innerHTML = `<p class="empty-block">${esc(error.message)}</p>`;
  }
}

function resetNativeChat() {
  closeChatCitation();
  nativeChatGeneration += 1;
  nativeChatLoading = false;
  clearTimeout(nativeChatTimer);
  stopNativeChatWatch();
  nativeChat.url = null;
  nativeChat.beatAt = 0;
  nativeChat.graceUntil = 0;
  nativeChat.misses = 0;
  nativeChat.reloads = 0;
  const frame = $("#native-chat-frame");
  frame.removeAttribute("src");
  frame.hidden = true;
  $("#native-chat-status").hidden = false;
}

function loopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost";
}

// 对话服务的登录 Cookie 是 SameSite=Strict，只有同主机名（同站）的 iframe 才会带上它。
function nativeChatEntryUrl(runtimeUrl) {
  const url = new URL(runtimeUrl, location.href);
  if (loopbackHost(url.hostname) && loopbackHost(location.hostname)) url.hostname = location.hostname;
  return url.href;
}

// 非本机地址打开的页面与对话服务必然跨站，挂一个只会 401 的空白页没有意义。
function nativeChatBlockedReason() {
  if (loopbackHost(location.hostname)) return null;
  const port = location.port || "8730";
  return `原生对话界面只能在本机地址打开：当前页面来自 ${location.hostname}，与对话服务不同站，登录状态无法传递。`
    + `请改用 http://127.0.0.1:${port}/ 或 http://localhost:${port}/ 打开。`;
}

function noteNativeChatBeat() {
  nativeChat.beatAt = Date.now();
  nativeChat.graceUntil = 0;
  nativeChat.misses = 0;
  nativeChat.reloads = 0;
}

function startNativeChatWatch() {
  if (nativeChat.watcher !== null) return;
  nativeChat.watcher = setInterval(() => { checkNativeChatHealth(); }, NATIVE_CHAT_WATCH_MS);
}

function stopNativeChatWatch() {
  if (nativeChat.watcher === null) return;
  clearInterval(nativeChat.watcher);
  nativeChat.watcher = null;
}

// 用新的入口地址重新挂载：进程重启后会换发启动令牌，沿用旧地址只会拿到 401。
function mountNativeChat(url, graceMs) {
  const frame = $("#native-chat-frame");
  nativeChat.url = url;
  nativeChat.beatAt = 0;
  nativeChat.graceUntil = Date.now() + graceMs;
  nativeChat.misses = 0;
  frame.removeAttribute("src");
  frame.src = url;
  frame.hidden = false;
  $("#native-chat-status").hidden = true;
  $("#native-chat-retry").hidden = true;
  startNativeChatWatch();
}

function stopNativeChat(message) {
  stopNativeChatWatch();
  const frame = $("#native-chat-frame");
  frame.removeAttribute("src");
  frame.hidden = true;
  nativeChat.url = null;
  nativeChat.beatAt = 0;
  nativeChat.graceUntil = 0;
  nativeChat.misses = 0;
  nativeChat.reloads = 0;
  $("#native-chat-message").textContent = message;
  $("#native-chat-status").hidden = false;
  $("#native-chat-retry").hidden = false;
}

async function loadChat() {
  const frame = $("#native-chat-frame");
  if (frame.getAttribute("src") || nativeChatLoading) return;
  clearTimeout(nativeChatTimer);
  const generation = nativeChatGeneration;
  nativeChatLoading = true;
  const status = $("#native-chat-status");
  const message = $("#native-chat-message");
  const retry = $("#native-chat-retry");
  status.hidden = false;
  retry.hidden = true;
  message.textContent = "正在准备对话…";
  try {
    const blocked = nativeChatBlockedReason();
    if (blocked !== null) throw new Error(blocked);
    const runtime = await api("/dsh-web");
    if (generation !== nativeChatGeneration) return;
    if (!runtime.enabled) throw new Error("AI 对话未启用，请在配置中开启 dsh.web_enabled。");
    if (runtime.ready && runtime.url) {
      mountNativeChat(nativeChatEntryUrl(runtime.url), NATIVE_CHAT_BOOT_MS);
    } else if (runtime.lastError) {
      throw new Error(runtime.lastError);
    } else {
      nativeChatTimer = setTimeout(loadChat, 1000);
    }
  } catch (error) {
    if (generation !== nativeChatGeneration) return;
    message.textContent = error.message;
    retry.hidden = false;
  } finally {
    if (generation === nativeChatGeneration) nativeChatLoading = false;
  }
}

// 心跳沉默只说明画面死了；原因和可用的新地址都要回到服务端确认。
async function recoverNativeChat() {
  if (nativeChat.recovering) return;
  const generation = nativeChatGeneration;
  nativeChat.recovering = true;
  try {
    const runtime = await api("/dsh-web");
    if (generation !== nativeChatGeneration) return;
    if (!runtime.enabled) throw new Error("AI 对话未启用，请在配置中开启 dsh.web_enabled。");
    if (!runtime.ready || !runtime.url) {
      stopNativeChat(runtime.lastError || "对话服务正在重启…");
      return;
    }
    const url = nativeChatEntryUrl(runtime.url);
    // 进程重启会换发入口地址：旧画面已经随进程消失，用新地址重载即可恢复。
    if (url !== nativeChat.url) {
      mountNativeChat(url, NATIVE_CHAT_BOOT_MS);
      return;
    }
    // 服务端认为它活着，可这个画面已经加载或认证失败：只给一次重载机会，再没响应就交给用户。
    if (nativeChat.reloads >= 1) {
      stopNativeChat("对话界面没有响应，请点重试；仍然失败请重启主服务。");
      return;
    }
    nativeChat.reloads += 1;
    mountNativeChat(url, NATIVE_CHAT_BOOT_MS);
  } catch (error) {
    if (generation !== nativeChatGeneration) return;
    stopNativeChat(error.message);
  } finally {
    nativeChat.recovering = false;
  }
}

async function checkNativeChatHealth() {
  if (!nativeChat.url || $("#native-chat-frame").getAttribute("src") === null) return;
  // 后台标签页和非对话页里的 iframe 计时器会被浏览器节流，此时不作判断。
  if (state.page !== "chat" || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now < nativeChat.graceUntil) return;
  if (now - nativeChat.beatAt < NATIVE_CHAT_SILENT_MS) {
    nativeChat.misses = 0;
    return;
  }
  nativeChat.misses += 1;
  if (nativeChat.misses < NATIVE_CHAT_MISSES) return;
  await recoverNativeChat();
}

function resumeNativeChat() {
  // 隐藏的 iframe 计时器被节流过，回到对话页先给一个宽限窗口再判定心跳。
  if (nativeChat.url) nativeChat.graceUntil = Date.now() + NATIVE_CHAT_RESUME_MS;
  loadChat();
}

function setupChat() {
  $("#chat-citation-close").addEventListener("click", closeChatCitation);
  $("#chat-citation-file").addEventListener("click", () => {
    if (chatCitation?.data?.file_type) void showChatCitationFile(chatCitation);
  });
  $("#chat-citation-text").addEventListener("click", () => {
    if (chatCitation?.data) showChatCitationText(chatCitation);
  });
  window.addEventListener("message", (event) => {
    const frame = $("#native-chat-frame");
    if (state.page !== "chat" || frame.hidden || event.source !== frame.contentWindow ||
        event.origin !== new URL(frame.src, location.href).origin) return;
    if (event.data?.type === "knowweave:heartbeat") {
      noteNativeChatBeat();
      return;
    }
    if (event.data?.type === "knowweave:new-conversation") {
      closeChatCitation();
      return;
    }
    if (event.data?.type === "knowweave:chat-feedback") {
      handleChatFeedback(event.data);
      return;
    }
    if (event.data?.type !== "knowweave:open-citation" || typeof event.data.path !== "string") return;
    const citation = /^\/([\w-]{1,100})\/([\w-]{1,100})(?:\/([\w-]{1,100}))?$/.exec(event.data.path);
    if (citation) void openChatCitation(citation[1], citation[2], citation[3]);
  });
  $("#native-chat-retry").addEventListener("click", () => {
    resetNativeChat();
    return loadChat();
  });
  $("#chat-feedback-submit").addEventListener("click", () => {
    const draft = chatFeedbackDraft;
    chatFeedbackDraft = null;
    const comment = $("#chat-feedback-comment").value.trim();
    $("#chat-feedback-dialog").close();
    if (draft) void recordChatFeedback(draft, comment);
  });
  // 取消/关闭对话框：通知原生界面清除按钮的等待状态，不记录。
  $("#chat-feedback-dialog").addEventListener("close", () => {
    if (chatFeedbackDraft) {
      ackChatFeedback(chatFeedbackDraft.messageId, false, chatFeedbackDraft.value);
      chatFeedbackDraft = null;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && nativeChat.url) {
      nativeChat.graceUntil = Date.now() + NATIVE_CHAT_RESUME_MS;
    }
  });
}

/* ============ 原生对话反馈（接管 DSH 评价按钮，只记录在本系统） ============ */
let chatFeedbackDraft = null;

function ackChatFeedback(messageId, ok, value) {
  const frame = $("#native-chat-frame");
  if (!frame?.contentWindow || !frame.src) return;
  frame.contentWindow.postMessage(
    { type: "knowweave:chat-feedback-ack", messageId, ok, value },
    new URL(frame.src, location.href).origin,
  );
}

async function recordChatFeedback(draft, comment) {
  try {
    await api("/chat-feedback", {
      method: "POST",
      body: {
        session_id: draft.sessionId,
        message_id: draft.messageId,
        value: draft.value,
        comment: comment || undefined,
        context: draft.context || undefined,
      },
    });
    ackChatFeedback(draft.messageId, true, draft.value);
    toast("感谢你的反馈，已记录到本系统");
  } catch (error) {
    ackChatFeedback(draft.messageId, false, draft.value);
    toast(error.message);
  }
}

function handleChatFeedback(data) {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const messageId = typeof data.messageId === "string" ? data.messageId : "";
  const value = data.value === 1 ? 1 : data.value === -1 ? -1 : 0;
  if (!sessionId || !messageId || !value) return;
  const draft = {
    sessionId, messageId, value,
    context: typeof data.context === "string" ? data.context : "",
  };
  if (value === 1) {
    void recordChatFeedback(draft, "");
    return;
  }
  chatFeedbackDraft = draft;
  $("#chat-feedback-comment").value = "";
  $("#chat-feedback-dialog").showModal();
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
  if (state.page !== returnPage) restorePageFromUrl();
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
  return safe.replace(/[ \t]*\[(\d{1,2})\]/g, (match, number) => `<button type="button" class="cite" data-cite="${number}" aria-label="证据 ${number}">${number}</button>`);
}

function answerHtml(text, refused) {
  const linked = linkifyCitations(text, refused);
  return renderMarkdown(linked);
}

// 模型输出带轻度 markdown：只处理粗体、行内代码、小标题、列表与分隔线。
function renderMarkdown(text, headingTag = "h3") {
  const inline = (value) => value
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = String(text).split("\n");
  const out = [];
  let list = null;
  let paragraph = [];
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
    list = null;
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const flush = () => { flushParagraph(); flushList(); };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    if (heading) { flush(); out.push(`<${headingTag}>${inline(heading[1])}</${headingTag}>`); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); out.push("<hr>"); continue; }
    const bullet = line.match(/^(?:[-*·]\s+|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      flushParagraph();
      const tag = /^\d/.test(line) ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(inline(line));
  }
  flush();
  return out.join("");
}

function setupAsk() {
  let composing = false;
  $$("#mode-tabs [data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$("#mode-tabs [data-mode]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", active ? "true" : "false");
      });
      applyModeHints();
    });
  });
  $("#ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runAsk();
  });
  const question = $("#question");
  question.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runAsk();
  });
  question.addEventListener("input", (event) => {
    // 输入法组字期间不动输入框：改高度/选区会打断组字，标记可能停在旧位置。
    if (event.isComposing || composing) return;
    resizeAskInput();
  });
  question.addEventListener("compositionstart", () => { composing = true; });
  question.addEventListener("compositionend", () => { composing = false; resizeAskInput(); });
  // 已有文字时插入点默认落在末尾：否则点进输入框会在旧文字开头继续写，
  // 拼音组字的标记也跟着画在开头。拖选、双击选词仍然保持原生行为。
  question.addEventListener("focus", () => {
    if (composing) return;
    moveCaretToEnd(question);
  });
  question.addEventListener("mouseup", (event) => {
    if (composing || event.detail > 1) return;
    if (question.selectionStart !== question.selectionEnd) return;
    moveCaretToEnd(question);
  });
  $("#ask-result").addEventListener("click", (event) => {
    const sample = event.target.closest("[data-sample]");
    if (!sample) return;
    fillAsk(sample.dataset.sample);
    runAsk();
  });
  applyModeHints();
  resizeAskInput();
}

function resizeAskInput() {
  const input = $("#question");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function moveCaretToEnd(input) {
  if (typeof input.setSelectionRange !== "function") return;
  const end = input.value.length;
  if (input.selectionStart === end && input.selectionEnd === end) return;
  input.setSelectionRange(end, end);
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

async function runAsk(retryPayload = null) {
  const input = $("#question");
  const question = retryPayload?.question ?? input.value.trim();
  if (!question) { toast("问题不能为空"); return; }
  const button = $("#ask-btn");
  if (button.disabled) return;
  const token = state.token;
  const payload = retryPayload ?? askPayload(question, state.conversationId);
  $(".ask-layout").classList.remove("is-empty");
  setBusy(button, true, "检索中");
  $("#ask-result").innerHTML = `<article class="answer answer-loading">${loadingLines()}</article>`;
  $("#evidence-gate").innerHTML = "";
  $("#evidence-count").textContent = "";
  $("#evidence-body").innerHTML = loadingLines();
  try {
    const result = await api("/ask", { method: "POST", body: payload });
    if (state.token !== token) return;
    state.lastAsk = result;
    state.conversationId = result.conversation_id;
    renderAsk(result, question);
    input.value = "";
    resizeAskInput();
    // 提问后回到最近视图：若刚在归档会话里提问，它已自动恢复。
    state.showArchivedConversations = false;
    loadConversations();
    loadDashboard();
  } catch (error) {
    if (state.token !== token) return;
    $("#ask-result").innerHTML = `<article class="answer"><div class="answer-error">${esc(error.message)}</div><button class="btn" id="retry-ask" type="button">重试这次提问</button></article>`;
    $("#retry-ask").addEventListener("click", () => runAsk(payload));
    $("#evidence-body").innerHTML = `<div class="rail-empty">暂无证据</div>`;
    $(".ask-layout").classList.add("is-empty");
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

function askEmptyHtml() {
  const samples = askSamples();
  return `<div class="ask-empty">
    <div class="ask-empty-lead">
      <h2>从一条具体问题开始</h2>
      <p>问题问得越具体，召回的片段越准。最高检索分达到阈值后，系统才会根据排序入围的原文生成回答。</p>
      <div class="ask-samples">
        <span class="ask-samples-label">试着问</span>
        ${samples.map((question) => `<button class="ask-sample" type="button" data-sample="${esc(question)}">${esc(question)}</button>`).join("")}
      </div>
    </div>
    <div class="ask-empty-steps">
      <div class="ask-step"><span>1</span><div><b>召回</b><p>混合检索从全部文档中取候选片段</p></div></div>
      <div class="ask-step"><span>2</span><div><b>重排与阈值</b><p>按分数排序选取片段，检查最高分是否达到作答阈值</p></div></div>
      <div class="ask-step"><span>3</span><div><b>成文与引用</b><p>答案逐句标注编号，可回到原文定位</p></div></div>
    </div>
  </div>`;
}

function askSamples() {
  const titles = (state.stats?.recent_documents || []).slice(0, 2).map((doc) => shortTitle(doc.title));
  const samples = titles.map((title) => `《${title}》里有哪些硬性要求？`);
  samples.push("这几份文档之间有没有互相矛盾的说法？");
  while (samples.length < 3) samples.push("最近入库的文档主要讲了什么？");
  return samples.slice(0, 3);
}

function shortTitle(title) {
  const text = String(title || "")
    .split(/[_—·|(（]/)[0]
    .replace(/\s+/g, " ")
    .trim() || "未命名文档";
  return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

function renderScope(stats) {
  const write = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = num(Number(value) || 0);
  };
  write("scope-docs", stats?.documents);
  write("scope-chunks", stats?.chunks);
  write("scope-entities", stats?.entities);
  write("scope-facts", stats?.facts_active);
}

function applyModeHints() {
  const modes = state.meta?.modes || [];
  $$("#mode-tabs [data-mode]").forEach((button) => {
    const description = modes.find((item) => item.id === button.dataset.mode)?.description;
    if (description) button.setAttribute("data-hover-tip", description);
  });
}

function fillAsk(question) {
  const input = $("#question");
  if (!input) return;
  input.value = question;
  resizeAskInput();
  input.focus();
}

function answerFailureHtml(answer, failure) {
  const { stage, queries, selected, excluded, verification } = failure;
  const score = (value) => Number(value).toFixed(3);
  const reachedDraft = stage === "grounding" || stage === "model_refusal";
  const sourceButton = (item, position, label) =>
    `<button type="button" class="text-btn failure-source" data-failure-source="${position}">${esc(label || item.doc_title)}</button>`;
  const sourceRow = (item, position, status) => {
    const location = [item.page ? `第 ${item.page} 页` : "", ...(item.heading_path || [])].filter(Boolean).join(" · ");
    return `<li>
      ${item.index ? `<span class="failure-source-index">[${num(item.index)}]</span> ` : ""}${sourceButton(item, position)}
      <span class="failure-meta">${location ? `${esc(location)} · ` : ""}重排分 ${score(item.rerank)}${status ? ` · ${esc(status)}` : ""}</span>
      <blockquote>${esc(item.quote)}</blockquote>
    </li>`;
  };
  const rows = (items) => `<ul class="failure-list">${items.join("")}</ul>`;
  const selectedRows = selected.map((item, position) => sourceRow(item, position, ""));
  const excludedRows = excluded.map((item, position) => sourceRow(item, position + selected.length,
    item.reason === "query_limit" ? "排序超出单次检索保留名额" : "排序超出本轮作答片段名额"));
  const issues = verification.issues.map((issue) => {
    const referenced = issue.evidence_indices.flatMap((index) => {
      const position = selected.findIndex((item) => item.index === index);
      return position < 0 ? [] : [sourceButton(selected[position], position, `片段 [${num(index)}]`)];
    });
    return `<li>
      ${issue.claim ? `<blockquote>${esc(issue.claim)}</blockquote>` : ""}
      <p>${esc(issue.reasons.join("；"))}。${issue.claim && !issue.evidence_indices.length ? "系统无法根据引用定位这句话对应的原文。" : ""}</p>
      ${referenced.length ? `<p class="failure-references">模型标注的原文 ${referenced.join(" ")}</p>` : ""}
    </li>`;
  });
  return `<div class="answer-failure">
    <p class="failure-summary">${esc(cleanAnswer(answer, true))}</p>
    <section>
      <h3>检索到了什么</h3>
      <p>执行了 ${num(queries.length)} 条检索语句，重排后共有 ${num(failure.ranked_count)} 条不同的原文片段。${
        failure.ranked_count ? `排序入围 ${num(failure.ranked_count - failure.excluded_count)} 条。${reachedDraft ? "" : "因最高分未达作答阈值，这些片段未送入回答生成。"}` : ""}</p>
      ${selectedRows.length ? rows(selectedRows.slice(0, 3)) : ""}
      ${selectedRows.length > 3 ? `<details><summary>查看其余 ${num(selectedRows.length - 3)} 条入围片段</summary>${rows(selectedRows.slice(3))}</details>` : ""}
      ${queries.length ? `<details><summary>查看实际检索语句</summary>${rows(queries.map((query) => `<li>${esc(query)}</li>`))}</details>` : ""}
    </section>
    <section>
      <h3>哪些片段未采用</h3>
      <p>${failure.excluded_count ? `${num(failure.excluded_count)} 条原文片段因排序名额未入围。` : "排序后没有因名额被排除的片段。"}${
        failure.fusion_excluded_count || failure.acl_excluded_count ? " 以下次数按检索语句累计。" : ""}</p>
      ${failure.query_limit_count ? `<p>${num(failure.query_limit_count)} 条超出单次检索保留名额。</p>` : ""}
      ${failure.excluded_count > failure.query_limit_count ? `<p>${num(failure.excluded_count - failure.query_limit_count)} 条超出本轮作答片段名额。</p>` : ""}
      ${failure.fusion_excluded_count ? `<p>${num(failure.fusion_excluded_count)} 次候选排序超出重排名额，未进入重排。</p>` : ""}
      ${failure.acl_excluded_count ? `<p>${num(failure.acl_excluded_count)} 次候选因访问权限被过滤。</p>` : ""}
      ${excludedRows.length ? rows(excludedRows.slice(0, 2)) : ""}
      ${excludedRows.length > 2 ? `<details><summary>查看其余 ${num(excludedRows.length - 2)} 条未入围样例</summary>${rows(excludedRows.slice(2))}</details>` : ""}
    </section>
    ${reachedDraft ? `<section>
      <h3>为什么无法回答</h3>
      <p>最高检索分 ${score(failure.top_score)} 已达到作答阈值 ${score(failure.threshold)}。</p>
      ${failure.model_reason ? `<p><strong>模型给出的原因</strong> ${esc(failure.model_reason)}</p>` : ""}
      ${stage === "grounding" ? `<p>问答模型收到你的问题和本轮入围的原文片段，先生成一份回答草稿。系统再逐条检查模型标注的引用能否支持对应表述。</p>
      <p>${verification.sentences
        ? `模型草稿中的 ${num(verification.sentences)} 条表述有 ${num(verification.supported)} 条通过原文核验。全部表述核验通过后，回答才会发布。`
        : "草稿中没有可核对的事实表述。"}${verification.semantic_rejected ? "独立语义核验未确认原文支持全部表述。" : ""}${verification.format_missing ? "草稿缺少对比模式要求的表格。" : ""}</p>` : ""}
      ${issues.length ? `<div class="failure-draft"><strong>模型生成的表述（未通过核验）</strong>${rows(issues)}</div>` : ""}
    </section>` : ""}
  </div>`;
}

function renderAsk(result, question = $("#question").value.trim() || "检索结果") {
  $(".ask-layout").classList.remove("is-empty");
  const refused = Boolean(result.refused);
  const failure = refused ? result.failure : null;
  const refusalLabel = failure?.stage === "grounding" ? "核验未通过" : "证据不足";
  const compact = refused || String(result.answer || "").length < 220;
  const modeName = state.meta?.modes?.find((mode) => mode.id === result.mode)?.name || result.mode || "";
  const confidence = Number(result.confidence) > 0 ? Math.round(Number(result.confidence) * 100) : 0;
  $("#ask-result").innerHTML = `
    <article class="answer ${compact ? "is-compact" : ""}">
      <header class="answer-head">
        <h2 class="answer-question" data-hover-tip="${esc(question)}">${esc(question)}</h2>
        <div class="answer-meta">
          <span class="pill ${refused ? "warn" : "ok"}">${refused ? refusalLabel : "已回答"}</span>
          <span class="meta-sep" aria-hidden="true"></span>
          <span>${esc(modeName)}</span>
          ${confidence ? `<span class="meta-sep" aria-hidden="true"></span><span>置信度 ${confidence}%</span>` : ""}
          ${result.latency_ms ? `<span class="meta-sep" aria-hidden="true"></span><span>${latencyLabel(result.latency_ms)}</span>` : ""}
        </div>
      </header>
      <div class="answer-body">${failure ? answerFailureHtml(result.answer, failure) : answerHtml(result.answer, refused)}</div>
      <footer class="answer-foot">
        <span class="answer-source">${refused ? "未发布回答或正式引用" : result.evidence?.length ? `基于 ${num(result.evidence.length)} 条证据` : "无引用片段"}</span>
        <div class="answer-actions">
          <button class="icon-btn" type="button" data-feedback="1" aria-label="有帮助" data-hover-tip="有帮助" data-hover-tip-delay="200">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 7.1 7.6 3.5a1.4 1.4 0 0 1 2.5 1.2L9.6 7h2.6a1.4 1.4 0 0 1 1.35 1.83l-1.1 3.6A1.4 1.4 0 0 1 11.1 13H5.6"/><rect x="2.4" y="7.1" width="2.4" height="5.9" rx="1.2"/></svg>
          </button>
          <button class="icon-btn is-flip" type="button" data-feedback="-1" aria-label="需改进" data-hover-tip="需改进" data-hover-tip-delay="200">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 7.1 7.6 3.5a1.4 1.4 0 0 1 2.5 1.2L9.6 7h2.6a1.4 1.4 0 0 1 1.35 1.83l-1.1 3.6A1.4 1.4 0 0 1 11.1 13H5.6"/><rect x="2.4" y="7.1" width="2.4" height="5.9" rx="1.2"/></svg>
          </button>
          ${result.trace_id ? `<button class="icon-btn" type="button" data-open-trace="${esc(result.trace_id)}" aria-label="查看轨迹" data-hover-tip="查看轨迹" data-hover-tip-delay="200">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.7" cy="11.3" r="1.5"/><circle cx="8.2" cy="7.3" r="1.5"/><circle cx="12.3" cy="4" r="1.5"/><path d="M4.9 10.2l2-1.8m2.4-1.9 1.8-1.6"/></svg>
          </button>` : ""}
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
  if (failure) {
    const sources = [...failure.selected, ...failure.excluded];
    $$("[data-failure-source]", $("#ask-result")).forEach((button) => {
      button.addEventListener("click", () => openCitation(sources[Number(button.dataset.failureSource)]));
    });
  }
  renderEvidence(result);
  renderRecentState();
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
  const evidence = result.evidence ?? result.failure?.selected ?? [];
  const facts = result.facts || [];
  const stats = result.stats || result.failure || {};
  const gate = $("#evidence-gate");
  const body = $("#evidence-body");
  const countEl = $("#evidence-count");
  gate.innerHTML = gateHtml(stats);
  if (!evidence.length) {
    countEl.textContent = "";
    body.innerHTML = facts.length ? factsHtml(facts) : `<div class="rail-empty">暂无证据</div>`;
    return;
  }
  countEl.textContent = `${result.failure?.stage === "below_threshold" ? "候选" : "入围"} ${num(evidence.length)} 条`;
  body.innerHTML = evidence.map((item, index) => {
    const number = item.index ?? index + 1;
    const score = Number(item.scores?.rerank ?? item.rerank);
    const path = (item.heading_path || []).slice(-2).join(" / ");
    const meta = [item.page ? `第 ${esc(item.page)} 页` : "正文", path ? esc(path) : ""].filter(Boolean).join(" · ");
    return `<button class="evr-item" type="button" data-evidence-index="${num(number)}">
      <span class="evr-head">
        <span class="evr-num">${num(number)}</span>
        <span class="evr-doc">${esc(item.doc_title || "未命名文档")}</span>
        ${Number.isFinite(score) ? `<span class="evr-score">${score.toFixed(3)}</span>` : ""}
      </span>
      <span class="evr-quote">${esc(plain(item.quote || item.text || ""))}</span>
      <span class="evr-meta">${meta} · 查看原文</span>
    </button>`;
  }).join("") + factsHtml(facts);
  $$("#evidence-body [data-evidence-index]").forEach((item, position) => {
    item.addEventListener("click", () => {
      $$("#evidence-body [data-evidence-index]").forEach((row) => row.classList.toggle("is-target", row === item));
      flashAskCite(Number(item.dataset.evidenceIndex));
      openCitation(evidence[position]);
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
  applyModeHints();
  if (state.stats) renderScope(state.stats);
  if ($("#ask-result .answer")) return;
  $(".ask-layout").classList.add("is-empty");
  $("#ask-result").innerHTML = askEmptyHtml();
  try {
    state.stats = await api("/stats");
  } catch (_) {
    return;
  }
  renderScope(state.stats);
  if (!$("#ask-result .answer")) $("#ask-result").innerHTML = askEmptyHtml();
}

async function loadConversations() {
  try {
    const suffix = state.showArchivedConversations ? "&archived=1" : "";
    const data = await api(`/conversations?limit=8${suffix}`);
    state.conversations = data.items;
    renderRecentState();
  } catch (_) { /* ignore */ }
}

function renderRecentState() {
  const target = $("#conversation-list");
  if (!target) return;
  const archivedView = state.showArchivedConversations;
  const items = state.conversations.slice(0, 8);
  if (!items.length && !archivedView) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }
  target.hidden = false;
  const rows = items.map((conversation) => `
    <button class="recent-item ${conversation.id === state.conversationId ? "active" : ""} ${archivedView ? "archived" : ""}" type="button" data-conversation="${esc(conversation.id)}" data-hover-tip="${esc(conversation.title || "未命名会话")}${archivedView ? "（已归档，继续提问会自动恢复）" : ""}">
      <span class="recent-title">${esc(conversation.title || "未命名会话")}</span>
      <span class="recent-time">${chatWhen(conversation.last_activity_at || conversation.created_at)}</span>
    </button>`).join("");
  const toggle = `<button class="recent-toggle" type="button" data-archive-toggle data-hover-tip="${archivedView ? "返回最近会话" : "查看已归档会话"}">${archivedView ? "最近" : "已归档"}</button>`;
  target.innerHTML = `<span class="recent-label">${archivedView ? "已归档" : "最近"}</span>` +
    (rows || `<span class="recent-empty">暂无归档会话</span>`) + toggle;
  $$("#conversation-list [data-conversation]").forEach((row) => {
    row.addEventListener("click", () => continueConversation(row.dataset.conversation));
  });
  $("#conversation-list [data-archive-toggle]")?.addEventListener("click", () => {
    state.showArchivedConversations = !state.showArchivedConversations;
    loadConversations();
  });
}

async function continueConversation(conversationId) {
  navigateToPage("ask");
  try {
    const data = await api(`/conversations/${encodeURIComponent(conversationId)}`);
    state.conversationId = conversationId;
    const messages = data.messages || [];
    const answer = [...messages].reverse().find((message) => message.role === "assistant");
    const question = [...messages].reverse().find((message) => message.role === "user");
    if (answer) {
      const result = { ...answer, answer: answer.content, message_id: answer.id, conversation_id: conversationId };
      state.lastAsk = result;
      renderAsk(result, question?.content || data.title);
    }
  } catch (error) {
    toast(error.message);
  }
}

const NODE_TYPE_LABEL = {
  concept: "概念",
  org: "机构",
  person: "人物",
  location: "地点",
  event: "事件",
  literal: "字面值",
  product: "产品",
  technology: "技术",
  tool: "工具",
};

function nodeTypeLabel(type) {
  return NODE_TYPE_LABEL[type] || type || "实体";
}

/* 标题里的计数按画布上实际出现的实体和关系算，别把被折叠的也算进去 */
function setEntitySub(drawnNodes, drawnEdges, hiddenNodes) {
  const count = $("#graph-count");
  if (!count) return;
  if (!drawnNodes) {
    count.textContent = "";
    return;
  }
  const folded = hiddenNodes > 0 ? `（还有 ${num(hiddenNodes)} 个未显示）` : "";
  count.textContent = `${num(drawnNodes)} 个实体 · ${num(drawnEdges)} 条关系${folded}`;
}

/* 实体列表与关系图谱两档布局：默认实体列表为主、图谱缩成小图；展开图谱时列表默认收起，只留图谱与描述 */
function applyEntityViewUI(view) {
  const layout = $("#entities-layout");
  if (layout) {
    layout.dataset.view = view;
    layout.dataset.rail = state.entityRail ? "shown" : "hidden";
  }
  const railToggle = $("#entity-rail-toggle");
  if (railToggle) {
    railToggle.setAttribute("aria-pressed", state.entityRail ? "true" : "false");
    railToggle.setAttribute("data-hover-tip", state.entityRail ? "收起实体列表，把空间留给图谱" : "展开实体列表，在图谱旁浏览实体");
  }
  const toggle = $("#graph-toggle");
  if (!toggle) return;
  const expanded = view === "graph";
  toggle.setAttribute("aria-pressed", expanded ? "true" : "false");
  toggle.setAttribute("data-hover-tip", expanded ? "收起图谱，回到实体列表" : "展开关系图谱");
  const label = toggle.querySelector("span");
  if (label) label.textContent = expanded ? "收起图谱" : "查看关系图谱";
}

function setEntityView(view) {
  const next = view === "graph" ? "graph" : "entity";
  state.entityView = next;
  localStorage.setItem("kw_entity_view", next);
  applyEntityViewUI(next);
  drawGraph();
}

function setupEntityView() {
  applyEntityViewUI(state.entityView);
  const hopsPicker = KnowWeavePickers.choice($("#graph-hops-picker"), {
    id: "graph-hops",
    label: "局部图谱跳数",
    value: String(state.graphHops),
    options: Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 跳` })),
    onChange: (value) => {
      state.graphHops = Number(value);
      loadGraph();
    },
  });
  $$("[data-graph-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.graphScope === "overview") hopsPicker.close();
      setGraphScope(button.dataset.graphScope);
      if (state.graphScope === "overview" && state.entityView !== "graph") setEntityView("graph");
      loadGraph();
    });
  });
  const size = $("#graph-overview-size");
  size.addEventListener("click", () => {
    state.graphOverviewZoom = !state.graphOverviewZoom;
    size.setAttribute("aria-pressed", String(state.graphOverviewZoom));
    size.textContent = state.graphOverviewZoom ? "适应画布" : "放大节点";
    drawGraph();
  });
  const toggle = $("#graph-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => setEntityView(state.entityView === "graph" ? "entity" : "graph"));
  }
  const railToggle = $("#entity-rail-toggle");
  if (railToggle) {
    railToggle.addEventListener("click", () => {
      state.entityRail = !state.entityRail;
      localStorage.setItem("kw_entity_rail", state.entityRail ? "shown" : "hidden");
      applyEntityViewUI(state.entityView);
      drawGraph();
    });
  }
  const canvas = $("#graph-canvas");
  if (canvas) setupGraphInteraction(canvas);
}

function setGraphScope(scope) {
  state.graphScope = scope;
  $("#graph-overview-size").hidden = scope !== "overview";
  $("#graph-hops-picker").hidden = scope !== "local";
  $$("[data-graph-scope]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.graphScope === scope));
  });
}

/* ============ Entities ============ */
async function loadEntities(q = "") {
  try {
    const data = await api(`/entities?limit=80${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const items = [...data.items].sort((a, b) => (b.facts || 0) - (a.facts || 0) || a.name.localeCompare(b.name, "zh"));
    state.entities = items;
    const target = $("#entity-list");
    $("#entity-count").textContent = `${num(items.length)} 个`;
    if (!items.length) {
      target.innerHTML = `<div class="empty-block">暂无实体</div>`;
      return;
    }
    target.innerHTML = items.map((entity) => `
      <button class="row ${state.activeEntity === entity.id ? "selected" : ""}" type="button" data-entity="${esc(entity.id)}">
        <span class="row-main">
          <span class="row-title" data-hover-tip="${esc(entity.name)}">${esc(entity.name)}</span>
          <span class="row-sub">${esc(nodeTypeLabel(entity.type))} · ${num(entity.facts)} 条事实</span>
        </span>
      </button>`).join("");
    $$("#entity-list [data-entity]").forEach((row) => row.addEventListener("click", () => selectEntity(row.dataset.entity)));
    const hasActive = items.some((entity) => entity.id === state.activeEntity);
    if (!hasActive && items[0] && state.graphScope === "local"
        && (!state.activeEntity || q || state.graph.error)) selectEntity(items[0].id);
  } catch (error) {
    toast(error.message);
  }
}

async function selectEntity(entityId) {
  state.activeEntity = entityId;
  $$("#entity-list [data-entity]").forEach((row) => row.classList.toggle("selected", row.dataset.entity === entityId));
  if (state.graphScope === "overview") {
    $$("#graph-canvas .g-overview-node").forEach((node) => {
      node.classList.toggle("selected", node.dataset.entity === entityId);
    });
  } else {
    loadGraph();
  }
  const target = $("#entity-detail");
  target.innerHTML = loadingLines();
  try {
    const data = await api(`/entities/${entityId}`);
    if (state.activeEntity !== entityId) return;
    const entity = data.entity;
    const facts = data.facts || [];
    const documents = data.documents || [];
    target.innerHTML = `
      <div class="entity-detail-main">
        <div class="entity-head"><h2>${esc(entity.name)}</h2></div>
        <div class="entity-tags">
          <span class="pill">${esc(nodeTypeLabel(entity.type))}</span>
          <span class="pill ${entity.acl_label === "全员可见" ? "" : "warn"}">${esc(entity.acl_label)}</span>
        </div>
        ${entity.description ? `<p class="entity-desc">${esc(plain(entity.description))}</p>` : ""}

        <div class="entity-section">
          <div class="entity-section-head"><h3>关系</h3><span>${num(facts.filter((fact) => fact.object_id).length)} 条</span></div>
          ${facts.some((fact) => fact.object_id) ? entityFactGroups(facts.filter((fact) => fact.object_id), entity) : `<div class="rail-empty">暂无实体间关系</div>`}
        </div>

        <div class="entity-section">
          <div class="entity-section-head"><h3>属性</h3><span>${num(facts.filter((fact) => !fact.object_id).length)} 条</span></div>
          ${facts.some((fact) => !fact.object_id) ? entityFactGroups(facts.filter((fact) => !fact.object_id), entity) : `<div class="rail-empty">暂无属性</div>`}
        </div>

        <div class="entity-section">
          <div class="entity-section-head"><h3>相关文档</h3><span>${num(documents.length)} 份</span></div>
          <div class="doc-links">
            ${documents.map((doc) => `<button class="doc-link" type="button" data-doc="${esc(doc.id)}">${esc(doc.title)}</button>`).join("") || `<div class="rail-empty">暂无</div>`}
          </div>
        </div>
      </div>
      <div class="entity-detail-foot">
        <button class="entity-act" type="button" data-entity-edit>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 12.6h2.1l6.2-6.2-2.1-2.1-6.2 6.2v2.1Z"/><path d="M10.6 3.3l.9-.9a.9.9 0 0 1 1.3 0l.8.8a.9.9 0 0 1 0 1.3l-.9.9"/></svg>
          编辑
        </button>
        <button class="entity-act danger" type="button" data-entity-remove>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.9 4.6h10.2M6.4 4.6V3.2h3.2v1.4M4.7 4.6l.5 8.2h5.6l.5-8.2"/></svg>
          删除
        </button>
      </div>`;
    $$("#entity-detail [data-doc]").forEach((button) => button.addEventListener("click", () => openDoc(button.dataset.doc)));
    const editButton = $("#entity-detail [data-entity-edit]");
    if (editButton) editButton.addEventListener("click", () => openEntityDialog(entity));
    const removeButton = $("#entity-detail [data-entity-remove]");
    if (removeButton) {
      removeButton.addEventListener("click", () =>
        openEntityDelete(entity, facts.filter((fact) => fact.subject_id === entity.id).length),
      );
    }
  } catch (error) {
    if (state.activeEntity === entityId) target.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

const ENTITY_TYPE_OPTIONS = ["concept", "org", "person", "location", "event", "literal"];

function fillEntityTypes(current) {
  const known = new Set(ENTITY_TYPE_OPTIONS);
  const extra = new Set();
  [...state.entities, ...(state.graph?.nodes || [])].forEach((node) => {
    const type = node?.type;
    if (type && !known.has(type)) extra.add(type);
  });
  if (current && !known.has(current)) extra.add(current);
  const types = [...ENTITY_TYPE_OPTIONS, ...[...extra].sort()];
  entityTypePicker.setOptions(types.map((type) => ({ value: type, label: nodeTypeLabel(type) })), current || "concept");
}

function openEntityDialog(entity) {
  const dialog = $("#entity-dialog");
  if (!dialog) return;
  $("#entity-dialog-title").textContent = `编辑实体 · ${entity.name}`;
  $("#entity-name").value = entity.name || "";
  fillEntityTypes(entity.type);
  $("#entity-description").value = entity.description || "";
  const hint = $("#entity-form-hint");
  hint.hidden = true;
  hint.textContent = "";
  $("#entity-form").dataset.entityId = entity.id;
  if (!dialog.open) dialog.showModal();
  $("#entity-name").focus();
  $("#entity-name").select();
}

async function saveEntity(form) {
  const entityId = form.dataset.entityId;
  const button = $("#entity-save", form);
  const name = $("#entity-name", form).value.trim();
  const hint = $("#entity-form-hint");
  if (!entityId || !name) {
    hint.hidden = false;
    hint.textContent = "实体名称不能为空";
    return;
  }
  setBusy(button, true, "保存中");
  try {
    await api(`/entities/${entityId}`, {
      method: "PATCH",
      body: { name, type: $("#entity-type", form).value, description: $("#entity-description", form).value.trim() },
    });
    $("#entity-dialog").close();
    toast("实体已更新");
    state.activeEntity = entityId;
    await loadEntities($("#entity-search").value.trim());
    await selectEntity(entityId);
    if (state.graphScope === "overview") await loadGraph();
  } catch (error) {
    hint.hidden = false;
    hint.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

function openEntityDelete(entity, subjectFacts) {
  const dialog = $("#entity-delete-dialog");
  if (!dialog) return;
  $("#entity-delete-title").textContent = `删除实体 · ${entity.name}`;
  const note = $("#entity-delete-note");
  note.innerHTML = subjectFacts
    ? `将以 <strong>${esc(entity.name)}</strong> 为主语的 <strong>${num(subjectFacts)}</strong> 条事实一并删除（含证据引用）；其它事实若只是把它当作宾语，则保留并把宾语降级为文本。删除后无法恢复。`
    : `该实体没有作为主语的事实，删除后仅移除实体与别名记录。删除后无法恢复。`;
  $("#entity-delete-confirm").dataset.entityId = entity.id;
  $("#entity-delete-confirm").dataset.entityName = entity.name;
  if (!dialog.open) dialog.showModal();
}

async function confirmEntityDelete(button) {
  const entityId = button.dataset.entityId;
  if (!entityId) return;
  setBusy(button, true, "删除中");
  try {
    const result = await api(`/entities/${entityId}`, { method: "DELETE" });
    $("#entity-delete-dialog").close();
    state.activeEntity = null;
    const details = [`已删除「${result.name}」`];
    if (result.facts_removed) details.push(`移除 ${num(result.facts_removed)} 条事实`);
    if (result.facts_unlinked) details.push(`${num(result.facts_unlinked)} 条事实转为文本`);
    if (result.reviews_closed) details.push(`关闭 ${num(result.reviews_closed)} 个待审项`);
    toast(details.join(" · "));
    $("#entity-detail").innerHTML = `<div class="empty-block">选择实体</div>`;
    state.graph = { focus: null, hops: 0, nodes: [], edges: [], hidden: { nodes: 0, edges: 0 } };
    renderGraph();
    await loadEntities($("#entity-search").value.trim());
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

/* 事实按关系类型分组：组头是归一后的关系类型，条目里保留原文谓语 */
function entityFactGroups(facts, entity) {
  const groups = new Map();
  facts.forEach((fact) => {
    const label = fact.relation?.label || "其它";
    const list = groups.get(label) || [];
    list.push(fact);
    groups.set(label, list);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([label, list]) => `<div class="fact-group">
      <div class="fact-group-head"><span>${esc(label)}</span><span>${num(list.length)}</span></div>
      ${list.map((fact) => entityFactHtml(fact, entity)).join("")}
    </div>`).join("");
}

function entityFactHtml(fact, entity) {
  const object = fact.object || fact.object_literal || "";
  const inbound = Boolean(fact.object_id) && fact.subject_id !== entity.id;
  const status = fact.status && fact.status !== "active" ? factPill(fact.status) : "";
  const date = fact.valid_from
    ? `${dayOnly(fact.valid_from)} → ${fact.valid_to ? dayOnly(fact.valid_to) : "至今"}`
    : (fact.recorded_at ? `记录于 ${dayOnly(fact.recorded_at)}` : "");
  const quote = fact.evidence?.[0]?.quote
    ? `<div class="fact-quote" data-hover-tip="${esc(plain(fact.evidence[0].quote))}">${esc(plain(fact.evidence[0].quote))}</div>`
    : "";
  return `<div class="entity-fact">
    <div class="fact-triple">
      ${inbound ? `<span class="fact-src">${esc(fact.subject)} →</span>` : ""}
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

let graphRequest = 0;

/* 取当前焦点指定跳数内的邻域；只认实体关系，字面值走属性条 */
async function loadGraph() {
  const focusId = state.activeEntity;
  const overview = state.graphScope === "overview";
  const token = ++graphRequest;
  if (!overview && !focusId) {
    if (state.entities[0]) return selectEntity(state.entities[0].id);
    state.graph = { focus: null, hops: 0, nodes: [], edges: [], hidden: { nodes: 0, edges: 0 } };
    renderGraph();
    return;
  }
  const hops = state.graphHops;
  if (state.graph.overview !== overview || (!overview && (state.graph.focus !== focusId || state.graph.hops !== hops))) {
    state.graph = { overview, nodes: [], edges: [], loading: true };
    renderGraph();
  }
  try {
    const data = await api(overview ? "/graph?scope=overview" : `/graph?focus=${encodeURIComponent(focusId)}&hops=${hops}&limit=80`);
    if (token !== graphRequest) return;   // 快速切换焦点或跳数时只渲染最新结果
    state.graph = { ...data, overview };
    renderGraph();
  } catch (error) {
    if (token !== graphRequest) return;
    if (state.graph.loading) {
      state.graph = { overview, nodes: [], edges: [], error: error.message };
      renderGraph();
    }
    toast(error.message);
  }
}


/* ============ 关系图谱 ============ */
/*
 * 阅读约定（与图例一致）：
 *   节点 = 有身份的实体；字面值不占节点，作为主语「属性」挂在节点上（图下方的属性条）。
 *   半径 = 跳数：焦点在中心，每一环对应与焦点的最短关系距离。
 *   连线 = 一条事实，箭头由主语指向宾语；线旁标出原文谓语（“筛查和发现”），
 *   不是归一后的类别名（“举措”）；类别只在悬停提示里说明，避免把动词读丢。
 *   位置不是装饰：同一关系类型的邻居相邻排列，肉眼能看出「这一类关系」。
 */
const GRAPH_NS = "http://www.w3.org/2000/svg";
let graphWheelScale = 1;
let graphDrag;
const graphNodeMoves = new WeakMap();

function stopGraphDrag(svg) {
  if (!graphDrag) return;
  const { pointerId, active } = graphDrag;
  graphDrag = null;
  if (!active) return;
  svg.classList.remove("is-dragging");
  if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
}

function setupGraphInteraction(svg) {
  let suppressClick = false;
  svg.addEventListener("wheel", zoomGraphAtPointer, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    suppressClick = false;
    if (event.button !== 0 || event.pointerType === "touch" || !state.graph?.nodes?.length) return;
    stopGraphDrag(svg);
    graphDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moveNode: graphNodeMoves.get(event.target.closest(".g-node, .g-focus-annotations")),
      active: false,
    };
  });

  window.addEventListener("pointermove", (event) => {
    const drag = graphDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      stopGraphDrag(svg);
      return;
    }
    const screenDx = event.clientX - drag.x;
    const screenDy = event.clientY - drag.y;
    if (!drag.active && Math.hypot(screenDx, screenDy) < 4) return;
    const matrix = svg.getScreenCTM()?.inverse();
    if (!matrix) return;
    if (!drag.active) {
      svg.setPointerCapture(event.pointerId);
      svg.classList.add("is-dragging");
      drag.active = true;
      suppressClick = true;
      if (hoverTooltipTarget) hideHoverTooltip();
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    const dx = matrix.a * screenDx + matrix.c * screenDy;
    const dy = matrix.b * screenDx + matrix.d * screenDy;
    if (drag.moveNode) {
      drag.moveNode(dx, dy);
    } else {
      const { x, y, width, height } = svg.viewBox.baseVal;
      svg.setAttribute("viewBox", `${x - dx} ${y - dy} ${width} ${height}`);
    }
  });

  const finish = (event) => {
    if (graphDrag?.pointerId === event.pointerId) stopGraphDrag(svg);
  };
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  svg.addEventListener("lostpointercapture", finish);
  window.addEventListener("blur", () => stopGraphDrag(svg));
  svg.addEventListener("click", (event) => {
    if (suppressClick && event.detail > 0) {
      suppressClick = false;
      event.stopImmediatePropagation();
      return;
    }
    // 缩略图的空白和关系标签仍可单击展开。
    if (state.entityView === "entity" && (event.target === svg || event.target.closest?.(".g-edge-tag"))) {
      setEntityView("graph");
    }
  }, true);
}

function positionGraphNode(group, point) {
  group.setAttribute("transform", `translate(${point.x},${point.y})`);
}

function bindGraphNodeMove(group, point, updateEdges) {
  const move = (dx, dy) => {
    point.x += dx;
    point.y += dy;
    positionGraphNode(group, point);
    for (const update of updateEdges) update();
  };
  graphNodeMoves.set(group, move);
  positionGraphNode(group, point);
  return move;
}

function zoomGraphAtPointer(event) {
  if (!state.graph?.nodes?.length || event.ctrlKey || event.shiftKey) return;
  const { currentTarget: svg, deltaMode, deltaY } = event;
  if (!deltaY) return;

  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  event.preventDefault();

  const pixelsPerUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? svg.clientHeight : 1;
  const scale = Math.min(6, Math.max(0.5, graphWheelScale * Math.exp(-deltaY * pixelsPerUnit * 0.002)));
  if (scale === graphWheelScale) return;

  const { x, y, width, height } = svg.viewBox.baseVal;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  // 用当前 SVG 坐标定位鼠标，缩放时保持该点在画布里的相对位置。
  const anchor = point.matrixTransform(matrix.inverse());
  const ratio = graphWheelScale / scale;
  const left = anchor.x - (anchor.x - x) * ratio;
  const top = anchor.y - (anchor.y - y) * ratio;
  svg.setAttribute("viewBox", `${left} ${top} ${width * ratio} ${height * ratio}`);
  graphWheelScale = scale;
}

function graphTextLabel(text, limit) {
  const chars = Array.from(String(text || ""));
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

/* 中文按 1.02 个字宽、西文按 0.58 估算，用来排标签框和避让 */
function graphTextWidth(text, size = 11) {
  return Array.from(String(text || "")).reduce(
    (width, ch) => width + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size * 1.02 : size * 0.58),
    0,
  );
}

/* 边与属性的标签：原文谓语优先，读者要看到“筛查和发现”这种动作，而不是“举措”这种归类 */
function graphRelationLabel(item) {
  const predicate = String((item && (item.predicate || item.label)) || "").trim();
  if (predicate) return predicate;
  return String((item && item.relation && item.relation.label) || "关系");
}

/* 关系类型短名（举措、目标值……）：只用于分组与悬停提示，不再直接当边标签 */
function graphRelationType(item) {
  const relation = item && item.relation;
  const label = relation && relation.label;
  return String(label || "其它");
}

function graphNodeRadius(node, compact, focusId) {
  if (node.id === focusId) return compact ? 15 : 22;
  const base = compact ? 6.5 : 9;
  return base + Math.min(compact ? 3 : 6, (node.degree || 0) * (compact ? 1.2 : 1.5));
}

/* 同一对实体、同一关系类型、同一状态的重复事实合并成一条线，标上 ×N，避免图上一排一模一样的弧线 */
function graphMergeEdges(edges) {
  const merged = [];
  const byKey = new Map();
  edges.forEach((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.relation?.key ?? edge.predicate}|${edge.status}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.predicates.push(edge.predicate);
      return;
    }
    const copy = { ...edge, count: 1, predicates: [edge.predicate] };
    byKey.set(key, copy);
    merged.push(copy);
  });
  return merged;
}

function graphEl(tag, className) {
  const el = document.createElementNS(GRAPH_NS, tag);
  if (className) el.setAttribute("class", className);
  return el;
}

/* 圆角标签框与已有内容的相交检测，用于把标签挤到不遮挡的位置 */
function graphLabelBox(x, y, width, anchor) {
  if (anchor === "start") return { x1: x - 5, x2: x + width + 5, y1: y - 11, y2: y + 4 };
  if (anchor === "end") return { x1: x - width - 5, x2: x + 5, y1: y - 11, y2: y + 4 };
  return { x1: x - width / 2 - 5, x2: x + width / 2 + 5, y1: y - 11, y2: y + 4 };
}

function graphBoxOverlaps(a, b) {
  return a.x2 > b.x1 && a.x1 < b.x2 && a.y2 > b.y1 && a.y1 < b.y2;
}

function graphBoxHitsCircle(box, circle) {
  const cx = Math.max(box.x1, Math.min(box.x2, circle.x));
  const cy = Math.max(box.y1, Math.min(box.y2, circle.y));
  return (circle.x - cx) ** 2 + (circle.y - cy) ** 2 < circle.r ** 2;
}

/* 标签一律画出来：越界就夹进画布，重叠就挑代价最小的候选位置，不再整块丢弃 */
function graphPlaceLabel(text, size, candidates, blockers, placed) {
  const width = graphTextWidth(text, size);
  let best = null;
  let bestScore = Infinity;
  candidates.forEach((candidate, index) => {
    const anchor = candidate.anchor || "middle";
    const box = graphLabelBox(candidate.x, candidate.y, width, anchor);
    let score = index * 0.4;
    blockers.forEach((circle) => {
      if (graphBoxHitsCircle(box, circle)) score += 5;
    });
    placed.forEach((other) => {
      if (graphBoxOverlaps(box, other)) score += 7;
    });
    if (score < bestScore) {
      bestScore = score;
      best = { x: candidate.x, y: candidate.y, anchor, box, index };
    }
  });
  placed.push(best.box);
  return { ...best, width, size };
}

/* 把锚点方向调到不会把文本顶出画布的一侧 */
function graphClampCandidate(candidate, textWidth, width, height) {
  const copy = { x: candidate.x, y: Math.min(Math.max(candidate.y, 14), height - 8), anchor: candidate.anchor || "middle" };
  // 只把坐标夹回画布，不翻转锚点：翻转会把文字压到节点自己身上
  if (copy.anchor === "start") copy.x = Math.min(copy.x, width - textWidth - 8);
  if (copy.anchor === "end") copy.x = Math.max(copy.x, textWidth + 8);
  if (copy.anchor === "middle") copy.x = Math.min(Math.max(copy.x, textWidth / 2 + 8), width - textWidth / 2 - 8);
  return copy;
}

/**
 * 焦点辐射布局：按 BFS 跳数分环，内环按关系类型分组排布，外环挂在父节点的角度上。
 */
function graphFocusLayout(nodes, edges, viewportWidth, viewportHeight, radiusOf, focusId, compact) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const focus = byId.get(focusId) || nodes[0];
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const focusEdge = new Map();
  edges.forEach((edge) => {
    if (!edge.target || !adjacency.has(edge.source) || !adjacency.has(edge.target)) return;
    adjacency.get(edge.source).push(edge.target);
    adjacency.get(edge.target).push(edge.source);
    if (edge.source !== focus.id && edge.target !== focus.id) return;
    const other = edge.source === focus.id ? edge.target : edge.source;
    const current = focusEdge.get(other);
    if (!current || (edge.confidence || 0) > (current.confidence || 0)) focusEdge.set(other, edge);
  });

  const hop = new Map([[focus.id, 0]]);
  const parent = new Map();
  const queue = [focus.id];
  while (queue.length) {
    const id = queue.shift();
    (adjacency.get(id) || []).forEach((other) => {
      if (hop.has(other)) return;
      hop.set(other, (hop.get(id) || 0) + 1);
      parent.set(other, id);
      queue.push(other);
    });
  }
  const hopOf = (id) => hop.get(id);

  const relationKey = (id) => {
    const edge = focusEdge.get(id);
    return edge ? graphRelationType(edge) : "～";
  };
  const neighbours = nodes
    .filter((node) => node.id !== focus.id && hopOf(node.id) === 1)
    .sort((a, b) => relationKey(a.id).localeCompare(relationKey(b.id), "zh")
      || (b.degree || 0) - (a.degree || 0)
      || a.name.localeCompare(b.name, "zh"));
  const farther = nodes
    .filter((node) => hopOf(node.id) > 1)
    .sort((a, b) => hopOf(a.id) - hopOf(b.id)
      || (b.degree || 0) - (a.degree || 0)
      || a.name.localeCompare(b.name, "zh"));

  const gaps = Math.max(0, Math.max(...hop.values()) - 1);
  const ringGap = compact ? 32 : 48;
  const r1Floor = radiusOf(focus) + (compact ? 20 : 34);
  const marginX = compact ? 54 : 70;
  const marginY = compact ? 26 : 42;
  // 跳数较多时扩大 SVG 的坐标空间，保留环间距，并让整张图仍可缩放查看。
  const minimumRadius = r1Floor + gaps * ringGap;
  const scale = Math.max(1, 2 * (minimumRadius + marginX) / viewportWidth, 2 * (minimumRadius + marginY) / viewportHeight);
  const width = Math.ceil(viewportWidth * scale);
  const height = Math.ceil(viewportHeight * scale);
  const center = { x: width / 2, y: height / 2 };
  const maxRing = Math.min(width / 2 - marginX, height / 2 - marginY);
  const stretch = Math.min(compact ? 2.1 : 1.35, (width / 2 - marginX) / maxRing);
  const ringNeed = (list) => list.reduce((sum, node) => sum + radiusOf(node) * 2 + (compact ? 20 : 34), 0) / (Math.PI * (stretch + 1));

  let inner = neighbours;
  // 环半径既要容得下所有邻居，也要把画布用起来：邻居很少时不要把图缩成中间一小团
  const r1Comfortable = maxRing * 0.72 / Math.max(1, (gaps + 1) / 2);
  const r1Ceiling = Math.max(r1Floor, Math.min(maxRing * 0.8, maxRing - gaps * ringGap));
  let r1 = r1Floor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    r1 = Math.min(Math.max(ringNeed(inner), r1Floor, r1Comfortable), r1Ceiling);
    const capacity = Math.max(1, Math.floor(Math.PI * r1 * (stretch + 1) / (compact ? 26 : 40)));
    const allowed = compact ? Math.min(capacity, 3) : capacity;
    if (inner.length <= allowed) break;
    inner = inner.slice(0, allowed);
  }

  const step = (maxRing - r1) / Math.max(1, gaps);
  const points = new Map([[focus.id, { ...center, angle: 0, ring: 0 }]]);
  const place = (node, angle, ring) => {
    const radius = r1 + (ring - 1) * step;
    points.set(node.id, { x: center.x + Math.cos(angle) * radius * stretch, y: center.y + Math.sin(angle) * radius, angle, ring });
  };
  // 邻居很少时横着摆，读起来像「中心 —关系→ 邻居」；多了才从正上方开始绕圈
  const angleAt = (index, count) => {
    if (count === 1) return 0;
    if (count === 2) return index === 0 ? 0 : Math.PI;
    return -Math.PI / 2 + (Math.PI * 2 * index) / count;
  };
  inner.forEach((node, index) => {
    place(node, angleAt(index, inner.length), 1);
  });

  const childrenByParent = new Map();
  farther.forEach((node) => {
    const owner = parent.get(node.id);
    const list = childrenByParent.get(owner) || [];
    list.push(node);
    childrenByParent.set(owner, list);
  });
  for (let ring = 2; ring <= gaps + 1; ring += 1) {
    const entries = [];
    childrenByParent.forEach((children, owner) => {
      const point = points.get(owner);
      if (point?.ring !== ring - 1) return;
      const shown = children.slice(0, compact ? 2 : 6);
      const spread = Math.min(0.42, 1.5 / (shown.length + 1));
      shown.forEach((node, index) => {
        entries.push({ node, angle: point.angle + (index - (shown.length - 1) / 2) * spread });
      });
    });
    const radius = r1 + (ring - 1) * step;
    separateGraphRing(entries, (compact ? 24 : 36) / radius);
    entries.forEach(({ node, angle }) => place(node, angle, ring));
  }

  return { focus, points, center, width, height, hidden: nodes.length - points.size };
}

function separateGraphRing(entries, minGap) {
  if (entries.length < 2) return;
  const turn = 2 * Math.PI;
  const wrap = (angle) => (angle % turn + turn) % turn;
  entries.forEach((entry) => { entry.angle = wrap(entry.angle); });
  entries.sort((a, b) => a.angle - b.angle);

  // 从最宽的空隙切开圆环，逐个拉开可能来自不同分支的重叠节点。
  let widest = -1;
  let start = 0;
  entries.forEach(({ angle }, index) => {
    const next = entries[index + 1]?.angle ?? entries[0].angle + turn;
    if (next - angle <= widest) return;
    widest = next - angle;
    start = angle + widest / 2;
  });
  entries.forEach((entry) => { entry.angle = wrap(entry.angle - start); });
  entries.sort((a, b) => a.angle - b.angle);
  const gap = Math.min(minGap, turn / entries.length);
  let floor = gap / 2;
  for (const entry of entries) {
    entry.angle = Math.max(floor, entry.angle);
    floor = entry.angle + gap;
  }
  let ceiling = turn - gap / 2;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    ceiling = Math.min(ceiling, entry.angle);
    entry.angle = start + ceiling;
    ceiling -= gap;
  }
}

function positionGraphArrow(arrow, tip, direction) {
  const length = 6.5;
  const half = 3.4;
  const baseX = tip.x - direction.x * length;
  const baseY = tip.y - direction.y * length;
  const perpendicularX = -direction.y * half;
  const perpendicularY = direction.x * half;
  arrow.setAttribute(
    "d",
    `M${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${(baseX + perpendicularX).toFixed(1)},${(baseY + perpendicularY).toFixed(1)} L${(baseX - perpendicularX).toFixed(1)},${(baseY - perpendicularY).toFixed(1)} Z`,
  );
}

let hoverTooltipTimer;
let hoverTooltipTarget;

function hideHoverTooltip() {
  clearTimeout(hoverTooltipTimer);
  hoverTooltipTarget = null;
  const tooltip = $("#hover-tooltip");
  tooltip.hidden = true;
  if (tooltip.parentElement !== document.body) document.body.appendChild(tooltip);
}

function setupHoverTooltip() {
  const tooltip = $("#hover-tooltip");
  const selector = "[data-hover-tip]";
  const position = (event) => {
    const left = Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8);
    const below = event.clientY + 16;
    const top = below + tooltip.offsetHeight <= window.innerHeight - 8
      ? below : event.clientY - tooltip.offsetHeight - 8;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  };
  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest(selector);
    if (!target || target === hoverTooltipTarget || event.pointerType === "touch") return;
    hideHoverTooltip();
    hoverTooltipTarget = target;
    const delay = Number(target.getAttribute("data-hover-tip-delay")) || 300;
    hoverTooltipTimer = setTimeout(() => {
      if (!target.isConnected || !target.getClientRects().length) return;
      const text = target.getAttribute("data-hover-tip");
      if (!text) return;
      const dialog = target.closest("dialog[open]");
      if (dialog) dialog.appendChild(tooltip);
      tooltip.textContent = text;
      tooltip.hidden = false;
      position(event);
    }, delay);
  });
  document.addEventListener("pointermove", (event) => {
    if (tooltip.hidden || !hoverTooltipTarget?.contains(event.target)) return;
    tooltip.textContent = hoverTooltipTarget.getAttribute("data-hover-tip");
    position(event);
  });
  document.addEventListener("pointerout", (event) => {
    if (hoverTooltipTarget && event.relatedTarget?.closest?.(selector) !== hoverTooltipTarget) hideHoverTooltip();
  });
  document.addEventListener("scroll", hideHoverTooltip, true);
  document.addEventListener("pointerdown", hideHoverTooltip);
  document.addEventListener("close", hideHoverTooltip, true);
  window.addEventListener("blur", hideHoverTooltip);
}

function renderGraphAttrs() {
  const strip = $("#graph-attrs");
  if (!strip) return;
  const data = state.graph || {};
  const focus = (data.nodes || []).find((node) => node.id === (data.focus || state.activeEntity));
  const attrs = (focus && focus.attrs) || [];
  const hasRelations = (data.edges || []).some((edge) => edge.target);
  // 没有实体关系时属性已经画在画布上，不再重复一条属性条
  if (data.overview || !attrs.length || !hasRelations) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  const shown = attrs.slice(0, 3);
  strip.hidden = false;
  strip.innerHTML = `<span class="graph-attrs-label">属性</span>`
    + shown.map((attr) => `<span class="graph-attr" data-hover-tip="${esc(`${graphRelationLabel(attr)}：${attr.value}`)}">`
      + `<b>${esc(graphRelationLabel(attr))}</b>${esc(attr.value)}</span>`).join("")
    + (attrs.length > shown.length ? `<span class="graph-attr more">还有 ${num(attrs.length - shown.length)} 条</span>` : "");
}

function renderGraph() {
  // 先铺属性条，再按实际剩余高度画图，避免画布被属性条挤扁后拉伸变形
  renderGraphAttrs();
  drawGraph();
}

function layoutGraphOverview(nodes, edges, width, height) {
  const neighbours = new Map(nodes.map(({ id }) => [id, new Set()]));
  for (const { source, target } of edges) {
    neighbours.get(source).add(target);
    neighbours.get(target).add(source);
  }
  const ordered = [...nodes].sort((a, b) =>
    neighbours.get(b.id).size - neighbours.get(a.id).size || b.degree - a.degree);
  const seen = new Set();
  const trees = [];
  const isolated = [];
  for (const { id } of ordered) {
    if (seen.has(id)) continue;
    if (!neighbours.get(id).size) {
      isolated.push(id);
      continue;
    }
    const root = { id, depth: 0, children: [], leaves: 1 };
    const entries = [root];
    seen.add(id);
    for (const parent of entries) {
      for (const next of neighbours.get(parent.id)) {
        if (seen.has(next)) continue;
        const child = { id: next, depth: parent.depth + 1, children: [], leaves: 1 };
        seen.add(next);
        parent.children.push(child);
        entries.push(child);
      }
    }
    // 每个分支的角度由它的叶节点数决定，避免不同分支互相穿过。
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.children.length) entry.leaves = entry.children.reduce((sum, child) => sum + child.leaves, 0);
    }
    trees.push({ root, depth: entries.at(-1).depth });
  }

  const [main, ...outer] = trees;
  const turn = Math.PI * 2;
  const points = new Map();
  let seed = 37;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const project = (tree, heading, sweep, step) => {
    const result = new Map();
    const queue = [{ entry: tree.root, start: heading - sweep / 2, sweep, x: 0, y: 0 }];
    for (const sector of queue) {
      const { entry, x, y } = sector;
      result.set(entry.id, { x, y });
      let angle = sector.start;
      for (const child of entry.children) {
        const span = sector.sweep * child.leaves / entry.leaves;
        const direction = angle + span * (0.28 + random() * 0.44);
        const length = step * (0.72 + random() * 0.56);
        queue.push({ entry: child, start: angle, sweep: span,
          x: x + Math.cos(direction) * length, y: y + Math.sin(direction) * length });
        angle += span;
      }
    }
    return result;
  };

  const aspect = Math.max(0.75, Math.min(2.5, width / height));
  const area = Math.max(65000, (nodes.length - isolated.length) * 7400 + isolated.length * 1550);
  const halfWidth = Math.sqrt(area * aspect) / 2;
  const halfHeight = Math.sqrt(area / aspect) / 2;
  const occupied = [];
  const put = (positions, dx, dy, box) => {
    for (const [id, point] of positions) points.set(id, { x: point.x + dx, y: point.y + dy });
    occupied.push({ x1: box.x1 + dx, x2: box.x2 + dx, y1: box.y1 + dy, y2: box.y2 + dy });
  };
  const bounds = (positions, horizontal, vertical) => {
    const box = { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity };
    for (const { x, y } of positions.values()) {
      box.x1 = Math.min(box.x1, x - horizontal);
      box.x2 = Math.max(box.x2, x + horizontal);
      box.y1 = Math.min(box.y1, y - vertical);
      box.y2 = Math.max(box.y2, y + vertical);
    }
    return box;
  };

  if (main) {
    const step = Math.max(122, main.root.leaves * 36 / turn);
    const positions = project(main, -1.2, turn, step);
    put(positions, 0, 0, bounds(positions, 44, 32));
  }
  // 给每组真实连线留出独立的空间。节点之间没有视觉边界。
  for (const tree of outer.sort((a, b) => b.root.leaves - a.root.leaves || b.depth - a.depth)) {
    const step = Math.max(54, tree.root.leaves * 12 / Math.PI);
    const positions = project(tree, random() * turn, Math.PI * 1.3, step);
    const box = bounds(positions, 20, 19);
    let best;
    for (let attempt = 0; !best; attempt += 1) {
      const expansion = 1 + Math.floor(attempt / 96) * 0.25;
      const x = (random() * 2 - 1) * halfWidth * expansion - (box.x1 + box.x2) / 2;
      const y = (random() * 2 - 1) * halfHeight * expansion - (box.y1 + box.y2) / 2;
      const candidate = { x1: x + box.x1, x2: x + box.x2, y1: y + box.y1, y2: y + box.y2 };
      if (!occupied.some((other) => graphBoxOverlaps(candidate, other))) best = { x, y };
    }
    put(positions, best.x, best.y, box);
  }
  // 独立节点散布在连线之间的空白处。
  const extent = bounds(points, 0, 0);
  const scatterWidth = Math.max(halfWidth, -extent.x1, extent.x2);
  const scatterHeight = Math.max(halfHeight, -extent.y1, extent.y2);
  const dot = { x1: -12, x2: 12, y1: -12, y2: 12 };
  for (const id of isolated) {
    for (let attempt = 0; ; attempt += 1) {
      const expansion = 1 + Math.floor(attempt / 96) * 0.2;
      const x = (random() * 2 - 1) * scatterWidth * expansion;
      const y = (random() * 2 - 1) * scatterHeight * expansion;
      const candidate = { x1: x + dot.x1, x2: x + dot.x2, y1: y + dot.y1, y2: y + dot.y2 };
      if (occupied.some((other) => graphBoxOverlaps(candidate, other))) continue;
      put(new Map([[id, { x: 0, y: 0 }]]), x, y, dot);
      break;
    }
  }
  const final = bounds(points, 72, 34);
  const canvasWidth = Math.max(-final.x1, final.x2) * 2;
  const canvasHeight = Math.max(-final.y1, final.y2) * 2;
  for (const point of points.values()) {
    point.x += canvasWidth / 2;
    point.y += canvasHeight / 2;
  }
  return { points, width: canvasWidth, height: canvasHeight, hub: main?.root.id, neighbours: neighbours.get(main?.root.id) };
}

function drawGraphOverview(svg, data, width, height) {
  const { nodes, edges } = data;
  const { points, width: canvasWidth, height: canvasHeight, hub, neighbours } = layoutGraphOverview(nodes, edges, width, height);
  const zoom = state.graphOverviewZoom ? 1.45 : 1;
  const scale = Math.min(width / canvasWidth, height / canvasHeight) * zoom;
  const viewWidth = Math.max(canvasWidth, width / scale);
  const viewHeight = Math.max(canvasHeight, height / scale);
  if (state.graphOverviewZoom) {
    svg.style.width = `${Math.ceil(viewWidth * scale)}px`;
    svg.style.height = `${Math.ceil(viewHeight * scale)}px`;
  }
  svg.setAttribute("viewBox", `${(canvasWidth - viewWidth) / 2} ${(canvasHeight - viewHeight) / 2} ${viewWidth} ${viewHeight}`);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const radiusOf = (node) => node.id === hub ? 15 : node.degree ? 5 + Math.min(node.degree, 4) : 3.5;
  const pairs = new Map();
  const incident = new Map(nodes.map((node) => [node.id, new Set()]));
  const edgeUpdates = new Map(nodes.map((node) => [node.id, new Set()]));
  edges.forEach((edge) => {
    const key = JSON.stringify([edge.source, edge.target].sort());
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge);
  });
  for (const pair of pairs.values()) {
    pair.forEach((edge, index) => {
      const a = points.get(edge.source);
      const b = points.get(edge.target);
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      const ra = radiusOf(source);
      const rb = radiusOf(target);
      const variant = edge.status === "disputed" ? "disputed" : "strong";
      const group = graphEl("g", `g-overview-edge${edge.source === hub || edge.target === hub ? " spoke" : ""}`);
      group.setAttribute("data-fact-id", edge.id);
      incident.get(edge.source).add(group);
      incident.get(edge.target).add(group);
      const path = graphEl("path", `g-link ${variant}`);
      const arrow = graphEl("path", `g-arrow ${variant}`);
      const update = () => {
        let end;
        let tangent;
        if (a === b) {
          const loop = ra + 15 + index * 7;
          const offset = ra * Math.SQRT1_2;
          end = { x: a.x + offset, y: a.y - offset };
          const control = { x: a.x + loop, y: a.y - loop };
          path.setAttribute("d", `M${a.x - offset},${end.y} C${a.x - loop},${control.y} ${control.x},${control.y} ${end.x},${end.y}`);
          tangent = { x: end.x - control.x, y: end.y - control.y };
        } else {
          const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const ux = (b.x - a.x) / distance;
          const uy = (b.y - a.y) / distance;
          const spacing = Math.min(18, distance / 2);
          const bow = (index - (pair.length - 1) / 2) * spacing * (edge.source < edge.target ? 1 : -1);
          const control = { x: (a.x + b.x) / 2 - uy * bow, y: (a.y + b.y) / 2 + ux * bow };
          const startLength = Math.hypot(control.x - a.x, control.y - a.y) || 1;
          const endLength = Math.hypot(b.x - control.x, b.y - control.y) || 1;
          const start = { x: a.x + (control.x - a.x) * ra / startLength, y: a.y + (control.y - a.y) * ra / startLength };
          end = { x: b.x - (b.x - control.x) * rb / endLength, y: b.y - (b.y - control.y) * rb / endLength };
          path.setAttribute("d", `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`);
          tangent = { x: b.x - control.x, y: b.y - control.y };
        }
        const length = Math.hypot(tangent.x, tangent.y) || 1;
        positionGraphArrow(arrow, end, { x: tangent.x / length, y: tangent.y / length });
      };
      edgeUpdates.get(edge.source).add(update);
      edgeUpdates.get(edge.target).add(update);
      update();
      group.setAttribute("data-hover-tip", `${source.name} — ${graphRelationLabel(edge)} → ${target.name}`);
      group.appendChild(path);
      group.appendChild(arrow);
      svg.appendChild(group);
    });
  }
  nodes.forEach((node) => {
    const point = points.get(node.id);
    const direct = neighbours?.has(node.id);
    const group = graphEl("g", `g-node g-overview-node${node.degree ? " linked" : ""}${node.id === hub ? " hub" : direct ? " neighbour" : ""}${node.id === state.activeEntity ? " selected" : ""}${state.graphOverviewZoom ? " zoomed" : ""}`);
    bindGraphNodeMove(group, point, edgeUpdates.get(node.id));
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("data-entity", node.id);
    group.setAttribute("aria-label", `查看 ${node.name} 的详情`);
    const shape = graphEl("circle", "g-shape");
    shape.setAttribute("r", String(radiusOf(node)));
    const label = graphEl("text", "g-label");
    label.setAttribute("text-anchor", "middle");
    const above = direct && point.y < canvasHeight / 2;
    label.setAttribute("y", String(above ? -radiusOf(node) - 6 : radiusOf(node) + 14));
    label.textContent = graphTextLabel(node.name, node.id === hub ? 24 : direct ? 15 : 10);
    group.setAttribute("data-hover-tip", node.name);
    group.appendChild(shape);
    group.appendChild(label);
    const highlight = (active) => {
      for (const edge of incident.get(node.id)) {
        if (active) edge.setAttribute("data-highlighted", "true");
        else edge.removeAttribute("data-highlighted");
      }
    };
    group.addEventListener("pointerenter", () => highlight(true));
    group.addEventListener("pointerleave", () => highlight(false));
    group.addEventListener("focus", () => highlight(true));
    group.addEventListener("blur", () => highlight(false));
    group.addEventListener("click", () => selectEntity(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectEntity(node.id);
    });
    svg.appendChild(group);
  });
  setEntitySub(nodes.length, edges.length, 0);
}

function drawGraph() {
  const svg = $("#graph-canvas");
  if (!svg) return;
  const data = state.graph || {};
  stopGraphDrag(svg);
  if (hoverTooltipTarget && svg.contains(hoverTooltipTarget)) hideHoverTooltip();
  $(".graph-stage").classList.toggle("graph-stage-overview", Boolean(data.overview));
  svg.style.width = "";
  svg.style.height = "";
  graphWheelScale = 1;
  const viewportHeight = Math.max(200, Math.round(svg.clientHeight || 420));
  const allNodes = data.nodes || [];
  const allEdges = data.edges || [];
  svg.classList.toggle("is-pannable", allNodes.length > 0);
  const viewportWidth = Math.max(300, Math.round(svg.clientWidth || 620));
  svg.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
  svg.innerHTML = "";
  const legend = $("#graph-legend");
  if (legend) legend.innerHTML = "";

  if (!allNodes.length) {
    const text = graphEl("text", "g-empty");
    text.setAttribute("x", String(viewportWidth / 2));
    text.setAttribute("y", String(viewportHeight / 2));
    text.setAttribute("text-anchor", "middle");
    text.textContent = data.loading ? "正在加载图谱…" : data.error || "暂无实体关系";
    svg.appendChild(text);
    setEntitySub(null);
    return;
  }

  if (data.overview) {
    drawGraphOverview(svg, data, viewportWidth, viewportHeight);
    return;
  }

  const compact = viewportWidth < 430;
  const nodeFont = compact ? 9.5 : 11;
  const edgeFont = compact ? 9 : 10;
  const focusId = data.focus || state.activeEntity || allNodes[0].id;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const radiusOf = (node) => graphNodeRadius(node, compact, focusId);
  const drawnEdges = allEdges.filter((edge) => edge.target && nodeById.has(edge.source) && nodeById.has(edge.target));
  const layout = graphFocusLayout(allNodes, drawnEdges, viewportWidth, viewportHeight, radiusOf, focusId, compact);
  const { points, width, height } = layout;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const drawnNodes = allNodes.filter((node) => points.has(node.id));
  const edgeUpdates = new Map(drawnNodes.map((node) => [node.id, new Set()]));
  let edges = graphMergeEdges(drawnEdges.filter((edge) => points.has(edge.source) && points.has(edge.target)));
  // 缩略图太小，同一对实体的正反两条关系合并成一条，标上 ⇄，避免两条弧线挤在一起
  if (compact) {
    const seenPairs = new Map();
    edges = edges.filter((edge) => {
      const key = [edge.source, edge.target].sort().join("|");
      const first = seenPairs.get(key);
      if (first) {
        if (first.source !== edge.source) first.twin = true;
        return false;
      }
      seenPairs.set(key, edge);
      return true;
    });
  }

  const nodeCircles = drawnNodes.map((node) => ({ x: points.get(node.id).x, y: points.get(node.id).y, r: radiusOf(node) + 2 }));

  // 同一对实体之间存在多条关系（含正反两条）时，平行弯开，否则两条线完全重叠、箭头互相抵消
  const pairCounts = new Map();
  edges.forEach((edge) => {
    const key = [edge.source, edge.target].sort().join("|");
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  });
  const pairSeen = new Map();

  // 焦点没有实体关系时，把字面值属性画成节点下方的属性卡：值不是节点，所以不连线、不带箭头
  const focusNode = layout.focus;
  const focusAttrs = (focusNode && focusNode.attrs) || [];
  const attrChips = [];
  let moveFocus;
  if (!edges.length && focusAttrs.length) {
    const chipFont = compact ? 9 : 10.5;
    const rowHeight = compact ? 23 : 30;
    const focusRadius = radiusOf(focusNode);
    const top = layout.center.y + focusRadius + (compact ? 26 : 34);
    const maxRows = Math.max(0, Math.floor((height - top - 14) / rowHeight));
    const shown = focusAttrs.slice(0, Math.min(compact ? 3 : 5, maxRows));
    shown.forEach((attr, index) => {
      const full = `${graphRelationLabel(attr)} · ${attr.value}`;
      const text = `${graphRelationLabel(attr)} · ${graphTextLabel(attr.value, compact ? 9 : 16)}`;
      const chipWidth = Math.min(Math.max(84, graphTextWidth(text, chipFont) + 18), width - 24);
      const x = Math.min(Math.max(layout.center.x - chipWidth / 2, 10), width - chipWidth - 10);
      const y = top + index * rowHeight + rowHeight / 2;
      attrChips.push({ text, title: full, x, y, width: chipWidth, height: rowHeight });
    });
  }

  // 先画线，再画标签，最后画节点：节点永远压在标签之上，不会被文字盖住
  const placed = [];
  attrChips.forEach((chip) => {
    placed.push({ x1: chip.x, x2: chip.x + chip.width, y1: chip.y - chip.height / 2, y2: chip.y + chip.height / 2 });
  });
  edges.forEach((edge) => {
    const a = points.get(edge.source);
    const b = points.get(edge.target);
    const ra = radiusOf(nodeById.get(edge.source));
    const rb = radiusOf(nodeById.get(edge.target));
    const incident = edge.source === focusId || edge.target === focusId;
    const chord = a.ring !== 0 && a.ring === b.ring;
    const pairKey = [edge.source, edge.target].sort().join("|");
    const twinIndex = pairSeen.get(pairKey) || 0;
    pairSeen.set(pairKey, twinIndex + 1);
    const twin = (pairCounts.get(pairKey) || 0) > 1;
    const edgeGeometry = () => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const ux = dx / distance;
      const uy = dy / distance;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      let controlX = midX;
      let controlY = midY;
      if (twin || chord) {
        const sign = twinIndex % 2 === 0 ? 1 : -1;
        let px = -uy * sign;
        let py = ux * sign;
        if (!twin && px * (midX - layout.center.x) + py * (midY - layout.center.y) < 0) {
          px = -px;
          py = -py;
        }
        const bow = twin ? Math.min(distance * 0.22, compact ? 18 : 34) : Math.min(distance * 0.26, compact ? 22 : 40);
        controlX = midX + px * bow;
        controlY = midY + py * bow;
      }
      const start = { x: a.x + ux * (ra + 1), y: a.y + uy * (ra + 1) };
      const end = { x: b.x - ux * (rb + 4), y: b.y - uy * (rb + 4) };
      return { start, end, controlX, controlY, ux, uy };
    };
    const path = graphEl("path", `g-link${incident ? " strong" : ""}${edge.status === "disputed" ? " disputed" : ""}`);
    const arrowVariant = edge.status === "disputed" ? " disputed" : incident ? " strong" : "";
    const arrow = graphEl("path", `g-arrow${arrowVariant}`);
    const sourceName = nodeById.get(edge.source).name;
    const targetName = nodeById.get(edge.target).name;
    const predicateText = (edge.predicates || [edge.predicate]).join(" / ");
    const statusText = edge.status === "disputed" ? "存疑" : "有效";
    const confidenceText = edge.confidence != null ? ` · 置信度 ${edge.confidence}` : "";
    const description = `${sourceName} — ${predicateText}${edge.value ? `（${edge.value}）` : ""} → ${targetName}`
      + `\n关系类型：${graphRelationType(edge)} · ${statusText}${confidenceText}`;
    path.setAttribute("data-hover-tip", description);
    svg.appendChild(path);
    svg.appendChild(arrow);

    // 关系标签：短边也要显示，绕着中点换几个位置，永不丢弃
    const labelText = graphTextLabel(graphRelationLabel(edge), compact ? 6 : 8)
      + (edge.count > 1 ? ` ×${edge.count}` : "")
      + (edge.twin ? " ⇄" : "");
    const textWidth = graphTextWidth(labelText, edgeFont);
    const labelCandidates = ({ start, end, controlX, controlY, ux, uy }) => {
      const curveX = (start.x + 2 * controlX + end.x) / 4;
      const curveY = (start.y + 2 * controlY + end.y) / 4;
      const normalX = -uy;
      const normalY = ux;
      return [
        { x: curveX + normalX * 9, y: curveY + normalY * 9 },
        { x: curveX - normalX * 9, y: curveY - normalY * 9 },
        { x: start.x + (end.x - start.x) * 0.36 + normalX * 9, y: start.y + (end.y - start.y) * 0.36 + normalY * 9 },
        { x: start.x + (end.x - start.x) * 0.64 - normalX * 9, y: start.y + (end.y - start.y) * 0.64 - normalY * 9 },
        { x: curveX + normalX * 16, y: curveY + normalY * 16 },
      ];
    };
    const initialGeometry = edgeGeometry();
    const initialCandidates = labelCandidates(initialGeometry);
    const candidates = initialCandidates.map((candidate) => graphClampCandidate(candidate, textWidth, width, height));
    const label = graphPlaceLabel(labelText, edgeFont, candidates, nodeCircles, placed);
    const group = graphEl("g", "g-edge-tag");
    const background = graphEl("rect", "g-edge-bg");
    background.setAttribute("x", String(label.box.x1));
    background.setAttribute("y", String(label.box.y1));
    background.setAttribute("width", String(label.box.x2 - label.box.x1));
    background.setAttribute("height", String(label.box.y2 - label.box.y1));
    background.setAttribute("rx", "3");
    group.appendChild(background);
    const text = graphEl("text", "g-edge-label");
    text.setAttribute("x", String(label.x));
    text.setAttribute("y", String(label.y));
    text.setAttribute("text-anchor", label.anchor);
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = labelText;
    group.appendChild(text);
    // 标签是缩略后的谓语，悬停看完整原文：主语 — 全部谓语 → 宾语
    group.setAttribute("data-hover-tip", description);
    svg.appendChild(group);

    const initialAnchor = initialCandidates[label.index];
    const update = (geometry = edgeGeometry()) => {
      const { start, end, controlX, controlY } = geometry;
      path.setAttribute("d", `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${controlX.toFixed(1)},${controlY.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`);
      const arrowX = end.x - controlX;
      const arrowY = end.y - controlY;
      const arrowLength = Math.hypot(arrowX, arrowY) || 1;
      positionGraphArrow(arrow, end, { x: arrowX / arrowLength, y: arrowY / arrowLength });
      const anchor = labelCandidates(geometry)[label.index];
      group.setAttribute("transform", `translate(${anchor.x - initialAnchor.x},${anchor.y - initialAnchor.y})`);
    };
    edgeUpdates.get(edge.source).add(update);
    edgeUpdates.get(edge.target).add(update);
    update(initialGeometry);
  });

  // 节点标签：一律画出，先按「径向朝外」排，挤不下就换到上下方
  drawnNodes.forEach((node) => {
    const point = points.get(node.id);
    const radius = radiusOf(node);
    const limit = node.id === focusId ? (compact ? 8 : 14) : (compact ? 6 : 9);
    const labelText = graphTextLabel(node.name, limit);
    const textWidth = graphTextWidth(labelText, nodeFont);
    const ux = Math.cos(point.angle);
    const uy = Math.sin(point.angle);
    const anchor = Math.abs(ux) < 0.32 ? "middle" : ux > 0 ? "start" : "end";
    const candidates = [
      { x: point.x + ux * (radius + 8), y: point.y + uy * (radius + 8), anchor },
      { x: point.x + ux * (radius + 20), y: point.y + uy * (radius + 20), anchor },
      { x: point.x, y: point.y + radius + 26, anchor: "middle" },
      { x: point.x, y: point.y - radius - 18, anchor: "middle" },
    ].map((candidate) => graphClampCandidate(candidate, textWidth, width, height));
    // 标签不能压在任何节点上（包括它自己的），否则等于没标
    const label = graphPlaceLabel(labelText, nodeFont, candidates, nodeCircles, placed);
    node.text = labelText;
    node.textPoint = { x: label.x, y: label.y, anchor: label.anchor, size: nodeFont };
  });

  drawnNodes.forEach((node) => {
    const point = points.get(node.id);
    const radius = radiusOf(node);
    const typeClass = String(node.type || "").replace(/[^a-z]/gi, "").toLowerCase();
    const group = graphEl("g", `g-node${node.id === focusId ? " selected" : ""}`);
    const move = bindGraphNodeMove(group, point, edgeUpdates.get(node.id));
    if (node === focusNode) moveFocus = move;
    let shape;
    if (typeClass === "org" || typeClass === "product") {
      shape = graphEl("rect", "g-shape");
      shape.setAttribute("x", String(-radius));
      shape.setAttribute("y", String(-radius));
      shape.setAttribute("width", String(radius * 2));
      shape.setAttribute("height", String(radius * 2));
      shape.setAttribute("rx", "4");
    } else if (typeClass === "literal") {
      shape = graphEl("path", "g-shape");
      shape.setAttribute("d", `M0,${-radius} L${radius},0 L0,${radius} L${-radius},0 Z`);
    } else {
      shape = graphEl("circle", "g-shape");
      shape.setAttribute("r", String(radius));
    }
    group.appendChild(shape);

    // 关系类型字母不显示在节点里；属性数量用一个小角标提示
    if ((node.attrs || []).length) {
      const badge = graphEl("circle", "g-attr-badge");
      badge.setAttribute("cx", String(radius * 0.72));
      badge.setAttribute("cy", String(-radius * 0.72));
      badge.setAttribute("r", "3.2");
      group.appendChild(badge);
    }

    if (node.text && node.textPoint) {
      const text = graphEl("text", node.id === focusId ? "g-label selected-label" : "g-label");
      text.setAttribute("text-anchor", node.textPoint.anchor);
      text.setAttribute("x", String(node.textPoint.x - point.x));
      text.setAttribute("y", String(node.textPoint.y - point.y));
      text.setAttribute("font-size", String(nodeFont));
      text.textContent = node.text;
      group.appendChild(text);
    }

    const lines = [`${node.name} · ${nodeTypeLabel(node.type)}`, `关系 ${node.degree || 0} 条 · 属性 ${(node.attrs || []).length} 条`];
    (node.attrs || []).slice(0, 5).forEach((attr) => lines.push(`${graphRelationLabel(attr)}：${attr.value}`));
    group.setAttribute("data-hover-tip", lines.join("\n"));

    if (node.id !== focusId) {
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
    }
    svg.appendChild(group);
  });

  if (!edges.length) {
    const annotations = graphEl("g", "g-focus-annotations");
    const point = points.get(focusNode.id);
    graphNodeMoves.set(annotations, moveFocus);
    edgeUpdates.get(focusNode.id).add(() => {
      annotations.setAttribute("transform", `translate(${point.x - layout.center.x},${point.y - layout.center.y})`);
    });
    if (attrChips.length) {
      const focusRadius = radiusOf(focusNode);
      const leader = graphEl("line", "g-attr-leader");
      leader.setAttribute("x1", String(layout.center.x));
      leader.setAttribute("y1", String(layout.center.y + focusRadius + 2));
      leader.setAttribute("x2", String(layout.center.x));
      leader.setAttribute("y2", String(attrChips[0].y - attrChips[0].height / 2));
      annotations.appendChild(leader);
      attrChips.forEach((chip) => {
        const group = graphEl("g", "g-attr-chip");
        const box = graphEl("rect", "g-attr-chip-bg");
        box.setAttribute("x", String(chip.x));
        box.setAttribute("y", String(chip.y - chip.height / 2));
        box.setAttribute("width", String(chip.width));
        box.setAttribute("height", String(chip.height));
        box.setAttribute("rx", "5");
        group.appendChild(box);
        const text = graphEl("text", "g-attr-chip-text");
        text.setAttribute("x", String(chip.x + 9));
        text.setAttribute("y", String(chip.y));
        text.setAttribute("dominant-baseline", "middle");
        text.textContent = chip.text;
        group.appendChild(text);
        // 卡片里的值被截断时，悬停显示完整谓语与值
        group.setAttribute("data-hover-tip", chip.title || chip.text);
        annotations.appendChild(group);
      });
      const rest = focusAttrs.length - attrChips.length;
      if (rest > 0) {
        const text = graphEl("text", "g-hint");
        text.setAttribute("x", String(layout.center.x));
        text.setAttribute("y", String(attrChips[attrChips.length - 1].y + attrChips[attrChips.length - 1].height / 2 + 14));
        text.setAttribute("text-anchor", "middle");
        text.textContent = `还有 ${rest} 条属性，见右侧面板`;
        annotations.appendChild(text);
      }
    } else {
      const text = graphEl("text", "g-hint");
      text.setAttribute("x", String(layout.center.x));
      text.setAttribute("y", String(layout.center.y + radiusOf(layout.focus) + (compact ? 30 : 38)));
      text.setAttribute("text-anchor", "middle");
      text.textContent = "该实体没有实体间关系，也没有属性";
      annotations.appendChild(text);
    }
    svg.appendChild(annotations);
  }

  const hidden = (layout.hidden || 0) + ((data.hidden && data.hidden.nodes) || 0);
  const drawnFacts = edges.reduce((sum, edge) => sum + (edge.count || 1), 0);
  setEntitySub(drawnNodes.length, drawnFacts, hidden);
  if (hidden > 0) {
    const text = graphEl("text", "g-hint");
    text.setAttribute("x", String(width - 10));
    text.setAttribute("y", String(height - 8));
    text.setAttribute("text-anchor", "end");
    text.textContent = `还有 ${hidden} 个实体未显示`;
    svg.appendChild(text);
  }

  if (legend) {
    const types = [...new Set(drawnNodes.map((node) => node.type).filter(Boolean))];
    const typeItems = types.map((type) => {
      const typeClass = String(type).replace(/[^a-z]/gi, "").toLowerCase();
      return `<span class="graph-legend-item"><i class="graph-mark ${typeClass}"></i>${esc(nodeTypeLabel(type))}</span>`;
    });
    legend.innerHTML = typeItems.join("")
      + `<span class="graph-legend-item"><i class="graph-key line strong"></i>指向宾语</span>`
      + `<span class="graph-legend-item">边标签＝原文谓语，悬停看关系类型</span>`
      + `<span class="graph-legend-item"><i class="graph-key line"></i>有效</span>`
      + `<span class="graph-legend-item"><i class="graph-key line disputed"></i>存疑</span>`
      + `<span class="graph-legend-item"><i class="graph-key dot"></i>有属性</span>`;
  }
}

let graphResizeTimer = 0;
window.addEventListener("resize", () => {
  if (document.body.dataset.page !== "entities") return;
  window.clearTimeout(graphResizeTimer);
  graphResizeTimer = window.setTimeout(() => drawGraph(), 180);
});


/* ============ 实时通道 ============ */
let realtimeSocket = null;
let realtimeRetry = 0;
let realtimeTimer = 0;

function applyReviewCount(value) {
  const count = Math.max(0, Number(value) || 0);
  state.stats = Object.assign({}, state.stats || {}, { reviews_open: count });
  const badge = $("#nav-review-count");
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
    badge.setAttribute("data-hover-tip", count ? `${count} 个待审项` : "");
  }
  const stat = $("#stat-reviews");
  if (stat) stat.textContent = num(count);
}

function connectRealtime() {
  if (realtimeSocket && realtimeSocket.readyState <= 1) return;
  window.clearTimeout(realtimeTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  let socket;
  try {
    socket = new WebSocket(`${scheme}://${location.host}${API}/realtime?token=${encodeURIComponent(state.token)}`);
  } catch (_) {
    scheduleRealtimeRetry();
    return;
  }
  realtimeSocket = socket;
  socket.addEventListener("open", () => { realtimeRetry = 0; });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message && message.type === "review_count") applyReviewCount(message.count);
  });
  socket.addEventListener("close", () => {
    if (realtimeSocket === socket) realtimeSocket = null;
    scheduleRealtimeRetry();
  });
  socket.addEventListener("error", () => socket.close());
}

function scheduleRealtimeRetry() {
  if (document.hidden) return; // 页面不可见时不重连，回到前台再连
  const delay = Math.min(30000, 1000 * 2 ** realtimeRetry) + Math.random() * 400;
  realtimeRetry = Math.min(realtimeRetry + 1, 5);
  window.clearTimeout(realtimeTimer);
  realtimeTimer = window.setTimeout(connectRealtime, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  connectRealtime();
});

/* ============ Review ============ */
function reviewSourcePane(side, label, choose = false) {
  return `<section class="review-source-pane" data-review-pane="${side}" aria-labelledby="review-source-${side}">
    <header class="review-source-heading">
      <h3 id="review-source-${side}">${label}</h3>
      ${choose ? '<div data-review-old-picker></div>' : ""}
      <p class="conflict-value" data-review-statement${choose ? " hidden" : ""}></p>
      <p class="doc-head-meta" data-review-location></p>
    </header>
    <div class="review-source-text" data-review-text tabindex="0" role="region" aria-label="${label}正文"></div>
  </section>`;
}

let reviewSourceRequest = 0;
async function openReviewSource(current, existing, selected = 0) {
  const comparison = existing.length > 0;
  const request = ++reviewSourceRequest;
  const dialog = $("#review-source-dialog");
  const titleLabel = $("#review-source-title");
  const meta = $("#review-source-meta");
  const body = $("#review-source-body");
  titleLabel.textContent = comparison ? "新旧原文对照" : "审阅原文";
  meta.textContent = "";
  body.innerHTML = `<div class="review-source-grid${comparison ? " is-comparison" : ""}">
    ${reviewSourcePane("current", comparison ? "新提取的原文" : "审阅原文")}
    ${comparison ? reviewSourcePane("existing", "库内已有的原文", existing.length > 1) : ""}
  </div>`;
  if (!dialog.open) dialog.showModal();

  const paneRequests = { current: 0, existing: 0 };
  async function showSource(side, record) {
    const paneRequest = ++paneRequests[side];
    const active = () => dialog.open && request === reviewSourceRequest && paneRequest === paneRequests[side];
    const pane = $(`[data-review-pane="${side}"]`, body);
    const content = $("[data-review-text]", pane);
    const location = $("[data-review-location]", pane);
    $("[data-review-statement]", pane).textContent = record.statement;
    location.textContent = record.location;
    content.scrollTop = 0;
    if (!record.path) {
      content.removeAttribute("aria-busy");
      content.innerHTML = record.quote?.trim()
        ? `<p class="doc-hint">仅有引文摘录</p><pre class="doc-source">${esc(record.quote)}</pre>`
        : '<p class="empty-block">暂无可查看的原文</p>';
      return;
    }

    content.setAttribute("aria-busy", "true");
    content.innerHTML = loadingLines();
    try {
      const data = await api(record.path);
      if (!active()) return;
      const { title, version, page } = data;
      const versionLabel = page ? `v${version} · 第 ${page} 页` : `v${version}`;
      if (comparison) location.textContent = `《${title}》 · ${versionLabel}`;
      else {
        titleLabel.textContent = title;
        meta.textContent = versionLabel;
      }
      const chunk = data.chunks[0];
      const ranges = sourceRanges(data, { chunk_id: chunk?.id, quote: chunk?.text });
      const targetId = `review-source-highlight-${side}`;
      content.innerHTML = `<pre class="doc-source">${sourceHtml(data.source.text, ranges, targetId) || "暂无原文"}</pre>`;
      const highlight = $(`#${targetId}`, content);
      highlight?.scrollIntoView({ block: "center" });
      if (!comparison) highlight?.focus({ preventScroll: true });
    } catch (error) {
      if (active()) content.innerHTML = `<p class="empty-block">${esc(error.message)}</p>`;
    } finally {
      if (active()) content.removeAttribute("aria-busy");
    }
  }

  if (existing.length > 1) {
    KnowWeavePickers.choice($("[data-review-old-picker]", body), {
      label: "库内记录", value: String(selected),
      options: existing.map((record, index) => ({ value: String(index), label: record.statement })),
      onChange: (value) => showSource("existing", existing[Number(value)]),
    });
  }
  await Promise.all([
    showSource("current", current),
    comparison && showSource("existing", existing[selected]),
  ]);
}

function reviewEvidence(statement, source, quote = source?.quote) {
  const heading = (source?.heading || []).filter((line) => line && line !== "正文").join(" / ");
  const location = [
    source?.title ? `《${source.title}》` : "",
    source?.page ? `第 ${source.page} 页` : "",
    heading || (!source?.page && source?.seq ? `第 ${source.seq} 段` : ""),
  ].filter(Boolean).join(" · ");
  const path = source?.doc_id && source.version_id && source.chunk_id
    ? documentCitationPath(source.doc_id, source.version_id, source.chunk_id) : "";
  return { statement, quote, location, path };
}

function reviewQuote(record, itemId, comparison, oldIndex = 0) {
  const { quote, location, path } = record;
  if (!quote?.trim()) return "";
  const excerpt = `原文${location ? `（${esc(location)}）` : ""}：${esc(quote)}`;
  if (!path) return `<div class="conflict-quote">${excerpt}</div>`;
  return `<button class="conflict-quote review-source-link" type="button" data-review-source="${esc(itemId)}" data-old-index="${oldIndex}" aria-haspopup="dialog">${excerpt}<span>${comparison ? "对照原文" : "查看原文"}</span></button>`;
}

async function loadReview() {
  const target = $("#review-list");
  target.innerHTML = loadingLines();
  try {
    const data = await api("/review?status=open");
    if (!data.items.length) {
      target.innerHTML = `
        <div class="review-empty">
          <div class="review-empty-content">
            <span class="review-empty-mark" aria-hidden="true"></span>
            <h1>暂无待审阅项</h1>
            <p>需要人工核对的内容会出现在这里。</p>
          </div>
        </div>`;
      return;
    }
    const records = new Map();
    target.innerHTML = data.items.map((item) => {
      const payload = item.payload || {};
      const isFact = Boolean(payload.subject && payload.predicate);
      const current = reviewEvidence(isFact ? factSentence(payload.subject, payload.predicate, payload.new_object) : item.title,
        item.source, item.source?.quote ?? payload.quote);
      const existing = isFact
        ? (payload.old_objects || []).flatMap((value, index) => value
          ? [reviewEvidence(factSentence(payload.subject, payload.predicate, value), item.old_sources?.[index])] : [])
        : [];
      records.set(item.id, { current, existing });
      const comparison = existing.length > 0;
      const source = reviewQuote(current, item.id, comparison);
      const facts = isFact ? `<div class="conflict">
            <div class="conflict-cell">
              <span class="label">本次提取到的信息</span>
              <div class="conflict-value">${esc(current.statement)}</div>
              ${source}
            </div>
            <div class="conflict-cell">
              <span class="label">知识库中已有信息</span>
              ${comparison ? existing.map((record, index) => `
                <div class="conflict-record">
                  <div class="conflict-value">${esc(record.statement)}</div>
                  ${reviewQuote(record, item.id, comparison, index)}
                </div>`).join("") : '<div class="conflict-value">没有</div>'}
            </div>
          </div>` : `<h2 class="review-title">${esc(item.title)}</h2>${source}`;
      const actions = item.kind === "parse_failure"
        ? `<button class="btn primary" data-review-job="${esc(payload.job_id)}">修正文并重试</button>`
        : existing.length
          ? `<button class="btn primary" data-review="${esc(item.id)}" data-action="accept_new">用这条新的</button>
             <button class="btn" data-review="${esc(item.id)}" data-action="reject_new">保留知识库里的</button>
             <button class="btn" data-review="${esc(item.id)}" data-action="merge">两条都留下</button>
             <button class="btn" data-review="${esc(item.id)}" data-action="dispute">标记为存疑</button>
             <button class="btn" data-consult="${esc(item.id)}">存疑</button>`
          : `<button class="btn primary" data-review="${esc(item.id)}" data-action="accept_new">${payload.model_error ? "重试抽取并采纳" : "采纳并入库"}</button>
             <button class="btn" data-review="${esc(item.id)}" data-action="reject_new">丢弃</button>
             <button class="btn" data-consult="${esc(item.id)}">存疑</button>`;
      return `
      <article class="review-card">
        <div>
          <div class="review-head">
            <span class="pill warn">${esc(REVIEW_KIND[item.kind] || item.kind)}</span>
            <span>${shortDate(item.created_at)}</span>
            ${payload.reason ? `<span class="review-reason">${esc(payload.reason)}</span>` : ""}
          </div>
          ${facts}
          ${payload.model_error ? `<p class="review-reason">${esc(payload.model_error)}</p>` : ""}
          ${payload.text && !isFact ? `<div class="quote-block" style="margin-top:12px">${esc(plainLines(payload.text))}</div>` : ""}
        </div>
        <div class="review-actions">${actions}</div>
      </article>`;
    }).join("");
    $$("[data-review-source]", target).forEach((button) => {
      const { current, existing } = records.get(button.dataset.reviewSource);
      button.addEventListener("click", () => openReviewSource(current, existing, Number(button.dataset.oldIndex)));
    });
    $$("[data-review]").forEach((button) => {
      button.addEventListener("click", () => resolveReview(button.dataset.review, button.dataset.action, button));
    });
    $$("[data-consult]").forEach((button) => {
      const item = data.items.find((entry) => entry.id === button.dataset.consult);
      if (item) button.addEventListener("click", () => openConsult(item));
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
    const result = await api(`/review/${reviewId}/resolve`, { method: "POST", body: { action, note: "" } });
    if (result.status === "queued") toast("已提交抽取，可在知识库查看进度");
    else toast("审阅项已处理", { centered: true });
    loadReview();
    loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

/* 存疑核查：对话式审阅助手，流式输出并展示模型的思考过程。 */
let consultState = null;

const CONSULT_SUGGESTIONS = [
  "这条信息和原文有出入吗？",
  "适合直接入库吗？",
  "知识库里有没有相关记录？",
];

function clockTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function consultAvatar(role) {
  const avatar = document.createElement("div");
  avatar.className = "consult-avatar";
  avatar.textContent = role === "user" ? "我" : "AI";
  return avatar;
}

function appendConsultMessage(role, text) {
  const log = $("#consult-log");
  if (!log) return null;
  const row = document.createElement("div");
  row.className = `consult-msg consult-msg-${role}`;
  const main = document.createElement("div");
  main.className = "consult-main";
  const meta = document.createElement("div");
  meta.className = "consult-meta";
  const name = document.createElement("span");
  name.className = "consult-name";
  name.textContent = role === "user" ? "我" : "审阅助手";
  const time = document.createElement("time");
  time.textContent = clockTime();
  if (role === "user") meta.append(time, name);
  else meta.append(name, time);
  const bubble = document.createElement("div");
  bubble.className = "consult-bubble";
  const body = document.createElement("div");
  body.className = "consult-body";
  body.textContent = text;
  bubble.append(body);
  main.append(meta, bubble);
  row.append(...(role === "user" ? [main, consultAvatar(role)] : [consultAvatar(role), main]));
  log.append(row);
  return { row, bubble, body };
}

function createConsultThink() {
  const think = document.createElement("details");
  think.className = "consult-think";
  think.open = true;
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = "正在思考";
  const dots = document.createElement("span");
  dots.className = "think-dots";
  dots.innerHTML = "<i></i><i></i><i></i>";
  summary.append(label, dots);
  const body = document.createElement("div");
  body.className = "consult-think-body";
  think.append(summary, body);
  return { think, label, dots, body };
}

function renderConsultSuggestions(show) {
  const wrap = $("#consult-suggest");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!show) return;
  for (const text of CONSULT_SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "consult-chip";
    chip.textContent = text;
    chip.addEventListener("click", () => void sendConsult(text));
    wrap.append(chip);
  }
}

function setConsultBusy(busy) {
  const send = $("#consult-send");
  if (!send) return;
  send.dataset.mode = busy ? "stop" : "send";
  send.textContent = busy ? "停止" : "发送";
}

function consultNearBottom(log) {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 140;
}

function openConsult(item) {
  const dialog = $("#consult-dialog");
  if (!dialog) return;
  consultState = { item, history: [], busy: false, abort: null };
  const subject = $("#consult-subject");
  if (subject) {
    subject.textContent = item.title || "";
    subject.setAttribute("data-hover-tip", item.title || "");
  }
  const log = $("#consult-log");
  if (log) log.innerHTML = "";
  const input = $("#consult-input");
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }
  setConsultBusy(false);
  renderConsultSuggestions(true);
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  else dialog.open = true;
  input?.focus();
  void sendConsult("", { auto: true });
}

async function streamConsult(path, payload, onEvent, signal) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data.detail || data.message || message;
    } catch {}
    throw new Error(message);
  }
  if (!response.body) throw new Error("当前浏览器不支持流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {}
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

async function sendConsult(question, options = {}) {
  const session = consultState;
  if (!session || session.busy) return;
  const log = $("#consult-log");
  if (!log) return;
  const auto = options.auto === true;
  session.busy = true;
  setConsultBusy(true);
  renderConsultSuggestions(false);

  if (auto) {
    const note = document.createElement("div");
    note.className = "consult-note";
    note.textContent = "已根据这条待审信息自动发起核对";
    log.append(note);
  } else {
    appendConsultMessage("user", question);
  }

  const ai = appendConsultMessage("ai", "");
  if (!ai) {
    session.busy = false;
    setConsultBusy(false);
    return;
  }
  const think = createConsultThink();
  ai.bubble.prepend(think.think);
  ai.body.innerHTML = `<span class="consult-wait">正在核对这条信息</span>`;
  log.scrollTop = log.scrollHeight;

  const startedAt = Date.now();
  let reasoning = "";
  let answer = "";
  let errorText = "";
  let folded = false;
  const controller = new AbortController();
  session.abort = controller;

  const paint = () => {
    const keep = consultNearBottom(log);
    if (reasoning) {
      think.think.hidden = false;
      think.body.textContent = reasoning;
      if (!answer) ai.body.innerHTML = "";
    }
    if (answer) {
      ai.body.innerHTML = renderMarkdown(esc(answer));
      const caret = document.createElement("span");
      caret.className = "consult-caret";
      ai.body.append(caret);
      if (!folded) {
        think.think.open = false;
        folded = true;
      }
    }
    if (keep) log.scrollTop = log.scrollHeight;
  };
  const timer = window.setInterval(paint, 80);

  try {
    await streamConsult(
      `/review/${encodeURIComponent(session.item.id)}/consult/stream`,
      { question, history: session.history },
      (event) => {
        if (event.type === "reasoning") reasoning += event.text || "";
        else if (event.type === "content") answer += event.text || "";
        else if (event.type === "error") errorText = event.message || "生成失败";
      },
      controller.signal,
    );
    paint();
    if (errorText) throw new Error(errorText);
    if (!answer.trim()) throw new Error("模型没有返回正文");
    ai.body.innerHTML = renderMarkdown(esc(answer));
    if (reasoning) {
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      think.label.textContent = `思考过程 · ${seconds} 秒`;
      think.dots.remove();
      think.think.open = false;
    } else {
      think.think.remove();
    }
    session.history.push({ role: "user", content: question || "请分析这条待审信息" });
    session.history.push({ role: "assistant", content: answer });
  } catch (error) {
    if (error?.name === "AbortError") {
      if (reasoning) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        think.label.textContent = `思考过程 · ${seconds} 秒`;
        think.dots.remove();
        think.think.open = false;
      } else {
        think.think.remove();
      }
      const partial = answer.trim() ? renderMarkdown(esc(answer)) : "";
      ai.body.innerHTML = `${partial}<span class="consult-abort">已停止生成</span>`;
    } else {
      think.think.remove();
      ai.body.innerHTML = `<span class="consult-error">${esc(error?.message || "生成失败")}</span>`;
    }
  } finally {
    window.clearInterval(timer);
    session.busy = false;
    session.abort = null;
    setConsultBusy(false);
    renderConsultSuggestions(true);
    log.scrollTop = log.scrollHeight;
  }
}

function setupReviewConsult() {
  const dialog = $("#consult-dialog");
  const form = $("#consult-form");
  const input = $("#consult-input");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const send = $("#consult-send");
    if (send?.dataset.mode === "stop") {
      consultState?.abort?.abort();
      return;
    }
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    input.style.height = "auto";
    void sendConsult(question);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });

  dialog?.addEventListener("close", () => {
    consultState?.abort?.abort();
    consultState = null;
  });
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
  if (tab === "feedback") return loadChatFeedback();
}

async function loadChatFeedback() {
  $("#ops-body").innerHTML = `<div class="block">${loadingLines()}</div>`;
  try {
    const data = await api("/chat-feedback?limit=100");
    const negative = data.items.filter((item) => item.value === -1).length;
    $("#ops-body").innerHTML = `
      <div class="metrics cols-3">
        <div class="metric"><span class="metric-label">反馈</span><div class="metric-value">${num(data.items.length)}</div></div>
        <div class="metric"><span class="metric-label">有问题的回答</span><div class="metric-value">${num(negative)}</div></div>
        <div class="metric"><span class="metric-label">好的回答</span><div class="metric-value">${num(data.items.length - negative)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:16px">
        <table class="table">
          <thead><tr><th scope="col">评价</th><th scope="col">反馈说明</th><th scope="col">对话摘录</th><th scope="col">时间</th></tr></thead>
          <tbody>${data.items.map((item) => `
            <tr>
              <td>${item.value === 1 ? '<span class="pill ok">好的回答</span>' : '<span class="pill bad">有问题的回答</span>'}</td>
              <td><span class="truncate" style="display:block;max-width:280px">${esc(item.comment || "—")}</span></td>
              <td><span class="truncate" style="display:block;max-width:420px">${esc(item.context || "—")}</span></td>
              <td class="date">${shortDate(item.created_at)}</td>
            </tr>`).join("") || `<tr><td colspan="4"><div class="empty-block">暂无对话反馈</div></td></tr>`}</tbody>
        </table>
      </div>`;
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
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
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function openTrace(traceId) {
  const dialog = $("#trace-dialog");
  const title = $("#trace-dialog-title");
  const body = $("#trace-dialog-body");
  title.textContent = "轨迹";
  body.innerHTML = loadingLines();
  const loading = body.firstElementChild;
  body.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  try {
    const { trace, spans, usage } = await api(`/traces/${traceId}`);
    if (loading !== body.firstElementChild) return;
    title.textContent = `轨迹 · ${featureLabel(trace.feature)}`;
    body.innerHTML = `
      <dl class="trace-overview">
        <div><dt>状态</dt><dd>${statusPill(trace.status)}</dd></div>
        <div><dt>耗时</dt><dd>${num(trace.latency_ms)} ms</dd></div>
        <div><dt>时间</dt><dd>${esc(shortDate(trace.created_at, { year: "numeric" }))}</dd></div>
      </dl>
      <div class="trace-exchange">
        <section class="trace-question" aria-labelledby="trace-question-title">
          <h3 id="trace-question-title">问题</h3>
          <p>${esc(trace.question || "无")}</p>
        </section>
        <section class="trace-answer" aria-labelledby="trace-answer-title">
          <h3 id="trace-answer-title">回答</h3>
          <div class="answer-body">${renderMarkdown(esc(trace.answer || "无"), "h4")}</div>
        </section>
      </div>
      <section class="trace-details" aria-labelledby="trace-details-title">
        <header class="trace-details-head">
          <h3 id="trace-details-title">执行详情</h3>
          <button class="btn" type="button" data-replay="${esc(trace.id)}">回放检索阶段</button>
        </header>
        <div id="replay-result" hidden></div>
        <div class="trace-disclosures">
          <details>
            <summary>执行阶段 <span class="trace-count">${spans.length ? `${num(spans.length)} 个阶段` : "暂无阶段"}</span></summary>
            <div class="trace-disclosure-body">
              ${spans.map((span) => `
                <div class="fact-item">
                  <div class="trace-stage-head">
                    <strong>${esc(runtimeText(span.stage))}</strong>
                    <span>${num(span.latency_ms)} ms ${statusPill(span.status)}</span>
                  </div>
                  <div class="fact-quote">${esc(runtimeText(JSON.stringify(span.output || {})).slice(0, 280))}</div>
                </div>`).join("") || `<p class="muted small">暂无阶段</p>`}
            </div>
          </details>
          <details>
            <summary>模型成本 <span class="trace-count">${usage.length ? `${num(usage.length)} 次调用` : "无模型调用"}</span></summary>
            <div class="trace-disclosure-body">
              ${usage.map((row) => `
                <div class="version-row">
                  <span>${esc(modelLabel(row.model))}</span>
                  <span class="meta">${num(row.tokens_in)} / ${num(row.tokens_out)} tokens · ${money(row.amount)}</span>
                </div>`).join("") || `<p class="muted small">无模型调用</p>`}
            </div>
          </details>
          <details>
            <summary>轨迹元数据</summary>
            <div class="trace-disclosure-body">
              <dl class="trace-overview">
                <div><dt>轨迹 ID</dt><dd class="mono">${esc(trace.id)}</dd></div>
              </dl>
              <pre class="code">${esc(runtimeText(JSON.stringify(trace.meta || {}, null, 2)))}</pre>
            </div>
          </details>
        </div>
      </section>`;
    const button = $("[data-replay]", body);
    const result = $("#replay-result", body);
    button.addEventListener("click", () => replayTrace(button.dataset.replay, button, result));
  } catch (error) {
    if (loading === body.firstElementChild) body.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function replayTrace(traceId, button, result) {
  setBusy(button, true, "回放中");
  try {
    const data = await api(`/traces/${traceId}/replay`, { method: "POST", body: { target_stage: "retrieve", top_k: 8 } });
    result.innerHTML = `
      <section aria-labelledby="trace-replay-title">
        <h4 id="trace-replay-title">检索回放</h4>
        <div class="version-row">
          <span>新增 ${num(data.diff.added.length)} 条 · 移除 ${num(data.diff.removed.length)} 条</span>
          <span class="meta">top ${Number(data.diff.top_score || 0).toFixed(3)}</span>
        </div>
        ${data.hits.slice(0, 4).map((hit) => `
          <div class="fact-item">
            <div class="fact-line">${esc(hit.doc_title)} <span class="pred">${Number(hit.scores.rerank).toFixed(3)}</span></div>
            <div class="fact-quote">${esc(plain(hit.quote))}</div>
          </div>`).join("")}
      </section>`;
    result.hidden = false;
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
      <div id="eval-failures"></div>
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
    $("#run-eval").addEventListener("click", () => runEvals());
    void loadEvalFailures();
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
  } catch (error) {
    $("#ops-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
  }
}

async function loadEvalFailures() {
  const target = $("#eval-failures");
  if (!target || !["owner", "admin"].includes(state.me?.role)) return;
  try {
    const { items } = await api("/evals/failures");
    target.innerHTML = items.length ? `
      <div class="toolbar"><strong>评测执行失败（${num(items.length)}）</strong>
        <button class="btn sm" data-eval-retry="">重试全部失败项</button>
      </div>
      ${items.map(item => `<div class="job-card failed">
        <strong>${esc(item.question)}</strong><p class="muted small">${esc(item.error)}</p>
        <button class="text-btn" data-eval-retry="${esc(item.case_id)}">重试此题</button>
      </div>`).join("")}` : "";
    $$("[data-eval-retry]", target).forEach(button => button.addEventListener("click", () => {
      const id = button.dataset.evalRetry;
      void runEvals(id ? [id] : items.map(item => item.case_id), button);
    }));
  } catch (error) {
    target.textContent = error.message;
  }
}

let evalRunning = false;
async function runEvals(caseIds, button = $("#run-eval")) {
  if (evalRunning) return;
  evalRunning = true;
  const token = state.token;
  setBusy(button, true, "评测中");
  try {
    const data = await api("/evals/run", { method: "POST", body: caseIds ? { case_ids: caseIds } : {} });
    if (state.token !== token || !$("#eval-result")) return;
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
              <td>${result.error ? "—" : result.refused ? "是" : "否"}</td>
              <td>${result.error ? esc(result.error) : result.pass ? `<span class="pill ok">通过</span>` : `<span class="pill warn">未通过</span>`}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
    toast(`评测完成 · 通过率 ${pct(metrics.pass_rate)}${metrics.failed_cases ? ` · ${num(metrics.failed_cases)} 项执行失败` : ""}`);
    await loadEvalFailures();
  } catch (error) {
    if (state.token === token) toast(error.message);
  } finally {
    evalRunning = false;
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
}

/* ============ Boot ============ */
const ownerIdentity = { value: "owner-token", label: "何道伟 · owner" };

async function boot() {
  document.body.dataset.page = state.page;
  accountPicker = KnowWeavePickers.choice($("#account-picker"), {
    id: "token-select", label: "当前身份", placeholder: "选择身份", value: state.token, options: [ownerIdentity],
  });
  entityTypePicker = KnowWeavePickers.choice($("#entity-type-picker"), {
    id: "entity-type", label: "类型", labelId: "entity-type-label", options: [],
  });
  fillEntityTypes();
  KnowWeavePickers.date($("#as-of-picker"), { id: "as-of", label: "截至日期", labelId: "as-of-label" });
  accountPicker.trigger.addEventListener("change", async (event) => {
    closeDocumentFile();
    state.token = event.target.value;
    localStorage.setItem("kw_token", state.token);
    state.me = null;
    state.stats = null;
    state.docs = [];
    state.jobs = [];
    jobStatusCache = null;
    activeExtractions.clear();
    stopJobPoll();
    renderIngestJobs();
    renderExtractionJobs({ items: [], can_retry: false });
    state.entities = [];
    state.activeEntity = null;
    state.conversationId = null;
    state.showArchivedConversations = false;
    resetNativeChat();
    $("#ask-result").innerHTML = askEmptyHtml();
    $(".ask-layout").classList.add("is-empty");
    $("#evidence-gate").innerHTML = "";
    $("#evidence-body").innerHTML = `<div class="rail-empty">暂无证据</div>`;
    $("#evidence-count").textContent = "";
    $("#conversation-list").innerHTML = "";
    $("#conversation-list").hidden = true;
    if (state.document) loadDocument(state.document);
    await refreshShell();
    await loadMetaAndHealth();
    if (!state.document) loadPage(state.page);
  });

  window.addEventListener("popstate", restorePageFromUrl);

  $$(".nav-item, [data-goto]").forEach((item) => item.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateToPage(item.dataset.page || item.dataset.goto);
  }));

  $("#nav-toggle").addEventListener("click", () => {
    if ($("#sidebar").classList.contains("open")) closeSidebar();
    else openSidebar();
  });
  $("#scrim").addEventListener("click", closeSidebar);

  $("#entity-search").addEventListener("input", (event) => {
    clearTimeout(window.__entityTimer);
    window.__entityTimer = setTimeout(() => loadEntities(event.target.value.trim()), 300);
  });

  $("#entity-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveEntity(event.currentTarget);
  });
  $("#entity-delete-confirm").addEventListener("click", (event) => confirmEntityDelete(event.currentTarget));

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !dialog.querySelector("[data-close]")?.disabled) dialog.close();
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
  setupLibraryView();
  setupAsk();
  setupChat();
  setupHoverTooltip();
  setupEntityView();
  setupTour();
  setupReviewConsult();
  setupOps();

  await refreshShell();
  await loadMetaAndHealth();
  restorePageFromUrl();
  connectRealtime();
  if (state.page === "chat" && !localStorage.getItem(tourKey())) openTour();
}

document.addEventListener("DOMContentLoaded", boot);
