import { taskBoardLayout } from "./task-board-layout.js";

export function renderBoardClient(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  const layout = JSON.stringify(taskBoardLayout);
  return `<script>
    const TOKEN = ${token};
    const boardLayout = ${layout};
    const columns = boardLayout.columns;
    const statusLabels = {
      active: "进行中", selecting_tasks: "安排任务中", evaluating: "产品验收中",
      waiting_for_input: "等待决定", stalled: "暂无进展", completed: "已完成",
      blocked: "已阻塞", cancelled: "已取消", backlog: "待安排", developing: "开发中",
      reviewing: "审查中", changes_requested: "返工中", integrating: "合入中", done: "已完成",
      running: "自动推进", paused: "已暂停", develop: "开发", rework: "返工", review: "审查",
      integrate: "合入", pending: "待开始", awaiting_report: "等待汇报", failed: "执行失败",
      interrupted: "已中断", approved: "审查通过", needs_review: "等待审查",
      needs_input: "等待决定", queued: "待安排",
      selected: "已完成本轮安排", waiting_for_task: "等待任务完成",
      retry_scheduled: "等待模型重试", active_paused: "执行中 · 后续已暂停",
      primary: "默认", fallback: "备用", user_confirmed: "用户确认",
      agent_decision: "Codex 判断", codex: "Codex", user: "用户",
      development_completed: "开发完成", rework_completed: "返工完成",
      review_approved: "审查通过", review_changes_requested: "审查退回",
      review_requested: "请求审查", integration_completed: "合入完成",
      decision_requested: "请求决定", execution_failed: "执行失败"
    };
    const path = window.location.pathname;
    const route = path === "/settings"
      ? { type: "settings" }
      : path.startsWith("/projects/")
        ? { type: "project", projectId: decodeURIComponent(path.slice("/projects/".length)) }
        : { type: "board" };
    let snapshots = [];
    let selectedProjectId = null;
    let selectedTaskId = null;
    let skillStatus = null;
    let productDetail = null;
    let taskDetail = null;
    let systemSettings = null;
    const headers = { "x-codrive-token": TOKEN, "content-type": "application/json" };
    const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[character]));
    const bucket = status => boardLayout.statusColumns[status] || status;
    const label = status => statusLabels[status] || String(status || "").replaceAll("_", " ");
    const formatTime = value => value ? new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const initials = value => String(value || "C").trim().split(/\\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    const command = (type, payload) => api("/api/commands", {
      method: "POST",
      body: JSON.stringify({ type, payload })
    });

    async function refreshSetup() {
      const system = await api("/api/system");
      skillStatus = system.skills;
      renderSetup();
    }

    function renderSetup() {
      const dialog = document.getElementById("setup-dialog");
      const trigger = document.getElementById("setup-trigger");
      if (!skillStatus || skillStatus.state === "current") {
        dialog.hidden = true;
        trigger.hidden = true;
        return;
      }
      const copy = {
        missing: {
          dialog: "完成一次本机设置后，就可以在 Codex 中使用 Codrive。",
          trigger: "完成一次设置即可使用"
        },
        outdated: {
          dialog: "Codrive 设置有更新，可以立即升级。",
          trigger: "有新版本可以升级"
        },
        conflict: {
          dialog: "检测到同名的本地扩展，请先处理后再继续。",
          trigger: "同名扩展需要处理"
        }
      }[skillStatus.state];
      document.getElementById("setup-copy").textContent = copy.dialog;
      document.getElementById("setup-trigger-copy").textContent = copy.trigger;
      const install = document.getElementById("setup-install");
      install.textContent = skillStatus.state === "missing" ? "立即设置" : "立即升级";
      install.disabled = skillStatus.state === "conflict";
      trigger.hidden = false;
      const dismissedVersion = localStorage.getItem("codrive:skills-dismissed");
      dialog.hidden = dismissedVersion === skillStatus.bundledVersion;
    }

    async function installSkills() {
      const button = document.getElementById("setup-install");
      const status = document.getElementById("setup-status");
      button.disabled = true;
      status.textContent = "正在完成设置...";
      try {
        const result = await command("system.install_skills", {});
        skillStatus = result.skills;
        localStorage.removeItem("codrive:skills-dismissed");
        status.textContent = "设置完成，可以在 Codex 中开始了。";
        renderSetup();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    async function refresh() {
      try {
        const requests = [api("/api/board")];
        if (route.type === "project") requests.push(api("/api/projects/"+encodeURIComponent(route.projectId)));
        if (route.type === "settings") requests.push(api("/api/system/settings"));
        const results = await Promise.all(requests);
        snapshots = results[0];
        productDetail = route.type === "project" ? results[1] : null;
        systemSettings = route.type === "settings" ? results[1] : null;
        document.getElementById("offline").style.display = "none";
        if (route.type === "project") selectedProjectId = route.projectId;
        if (!selectedProjectId || !snapshots.some(snapshot => snapshot.project.id === selectedProjectId)) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
        }
        const snapshot = currentSnapshot();
        if (selectedTaskId && !snapshot?.tasks.some(task => task.id === selectedTaskId)) {
          selectedTaskId = null;
          taskDetail = null;
        }
        if (route.type === "board" && selectedTaskId) {
          taskDetail = await api("/api/tasks/"+encodeURIComponent(selectedTaskId));
        }
        render();
      } catch {
        document.getElementById("offline").style.display = "block";
      }
    }

    const currentSnapshot = () => snapshots.find(snapshot => snapshot.project.id === selectedProjectId);

    function render() {
      renderProjects();
      if (route.type === "settings") renderSettings();
      else if (route.type === "project") renderProductDetail();
      else renderWorkspace();
      if (route.type === "board") renderTaskDetail();
      else clearTaskDetail();
    }

    function renderProjects() {
      document.getElementById("project-count").textContent = snapshots.length;
      const host = document.getElementById("projects");
      host.innerHTML = snapshots.length
        ? snapshots.map(({ project, tasks }) =>
            '<button class="project-button '+(project.id === selectedProjectId ? 'active' : '')+'" type="button" data-project="'+escapeHtml(project.id)+'" aria-pressed="'+(project.id === selectedProjectId)+'">'+
              '<span class="project-glyph">'+escapeHtml(initials(project.name))+'</span>'+
              '<span class="project-label"><b>'+escapeHtml(project.name)+'</b><small>'+escapeHtml(label(project.displayStatus))+'</small></span>'+
              '<span class="project-total">'+tasks.length+'</span>'+
            '</button>'
          ).join("")
        : '';
      host.querySelectorAll("[data-project]").forEach(button => {
        button.onclick = () => {
          if (route.type !== "board") {
            window.location.href = "/projects/"+encodeURIComponent(button.dataset.project);
            return;
          }
          selectedProjectId = button.dataset.project;
          selectedTaskId = null;
          taskDetail = null;
          document.body.classList.remove("detail-open", "nav-open");
          render();
        };
      });
    }

    function renderWorkspace() {
      const snapshot = currentSnapshot();
      const host = document.getElementById("project");
      if (!snapshot) {
        host.innerHTML = '<div class="empty-workspace"><section class="empty-card"><div class="empty-kicker">从这里开始</div><h1>告诉 Codex 你的想法</h1><p>直接用自然语言描述，确认计划后，Codrive 会自动推进任务。</p><div class="starter-example">“用 Codrive 的方式帮我做一个经营太空货运公司的游戏。”</div></section></div>';
        return;
      }
      const { project, tasks } = snapshot;
      const active = tasks.filter(task => ["developing", "reviewing", "changes_requested", "integrating"].includes(task.status)).length;
      const waiting = tasks.filter(task => ["waiting_for_input", "blocked"].includes(task.status)).length;
      const done = tasks.filter(task => task.status === "done").length;
      const terminal = ["completed", "cancelled"].includes(project.status);
      const actions = terminal ? [] : [project.scheduling === "paused"
        ? '<button class="action-button" data-project-action="resume">继续</button>'
        : '<button class="action-button" data-project-action="pause">暂停</button>'];
      actions.unshift('<a class="action-button" href="/projects/'+encodeURIComponent(project.id)+'">产品详情</a>');
      if (project.executionStatus === "failed" && project.requestedAction) actions.unshift('<button class="action-button" data-project-action="retry">重试失败执行</button>');
      if (["waiting_for_task", "needs_input", "blocked"].includes(project.planning.status)) actions.unshift('<button class="action-button" data-project-action="replan">重新判断任务</button>');
      const attention = project.attention;
      const attentionCopy = attention?.question || attention?.summary;
      const cancellationReason = project.cancellation?.reason || (project.status === "cancelled" ? "历史取消记录未保存理由。" : null);
      const planningBanner = cancellationReason
        ? '<div class="planning-notice cancellation"><b>取消理由</b><span title="'+escapeHtml(cancellationReason)+'">'+escapeHtml(cancellationReason)+'</span><a href="/projects/'+encodeURIComponent(project.id)+'">查看详情</a></div>'
        : attentionCopy
        ? '<div class="planning-notice '+escapeHtml(attention.kind)+'"><b>'+escapeHtml(attention.kind === "decision_requested" ? "请求决定" : "项目阻塞")+'</b><span title="'+escapeHtml(attentionCopy)+'">'+escapeHtml(attentionCopy)+'</span><a href="/projects/'+encodeURIComponent(project.id)+'#attention">查看详情</a></div>'
        : '';
      host.innerHTML =
        '<header class="workspace-header">'+
          '<div class="workspace-topline">'+
            '<div class="project-identity">'+
              '<button id="mobile-projects" class="mobile-projects" type="button" aria-label="打开项目列表">☰</button>'+
              '<span class="project-status-dot"></span>'+
              '<div class="project-title"><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span><span>'+escapeHtml(label(project.planning.status))+'</span></div><h1><a href="/projects/'+encodeURIComponent(project.id)+'">'+escapeHtml(project.name)+'</a></h1>'+planningBanner+'</div>'+
            '</div>'+
            '<div class="project-actions">'+actions.join("")+'</div>'+
          '</div>'+
          '<div class="project-stats"><span><b>'+tasks.length+'</b>总任务</span><span><b>'+active+'</b>进行中</span><span><b>'+waiting+'</b>等待</span><span><b>'+done+'</b>已完成</span></div>'+
        '</header>'+
        '<div class="board-wrap"><div class="board">'+columns.map(([key, columnLabel]) => {
          const cards = tasks.filter(task => bucket(task.status) === key);
          return '<section class="column" data-column="'+key+'"><div class="column-head"><span><i></i>'+columnLabel+'</span><b>'+cards.length+'</b></div><div class="column-body">'+
            (cards.length ? cards.map(taskCard).join("") : '<div class="column-empty">暂无任务</div>')+
          '</div></section>';
        }).join("")+'</div></div>';

      document.getElementById("mobile-projects").onclick = () => document.body.classList.add("nav-open");
      host.querySelectorAll("[data-project-action]").forEach(button => {
        button.onclick = async () => {
          await command("project.control", { projectId: project.id, action: button.dataset.projectAction });
          await refresh();
        };
      });
      host.querySelectorAll("[data-task]").forEach(button => {
        button.onclick = async () => {
          selectedTaskId = button.dataset.task;
          taskDetail = await api("/api/tasks/"+encodeURIComponent(selectedTaskId));
          document.body.classList.add("detail-open");
          render();
        };
      });
    }

    function taskCard(task) {
      const copy = task.cancellation?.reason || task.description;
      const alert = ["waiting_for_input", "blocked", "changes_requested"].includes(task.status) ? "task-alert" : "";
      const visibleStatus = task.executionStatus === "retry_scheduled" ? task.executionStatus : task.status;
      return '<button class="task-card '+(task.id === selectedTaskId ? 'active' : '')+'" type="button" data-task="'+escapeHtml(task.id)+'" data-status="'+escapeHtml(task.status)+'">'+
        '<span class="task-card-top"><span class="task-index">任务 '+String(task.order).padStart(2, "0")+'</span><span class="task-state '+alert+'"><i></i>'+escapeHtml(label(visibleStatus))+'</span></span>'+
        '<h3>'+escapeHtml(task.title)+'</h3><p>'+escapeHtml(copy)+'</p>'+
        '<span class="task-card-footer"><span class="task-action">'+escapeHtml(label(task.requestedAction || task.status || "queued"))+'</span><span>'+escapeHtml(formatTime(task.updatedAt))+'</span></span>'+
      '</button>';
    }

    function renderSettings() {
      const host = document.getElementById("project");
      if (!systemSettings) return;
      const { settings, availableModels } = systemSettings;
      const options = selected => availableModels.map(model =>
        '<option value="'+escapeHtml(model.id)+'" '+(model.id === selected ? 'selected' : '')+'>'+escapeHtml(model.displayName)+'</option>'
      ).join("");
      host.innerHTML =
        '<div class="page-screen settings-screen">'+
          '<header class="settings-header"><a class="eyebrow-link" href="/">← 返回看板</a><div><h1>运行设置</h1><p>调整后续任务的并发数和模型路由。</p></div></header>'+
          '<form id="settings-form" class="settings-form settings-panel">'+
            '<label class="setting-field"><span><b>每个项目的并发任务数</b><small>每个项目独立计算容量，不同项目互不占用槽位。</small></span><input name="maxConcurrentTasks" type="number" min="1" max="32" required value="'+settings.maxConcurrentTasks+'"></label>'+
            '<label class="setting-field"><span><b>默认模型</b><small>新任务、审查、合入与项目规划优先使用这个模型。</small></span><select name="primary">'+options(settings.models.primary)+'</select></label>'+
            '<label class="setting-field"><span><b>备用模型</b><small>默认模型容量重试三次后，在同一任务对话中切换到这里。</small></span><select name="fallback">'+options(settings.models.fallback)+'</select></label>'+
            '<div class="settings-actions"><button class="primary-button" type="submit">保存并应用</button><span id="settings-status" role="status"></span></div>'+
          '</form>'+
        '</div>';
      document.getElementById("settings-form").onsubmit = async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const status = document.getElementById("settings-status");
        status.textContent = "正在保存...";
        try {
          systemSettings = await command("system.update_settings", {
            maxConcurrentTasks: Number(form.get("maxConcurrentTasks")),
            models: {
              primary: String(form.get("primary")),
              fallback: String(form.get("fallback"))
            }
          });
          status.textContent = "设置已保存并生效。";
          renderSettings();
          document.getElementById("settings-status").textContent = "设置已保存并生效。";
        } catch (error) {
          status.textContent = error.message;
        }
      };
    }

    function renderProductDetail() {
      const host = document.getElementById("project");
      if (!productDetail) return;
      const { project, productDocument, attention, tasks } = productDetail;
      const model = project.currentExecution?.modelRouting;
      const cancellationReason = project.cancellation?.reason || (project.status === "cancelled" ? "历史取消记录未保存理由。" : null);
      const notice = cancellationReason
        ? '<section id="planning" class="product-panel planning-panel cancellation"><div class="panel-heading"><span>取消理由</span><b>'+(project.cancellation ? escapeHtml(label(project.cancellation.decisionBasis)) : "历史记录")+'</b></div><p>'+escapeHtml(cancellationReason)+'</p>'+(project.cancellation ? '<div class="cancellation-meta">'+escapeHtml(label(project.cancellation.cancelledBy))+' · '+escapeHtml(formatTime(project.cancellation.cancelledAt))+'</div>' : '<div class="cancellation-meta">该项目在取消理由成为必填项之前结束。</div>')+'</section>'
        : attention
        ? '<section id="attention" class="product-panel planning-panel '+escapeHtml(attention.kind)+'"><div class="panel-heading"><span>'+escapeHtml(attention.kind === "decision_requested" ? "请求决定" : "项目阻塞")+'</span><b>'+escapeHtml(formatTime(attention.occurredAt))+'</b></div><p>'+escapeHtml(attention.summary)+'</p>'+(attention.question ? '<div class="decision-question">'+escapeHtml(attention.question)+'</div>' : '')+'</section>'
        : '';
      const notes = project.contextNotes.length
        ? '<ul class="context-notes">'+project.contextNotes.map(note => '<li>'+escapeHtml(note)+'</li>').join("")+'</ul>'
        : '<p class="empty-copy">尚未记录产品决定或补充上下文。</p>';
      host.innerHTML =
        '<div class="page-screen product-screen">'+
          '<header class="page-hero product-hero"><a class="eyebrow-link" href="/">← 返回看板</a><div class="page-kicker">Product dossier</div><div class="product-hero-row"><div><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span></div><h1>产品详情 · '+escapeHtml(project.name)+'</h1></div><a class="action-button" href="/settings">运行设置</a></div><p>'+escapeHtml(project.repositoryPath)+' · '+escapeHtml(project.defaultBranch)+'</p></header>'+
          '<div class="product-grid">'+
            '<div class="product-main">'+notice+
              '<section class="product-panel"><div class="panel-heading"><span>产品文档</span><b>PROJECT.md</b></div><article class="markdown-body">'+renderMarkdown(productDocument)+'</article></section>'+
              '<section class="product-panel"><div class="panel-heading"><span>任务清单</span><b>'+tasks.length+'</b></div><div class="product-task-list">'+tasks.map(productTask).join("")+'</div></section>'+
            '</div>'+
            '<aside class="product-rail">'+
              '<section class="product-panel compact"><div class="panel-heading"><span>注册信息</span></div><dl class="detail-meta"><dt>项目 ID</dt><dd>'+escapeHtml(project.id)+'</dd><dt>仓库</dt><dd>'+escapeHtml(project.repositoryPath)+'</dd><dt>默认分支</dt><dd>'+escapeHtml(project.defaultBranch)+'</dd><dt>注册时间</dt><dd>'+escapeHtml(formatTime(project.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(project.updatedAt))+'</dd></dl></section>'+
              '<section class="product-panel compact"><div class="panel-heading"><span>当前执行</span><b>'+escapeHtml(label(project.executionStatus || "pending"))+'</b></div><dl class="detail-meta"><dt>动作</dt><dd>'+escapeHtml(label(project.requestedAction || "pending"))+'</dd>'+(model ? '<dt>模型</dt><dd>'+escapeHtml(model.model)+'</dd><dt>路由</dt><dd>'+escapeHtml(label(model.route))+'</dd><dt>容量重试</dt><dd>'+model.retryCount+'</dd>' : '')+'</dl></section>'+
              '<section class="product-panel compact"><div class="panel-heading"><span>产品上下文</span><b>'+project.contextNotes.length+'</b></div>'+notes+'</section>'+
            '</aside>'+
          '</div>'+
        '</div>';
    }

    function productTask(task) {
      const executionStatus = task.executionStatus === "retry_scheduled" ? task.executionStatus : task.status;
      return '<article class="product-task"><span class="task-index">任务 '+String(task.order).padStart(2, "0")+'</span><div><h3>'+escapeHtml(task.title)+'</h3><p>'+escapeHtml(task.description)+'</p></div><span class="status-pill">'+escapeHtml(label(executionStatus))+'</span></article>';
    }

    function renderMarkdown(markdown) {
      return String(markdown || "").split("\\n").map(line => {
        const value = escapeHtml(line);
        if (line.startsWith("### ")) return '<h3>'+escapeHtml(line.slice(4))+'</h3>';
        if (line.startsWith("## ")) return '<h2>'+escapeHtml(line.slice(3))+'</h2>';
        if (line.startsWith("# ")) return '<h1>'+escapeHtml(line.slice(2))+'</h1>';
        if (line.startsWith("- ")) return '<div class="markdown-list-item">'+escapeHtml(line.slice(2))+'</div>';
        return line.trim() ? '<p>'+value+'</p>' : '<div class="markdown-space"></div>';
      }).join("");
    }

    function clearTaskDetail() {
      selectedTaskId = null;
      document.body.classList.remove("detail-open");
      const detail = document.getElementById("task-detail");
      detail.setAttribute("aria-hidden", "true");
      document.getElementById("task-detail-content").innerHTML = "";
    }

    function renderTaskDetail() {
      const detail = document.getElementById("task-detail");
      const host = document.getElementById("task-detail-content");
      if (!taskDetail || taskDetail.task.id !== selectedTaskId) {
        document.body.classList.remove("detail-open");
        detail.setAttribute("aria-hidden", "true");
        host.innerHTML = "";
        return;
      }
      const { task, activities, conversations } = taskDetail;
      detail.setAttribute("aria-hidden", "false");
      const criteria = task.acceptanceCriteria.length
        ? '<ul class="criteria-list '+(task.status === "done" ? "complete" : "")+'">'+task.acceptanceCriteria.map(item => '<li><i>'+(task.status === "done" ? "✓" : "")+'</i><span>'+escapeHtml(item)+'</span></li>').join("")+'</ul>'
        : '<div class="criteria-empty">未设置验收标准。</div>';
      const cancellation = task.status === "cancelled"
        ? '<div class="cancellation-card"><b>取消理由</b><p>'+escapeHtml(task.cancellation?.reason || "历史取消记录未保存理由。")+'</p>'+(task.cancellation ? '<small>'+escapeHtml(label(task.cancellation.decisionBasis))+' · '+escapeHtml(label(task.cancellation.cancelledBy))+' · '+escapeHtml(formatTime(task.cancellation.cancelledAt))+'</small>' : '<small>该任务在取消理由成为必填项之前结束。</small>')+'</div>'
        : '';
      const activityTimeline = activities.length
        ? '<ol class="activity-timeline">'+activities.map(activityCard).join("")+'</ol>'
        : '<div class="activity-empty"><b>尚无进展记录</b><span>节点完成汇报后会按时间出现在这里。</span></div>';
      const links = [
        conversations.developmentThreadId ? '<a class="detail-link primary" href="codex://threads/'+escapeHtml(conversations.developmentThreadId)+'"><span>任务对话</span><span>打开 ↗</span></a>' : '',
        conversations.reviewThreadId ? '<a class="detail-link" href="codex://threads/'+escapeHtml(conversations.reviewThreadId)+'"><span>审查对话</span><span>打开 ↗</span></a>' : ''
      ].filter(Boolean).join("");
      const controls = [
        task.status === "blocked" ? '<button class="action-button" data-retry>重试</button>' : ''
      ].filter(Boolean).join("");
      host.innerHTML =
        '<header class="detail-head"><strong>任务详情</strong><button id="close-detail" class="icon-button" type="button" aria-label="关闭任务详情">×</button></header>'+
        '<div class="detail-body">'+
          '<div class="detail-status"><span></span>'+escapeHtml(label(task.status))+'</div>'+
          '<div class="task-id-row"><code title="'+escapeHtml(task.id)+'">'+escapeHtml(task.id)+'</code><button class="copy-id-button" type="button" data-copy-task-id aria-label="复制任务 ID" aria-live="polite">复制 ID</button></div>'+
          '<h2>'+escapeHtml(task.title)+'</h2><p class="detail-description">'+escapeHtml(task.description)+'</p>'+
          (controls ? '<div class="detail-actions">'+controls+'</div>' : '')+cancellation+
          '<section class="detail-section"><h3>验收标准 <span>'+task.acceptanceCriteria.length+'</span></h3>'+criteria+'</section>'+
          '<section class="detail-section activity-section"><h3>进展记录 <span>'+activities.length+'</span></h3>'+activityTimeline+'</section>'+
          (links ? '<section class="detail-section"><h3>Codex 对话</h3><div class="conversation-list">'+links+'</div></section>' : '')+
          '<section class="detail-section"><h3>执行信息</h3><dl class="detail-meta"><dt>当前阶段</dt><dd>'+escapeHtml(label(task.executionStatus === "retry_scheduled" ? task.executionStatus : task.requestedAction || task.status))+'</dd>'+
            (task.modelRouting ? '<dt>当前模型</dt><dd>'+escapeHtml(task.modelRouting.model)+' · '+escapeHtml(label(task.modelRouting.route))+'</dd><dt>容量重试</dt><dd>'+task.modelRouting.retryCount+(task.modelRouting.nextRetryAt ? ' · '+escapeHtml(formatTime(task.modelRouting.nextRetryAt)) : '')+'</dd>' : '')+
            '<dt>审查次数</dt><dd>'+task.reviewCount+'</dd><dt>创建时间</dt><dd>'+escapeHtml(formatTime(task.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(task.updatedAt))+'</dd></dl></section>'+
        '</div>';
      host.querySelector("[data-latest-activity]")?.scrollIntoView({ block: "end", inline: "nearest" });
      document.getElementById("close-detail").onclick = closeDetail;
      const copyTaskId = host.querySelector("[data-copy-task-id]");
      copyTaskId?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(task.id);
          copyTaskId.textContent = "已复制";
          copyTaskId.classList.add("copied");
        } catch {
          copyTaskId.textContent = "复制失败";
        }
        window.setTimeout(() => {
          if (!copyTaskId.isConnected) return;
          copyTaskId.textContent = "复制 ID";
          copyTaskId.classList.remove("copied");
        }, 1600);
      });
      host.querySelector("[data-retry]")?.addEventListener("click", async () => {
        await command("task.control", { taskId: task.id, action: "retry" });
        await refresh();
      });
    }

    function activityCard(activity, index, all) {
      const evidence = activity.evidence || {};
      const rows = [
        ["工作树", evidence.workspacePath],
        ["基础提交", evidence.baseCommit],
        ["候选提交", evidence.candidateCommit],
        ["审查基线", evidence.reviewedMainCommit],
        ["合入提交", evidence.mergedCommit]
      ].filter(([, value]) => value);
      const question = evidence.question
        ? '<div class="activity-question"><b>需要决定</b><p>'+escapeHtml(evidence.question)+'</p><small>请在对应的 Codex App 对话中回复。</small></div>'
        : '';
      const findings = evidence.findings?.length
        ? '<div class="activity-evidence-block"><b>审查发现</b><ul>'+evidence.findings.map(finding => '<li>'+escapeHtml(finding)+'</li>').join("")+'</ul></div>'
        : '';
      const tests = evidence.tests
        ? '<div class="activity-evidence-block"><b>验证</b><p>'+escapeHtml(evidence.tests)+'</p></div>'
        : '';
      const git = rows.length
        ? '<dl class="activity-git">'+rows.map(([name, value]) => '<dt>'+name+'</dt><dd><code>'+escapeHtml(value)+'</code></dd>').join("")+'</dl>'
        : '';
      const hasEvidence = question || findings || tests || git;
      return '<li class="activity-item '+escapeHtml(activity.type)+'" '+(index === all.length - 1 ? 'data-latest-activity' : '')+'><span class="activity-node"></span><article class="activity-card"><header><b>'+escapeHtml(label(activity.type))+'</b><time>'+escapeHtml(formatTime(activity.occurredAt))+'</time></header><p class="activity-summary">'+escapeHtml(activity.summary)+'</p>'+(hasEvidence ? '<div class="activity-evidence">'+question+findings+tests+git+'</div>' : '')+'</article></li>';
    }

    function closeDetail() {
      selectedTaskId = null;
      taskDetail = null;
      document.body.classList.remove("detail-open");
      render();
    }

    document.getElementById("setup-install").onclick = installSkills;
    document.getElementById("setup-later").onclick = () => {
      localStorage.setItem("codrive:skills-dismissed", skillStatus.bundledVersion);
      document.getElementById("setup-dialog").hidden = true;
      document.getElementById("setup-trigger").hidden = false;
    };
    document.getElementById("setup-trigger").onclick = () => document.getElementById("setup-dialog").hidden = false;
    document.getElementById("nav-backdrop").onclick = () => document.body.classList.remove("nav-open");
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (selectedTaskId) closeDetail();
      else if (document.body.classList.contains("nav-open")) document.body.classList.remove("nav-open");
      else if (skillStatus?.state !== "current") document.getElementById("setup-later").click();
    });
    const events = new EventSource("/api/events?token="+encodeURIComponent(TOKEN));
    events.onmessage = refresh;
    events.onerror = () => document.getElementById("offline").style.display = "block";
    refreshSetup();
    refresh();
  </script>`;
}
