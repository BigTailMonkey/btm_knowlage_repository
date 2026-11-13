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
  stats: null,
  conversations: [],
  showArchivedConversations: false,
  entities: [],
  graph: { nodes: [], edges: [] },
  graphScope: "local",
  graphOverviewZoom: false,
  activeEntity: null,
  entityView: localStorage.getItem("kw_entity_view") === "graph" ? "graph" : "entity",
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

/* ============ Shell ============ */
function pageFromUrl() {
  const url = new URL(location.href);
  const legacyPage = url.hash.slice(1);
  if (Object.hasOwn(PAGE_META, legacyPage)) return legacyPage;
  return url.searchParams.get("page");
}

function showPage(page) {
  if (!Object.hasOwn(PAGE_META, page)) page = "chat";
  if (state.page === "chat" && page !== "chat") closeChatCitation();
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
  const url = new URL(location.href);
  if (page === "chat") {
    if (url.searchParams.has("page")) url.searchParams.delete("page");
  } else if (url.searchParams.get("page") !== page) {
    url.searchParams.set("page", page);
  }
  url.hash = "";
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  closeSidebar();
  loadPage(page);
}

function loadPage(page) {
  if (page === "chat") resumeNativeChat();
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
  if (state.page !== "library") {
    stopJobPoll();
    return;
  }
  const token = state.token;
  const [ingest, extraction] = await Promise.allSettled([api("/documents/jobs"), api("/documents/extractions")]);
  if (state.page !== "library" || state.token !== token) return;
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
            <button class="text-btn" data-extraction-reset="${esc(task.id)}" ${extractionRetrying ? "disabled" : ""} title="丢掉已有断点，从第一批重新抽取：更慢，但结果完全重算">从头重抽</button>` : ""}` : ""}
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
          <span class="job-stage" title="${esc(stage)}">${esc(stage)}</span>
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
  if (q) params.set("q", q);
  if (state.source) params.set("source_type", state.source);
  try {
    const data = await api(`/documents?${params}`);
    state.docs = data.items;
    renderDocs();
    const totalChunks = data.items.reduce((sum, doc) => sum + Number(doc.chunks || 0), 0);
    $("#doc-count").textContent = `${num(data.items.length)} 篇`;
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
  if (!doc.continuation) return "";
  const status = continuationStatus(doc);
  return `<div class="pill ${status.tone}">${esc(status.label)}</div>`;
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
          ${continuationBadge(doc)}
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

const ENRICHMENT_LABEL = {
  pending: "等待抽取事实与实体",
  running: "正在抽取事实与实体",
  deferred: "该文档尚未抽取，可点击「重新抽取事实」",
  empty: "未找到有原文依据的事实",
  failed: "抽取失败，可点击「重新抽取事实」重试",
};

function docTabButton(id, label, count, active) {
  return `<button class="tab${active ? " active" : ""}" type="button" role="tab" id="doc-tab-${id}" aria-controls="doc-panel-${id}" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" data-doc-tab="${id}">${label}${count === null ? "" : `<span class="doc-tab-count">${num(count)}</span>`}</button>`;
}

function docTabPanel(id, content, active) {
  return `<div class="doc-panel" id="doc-panel-${id}" role="tabpanel" aria-labelledby="doc-tab-${id}" data-doc-panel="${id}"${active ? "" : " hidden"}>${content}</div>`;
}

async function openDoc(docId, citation = null) {
  const request = ++docOpenRequest;
  const dialog = $("#doc-dialog");
  $("#doc-dialog-title").textContent = "文档";
  $("#doc-dialog-meta").innerHTML = "";
  $("#doc-dialog-body").innerHTML = loadingLines();
  if (!dialog.open) dialog.showModal();
  try {
    const selectedVersion = citation?.version_id;
    const [data, library] = await Promise.all([
      api(`/documents/${encodeURIComponent(docId)}${selectedVersion ? `?version_id=${encodeURIComponent(selectedVersion)}` : ""}`),
      api("/documents?limit=200").catch(() => ({ items: [] })),
    ]);
    if (request !== docOpenRequest) return;
    const doc = data.document;
    const continuation = data.continuation;
    const linkableItems = (library.items || []).filter((item) => item.id !== doc.id);
    const enrichmentLabel = ENRICHMENT_LABEL[doc.enrichment_status];
    const ranges = sourceRanges(data, citation);
    const version = data.source?.version ?? doc.version;
    const sourceText = data.source?.text ?? "";
    const sourceLabel = SOURCE_LABEL[doc.source_type] || doc.source_type;
    const locating = Boolean(citation?.chunk_id || citation?.quote || citation?.spans?.length);
    const status = continuationStatus(doc);
    const hasChain = Boolean(doc.continuation) || (continuation?.chain?.length ?? 0) > 1;
    const activeVersionId = data.source?.version_id;
    $("#doc-dialog-title").textContent = doc.title;
    $("#doc-dialog-meta").innerHTML = `
      <span class="pill ${status.tone}">${esc(status.label)}</span>
      ${version !== doc.version ? `<span class="pill warn">历史版本</span>` : ""}
      <span>${esc(sourceLabel)} · v${esc(version)} · 更新于 ${esc(shortDate(doc.updated_at))}</span>`;

    const sourcePanel = `
      <div class="doc-panel-toolbar">
        <span class="doc-panel-note">v${esc(version)} · ${esc(data.source?.parser || "解析器未知")} · ${num(sourceText.length)} 字符 · ${num(data.chunks.length)} 个检索单元</span>
        <div class="doc-panel-tools">
          ${locating ? `<span class="pill info">已定位引用</span>` : ""}
          <button class="text-btn" type="button" data-copy-source>复制全文</button>
        </div>
      </div>
      ${locating && !ranges.length ? `<p class="doc-hint">该引用暂无精确坐标，可在下方原文中核对。</p>` : ""}
      <pre class="doc-source">${sourceHtml(sourceText, ranges) || '<span class="muted">暂无原文</span>'}</pre>
      <p class="doc-hint">区间坐标：规范化原文 UTF-16 偏移，末尾不含；与引用中的版本一致。</p>`;

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
      ? `<div class="doc-version-list">${data.versions.map((item) => `
          <button type="button" class="doc-version-row${item.id === activeVersionId ? " is-active" : ""}" data-doc-version="${esc(item.id)}"${item.id === activeVersionId ? ' aria-current="true"' : ""}>
            <span class="doc-version-no">v${esc(item.version)}</span>
            <span class="doc-version-body">
              <strong>${esc(item.parser)}</strong>
              <small>${num(item.chars)} 字符 · <span class="mono">${esc(item.hash)}</span></small>
            </span>
            <span class="doc-version-date">${esc(shortDate(item.created_at))}</span>
            ${item.version === doc.version ? `<span class="pill info">当前</span>` : item.id === activeVersionId ? `<span class="doc-version-open">查看中</span>` : `<span class="doc-version-open">查看</span>`}
          </button>`).join("")}</div><p class="doc-hint">同一文档的内容修订会新增版本；引用始终指向生成时的版本，历史版本不会被覆盖。</p>`
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
    const unlinkHtml = [
      continuation?.predecessor ? `<span>前序：${esc(continuation.predecessor.title)}</span><button class="text-btn danger" type="button" data-continuation-unlink="continues">解除接续</button>` : "",
      continuation?.successor ? `<span>后续：${esc(continuation.successor.title)}</span><button class="text-btn danger" type="button" data-continuation-unlink="continued_by">解除延续</button>` : "",
    ].filter(Boolean).join("");

    $("#doc-dialog-body").innerHTML = `
      <div class="doc-shell">
        <aside class="doc-rail" aria-label="文档信息与操作">
          <div class="doc-kpis">
            <div class="doc-kpi"><span>检索单元</span><strong>${num(data.chunks.length)}</strong></div>
            <div class="doc-kpi"><span>查看版本</span><strong>v${esc(version)}</strong></div>
            <div class="doc-kpi"><span>原文长度</span><strong>${num(sourceText.length)}</strong></div>
            <div class="doc-kpi"><span>解析质量</span><strong>${esc(doc.quality)}</strong></div>
          </div>

          <section class="doc-rail-section">
            <h3>文档状态</h3>
            <dl class="doc-meta">
              <div><dt>来源</dt><dd>${esc(sourceLabel)}</dd></div>
              <div><dt>权限</dt><dd>${esc(doc.acl_label)}</dd></div>
              <div><dt>可信度</dt><dd>${esc(doc.source_trust ?? 0.5)}${doc.is_core ? " · 核心" : ""}</dd></div>
              <div><dt>内容哈希</dt><dd class="mono">${esc(doc.content_hash)}</dd></div>
            </dl>
          </section>

          <section class="doc-rail-section">
            <h3>操作</h3>
            <div class="doc-actions">
              <button class="btn primary block" data-doc-action="update" data-doc-id="${esc(doc.id)}">更新内容</button>
              <div class="doc-action-grid">
                <button class="btn" data-doc-action="reprocess" data-doc-id="${esc(doc.id)}">重新抽取事实</button>
                <button class="btn" data-doc-action="reindex" data-doc-id="${esc(doc.id)}">重建检索索引</button>
                <button class="btn span-2" data-doc-action="policy" data-doc-id="${esc(doc.id)}" data-trust="${esc(doc.source_trust ?? 0.5)}" data-core="${doc.is_core ? 'true' : 'false'}">来源与核心标记</button>
              </div>
            </div>
          </section>

          <section class="doc-rail-section">
            <div class="doc-section-head"><h3>沿革</h3><span class="doc-section-note">${hasChain ? (chain.length > 1 ? `${chain.length} 代` : "已登记") : "未登记"}</span></div>
            ${chainHtml}
            ${unlinkHtml ? `<div class="doc-chain-actions">${unlinkHtml}</div>` : ""}
            <details class="doc-link">
              <summary>登记延续关系</summary>
              <div class="doc-link-fields">
                <label class="doc-field"><span>方向</span>
                  <select id="continuation-direction">
                    <option value="continues">接续自（当前是新文档）</option>
                    <option value="continued_by">延续到（当前是旧文档）</option>
                  </select>
                </label>
                <label class="doc-field"><span>关联文档</span>
                  <select id="continuation-other"${linkableItems.length ? "" : " disabled"}>
                    ${linkableItems.length ? linkableItems.map((item) => `<option value="${esc(item.id)}">${esc(item.title)}</option>`).join("") : `<option>没有可关联的文档</option>`}
                  </select>
                </label>
                <label class="doc-field"><span>生效日期</span><input type="date" id="continuation-date" /></label>
                <label class="doc-field"><span>备注</span><input id="continuation-note" maxlength="500" placeholder="可选" /></label>
                <button class="btn block" type="button" data-continuation-link${linkableItems.length ? "" : " disabled"}>建立延续</button>
              </div>
            </details>
          </section>

          <section class="doc-rail-section">
            <div class="doc-section-head"><h3>关联实体</h3><span class="doc-section-note">${num(data.entities.length)}</span></div>
            ${enrichmentLabel ? `<p class="doc-hint">${esc(enrichmentLabel)}</p>` : ""}
            ${doc.enrichment_status === "failed" && doc.enrichment_error ? `<p class="doc-hint danger-text">${esc(doc.enrichment_error)}</p>` : ""}
            <div class="pill-row">${data.entities.length ? data.entities.map((entity) => `<span class="pill">${esc(entity.name)}</span>`).join("") : `<span class="doc-hint">暂无</span>`}</div>
          </section>

          <div class="doc-rail-danger">
            <button class="text-btn danger" data-doc-action="delete" data-doc-id="${esc(doc.id)}">移入回收站</button>
          </div>
        </aside>

        <section class="doc-main">
          <div class="doc-tabs-wrap">
            <div class="tabs doc-tabs" role="tablist" aria-label="文档内容">
              ${docTabButton("source", "原文", null, true)}
              ${docTabButton("chunks", "检索单元", data.chunks.length, false)}
              ${docTabButton("versions", "版本", data.versions.length, false)}
              ${docTabButton("facts", "事实", data.facts.length, false)}
            </div>
          </div>
          <div class="doc-panels">
            ${docTabPanel("source", sourcePanel, true)}
            ${docTabPanel("chunks", chunksPanel, false)}
            ${docTabPanel("versions", versionsPanel, false)}
            ${docTabPanel("facts", factsPanel, false)}
          </div>
        </section>
      </div>`;

    const body = $("#doc-dialog-body");
    const infoButton = $("[data-doc-info]", dialog);
    if (infoButton) infoButton.onclick = () => $(".doc-rail", body)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const tabs = $$("[data-doc-tab]", body);
    const panels = $$("[data-doc-panel]", body);
    const activateTab = (id) => {
      for (const tab of tabs) {
        const active = tab.dataset.docTab === id;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.dataset.docPanel !== id;
    };
    for (const tab of tabs) tab.addEventListener("click", () => activateTab(tab.dataset.docTab));
    $(".doc-tabs", body)?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next].dataset.docTab);
    });
    $("[data-copy-source]", body)?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(sourceText);
        toast("原文已复制");
      } catch {
        toast("复制失败，请手动选择原文");
      }
    });
    $$("[data-doc-action]", body).forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.docAction === "update") {
          dialog.close();
          openIngest(doc);
        } else handleDocAction(button.dataset.docAction, button.dataset.docId, button);
      });
    });
    $$("[data-doc-version]", body).forEach((button) => {
      button.addEventListener("click", () => openDoc(docId, { version_id: button.dataset.docVersion }));
    });
    $$("[data-open-doc]", body).forEach((button) => {
      button.addEventListener("click", () => openDoc(button.dataset.openDoc));
    });
    $$("[data-continuation-unlink]", body).forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("确认解除这条延续关系？")) return;
        setBusy(button, true, "解除中");
        try {
          await api(`/documents/${encodeURIComponent(doc.id)}/continuation?relation=${button.dataset.continuationUnlink}`, { method: "DELETE" });
          toast("延续关系已解除");
          await openDoc(doc.id);
          loadDocs();
        } catch (error) {
          toast(error.message);
        } finally {
          setBusy(button, false);
        }
      });
    });
    $("[data-continuation-link]", body)?.addEventListener("click", async (event) => {
      const other = $("#continuation-other", body)?.value;
      const effectiveDate = $("#continuation-date", body)?.value;
      const relation = $("#continuation-direction", body)?.value;
      const note = $("#continuation-note", body)?.value.trim();
      if (!other) return toast("没有可关联的文档");
      if (!effectiveDate) return toast("请填写生效日期");
      setBusy(event.currentTarget, true, "保存中");
      try {
        await api(`/documents/${encodeURIComponent(doc.id)}/continuation`, {
          method: "POST",
          body: { other_doc_id: other, relation, effective_date: effectiveDate, note },
        });
        toast("延续关系已建立");
        await openDoc(doc.id);
        loadDocs();
      } catch (error) {
        toast(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    const highlight = $("#source-highlight-target", body);
    highlight?.scrollIntoView({ behavior: "smooth", block: "center" });
    highlight?.focus({ preventScroll: true });
  } catch (error) {
    if (request === docOpenRequest) {
      $("#doc-dialog-meta").innerHTML = "";
      $("#doc-dialog-body").innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
    }
  }
}

async function handleDocAction(action, docId, button) {
  if (action === "delete") {
    if (!confirm("确认移入回收站？可在回收站中恢复。")) return;
    setBusy(button, true, "删除中");
    try {
      await api(`/documents/${docId}`, { method: "DELETE" });
      toast("文档已移入回收站，可到回收站恢复");
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
      void loadIngestJobs();
      await openDoc(docId);
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
    if (chatCitation !== preview) return;
    const base = page.getViewport({ scale: 1 });
    const width = entry.page.clientWidth || body.clientWidth || 480;
    const scale = width / base.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    entry.canvas.width = Math.floor(viewport.width);
    entry.canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: entry.canvas.getContext("2d"), viewport }).promise;
    if (chatCitation !== preview) return;
    entry.page.style.aspectRatio = `${base.width} / ${base.height}`;
    entry.page.classList.add("is-rendered");
    entry.rendered = true;
    if (entry.number !== (Number(preview.data.page) || 0)) return;
    const cssViewport = page.getViewport({ scale });
    const quote = pdfFlatText(preview.data.chunks[0]?.text);
    const rects = pdfHighlightRects(await page.getTextContent(), cssViewport, lib, quote);
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

async function renderPdfInto(preview, body) {
  const lib = await loadPdfjs();
  if (chatCitation !== preview) return;
  preview.pdfTask ??= lib.getDocument({
    url: preview.url,
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
  });
  const pdf = await preview.pdfTask.promise;
  if (chatCitation !== preview) return;
  preview.pdf = pdf;
  const first = await pdf.getPage(1);
  if (chatCitation !== preview || $("#chat-citation-file").getAttribute("aria-pressed") !== "true") return;
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
  }, { root: body, rootMargin: "320px 0px" });
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
    preview.file ??= (async () => {
      const response = await fetch(`${API}${preview.path}&format=pdf`, {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: preview.controller.signal,
      });
      if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "application/pdf") {
        throw new Error("版式预览暂不可用，已显示引用文本。");
      }
      const blob = await response.blob();
      preview.controller.signal.throwIfAborted();
      preview.url = URL.createObjectURL(blob);
    })();
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

async function openChatCitation(docId, versionId, chunkId) {
  closeChatCitation();
  const params = new URLSearchParams({ chunk_id: chunkId ?? "" });
  const path = `/documents/${docId}/citation/${versionId}?${params}`;
  const preview = chatCitation = { controller: new AbortController(), path };
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
  return safe.replace(/[ \t]*\[(\d{1,2})\]/g, (match, number) => `<button type="button" class="cite" data-cite="${number}" aria-label="证据 ${number}">${number}</button>`);
}

function answerHtml(text, refused) {
  const linked = linkifyCitations(text, refused);
  return renderMarkdown(linked);
}

// 模型输出带轻度 markdown：只处理粗体、行内代码、小标题、列表与分隔线。
function renderMarkdown(text) {
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
    if (heading) { flush(); out.push(`<h3>${inline(heading[1])}</h3>`); continue; }
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
  $$("#mode-tabs [data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$("#mode-tabs [data-mode]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", active ? "true" : "false");
      });
      updateModeHint();
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
  $("#ask-result").addEventListener("click", (event) => {
    const sample = event.target.closest("[data-sample]");
    if (!sample) return;
    fillAsk(sample.dataset.sample);
    runAsk();
  });
  updateModeHint();
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
      <span class="ask-empty-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M3 9c4.5 0 4.5-5 9-5s4.5 5 9 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M3 15c4.5 0 4.5 5 9 5s4.5-5 9-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      <h2>从一条具体问题开始</h2>
      <p>问题问得越具体，召回的片段越准。系统只使用通过阈值筛选的原文作答，证据不足时会直接说明。</p>
      <div class="ask-samples">
        <span class="ask-samples-label">试着问</span>
        ${samples.map((question) => `<button class="ask-sample" type="button" data-sample="${esc(question)}">${esc(question)}</button>`).join("")}
      </div>
    </div>
    <div class="ask-empty-steps">
      <div class="ask-step"><span>1</span><div><b>召回</b><p>混合检索从全部文档中取候选片段</p></div></div>
      <div class="ask-step"><span>2</span><div><b>重排与阈值</b><p>低分片段被淘汰，不进入生成上下文</p></div></div>
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

function updateModeHint() {
  const hint = $("#mode-hint");
  if (!hint) return;
  const mode = state.meta?.modes?.find((item) => item.id === state.mode);
  hint.textContent = mode?.description || "";
}

function fillAsk(question) {
  const input = $("#question");
  if (!input) return;
  input.value = question;
  resizeAskInput();
  input.focus();
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
          <span class="pill ${refused ? "warn" : "ok"}">${refused ? "证据不足" : "已回答"}</span>
          <span class="meta-sep" aria-hidden="true"></span>
          <span>${esc(modeName)}</span>
          ${confidence ? `<span class="meta-sep" aria-hidden="true"></span><span>置信度 ${confidence}%</span>` : ""}
          ${result.latency_ms ? `<span class="meta-sep" aria-hidden="true"></span><span>${latencyLabel(result.latency_ms)}</span>` : ""}
        </div>
      </header>
      <div class="answer-body">${answerHtml(result.answer, refused)}</div>
      <footer class="answer-foot">
        <span class="answer-source">${result.evidence?.length ? `基于 ${num(result.evidence.length)} 条证据` : "无引用片段"}</span>
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
  updateModeHint();
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
    <button class="recent-item ${conversation.id === state.conversationId ? "active" : ""} ${archivedView ? "archived" : ""}" type="button" data-conversation="${esc(conversation.id)}" title="${esc(conversation.title || "未命名会话")}${archivedView ? "（已归档，继续提问会自动恢复）" : ""}">
      <span class="recent-title">${esc(conversation.title || "未命名会话")}</span>
      <span class="recent-time">${chatWhen(conversation.last_activity_at || conversation.created_at)}</span>
    </button>`).join("");
  const toggle = `<button class="recent-toggle" type="button" data-archive-toggle title="${archivedView ? "返回最近会话" : "查看已归档会话"}">${archivedView ? "最近" : "已归档"}</button>`;
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
  showPage("ask");
  try {
    const data = await api(`/conversations/${encodeURIComponent(conversationId)}`);
    state.conversationId = conversationId;
    const messages = data.messages || [];
    const answer = [...messages].reverse().find((message) => message.role === "assistant");
    const question = [...messages].reverse().find((message) => message.role === "user");
    if (answer) {
      const result = { ...answer, answer: answer.content, conversation_id: conversationId };
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
    railToggle.title = state.entityRail ? "收起实体列表，把空间留给图谱" : "展开实体列表，在图谱旁浏览实体";
  }
  const toggle = $("#graph-toggle");
  if (!toggle) return;
  const expanded = view === "graph";
  toggle.setAttribute("aria-pressed", expanded ? "true" : "false");
  toggle.title = expanded ? "收起图谱，回到实体列表" : "展开关系图谱";
  const label = toggle.querySelector("span");
  if (label) label.textContent = expanded ? "收起图谱" : "查看关系图谱";
}

function setEntityView(view) {
  const next = view === "graph" ? "graph" : "entity";
  state.entityView = next;
  localStorage.setItem("kw_entity_view", next);
  applyEntityViewUI(next);
  // 缩略图只看一跳，展开后取两跳：重新取一次数据，再按新画布重绘
  loadGraph();
}

function setupEntityView() {
  applyEntityViewUI(state.entityView);
  $$("[data-graph-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      setGraphScope(button.dataset.graphScope);
      if (state.graphScope === "overview" && state.entityView !== "graph") setEntityView("graph");
      else loadGraph();
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
  // 缩略图状态下点击图谱空白处直接展开
  const canvas = $("#graph-canvas");
  if (canvas) {
    canvas.addEventListener("click", (event) => {
      if (state.entityView !== "entity") return;
      // 空白处或边标签上都可以展开：标签现在可悬停（为了看完整原文），不再穿透到画布
      const onTag = Boolean(event.target && event.target.closest && event.target.closest(".g-edge-tag"));
      if (event.target !== canvas && !onTag) return;
      setEntityView("graph");
    });
  }
}

function setGraphScope(scope) {
  state.graphScope = scope;
  $("#graph-overview-size").hidden = scope !== "overview";
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
          <span class="row-title" title="${esc(entity.name)}">${esc(entity.name)}</span>
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
  const select = $("#entity-type");
  if (!select) return;
  const known = new Set(ENTITY_TYPE_OPTIONS);
  const extra = new Set();
  [...state.entities, ...(state.graph?.nodes || [])].forEach((node) => {
    const type = node?.type;
    if (type && !known.has(type)) extra.add(type);
  });
  if (current && !known.has(current)) extra.add(current);
  const types = [...ENTITY_TYPE_OPTIONS, ...[...extra].sort()];
  select.innerHTML = types
    .map((type) => `<option value="${esc(type)}">${esc(nodeTypeLabel(type))}</option>`)
    .join("");
  select.value = current || "concept";
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
    ? `<div class="fact-quote" title="${esc(plain(fact.evidence[0].quote))}">${esc(plain(fact.evidence[0].quote))}</div>`
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

/* 取当前焦点的邻域：缩略图看一跳，展开看两跳；只认实体关系，字面值走属性条 */
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
  const hops = state.entityView === "graph" ? 2 : 1;
  if (state.graph.overview !== overview || (!overview && state.graph.focus !== focusId)) {
    state.graph = { overview, nodes: [], edges: [], loading: true };
    renderGraph();
  }
  try {
    const data = await api(overview ? "/graph?scope=overview" : `/graph?focus=${encodeURIComponent(focusId)}&hops=${hops}&limit=80`);
    if (token !== graphRequest) return;   // 只渲染最新一次请求，避免快速切换实体时串图
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
 *   半径 = 跳数：焦点在中心，内环是一跳直接关系，外环是二跳中介实体。
 *   连线 = 一条事实，箭头由主语指向宾语；线旁标出原文谓语（“筛查和发现”），
 *   不是归一后的类别名（“举措”）；类别只在悬停提示里说明，避免把动词读丢。
 *   位置不是装饰：同一关系类型的邻居相邻排列，肉眼能看出「这一类关系」。
 */
const GRAPH_NS = "http://www.w3.org/2000/svg";

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
      best = { x: candidate.x, y: candidate.y, anchor, box };
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
 * 关系只有两种端点在同一环时（兄弟之间）才弯曲线条，避免从中心横穿。
 */
function graphFocusLayout(nodes, edges, width, height, radiusOf, focusId, compact) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const focus = byId.get(focusId) || nodes[0];
  const center = { x: width / 2, y: height / 2 };
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
  const hopOf = (id) => hop.get(id) ?? Infinity;

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
    .filter((node) => node.id !== focus.id && hopOf(node.id) !== 1)
    .sort((a, b) => hopOf(a.id) - hopOf(b.id)
      || (b.degree || 0) - (a.degree || 0)
      || a.name.localeCompare(b.name, "zh"));

  const focusRadius = radiusOf(focus);
  const maxRing = Math.max(40, Math.min(width, height) / 2 - (compact ? 18 : 42));
  // 环是椭圆：横向留出更多字位，竖向受画布高度限制。半径仍编码跳数，只是两个半轴不同
  const ringRadii = (radius) => ({
    rx: compact ? Math.min(Math.max(46, width / 2 - 70), Math.max(radius, 40) * 2.1) : Math.min(width / 2 - 70, radius * 1.35),
    ry: compact ? Math.max(26, Math.min(height / 2 - 34, Math.max(radius, 40) * 1.12)) : radius,
  });
  const perimeter = (radius) => {
    const { rx, ry } = ringRadii(radius);
    return Math.PI * (rx + ry);
  };
  const ringNeed = (list) => list.reduce((sum, node) => sum + radiusOf(node) * 2 + (compact ? 20 : 34), 0) / (Math.PI * 2);

  let inner = neighbours;
  const r1Floor = focusRadius + (compact ? 20 : 34);
  // 环半径既要容得下所有邻居，也要把画布用起来：邻居很少时不要把图缩成中间一小团
  const r1Comfortable = maxRing * 0.72;
  const r1Ceiling = Math.max(r1Floor, maxRing * 0.8);
  let r1 = r1Floor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    r1 = Math.min(Math.max(ringNeed(inner), r1Floor, r1Comfortable), r1Ceiling);
    const capacity = Math.max(1, Math.floor(perimeter(r1) / (compact ? 26 : 40)));
    const allowed = compact ? Math.min(capacity, 3) : capacity;
    if (inner.length <= allowed) break;
    inner = inner.slice(0, allowed);
  }

  const angles = new Map();
  // 邻居很少时横着摆，读起来像「中心 —关系→ 邻居」；多了才从正上方开始绕圈
  const angleAt = (index, count) => {
    if (count === 1) return 0;
    if (count === 2) return index === 0 ? 0 : Math.PI;
    return -Math.PI / 2 + (Math.PI * 2 * index) / count;
  };
  inner.forEach((node, index) => {
    angles.set(node.id, angleAt(index, inner.length));
  });

  const childrenByParent = new Map();
  farther.forEach((node) => {
    const owner = parent.get(node.id) || focus.id;
    const list = childrenByParent.get(owner) || [];
    list.push(node);
    childrenByParent.set(owner, list);
  });
  const outer = [];
  childrenByParent.forEach((children, owner) => {
    const base = angles.get(owner) ?? -Math.PI / 4;
    const shown = compact ? [] : children.slice(0, 6);
    shown.forEach((node, index) => {
      const spread = Math.min(0.42, 1.5 / (shown.length + 1));
      angles.set(node.id, base + (index - (shown.length - 1) / 2) * spread);
      outer.push(node);
    });
  });

  const r2 = Math.max(r1 + 34, Math.min(maxRing, r1 * 1.6));
  const innerRing = ringRadii(r1);
  const outerRing = ringRadii(r2);
  const points = new Map();
  points.set(focus.id, { x: center.x, y: center.y, angle: 0, ring: 0 });
  inner.forEach((node) => {
    const angle = angles.get(node.id) ?? 0;
    points.set(node.id, { x: center.x + Math.cos(angle) * innerRing.rx, y: center.y + Math.sin(angle) * innerRing.ry, angle, ring: 1 });
  });
  outer.forEach((node) => {
    const angle = angles.get(node.id) ?? 0;
    points.set(node.id, { x: center.x + Math.cos(angle) * outerRing.rx, y: center.y + Math.sin(angle) * outerRing.ry, angle, ring: 2 });
  });

  return { focus, points, center, hidden: nodes.length - points.size };
}

function graphArrow(svg, tip, direction, variant) {
  const length = 6.5;
  const half = 3.4;
  const baseX = tip.x - direction.x * length;
  const baseY = tip.y - direction.y * length;
  const perpendicularX = -direction.y * half;
  const perpendicularY = direction.x * half;
  const arrow = graphEl("path", `g-arrow${variant ? ` ${variant}` : ""}`);
  arrow.setAttribute(
    "d",
    `M${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${(baseX + perpendicularX).toFixed(1)},${(baseY + perpendicularY).toFixed(1)} L${(baseX - perpendicularX).toFixed(1)},${(baseY - perpendicularY).toFixed(1)} Z`,
  );
  svg.appendChild(arrow);
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
    + shown.map((attr) => `<span class="graph-attr" title="${esc(`${graphRelationLabel(attr)}：${attr.value}`)}">`
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
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / distance;
        const uy = (b.y - a.y) / distance;
        const spacing = Math.min(18, distance / 2);
        const bow = (index - (pair.length - 1) / 2) * spacing * (edge.source < edge.target ? 1 : -1);
        const control = { x: (a.x + b.x) / 2 - uy * bow, y: (a.y + b.y) / 2 + ux * bow };
        const startLength = Math.hypot(control.x - a.x, control.y - a.y);
        const endLength = Math.hypot(b.x - control.x, b.y - control.y);
        const start = { x: a.x + (control.x - a.x) * ra / startLength, y: a.y + (control.y - a.y) * ra / startLength };
        end = { x: b.x - (b.x - control.x) * rb / endLength, y: b.y - (b.y - control.y) * rb / endLength };
        path.setAttribute("d", `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`);
        tangent = { x: b.x - control.x, y: b.y - control.y };
      }
      const title = graphEl("title");
      title.textContent = `${source.name} — ${graphRelationLabel(edge)} → ${target.name}`;
      group.appendChild(title);
      group.appendChild(path);
      const length = Math.hypot(tangent.x, tangent.y);
      graphArrow(group, end, { x: tangent.x / length, y: tangent.y / length }, variant);
      svg.appendChild(group);
    });
  }
  nodes.forEach((node) => {
    const { x, y } = points.get(node.id);
    const direct = neighbours?.has(node.id);
    const group = graphEl("g", `g-node g-overview-node${node.degree ? " linked" : ""}${node.id === hub ? " hub" : direct ? " neighbour" : ""}${node.id === state.activeEntity ? " selected" : ""}${state.graphOverviewZoom ? " zoomed" : ""}`);
    group.setAttribute("transform", `translate(${x},${y})`);
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("data-entity", node.id);
    group.setAttribute("aria-label", `查看 ${node.name} 的详情`);
    const shape = graphEl("circle", "g-shape");
    shape.setAttribute("r", String(radiusOf(node)));
    const label = graphEl("text", "g-label");
    label.setAttribute("text-anchor", "middle");
    const above = direct && y < canvasHeight / 2;
    label.setAttribute("y", String(above ? -radiusOf(node) - 6 : radiusOf(node) + 14));
    label.textContent = graphTextLabel(node.name, node.id === hub ? 24 : direct ? 15 : 10);
    const title = graphEl("title");
    title.textContent = node.name;
    group.appendChild(shape);
    group.appendChild(label);
    group.appendChild(title);
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
  $(".graph-stage").classList.toggle("graph-stage-overview", Boolean(data.overview));
  svg.style.width = "";
  svg.style.height = "";
  const height = Math.max(200, Math.round(svg.clientHeight || 420));
  const allNodes = data.nodes || [];
  const allEdges = data.edges || [];
  const width = Math.max(300, Math.round(svg.clientWidth || 620));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  const legend = $("#graph-legend");
  if (legend) legend.innerHTML = "";

  if (!allNodes.length) {
    const text = graphEl("text", "g-empty");
    text.setAttribute("x", String(width / 2));
    text.setAttribute("y", String(height / 2));
    text.setAttribute("text-anchor", "middle");
    text.textContent = data.loading ? "正在加载图谱…" : data.error || "暂无实体关系";
    svg.appendChild(text);
    setEntitySub(null);
    return;
  }

  if (data.overview) {
    drawGraphOverview(svg, data, width, height);
    return;
  }

  const compact = width < 430;
  const nodeFont = compact ? 9.5 : 11;
  const edgeFont = compact ? 9 : 10;
  const focusId = data.focus || state.activeEntity || allNodes[0].id;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const radiusOf = (node) => graphNodeRadius(node, compact, focusId);
  const drawnEdges = allEdges.filter((edge) => edge.target && nodeById.has(edge.source) && nodeById.has(edge.target));
  const layout = graphFocusLayout(allNodes, drawnEdges, width, height, radiusOf, focusId, compact);
  const points = layout.points;
  const drawnNodes = allNodes.filter((node) => points.has(node.id));
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
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const incident = edge.source === focusId || edge.target === focusId;
    const chord = a.ring !== 0 && a.ring === b.ring;
    const pairKey = [edge.source, edge.target].sort().join("|");
    const twinIndex = pairSeen.get(pairKey) || 0;
    pairSeen.set(pairKey, twinIndex + 1);
    const twin = (pairCounts.get(pairKey) || 0) > 1;
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
    const path = graphEl("path", `g-link${incident ? " strong" : ""}${edge.status === "disputed" ? " disputed" : ""}`);
    path.setAttribute("d", `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${controlX.toFixed(1)},${controlY.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`);
    const title = graphEl("title");
    const sourceName = nodeById.get(edge.source).name;
    const targetName = nodeById.get(edge.target).name;
    const predicateText = (edge.predicates || [edge.predicate]).join(" / ");
    const statusText = edge.status === "disputed" ? "存疑" : "有效";
    const confidenceText = edge.confidence != null ? ` · 置信度 ${edge.confidence}` : "";
    title.textContent = `${sourceName} — ${predicateText}${edge.value ? `（${edge.value}）` : ""} → ${targetName}`
      + `\n关系类型：${graphRelationType(edge)} · ${statusText}${confidenceText}`;
    path.appendChild(title);
    svg.appendChild(path);

    const arrowDirection = { x: end.x - controlX, y: end.y - controlY };
    const arrowLength = Math.hypot(arrowDirection.x, arrowDirection.y) || 1;
    graphArrow(
      svg,
      end,
      { x: arrowDirection.x / arrowLength, y: arrowDirection.y / arrowLength },
      edge.status === "disputed" ? "disputed" : incident ? "strong" : "",
    );

    // 关系标签：短边也要显示，绕着中点换几个位置，永不丢弃
    const labelText = graphTextLabel(graphRelationLabel(edge), compact ? 6 : 8)
      + (edge.count > 1 ? ` ×${edge.count}` : "")
      + (edge.twin ? " ⇄" : "");
    const textWidth = graphTextWidth(labelText, edgeFont);
    const curveX = (start.x + 2 * controlX + end.x) / 4;
    const curveY = (start.y + 2 * controlY + end.y) / 4;
    const normalX = -uy;
    const normalY = ux;
    const candidates = [
      { x: curveX + normalX * 9, y: curveY + normalY * 9, anchor: "middle" },
      { x: curveX - normalX * 9, y: curveY - normalY * 9, anchor: "middle" },
      { x: start.x + (end.x - start.x) * 0.36 + normalX * 9, y: start.y + (end.y - start.y) * 0.36 + normalY * 9, anchor: "middle" },
      { x: start.x + (end.x - start.x) * 0.64 - normalX * 9, y: start.y + (end.y - start.y) * 0.64 - normalY * 9, anchor: "middle" },
      { x: curveX + normalX * 16, y: curveY + normalY * 16, anchor: "middle" },
    ].map((candidate) => graphClampCandidate(candidate, textWidth, width, height));
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
    const tagTitle = graphEl("title");
    tagTitle.textContent = `${sourceName} — ${predicateText}${edge.value ? `（${edge.value}）` : ""} → ${targetName}`
      + `\n关系类型：${graphRelationType(edge)}`;
    group.appendChild(tagTitle);
    svg.appendChild(group);
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
    group.setAttribute("transform", `translate(${point.x},${point.y})`);
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

    const title = graphEl("title");
    const lines = [`${node.name} · ${nodeTypeLabel(node.type)}`, `关系 ${node.degree || 0} 条 · 属性 ${(node.attrs || []).length} 条`];
    (node.attrs || []).slice(0, 5).forEach((attr) => lines.push(`${graphRelationLabel(attr)}：${attr.value}`));
    title.textContent = lines.join("\n");
    group.appendChild(title);

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
    if (attrChips.length) {
      const focusRadius = radiusOf(focusNode);
      const leader = graphEl("line", "g-attr-leader");
      leader.setAttribute("x1", String(layout.center.x));
      leader.setAttribute("y1", String(layout.center.y + focusRadius + 2));
      leader.setAttribute("x2", String(layout.center.x));
      leader.setAttribute("y2", String(attrChips[0].y - attrChips[0].height / 2));
      svg.appendChild(leader);
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
        const chipTitle = graphEl("title");
        chipTitle.textContent = chip.title || chip.text;
        group.appendChild(chipTitle);
        svg.appendChild(group);
      });
      const rest = focusAttrs.length - attrChips.length;
      if (rest > 0) {
        const text = graphEl("text", "g-hint");
        text.setAttribute("x", String(layout.center.x));
        text.setAttribute("y", String(attrChips[attrChips.length - 1].y + attrChips[attrChips.length - 1].height / 2 + 14));
        text.setAttribute("text-anchor", "middle");
        text.textContent = `还有 ${rest} 条属性，见右侧面板`;
        svg.appendChild(text);
      }
    } else {
      const text = graphEl("text", "g-hint");
      text.setAttribute("x", String(layout.center.x));
      text.setAttribute("y", String(layout.center.y + radiusOf(layout.focus) + (compact ? 30 : 38)));
      text.setAttribute("text-anchor", "middle");
      text.textContent = "该实体没有实体间关系，也没有属性";
      svg.appendChild(text);
    }
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
    badge.title = count ? `${count} 个待审项` : "";
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
function reviewQuote(quote, source) {
  if (!quote?.trim()) return "";
  const heading = (source?.heading || []).filter((line) => line && line !== "正文").join(" / ");
  const where = [
    source?.title ? `《${source.title}》` : "",
    source?.page ? `第 ${source.page} 页` : "",
    heading || (!source?.page && source?.seq ? `第 ${source.seq} 段` : ""),
  ].filter(Boolean).join(" · ");
  return `<div class="conflict-quote">原文${where ? `（${esc(where)}）` : ""}：${esc(quote)}</div>`;
}

async function loadReview() {
  const target = $("#review-list");
  target.innerHTML = loadingLines();
  try {
    const data = await api("/review?status=open");
    if (!data.items.length) {
      target.innerHTML = `<div class="empty-block">暂无待审项</div>`;
      return;
    }
    target.innerHTML = data.items.map((item) => {
      const payload = item.payload || {};
      const isFact = Boolean(payload.subject && payload.predicate);
      const current = isFact ? factSentence(payload.subject, payload.predicate, payload.new_object) : "";
      const existing = isFact
        ? (payload.old_objects || []).map((value, index) => ({ value, source: item.old_sources?.[index] })).filter(({ value }) => Boolean(value))
        : [];
      const facts = isFact ? `<div class="conflict">
            <div class="conflict-cell">
              <span class="label">本次提取到的信息</span>
              <div class="conflict-value">${esc(current)}</div>
              ${reviewQuote(payload.quote, item.source)}
            </div>
            <div class="conflict-cell">
              <span class="label">知识库中已有信息</span>
              ${existing.length ? existing.map(({ value, source }) => `
                <div class="conflict-record">
                  <div class="conflict-value">${esc(factSentence(payload.subject, payload.predicate, value))}</div>
                  ${reviewQuote(source?.quote, source)}
                </div>`).join("") : '<div class="conflict-value">没有</div>'}
            </div>
          </div>` : `<h2 class="review-title">${esc(item.title)}</h2>`;
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
    toast(result.status === "queued" ? "已提交抽取，可在知识库查看进度" : "审阅项已处理");
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
    subject.title = item.title || "";
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
async function boot() {
  document.body.dataset.page = state.page;
  $("#token-select").value = state.token;
  $("#token-select").addEventListener("change", async (event) => {
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
    await refreshShell();
    await loadMetaAndHealth();
    loadPage(state.page);
  });

  window.addEventListener("popstate", () => showPage(pageFromUrl()));

  $$(".nav-item").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));
  $$("[data-goto]").forEach((item) => item.addEventListener("click", (event) => {
    if (item instanceof HTMLAnchorElement && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    showPage(item.dataset.goto);
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
  setupAsk();
  setupChat();
  setupEntityView();
  setupTour();
  setupReviewConsult();
  setupOps();

  const initial = pageFromUrl();
  await refreshShell();
  await loadMetaAndHealth();
  showPage(initial);
  connectRealtime();
  if (!localStorage.getItem(tourKey())) openTour();
}

document.addEventListener("DOMContentLoaded", boot);
