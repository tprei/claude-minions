export const state = {
  workflows: [],
  currentId: null,
  currentWorkflow: null,
  transcript: [],
  pushStatusByWorkflow: {},
  error: null,
  streamStatus: "closed",
};

let es = null;
let routeGen = 0;

document.addEventListener("DOMContentLoaded", bootstrap);

function bootstrap() {
  registerSW();
  loadList();
  window.addEventListener("hashchange", onRoute);
  navigator.serviceWorker?.addEventListener("message", (evt) => {
    if (evt.data?.type === "navigate") {
      window.location.hash = `#/workflow/${evt.data.workflowId}`;
    }
  });
  onRoute();
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function onRoute() {
  const id = parseHash(window.location.hash);
  if (id) {
    state.currentId = id;
    loadWorkflowAndSubscribe(id);
  } else {
    state.currentId = null;
    state.currentWorkflow = null;
    state.transcript = [];
    closeStream();
    render();
  }
}

export function parseHash(hash) {
  const m = /^#\/workflow\/([^/]+)$/.exec(hash);
  if (!m || !m[1]) return null;
  return m[1];
}

function loadList() {
  fetch("/workflows")
    .then((r) => r.json())
    .then((data) => {
      state.workflows = data;
      render();
    })
    .catch((err) => {
      state.error = err.message;
      render();
    });
}

export function loadWorkflowAndSubscribe(id) {
  const myGen = ++routeGen;
  closeStream();
  state.currentWorkflow = null;
  state.transcript = [];
  render();

  fetch(`/workflows/${id}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((wf) => {
      if (myGen !== routeGen) return;
      state.currentWorkflow = wf;
      render();
      openStream(id);
    })
    .catch((err) => {
      if (myGen !== routeGen) return;
      state.error = err.message;
      render();
    });
}

function openStream(id) {
  closeStream();
  es = new EventSource(`/workflows/${id}/events`);
  state.streamStatus = "connected";
  updateLiveIndicator();

  es.addEventListener("task-transitioned", (e) => {
    const event = JSON.parse(e.data);
    const payload = event.payload;
    if (!state.currentWorkflow) return;
    const nodes = state.currentWorkflow.graph;
    const task = nodes[payload.taskId];
    if (task) nodes[payload.taskId] = { ...task, executionStatus: payload.toExecutionStatus };
    renderKanban();
  });

  es.addEventListener("workflow-status-changed", (e) => {
    const event = JSON.parse(e.data);
    const payload = event.payload;
    if (!state.currentWorkflow) return;
    state.currentWorkflow = { ...state.currentWorkflow, status: payload.toStatus };
    renderKanban();
  });

  es.addEventListener("provider-event", (e) => {
    const event = JSON.parse(e.data);
    const payload = event.payload;
    const node = transcriptNode(payload);
    state.transcript.push(payload);
    const container = document.querySelector(".transcript");
    if (container) {
      container.appendChild(node);
      container.scrollTop = container.scrollHeight;
    }
  });

  es.onerror = () => {
    state.streamStatus = "reconnecting";
    updateLiveIndicator();
  };
}

function closeStream() {
  if (es) {
    es.close();
    es = null;
  }
  state.streamStatus = "closed";
  updateLiveIndicator();
}

function updateLiveIndicator() {
  const indicator = document.querySelector(".live-indicator");
  if (!indicator) return;
  indicator.className = `live-indicator ${state.streamStatus}`;
  const dot = indicator.querySelector(".live-dot");
  const label = indicator.querySelector(".live-label");
  if (state.streamStatus === "connected") {
    if (label) label.textContent = "LIVE";
  } else if (state.streamStatus === "reconnecting") {
    if (label) label.textContent = "RECONNECTING";
  } else {
    if (label) label.textContent = "OFFLINE";
  }
}

export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

export function glyphFor(kind) {
  switch (kind) {
    case "assistant_text":    return "▸";
    case "thinking":          return "◇";
    case "tool_call":         return "▸";
    case "tool_result":       return "■";
    case "permission_request":return "⚠";
    case "usage":             return "∑";
    case "error":             return "✕";
    case "final":             return "■";
    default:                  return "▸";
  }
}

export function statusColorClass(status) {
  switch (status) {
    case "pending":
    case "ready":
      return "status-pending";
    case "running":
    case "finalizing":
    case "quality-pending":
    case "ci-pending":
      return "status-running";
    case "needs-review":
    case "pr-open":
      return "status-review";
    case "completed":
    case "merged":
      return "status-done";
    case "failed":
    case "cancelled":
      return "status-failed";
    default:
      return "status-pending";
  }
}

export function transcriptNode(payload) {
  const el = document.createElement("div");
  el.classList.add("msg");

  const kind = payload?.providerEvent?.kind ?? payload?.kind;
  const ev = payload?.providerEvent ?? payload;

  const ts = document.createElement("div");
  ts.className = "msg-ts";
  ts.textContent = formatTime(new Date());

  const glyph = document.createElement("div");
  glyph.className = "msg-glyph";

  const content = document.createElement("div");
  content.className = "msg-content";

  switch (kind) {
    case "assistant_text":
      el.classList.add("assistant");
      glyph.textContent = glyphFor("assistant_text");
      content.textContent = ev.text ?? "";
      break;

    case "thinking":
      el.classList.add("thinking");
      glyph.textContent = glyphFor("thinking");
      content.textContent = ev.text ?? "";
      break;

    case "tool_call": {
      el.classList.add("tool-call");
      glyph.textContent = glyphFor("tool_call");
      const summary = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = ev.name ?? "";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(ev.input, null, 2);
      summary.appendChild(sum);
      summary.appendChild(pre);
      content.textContent = `${ev.name}(${JSON.stringify(ev.input)})`;
      content.appendChild(summary);
      break;
    }

    case "tool_result":
      el.classList.add("tool-result");
      if (ev.isError) {
        el.classList.add("err");
        glyph.textContent = "✕";
      } else {
        glyph.textContent = glyphFor("tool_result");
      }
      content.textContent = JSON.stringify(ev.output);
      break;

    case "permission_request":
      el.classList.add("perm");
      glyph.textContent = glyphFor("permission_request");
      content.textContent = `permission: ${ev.tool}`;
      break;

    case "usage":
      el.classList.add("usage");
      glyph.textContent = glyphFor("usage");
      content.textContent = `tokens — in:${ev.inputTokens ?? 0} out:${ev.outputTokens ?? 0}`;
      break;

    case "error":
      el.classList.add("error");
      glyph.textContent = glyphFor("error");
      content.textContent = ev.message;
      break;

    case "final":
      el.classList.add("final");
      glyph.textContent = glyphFor("final");
      content.textContent = `final ${ev.sessionRef}`;
      break;

    default:
      el.classList.add("assistant");
      glyph.textContent = glyphFor(kind);
      content.textContent = JSON.stringify(payload);
  }

  el.appendChild(ts);
  el.appendChild(glyph);
  el.appendChild(content);

  return el;
}

function submitReply(taskId, prompt, fresh) {
  const body = {
    kind: fresh ? "retry-task" : "continue-task",
    workflowId: state.currentId,
    taskId,
    prompt,
  };

  fetch("/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function setupPush(workflowId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  navigator.serviceWorker.ready
    .then((reg) => fetch("/push/vapid-public-key").then((r) => r.json()).then((data) => ({ reg, key: data.publicKey })))
    .then(({ reg, key }) =>
      Notification.requestPermission().then((permission) => ({ reg, key, permission }))
    )
    .then(({ reg, key, permission }) => {
      if (permission !== "granted") {
        state.pushStatusByWorkflow[workflowId] = "denied";
        renderPushBanner();
        return;
      }
      return reg.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })
        .then((sub) =>
          fetch("/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowId, subscription: sub.toJSON() }),
          })
        )
        .then(() => {
          state.pushStatusByWorkflow[workflowId] = "subscribed";
          renderPushBanner();
        });
    })
    .catch(() => {
      state.pushStatusByWorkflow[workflowId] = "denied";
      renderPushBanner();
    });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = "";

  renderHeader(app);

  if (state.error) {
    const err = document.createElement("div");
    err.className = "err-msg";
    err.textContent = state.error;
    app.appendChild(err);
    return;
  }

  if (state.currentWorkflow) {
    renderPushBanner();
    const main = document.createElement("main");
    renderKanban(main);
    renderTranscript(main);
    renderReply(main);
    app.appendChild(main);
  } else {
    renderWorkflowList(app);
  }
}

function renderHeader(container) {
  const hdr = document.createElement("header");

  const h1 = document.createElement("h1");
  h1.textContent = "Minions";
  hdr.appendChild(h1);

  if (state.currentWorkflow) {
    const indicator = document.createElement("div");
    indicator.className = `live-indicator ${state.streamStatus}`;

    const label = document.createElement("span");
    label.className = "live-label";
    label.textContent = state.streamStatus === "connected"
      ? "LIVE"
      : state.streamStatus === "reconnecting"
        ? "RECONNECTING"
        : "OFFLINE";

    const dot = document.createElement("span");
    dot.className = "live-dot";

    indicator.appendChild(label);
    indicator.appendChild(dot);
    hdr.appendChild(indicator);
  }

  container.appendChild(hdr);
}

function renderPushBanner() {
  const app = document.getElementById("app");
  if (!app) return;

  let banner = app.querySelector(".banner");
  const pushStatus = state.pushStatusByWorkflow[state.currentId] ?? "idle";

  if (!banner) {
    banner = document.createElement("div");
    banner.className = "banner";
    const hdr = app.querySelector("header");
    if (hdr && hdr.nextSibling) {
      app.insertBefore(banner, hdr.nextSibling);
    } else {
      app.appendChild(banner);
    }
  }

  banner.innerHTML = "";

  if (pushStatus === "subscribed") {
    banner.classList.add("subscribed");
    const span = document.createElement("span");
    span.textContent = "notifications active ✓";
    banner.appendChild(span);
    setTimeout(() => banner.remove(), 3000);
    return;
  }

  if (pushStatus === "denied") {
    banner.classList.add("denied");
    const span = document.createElement("span");
    span.textContent = "notifications blocked · enable in browser settings";
    banner.appendChild(span);
    return;
  }

  if (pushStatus === "unsupported") {
    banner.classList.add("unsupported");
    const span = document.createElement("span");
    span.textContent = "push notifications not supported in this browser";
    banner.appendChild(span);
    return;
  }

  const span = document.createElement("span");
  span.textContent = "notifications off · enable →";
  banner.appendChild(span);
  banner.addEventListener("click", () => setupPush(state.currentId), { once: true });
}

function renderWorkflowList(container) {
  if (state.workflows.length === 0) {
    const loading = document.createElement("div");
    loading.className = "loading";
    loading.textContent = "No active workflows.";
    container.appendChild(loading);
    return;
  }

  const list = document.createElement("div");
  list.className = "workflow-list";

  for (const wf of state.workflows) {
    const item = document.createElement("div");
    const isActive = wf.id === state.currentId;
    item.className = `workflow-item${isActive ? " active" : ""}`;
    item.addEventListener("click", () => {
      window.location.hash = `#/workflow/${wf.id}`;
    });

    const titleEl = document.createElement("div");
    titleEl.className = "wf-title";
    titleEl.textContent = wf.title || wf.id;

    const idEl = document.createElement("div");
    idEl.className = "wf-id";
    idEl.textContent = wf.id;

    const meta = document.createElement("div");
    meta.className = "wf-meta";

    const statusEl = document.createElement("div");
    const sc = statusColorClass(wf.status ?? "pending");
    statusEl.className = `wf-status ${sc}`;
    statusEl.textContent = `[${wf.status ?? "unknown"}]`;

    const timeEl = document.createElement("div");
    timeEl.className = "wf-time";
    timeEl.textContent = wf.updatedAt ? formatTime(wf.updatedAt) : "";

    meta.appendChild(statusEl);
    meta.appendChild(timeEl);

    item.appendChild(titleEl);
    item.appendChild(idEl);
    item.appendChild(meta);
    list.appendChild(item);
  }

  container.appendChild(list);
}

function renderKanban(container) {
  const wf = state.currentWorkflow;
  if (!wf) return;

  let kanban = container
    ? null
    : document.querySelector(".kanban");

  if (kanban) {
    kanban.innerHTML = "";
  } else {
    kanban = document.createElement("div");
    kanban.className = "kanban";
    if (container) container.appendChild(kanban);
  }

  const BUCKET = {
    pending: "Pending",
    ready: "Pending",
    running: "Running",
    finalizing: "Running",
    "quality-pending": "Running",
    "ci-pending": "Running",
    "needs-review": "Review",
    "pr-open": "Review",
    completed: "Done",
    merged: "Done",
    failed: "Failed",
    cancelled: "Failed",
  };

  const columns = {
    Pending: [],
    Running: [],
    Review: [],
    Done: [],
    Failed: [],
  };

  for (const node of Object.values(wf.graph)) {
    const bucket = BUCKET[node.executionStatus] ?? "Pending";
    columns[bucket].push(node);
  }

  const statusClassMap = {
    Pending: "status-pending",
    Running: "status-running",
    Review: "status-review",
    Done: "status-done",
    Failed: "status-failed",
  };

  for (const [colName, tasks] of Object.entries(columns)) {
    if (tasks.length === 0 && colName !== "Pending" && colName !== "Running") continue;

    const col = document.createElement("div");
    col.className = "kanban-col";

    const colHeader = document.createElement("div");
    colHeader.className = "kanban-col-header";

    const h2 = document.createElement("h2");
    h2.textContent = colName.toUpperCase();

    const count = document.createElement("span");
    count.className = "kanban-col-count";
    count.textContent = String(tasks.length).padStart(2, "0");

    colHeader.appendChild(h2);
    colHeader.appendChild(count);
    col.appendChild(colHeader);

    for (const task of tasks) {
      const card = document.createElement("div");
      const sc = statusClassMap[colName] ?? "status-pending";
      card.className = `task-card ${sc}`;
      card.dataset.taskId = task.id;

      const titleRow = document.createElement("div");
      titleRow.className = "task-card-title";

      if (colName === "Running") {
        const arrow = document.createElement("span");
        arrow.className = "task-running-glyph";
        arrow.textContent = "▶";
        titleRow.appendChild(arrow);
      }

      const titleText = document.createTextNode(task.title || task.id);
      titleRow.appendChild(titleText);
      card.appendChild(titleRow);

      const meta = document.createElement("div");
      meta.className = "task-card-meta";
      const parts = [];
      if (task.attempt != null) parts.push(`attempt: ${task.attempt}`);
      if (task.runs != null) parts.push(`runs: ${task.runs}`);
      if (parts.length) meta.textContent = parts.join(" · ");
      card.appendChild(meta);

      col.appendChild(card);
    }

    kanban.appendChild(col);
  }
}

function renderTranscript(container) {
  let transcript = container
    ? null
    : document.querySelector(".transcript");

  if (!transcript) {
    transcript = document.createElement("div");
    transcript.className = "transcript";
    if (container) container.appendChild(transcript);
  }

  transcript.replaceChildren(...state.transcript.map(transcriptNode));
}

export function renderReply(container, workflow) {
  const wf = workflow !== undefined ? workflow : state.currentWorkflow;

  let reply = container ? null : document.querySelector(".reply");

  if (!reply) {
    reply = document.createElement("div");
    reply.className = "reply";
    if (container) container.appendChild(reply);
  }

  reply.innerHTML = "";

  const reviewTask = wf
    ? Object.values(wf.graph).find((n) => n.executionStatus === "needs-review")
    : undefined;

  if (!reviewTask) {
    const placeholder = document.createElement("div");
    placeholder.className = "reply-placeholder";
    placeholder.textContent = "No tasks awaiting review.";
    reply.appendChild(placeholder);
    return;
  }

  const taskId = reviewTask.id;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Reply to agent…";
  reply.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "reply-actions";

  const btnContinue = document.createElement("button");
  btnContinue.className = "btn-continue";
  btnContinue.textContent = "Continue";
  btnContinue.addEventListener("click", () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    submitReply(taskId, prompt, false);
    input.value = "";
  });
  actions.appendChild(btnContinue);

  const btnFresh = document.createElement("button");
  btnFresh.className = "btn-fresh";
  btnFresh.textContent = "Start fresh";
  btnFresh.addEventListener("click", () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    submitReply(taskId, prompt, true);
    input.value = "";
  });
  actions.appendChild(btnFresh);

  reply.appendChild(actions);
}
