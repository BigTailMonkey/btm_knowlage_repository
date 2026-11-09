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
  entities: [],
  graph: { nodes: [], edges: [] },
  activeEntity: null,
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
function showPage(page) {
  if (!PAGE_META[page]) page = "chat";
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
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
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
    ${items.map(task => `
      <div class="job-card${task.status === "failed" ? " failed" : ""}">
        <div class="job-line"><strong class="job-title">${esc(task.title)} · v${num(task.version)}</strong>
          <span class="job-stage">${task.status === "failed" ? "抽取失败" : task.status === "running" ? "抽取中" : "等待抽取"}</span>
        </div>
        ${task.status === "failed" ? `<p class="muted small">${esc(task.error || "上次抽取失败，可重试。")}</p>
          ${can_retry ? `<button class="text-btn" data-extraction-retry="${esc(task.id)}" ${extractionRetrying ? "disabled" : ""}>重试抽取</button>` : ""}` : ""}
      </div>`).join("")}` : "";
  $$("[data-extraction-retry]", box).forEach(button => button.addEventListener("click", async () => {
    if (extractionRetrying) return;
    extractionRetrying = true;
    const id = button.dataset.extractionRetry;
    renderExtractionJobs({ items, can_retry });
    try {
      const result = await api("/documents/extractions/retry", { method: "POST", body: id ? { document_ids: [id] } : {} });
      toast(result.queued ? `已提交 ${num(result.queued)} 项抽取重试` : "没有可重试的失败项");
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
    const enrichmentLabel = ENRICHMENT_LABEL[doc.enrichment_status];
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
        ${data.review_only_facts ? `<p class="muted small">${num(data.review_only_facts)} 条低置信度候选仅供审阅。</p>` : ""}
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
        ${enrichmentLabel ? `<p class="muted small">${esc(enrichmentLabel)}</p>` : ""}
        ${doc.enrichment_status === "failed" && doc.enrichment_error ? `<p class="muted small">${esc(doc.enrichment_error)}</p>` : ""}
        <div class="pill-row">${data.entities.length ? data.entities.map((entity) => `<span class="pill">${esc(entity.name)}</span>`).join("") : enrichmentLabel ? "" : `<span class="muted small">暂无</span>`}</div>
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
    if (event.data?.type !== "knowweave:open-citation" || typeof event.data.path !== "string") return;
    const citation = /^\/([\w-]{1,100})\/([\w-]{1,100})(?:\/([\w-]{1,100}))?$/.exec(event.data.path);
    if (citation) void openChatCitation(citation[1], citation[2], citation[3]);
  });
  $("#native-chat-retry").addEventListener("click", () => {
    resetNativeChat();
    return loadChat();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && nativeChat.url) {
      nativeChat.graceUntil = Date.now() + NATIVE_CHAT_RESUME_MS;
    }
  });
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
      <div class="entity-detail-main">
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
    target.innerHTML = `<div class="empty-block">${esc(error.message)}</div>`;
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
    await loadGraph();
    await selectEntity(entityId);
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
    drawGraph(null);
    await loadEntities($("#entity-search").value.trim());
    await loadGraph();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
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

function localComponent(component, radiusOf, compact, spread = 1) {
  const degree = new Map(component.nodes.map((node) => [node.id, 0]));
  component.edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });
  const hub = component.nodes.reduce((best, node) => (degree.get(node.id) > degree.get(best.id) ? node : best), component.nodes[0]);
  const positions = new Map([[hub.id, { x: 0, y: 0 }]]);
  const others = component.nodes.filter((node) => node.id !== hub.id);
  const radius = (compact ? 34 : 48) * spread;
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

function graphLayout(nodes, edges, width, height, radiusOf, centerId, compact, gridMode, spread = 1) {
  const components = splitGraph(nodes, edges);
  const selected = components.find((component) => component.nodes.some((node) => node.id === centerId)) || components[0];
  const rest = components.filter((component) => component !== selected);
  const layouts = new Map(components.map((component) => [component, localComponent(component, radiusOf, compact, spread)]));
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
  // 画布越大，星形排布越舒展，避免小图悬浮在大片空白里
  const spread = compact || gridMode ? 1 : Math.max(1, Math.min(1.8, Math.min(width, height) / 520));
  const radiusOf = (node) => {
    if (node.id === center.id) return compact ? 19 : 24;
    return (compact ? 8 : 9) + Math.min(compact ? 6 : 8, (degree.get(node.id) || 0) * (compact ? 1.6 : 2));
  };
  const points = graphLayout(nodes, edges, width, height, radiusOf, center.id, compact, gridMode, spread);

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
        ? (payload.old_objects || []).filter(Boolean).map((value) => factSentence(payload.subject, payload.predicate, value))
        : [];
      const source = item.source || null;
      const heading = (source?.heading || []).filter((line) => line && line !== "正文").join(" / ");
      const where = [
        source?.title ? `《${source.title}》` : "",
        source?.page ? `第 ${source.page} 页` : "",
        heading || (!source?.page && source?.seq ? `第 ${source.seq} 段` : ""),
      ].filter(Boolean).join(" · ");
      const quote = payload.quote ? plain(payload.quote) : "";
      const quoteLine = quote
        ? `<div class="conflict-quote">原文${where ? `（${esc(where)}）` : ""}：${esc(quote)}</div>`
        : "";
      const facts = isFact ? `<div class="conflict">
            <div class="conflict-cell">
              <span class="label">本次提取到的信息</span>
              <div class="conflict-value">${esc(current)}</div>
              ${quoteLine}
            </div>
            <div class="conflict-cell">
              <span class="label">知识库中已有信息</span>
              <div class="conflict-value">${existing.length ? existing.map((line) => esc(line)).join("<br>") : "没有"}</div>
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
  setupTour();
  setupReviewConsult();
  setupOps();

  const initial = (location.hash || "#chat").replace("#", "");
  await refreshShell();
  await loadMetaAndHealth();
  showPage(PAGE_META[initial] ? initial : "chat");
  connectRealtime();
  if (!localStorage.getItem(tourKey())) openTour();
}

document.addEventListener("DOMContentLoaded", boot);
