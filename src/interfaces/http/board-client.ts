export function renderBoardClient(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  return `<script>
    const TOKEN = ${token};
    const columns = [
      ["backlog", "Backlog"],
      ["developing", "Building"],
      ["reviewing", "Review"],
      ["integrating", "Integrating"],
      ["waiting", "Waiting"],
      ["done", "Done"]
    ];
    const statusLabels = {
      active: "Active", selecting_tasks: "Selecting work", evaluating: "Evaluating",
      waiting_for_input: "Waiting for input", stalled: "Stalled", completed: "Completed",
      blocked: "Blocked", cancelled: "Cancelled", backlog: "Backlog", developing: "Building",
      reviewing: "In review", changes_requested: "Changes requested", integrating: "Integrating",
      done: "Done"
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
    const formatTime = value => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const initials = value => String(value || "C").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

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
        missing: "Skills are not installed on this Mac yet.",
        outdated: "Bundled Skills have changed and are ready to update.",
        conflict: "Existing unmanaged Skills use Codrive names. Move them before installing."
      }[skillStatus.state];
      document.getElementById("setup-copy").textContent = copy;
      document.getElementById("setup-trigger-copy").textContent = copy;
      const install = document.getElementById("setup-install");
      install.textContent = skillStatus.state === "missing" ? "Install Skills" : "Update Skills";
      install.disabled = skillStatus.state === "conflict";
      trigger.hidden = false;
      const dismissedVersion = localStorage.getItem("codrive:skills-dismissed");
      dialog.hidden = dismissedVersion === skillStatus.bundledVersion;
    }

    async function installSkills() {
      const button = document.getElementById("setup-install");
      const status = document.getElementById("setup-status");
      button.disabled = true;
      status.textContent = "Installing local Skills…";
      try {
        const result = await command("system.install_skills", {});
        skillStatus = result.skills;
        localStorage.removeItem("codrive:skills-dismissed");
        status.textContent = "Skills installed. Codex is ready to drive.";
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
              '<span class="project-label"><b>'+escapeHtml(project.name)+'</b><small>'+escapeHtml(label(project.status))+'</small></span>'+
              '<span class="project-total">'+tasks.length+'</span>'+
            '</button>'
          ).join("")
        : '<div class="project-list-empty">No projects yet.<br>Start one with <code>$codrive-forge</code>.</div>';
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
        host.innerHTML = '<div class="empty-workspace"><section class="empty-card"><div class="empty-number">NO. 00 / READY</div><h1>Put a product in motion.</h1><p>Codrive turns a confirmed product plan into visible development and review tasks. Start in Codex App; this workbench will come alive as soon as the project is registered.</p><div class="starter-command">Use $codrive-forge to plan and register this product.</div></section></div>';
        return;
      }
      const { project, tasks } = snapshot;
      const active = tasks.filter(task => ["developing", "reviewing", "changes_requested", "integrating"].includes(task.status)).length;
      const waiting = tasks.filter(task => ["waiting_for_input", "blocked"].includes(task.status)).length;
      const done = tasks.filter(task => task.status === "done").length;
      const terminal = ["completed", "cancelled"].includes(project.status);
      const actions = terminal ? [] : [project.scheduling === "paused"
        ? '<button class="action-button" data-project-action="resume">Resume</button>'
        : '<button class="action-button" data-project-action="pause">Pause</button>'];
      if (project.status !== "cancelled") actions.push('<button class="action-button danger" data-project-action="cancel">Cancel</button>');
      const projectCopy = project.question || project.summary || project.repositoryPath;
      host.innerHTML =
        '<header class="workspace-header">'+
          '<div class="workspace-topline">'+
            '<div class="project-identity">'+
              '<button id="mobile-projects" class="mobile-projects" type="button" aria-label="Open projects">☰</button>'+
              '<span class="project-status-dot"></span>'+
              '<div class="project-title"><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.status))+'</span><span>'+escapeHtml(project.scheduling)+'</span></div><h1>'+escapeHtml(project.name)+'</h1><p>'+escapeHtml(projectCopy)+'</p></div>'+
            '</div>'+
            '<div class="project-actions">'+actions.join("")+'</div>'+
          '</div>'+
          '<div class="project-stats"><span><b>'+tasks.length+'</b>Total</span><span><b>'+active+'</b>In motion</span><span><b>'+waiting+'</b>Waiting</span><span><b>'+done+'</b>Done</span></div>'+
        '</header>'+
        '<div class="board-wrap"><div class="board">'+columns.map(([key, columnLabel]) => {
          const cards = tasks.filter(task => bucket(task.status) === key);
          return '<section class="column" data-column="'+key+'"><div class="column-head"><span><i></i>'+columnLabel+'</span><b>'+cards.length+'</b></div><div class="column-body">'+
            (cards.length ? cards.map(taskCard).join("") : '<div class="column-empty">Nothing here</div>')+
          '</div></section>';
        }).join("")+'</div></div>';

      document.getElementById("mobile-projects").onclick = () => document.body.classList.add("nav-open");
      host.querySelectorAll("[data-project-action]").forEach(button => {
        button.onclick = async () => {
          if (button.dataset.projectAction === "cancel" && !window.confirm("Cancel this project?")) return;
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
        '<span class="task-card-top"><span class="task-index">TASK '+String(task.order).padStart(2, "0")+'</span><span class="task-state '+alert+'"><i></i>'+escapeHtml(label(task.status))+'</span></span>'+
        '<h3>'+escapeHtml(task.title)+'</h3><p>'+escapeHtml(copy)+'</p>'+
        '<span class="task-card-footer"><span class="task-action">'+escapeHtml(task.requestedAction || task.report?.outcome || "queued")+'</span><span>'+escapeHtml(formatTime(task.updatedAt))+'</span></span>'+
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
        : '<div class="report-card">No explicit acceptance criteria were recorded.</div>';
      const question = task.question
        ? '<div class="question-card"><b>Decision needed</b><p>'+escapeHtml(task.question)+'</p><small>Reply in the linked Codex task.</small></div>'
        : '';
      const reportSection = report
        ? '<section class="detail-section"><h3>Latest report <span>'+escapeHtml(label(report.outcome))+'</span></h3><div class="report-card">'+escapeHtml(report.summary)+'</div>'+
          (report.tests ? '<div class="tests-card">'+escapeHtml(report.tests)+'</div>' : '')+
          (report.findings.length ? '<ul class="finding-list">'+report.findings.map(finding => '<li>'+escapeHtml(finding)+'</li>').join("")+'</ul>' : '')+'</section>'
        : '';
      const links = [
        task.developmentThreadId ? '<a class="detail-link primary" href="codex://threads/'+escapeHtml(task.developmentThreadId)+'"><span>Development task</span><span>Open ↗</span></a>' : '',
        task.reviewThreadId ? '<a class="detail-link" href="codex://threads/'+escapeHtml(task.reviewThreadId)+'"><span>Latest review</span><span>Open ↗</span></a>' : ''
      ].filter(Boolean).join("");
      const controls = [
        task.status === "blocked" ? '<button class="action-button" data-retry>Retry task</button>' : '',
        !["done", "cancelled"].includes(task.status) ? '<button class="action-button danger" data-cancel-task>Cancel</button>' : ''
      ].filter(Boolean).join("");
      host.innerHTML =
        '<header class="detail-head"><strong>Task details</strong><button id="close-detail" class="icon-button" type="button" aria-label="Close task details">×</button></header>'+
        '<div class="detail-body">'+
          '<div class="detail-status"><span></span>'+escapeHtml(label(task.status))+'</div><h2>'+escapeHtml(task.title)+'</h2><p class="detail-description">'+escapeHtml(task.description)+'</p>'+
          (controls ? '<div class="detail-actions">'+controls+'</div>' : '')+question+
          '<section class="detail-section"><h3>Acceptance criteria <span>'+task.acceptanceCriteria.length+'</span></h3>'+criteria+'</section>'+
          reportSection+
          (links ? '<section class="detail-section"><h3>Codex tasks</h3><div class="conversation-list">'+links+'</div></section>' : '')+
          '<section class="detail-section"><h3>Activity</h3><dl class="detail-meta"><dt>Current action</dt><dd>'+escapeHtml(task.requestedAction || "None")+'</dd><dt>Execution</dt><dd>'+escapeHtml(task.executionStatus || "Not started")+'</dd><dt>Review rounds</dt><dd>'+task.reviewCount+'</dd><dt>Created</dt><dd>'+escapeHtml(formatTime(task.createdAt))+'</dd><dt>Updated</dt><dd>'+escapeHtml(formatTime(task.updatedAt))+'</dd><dt>Task ID</dt><dd>'+escapeHtml(task.id)+'</dd></dl></section>'+
        '</div>';
      document.getElementById("close-detail").onclick = closeDetail;
      host.querySelector("[data-retry]")?.addEventListener("click", async () => {
        await command("task.control", { taskId: task.id, action: "retry" });
        await refresh();
      });
      host.querySelector("[data-cancel-task]")?.addEventListener("click", async () => {
        if (!window.confirm("Cancel this task?")) return;
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
