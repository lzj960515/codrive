export function renderBoardClient(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  return `<script>
    const TOKEN = ${token};
    const columns = [
      ["backlog", "待安排"],
      ["developing", "开发中"],
      ["reviewing", "审查中"],
      ["integrating", "合入中"],
      ["waiting", "等待中"],
      ["done", "已完成"]
    ];
    const statusLabels = {
      active: "进行中", selecting_tasks: "安排任务中", evaluating: "产品验收中",
      waiting_for_input: "等待决定", stalled: "暂无进展", completed: "已完成",
      blocked: "已阻塞", cancelled: "已取消", backlog: "待安排", developing: "开发中",
      reviewing: "审查中", changes_requested: "返工中", integrating: "合入中", done: "已完成",
      running: "自动推进", paused: "已暂停", develop: "开发", rework: "返工", review: "审查",
      integrate: "合入", pending: "待开始", awaiting_report: "等待汇报", failed: "执行失败",
      interrupted: "已中断", approved: "审查通过", needs_review: "等待审查",
      needs_input: "等待决定", queued: "待安排", pending: "等待安排",
      selected: "已完成本轮安排", waiting_for_task: "等待任务完成"
    };
    let snapshots = [];
    let selectedProjectId = null;
    let selectedTaskId = null;
    let skillStatus = null;
    const headers = { "x-codrive-token": TOKEN, "content-type": "application/json" };
    const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[character]));
    const bucket = status => {
      if (["changes_requested"].includes(status)) return "developing";
      if (["waiting_for_input", "blocked"].includes(status)) return "waiting";
      if (["done", "cancelled"].includes(status)) return "done";
      return status;
    };
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
        snapshots = await api("/api/board");
        document.getElementById("offline").style.display = "none";
        if (!selectedProjectId || !snapshots.some(snapshot => snapshot.project.id === selectedProjectId)) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
        }
        const snapshot = currentSnapshot();
        if (selectedTaskId && !snapshot?.tasks.some(task => task.id === selectedTaskId)) selectedTaskId = null;
        render();
      } catch {
        document.getElementById("offline").style.display = "block";
      }
    }

    const currentSnapshot = () => snapshots.find(snapshot => snapshot.project.id === selectedProjectId);

    function render() {
      renderProjects();
      renderWorkspace();
      renderTaskDetail();
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
          selectedProjectId = button.dataset.project;
          selectedTaskId = null;
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
      if (project.executionStatus === "failed" && project.requestedAction) actions.unshift('<button class="action-button" data-project-action="retry">重试失败执行</button>');
      if (["waiting_for_task", "needs_input", "blocked"].includes(project.planning.status)) actions.unshift('<button class="action-button" data-project-action="replan">重新判断任务</button>');
      if (project.status !== "cancelled") actions.push('<button class="action-button danger" data-project-action="cancel">取消</button>');
      const projectCopy = project.question || project.summary;
      const projectDescription = projectCopy ? '<p>'+escapeHtml(projectCopy)+'</p>' : '';
      host.innerHTML =
        '<header class="workspace-header">'+
          '<div class="workspace-topline">'+
            '<div class="project-identity">'+
              '<button id="mobile-projects" class="mobile-projects" type="button" aria-label="打开项目列表">☰</button>'+
              '<span class="project-status-dot"></span>'+
              '<div class="project-title"><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span><span>'+escapeHtml(label(project.planning.status))+'</span></div><h1>'+escapeHtml(project.name)+'</h1>'+projectDescription+'</div>'+
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
          if (button.dataset.projectAction === "cancel" && !window.confirm("取消会永久终止这个项目。确定继续吗？")) return;
          await command("project.control", { projectId: project.id, action: button.dataset.projectAction });
          await refresh();
        };
      });
      host.querySelectorAll("[data-task]").forEach(button => {
        button.onclick = () => {
          selectedTaskId = button.dataset.task;
          document.body.classList.add("detail-open");
          render();
        };
      });
    }

    function taskCard(task) {
      const copy = task.question || task.summary || task.description;
      const alert = ["waiting_for_input", "blocked", "changes_requested"].includes(task.status) ? "task-alert" : "";
      return '<button class="task-card '+(task.id === selectedTaskId ? 'active' : '')+'" type="button" data-task="'+escapeHtml(task.id)+'" data-status="'+escapeHtml(task.status)+'">'+
        '<span class="task-card-top"><span class="task-index">任务 '+String(task.order).padStart(2, "0")+'</span><span class="task-state '+alert+'"><i></i>'+escapeHtml(label(task.status))+'</span></span>'+
        '<h3>'+escapeHtml(task.title)+'</h3><p>'+escapeHtml(copy)+'</p>'+
        '<span class="task-card-footer"><span class="task-action">'+escapeHtml(label(task.requestedAction || task.report?.outcome || "queued"))+'</span><span>'+escapeHtml(formatTime(task.updatedAt))+'</span></span>'+
      '</button>';
    }

    function renderTaskDetail() {
      const snapshot = currentSnapshot();
      const task = snapshot?.tasks.find(candidate => candidate.id === selectedTaskId);
      const detail = document.getElementById("task-detail");
      const host = document.getElementById("task-detail-content");
      if (!task) {
        document.body.classList.remove("detail-open");
        detail.setAttribute("aria-hidden", "true");
        host.innerHTML = "";
        return;
      }
      detail.setAttribute("aria-hidden", "false");
      const report = task.report;
      const criteria = task.acceptanceCriteria.length
        ? '<ul class="criteria-list '+(task.status === "done" ? "complete" : "")+'">'+task.acceptanceCriteria.map(item => '<li><i>'+(task.status === "done" ? "✓" : "")+'</i><span>'+escapeHtml(item)+'</span></li>').join("")+'</ul>'
        : '<div class="report-card">未设置验收标准。</div>';
      const question = task.question
        ? '<div class="question-card"><b>需要你决定</b><p>'+escapeHtml(task.question)+'</p><small>请在对应的 Codex 对话中回复。</small></div>'
        : '';
      const reportSection = report
        ? '<section class="detail-section"><h3>最新进展 <span>'+escapeHtml(label(report.outcome))+'</span></h3><div class="report-card">'+escapeHtml(report.summary)+'</div>'+
          (report.tests ? '<div class="tests-card">'+escapeHtml(report.tests)+'</div>' : '')+
          (report.findings.length ? '<ul class="finding-list">'+report.findings.map(finding => '<li>'+escapeHtml(finding)+'</li>').join("")+'</ul>' : '')+'</section>'
        : '';
      const links = [
        task.developmentThreadId ? '<a class="detail-link primary" href="codex://threads/'+escapeHtml(task.developmentThreadId)+'"><span>开发对话</span><span>打开 ↗</span></a>' : '',
        task.reviewThreadId ? '<a class="detail-link" href="codex://threads/'+escapeHtml(task.reviewThreadId)+'"><span>最新审查</span><span>打开 ↗</span></a>' : ''
      ].filter(Boolean).join("");
      const controls = [
        task.status === "blocked" ? '<button class="action-button" data-retry>重试</button>' : '',
        !["done", "cancelled"].includes(task.status) ? '<button class="action-button danger" data-cancel-task>取消</button>' : ''
      ].filter(Boolean).join("");
      host.innerHTML =
        '<header class="detail-head"><strong>任务详情</strong><button id="close-detail" class="icon-button" type="button" aria-label="关闭任务详情">×</button></header>'+
        '<div class="detail-body">'+
          '<div class="detail-status"><span></span>'+escapeHtml(label(task.status))+'</div><h2>'+escapeHtml(task.title)+'</h2><p class="detail-description">'+escapeHtml(task.description)+'</p>'+
          (controls ? '<div class="detail-actions">'+controls+'</div>' : '')+question+
          '<section class="detail-section"><h3>验收标准 <span>'+task.acceptanceCriteria.length+'</span></h3>'+criteria+'</section>'+
          reportSection+
          (links ? '<section class="detail-section"><h3>Codex 对话</h3><div class="conversation-list">'+links+'</div></section>' : '')+
          '<section class="detail-section"><h3>执行信息</h3><dl class="detail-meta"><dt>当前阶段</dt><dd>'+escapeHtml(label(task.requestedAction || task.status))+'</dd><dt>审查次数</dt><dd>'+task.reviewCount+'</dd><dt>创建时间</dt><dd>'+escapeHtml(formatTime(task.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(task.updatedAt))+'</dd></dl></section>'+
        '</div>';
      document.getElementById("close-detail").onclick = closeDetail;
      host.querySelector("[data-retry]")?.addEventListener("click", async () => {
        await command("task.control", { taskId: task.id, action: "retry" });
        await refresh();
      });
      host.querySelector("[data-cancel-task]")?.addEventListener("click", async () => {
        if (!window.confirm("取消会永久终止这个任务，之后不能重试。确定继续吗？")) return;
        await command("task.control", { taskId: task.id, action: "cancel" });
        closeDetail();
        await refresh();
      });
    }

    function closeDetail() {
      selectedTaskId = null;
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
