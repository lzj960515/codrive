import { taskBoardLayout } from "./task-board-layout.js";
import { renderLiveSyncClientRuntime } from "./live-sync-client.js";

export function renderBoardClient(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  const layout = JSON.stringify(taskBoardLayout);
  return `<script>
    ${renderLiveSyncClientRuntime()}
    const TOKEN = ${token};
    const boardLayout = ${layout};
    const columns = boardLayout.columns;
    const statusLabels = {
      active: "进行中", selecting_tasks: "安排任务中", idle: "当前无待办",
      waiting_for_input: "等待决定",
      waiting_for_resume: "计划等待",
      blocked: "已阻塞", cancelled: "已取消", backlog: "待安排", developing: "开发中",
      reviewing: "审查中", changes_requested: "返工中", integrating: "合入中", done: "已完成",
      running: "自动推进", paused: "已暂停", develop: "开发", rework: "返工", review: "审查",
      integrate: "合入", pending: "待开始", awaiting_report: "等待汇报", failed: "执行失败",
      interrupted: "已中断", approved: "审查通过", needs_review: "等待审查",
      needs_input: "等待决定", queued: "待安排",
      selected: "已完成本轮安排", waiting_for_task: "等待任务完成",
      retry_scheduled: "等待模型重试", active_paused: "执行中 · 后续已暂停",
      primary: "默认", fallback: "备用", user_confirmed: "用户确认",
      closed: "正常", open: "已熔断", half_open: "主模型探测",
      agent_decision: "Codex 判断", codex: "Codex", user: "用户",
      missing: "待补齐", outdated: "待同步", current: "已对齐", conflict: "存在冲突",
      development_completed: "开发完成", rework_completed: "返工完成",
      review_approved: "审查通过", review_changes_requested: "审查退回",
      review_requested: "请求审查", integration_completed: "合入完成",
      decision_requested: "请求决定", scheduled_resume_started: "计划恢复",
      scheduled_resume_rescheduled: "重新安排恢复", execution_recovered: "中断恢复", execution_failed: "执行失败"
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
    let systemUpdate = null;
    let productDetail = null;
    let taskDetail = null;
    let systemSettings = null;
    let updateActionError = null;
    const headers = { "x-codrive-token": TOKEN, "content-type": "application/json" };
    const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[character]));
    const bucket = status => boardLayout.statusColumns[status] || status;
    const label = status => statusLabels[status] || String(status || "").replaceAll("_", " ");
    const formatTime = value => value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "—";
    const initials = value => String(value || "C").trim().split(/\\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try { message = JSON.parse(body).error || body; } catch {}
        throw new Error(message);
      }
      return response.json();
    }

    const command = (type, payload) => api("/api/commands", {
      method: "POST",
      body: JSON.stringify({ type, payload })
    });

    const activeUpdatePhases = ["checking", "installing", "restarting", "syncing_skills"];
    const updatePhaseCopy = {
      checking: ["正在固定目标版本", 8],
      installing: ["正在安装 Codrive", 38],
      restarting: ["正在重启本机服务", 66],
      syncing_skills: ["正在同步 4 个托管 Skills", 86],
      succeeded: ["更新完成", 100],
      failed: ["更新未完成", 100]
    };

    function renderSystemUpdate() {
      if (!systemUpdate) return;
      const { version, upgrade, skills } = systemUpdate;
      const active = upgrade && activeUpdatePhases.includes(upgrade.phase);
      const triggerCopy = active
        ? updatePhaseCopy[upgrade.phase][0]
        : version?.updateAvailable
          ? "新版本 "+version.latestVersion+" 可用"
          : skills.state === "conflict"
            ? "本地 Skill 冲突待处理"
          : version?.latestVersion && skills.state === "current"
              ? "Codrive 与 Skills 已对齐"
              : skills.state === "current" ? "等待稳定版检查" : "托管 Skills 需要补齐";
      document.getElementById("update-trigger-copy").textContent = triggerCopy;
      document.getElementById("update-trigger-icon").textContent = active ? "↻" : version?.updateAvailable ? "↑" : skills.state === "current" ? "✓" : "+";
      document.getElementById("update-trigger").dataset.state = active ? "active" : version?.updateAvailable || skills.state !== "current" ? "attention" : "current";

      document.getElementById("update-current-version").textContent = version?.currentVersion || skills.bundledVersion;
      document.getElementById("update-latest-version").textContent = version?.latestVersion || "待检查";
      document.getElementById("update-skills").textContent = skills.state === "current" ? skills.managedSkillCount+" / "+skills.managedSkillCount+" 已对齐" : label(skills.state);
      document.getElementById("update-checked-at").textContent = formatTime(version?.lastCheckedAt);
      document.getElementById("update-check-result").textContent = version?.checkError?.summary || (version?.latestVersion ? "npm latest 稳定版已读取" : "等待首次检查");

      const progress = document.getElementById("update-progress");
      progress.hidden = !upgrade;
      if (upgrade) {
        const phase = updatePhaseCopy[upgrade.phase] || [upgrade.phase, 0];
        document.getElementById("update-phase").textContent = phase[0];
        document.getElementById("update-progress-bar").style.width = phase[1]+"%";
        document.getElementById("update-phase-time").textContent = formatTime(upgrade.updatedAt);
        progress.dataset.phase = upgrade.phase;
      }
      const timeline = document.getElementById("update-timeline");
      const timelinePhases = Object.entries(upgrade?.phaseStartedAt || {});
      timeline.hidden = timelinePhases.length === 0;
      timeline.innerHTML = timelinePhases.map(([phase, occurredAt]) =>
        '<div><span>'+escapeHtml((updatePhaseCopy[phase] || [phase])[0])+'</span><time>'+escapeHtml(formatTime(occurredAt))+'</time></div>'
      ).join("");

      const conflict = document.getElementById("update-conflict");
      conflict.hidden = skills.state !== "conflict";
      conflict.innerHTML = skills.state === "conflict"
        ? '<b>保留了本地同名 Skill</b><p>Codrive 不会覆盖未托管文件。请先移动以下路径，再重新同步：</p><code>'+escapeHtml(skills.conflictPaths.join("\\n"))+'</code>'
        : "";

      const summary = upgrade?.phase === "failed"
        ? upgrade.error?.summary || "更新未完成，可以安全重试。"
        : active
          ? "目标版本 "+upgrade.targetVersion+" 已固定。页面断线时，独立进程仍会继续。"
          : version?.updateAvailable
            ? "Codrive "+version.latestVersion+" 与该版本随附的 4 个托管 Skills 将在一次操作中更新。"
            : version?.checkError
              ? "无法确认 npm latest 稳定版；看板与任务调度不受影响，可以重新检查。"
              : version?.latestVersion && skills.state === "current"
              ? "当前已是最新稳定版，Codrive 与随包托管 Skills 保持一致。"
              : "Codrive 已安装；需要从当前包补齐 4 个托管 Skills。";
      document.getElementById("update-summary").textContent = summary;

      const primary = document.getElementById("update-primary");
      primary.disabled = Boolean(active) || skills.state === "conflict" || Boolean(version?.checking);
      primary.textContent = active
        ? "更新进行中"
        : version?.updateAvailable
          ? upgrade?.phase === "failed" ? "重试更新" : "更新 Codrive 与 Skills"
          : version?.latestVersion && skills.state === "current"
            ? "已是最新版"
            : skills.state === "current" ? "等待版本检查" : "补齐托管 Skills";
      if (upgrade?.phase === "failed" && upgrade.targetVersion === version?.currentVersion && skills.state !== "current") {
        primary.textContent = "补齐托管 Skills";
      }
      if (!version?.updateAvailable && skills.state === "current") primary.disabled = true;
      document.getElementById("update-check").disabled = Boolean(active) || Boolean(version?.checking);
      document.getElementById("update-status").textContent = updateActionError || upgrade?.error?.summary || version?.checkError?.summary || "";
      document.getElementById("update-fallback").hidden = upgrade?.phase !== "failed" && !version?.checkError;
    }

    async function checkForUpdates() {
      const status = document.getElementById("update-status");
      updateActionError = null;
      status.textContent = "正在检查 npm latest 稳定版...";
      document.getElementById("update-check").disabled = true;
      try {
        systemUpdate = await command("system.check_for_updates", {});
      } catch (error) {
        updateActionError = error.message;
      }
      renderSystemUpdate();
    }

    async function runPrimaryUpdateAction() {
      const status = document.getElementById("update-status");
      updateActionError = null;
      try {
        const repairCurrentVersion =
          systemUpdate.upgrade?.phase === "failed" &&
          systemUpdate.upgrade.targetVersion === systemUpdate.version?.currentVersion &&
          systemUpdate.skills.state !== "current";
        if (systemUpdate.version?.updateAvailable && !repairCurrentVersion) {
          status.textContent = "正在启动独立更新进程...";
          systemUpdate = await command("system.start_upgrade", { targetVersion: systemUpdate.version.latestVersion });
        } else {
          status.textContent = "正在同步托管 Skills...";
          systemUpdate = await command("system.install_skills", {});
        }
      } catch (error) {
        updateActionError = error.message;
      }
      renderSystemUpdate();
    }

    function openUpdateDialog() {
      const dialog = document.getElementById("update-dialog");
      dialog.hidden = false;
      document.getElementById("update-close").focus();
    }

    function closeUpdateDialog() {
      document.getElementById("update-dialog").hidden = true;
      document.getElementById("update-trigger").focus();
    }

    const currentSnapshot = () => snapshots.find(snapshot => snapshot.project.id === selectedProjectId);

    const currentLiveSyncState = () => ({
      route,
      selectedProjectId,
      selectedTaskId
    });

    async function refreshFromPlan(plan) {
      const [nextSnapshots, nextProductDetail, nextSettings, nextTaskDetail, nextSystem] = await Promise.all([
        plan.board ? api("/api/board") : Promise.resolve(null),
        plan.projectId ? api("/api/projects/"+encodeURIComponent(plan.projectId)) : Promise.resolve(null),
        plan.settings ? api("/api/system/settings") : Promise.resolve(null),
        plan.taskId ? api("/api/tasks/"+encodeURIComponent(plan.taskId)) : Promise.resolve(null),
        plan.system ? api("/api/system") : Promise.resolve(null)
      ]);
      const uiState = captureLiveUiState(document, window);
      if (nextSnapshots) {
        snapshots = nextSnapshots;
        if (route.type === "project") selectedProjectId = route.projectId;
        if (!selectedProjectId || !snapshots.some(snapshot => snapshot.project.id === selectedProjectId)) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
          taskDetail = null;
        }
        const snapshot = currentSnapshot();
        if (selectedTaskId && !snapshot?.tasks.some(task => task.id === selectedTaskId)) {
          selectedTaskId = null;
          taskDetail = null;
        }
        renderProjects();
        if (route.type === "board") renderWorkspace();
      }
      if (nextProductDetail && route.type === "project" && plan.projectId === route.projectId) {
        productDetail = nextProductDetail;
        renderProductDetail();
      }
      if (nextSettings && route.type === "settings") {
        systemSettings = nextSettings;
        renderSettings();
      }
      if (nextTaskDetail && selectedTaskId === plan.taskId && route.type === "board") {
        taskDetail = nextTaskDetail;
        renderTaskDetail();
      } else if (route.type === "board" && !selectedTaskId) {
        clearTaskDetail();
      }
      if (nextSystem) {
        systemUpdate = nextSystem;
        renderSystemUpdate();
      }
      restoreLiveUiState(document, window, uiState);
    }

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
            '<button class="project-button '+(project.id === selectedProjectId ? 'active' : '')+'" type="button" data-project="'+escapeHtml(project.id)+'" data-live-sync-key="project:'+escapeHtml(project.id)+'" aria-pressed="'+(project.id === selectedProjectId)+'">'+
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
      const terminal = project.status === "cancelled";
      const actions = terminal ? [] : [project.scheduling === "paused"
        ? '<button class="action-button" data-project-action="resume" data-live-sync-key="project-action:resume">继续</button>'
        : '<button class="action-button" data-project-action="pause" data-live-sync-key="project-action:pause">暂停</button>'];
      actions.unshift('<a class="action-button" data-live-sync-key="project-detail" href="/projects/'+encodeURIComponent(project.id)+'">产品详情</a>');
      if (project.executionStatus === "failed" && project.requestedAction) actions.unshift('<button class="action-button" data-project-action="retry" data-live-sync-key="project-action:retry">重试失败执行</button>');
      if (["waiting_for_task", "needs_input", "blocked"].includes(project.planning.status)) actions.unshift('<button class="action-button" data-project-action="replan" data-live-sync-key="project-action:replan">重新判断任务</button>');
      const attention = project.attention;
      const attentionCopy = attention?.question || attention?.summary;
      const cancellationReason = project.cancellation?.reason || (project.status === "cancelled" ? "历史取消记录未保存理由。" : null);
      const planningBanner = cancellationReason
        ? '<div class="planning-notice cancellation"><b>取消理由</b><span title="'+escapeHtml(cancellationReason)+'">'+escapeHtml(cancellationReason)+'</span><a data-live-sync-key="project-notice-detail" href="/projects/'+encodeURIComponent(project.id)+'">查看详情</a></div>'
        : attentionCopy
        ? '<div class="planning-notice '+escapeHtml(attention.kind)+'"><b>'+escapeHtml(attention.kind === "decision_requested" ? "请求决定" : "项目阻塞")+'</b><span title="'+escapeHtml(attentionCopy)+'">'+escapeHtml(attentionCopy)+'</span><a data-live-sync-key="project-notice-detail" href="/projects/'+encodeURIComponent(project.id)+'#attention">查看详情</a></div>'
        : '';
      host.innerHTML =
        '<header class="workspace-header">'+
          '<div class="workspace-topline">'+
            '<div class="project-identity">'+
              '<button id="mobile-projects" class="mobile-projects" type="button" aria-label="打开项目列表">☰</button>'+
              '<span class="project-status-dot"></span>'+
              '<div class="project-title"><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span><span>'+escapeHtml(label(project.planning.status))+'</span></div><h1><a data-live-sync-key="project-title" href="/projects/'+encodeURIComponent(project.id)+'">'+escapeHtml(project.name)+'</a></h1>'+planningBanner+'</div>'+
            '</div>'+
            '<div class="project-actions">'+actions.join("")+'</div>'+
          '</div>'+
          '<div class="project-stats"><span><b>'+tasks.length+'</b>总任务</span><span><b>'+active+'</b>进行中</span><span><b>'+waiting+'</b>等待</span><span><b>'+done+'</b>已完成</span></div>'+
        '</header>'+
        '<div class="board-wrap" data-preserve-scroll="board"><div class="board">'+columns.map(([key, columnLabel]) => {
          const cards = tasks.filter(task => bucket(task.status) === key);
          return '<section class="column" data-column="'+key+'"><div class="column-head"><span><i></i>'+columnLabel+'</span><b>'+cards.length+'</b></div><div class="column-body">'+
            (cards.length ? cards.map(taskCard).join("") : '<div class="column-empty">暂无任务</div>')+
          '</div></section>';
        }).join("")+'</div></div>';

      document.getElementById("mobile-projects").onclick = () => document.body.classList.add("nav-open");
      host.querySelectorAll("[data-project-action]").forEach(button => {
        button.onclick = async () => {
          await command("project.control", { projectId: project.id, action: button.dataset.projectAction });
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
      const visibleStatus = ["retry_scheduled", "waiting_for_resume"].includes(task.executionStatus) ? task.executionStatus : task.status;
      return '<button class="task-card '+(task.id === selectedTaskId ? 'active' : '')+'" type="button" data-task="'+escapeHtml(task.id)+'" data-live-sync-key="task:'+escapeHtml(task.id)+'" data-status="'+escapeHtml(task.status)+'">'+
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
        '<div class="page-screen settings-screen" data-preserve-scroll="page">'+
          '<header class="settings-header"><a class="eyebrow-link" data-live-sync-key="settings-back" href="/">← 返回看板</a><div><h1>运行设置</h1><p>调整后续任务的并发数和模型路由。</p></div></header>'+
          '<form id="settings-form" class="settings-form settings-panel">'+
            '<label class="setting-field"><span><b>每个项目的并发任务数</b><small>每个项目独立计算容量，不同项目互不占用槽位。</small></span><input name="maxConcurrentTasks" type="number" min="1" max="32" required value="'+settings.maxConcurrentTasks+'"></label>'+
            '<label class="setting-field"><span><b>默认模型</b><small>新任务、审查、合入与项目规划优先使用这个模型。</small></span><select name="primary">'+options(settings.models.primary)+'</select></label>'+
            '<label class="setting-field"><span><b>备用模型</b><small>默认模型容量重试三次后切换到这里；冷却后会在下一次自然 turn 探测默认模型。</small></span><select name="fallback">'+options(settings.models.fallback)+'</select></label>'+
            '<div class="settings-actions"><button class="primary-button" data-live-sync-key="settings-submit" type="submit">保存并应用</button><span id="settings-status" role="status"></span></div>'+
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
        '<div class="page-screen product-screen" data-preserve-scroll="page">'+
          '<header class="page-hero product-hero"><a class="eyebrow-link" data-live-sync-key="product-back" href="/">← 返回看板</a><div class="page-kicker">Product dossier</div><div class="product-hero-row"><div><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span></div><h1>产品详情 · '+escapeHtml(project.name)+'</h1></div><a class="action-button" data-live-sync-key="product-settings" href="/settings">运行设置</a></div><p>'+escapeHtml(project.repositoryPath)+' · '+escapeHtml(project.defaultBranch)+'</p></header>'+
          '<div class="product-grid">'+
            '<div class="product-main">'+notice+
              '<section class="product-panel"><div class="panel-heading"><span>产品文档</span><b>PROJECT.md</b></div><article class="markdown-body">'+renderMarkdown(productDocument)+'</article></section>'+
              '<section class="product-panel"><div class="panel-heading"><span>任务清单</span><b>'+tasks.length+'</b></div><div class="product-task-list">'+tasks.map(productTask).join("")+'</div></section>'+
            '</div>'+
            '<aside class="product-rail">'+
              '<section class="product-panel compact"><div class="panel-heading"><span>注册信息</span></div><dl class="detail-meta"><dt>项目 ID</dt><dd>'+escapeHtml(project.id)+'</dd><dt>仓库</dt><dd>'+escapeHtml(project.repositoryPath)+'</dd><dt>默认分支</dt><dd>'+escapeHtml(project.defaultBranch)+'</dd><dt>注册时间</dt><dd>'+escapeHtml(formatTime(project.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(project.updatedAt))+'</dd></dl></section>'+
              '<section class="product-panel compact"><div class="panel-heading"><span>当前执行</span><b>'+escapeHtml(label(project.executionStatus || "pending"))+'</b></div><dl class="detail-meta"><dt>动作</dt><dd>'+escapeHtml(label(project.requestedAction || "pending"))+'</dd>'+(model ? '<dt>模型</dt><dd>'+escapeHtml(model.model)+'</dd><dt>路由</dt><dd>'+escapeHtml(label(model.route))+'</dd>'+(model.circuitBreaker ? '<dt>主模型熔断</dt><dd>'+escapeHtml(label(model.circuitBreaker.state))+(model.circuitBreaker.primaryProbeAt ? ' · '+escapeHtml(formatTime(model.circuitBreaker.primaryProbeAt)) : '')+'</dd>' : '')+'<dt>容量重试</dt><dd>'+model.retryCount+'</dd>' : '')+'</dl></section>'+
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
      const { task, activities, currentDecisionRequest } = taskDetail;
      detail.setAttribute("aria-hidden", "false");
      const criteria = task.acceptanceCriteria.length
        ? '<ul class="criteria-list '+(task.status === "done" ? "complete" : "")+'">'+task.acceptanceCriteria.map(item => '<li><i>'+(task.status === "done" ? "✓" : "")+'</i><span>'+escapeHtml(item)+'</span></li>').join("")+'</ul>'
        : '<div class="criteria-empty">未设置验收标准。</div>';
      const cancellation = task.status === "cancelled"
        ? '<div class="cancellation-card"><b>取消理由</b><p>'+escapeHtml(task.cancellation?.reason || "历史取消记录未保存理由。")+'</p>'+(task.cancellation ? '<small>'+escapeHtml(label(task.cancellation.decisionBasis))+' · '+escapeHtml(label(task.cancellation.cancelledBy))+' · '+escapeHtml(formatTime(task.cancellation.cancelledAt))+'</small>' : '<small>该任务在取消理由成为必填项之前结束。</small>')+'</div>'
        : '';
      const scheduledResume = task.currentExecution?.scheduledResume
        ? '<section class="scheduled-resume-card"><div><b>计划恢复</b><p>'+escapeHtml(task.currentExecution.scheduledResume.reason)+'</p><time>'+escapeHtml(formatTime(task.currentExecution.scheduledResume.resumeAt))+'</time></div><div class="scheduled-resume-actions"><button class="action-button" type="button" data-continue-now data-live-sync-key="task-continue">提前继续</button><label>重新安排<input type="datetime-local" data-reschedule-at data-live-sync-key="task-resume-at"></label><button class="action-button" type="button" data-reschedule data-live-sync-key="task-reschedule">保存时间</button></div></section>'
        : '';
      const currentConversation = task.currentExecution
        ? '<section class="current-conversation">'+
            '<div class="current-conversation-copy"><span>当前对话</span><div><b>'+escapeHtml(label(task.currentExecution.action))+'</b><i aria-hidden="true">·</i><strong>'+escapeHtml(label(task.currentExecution.status))+'</strong></div></div>'+
            (task.currentExecution.threadId ? '<a class="detail-link primary" data-live-sync-key="task-current-conversation" href="codex://threads/'+escapeHtml(task.currentExecution.threadId)+'">'+(task.currentExecution.status === "waiting_for_input" ? "前往当前对话回复" : "打开当前对话")+' <span>↗</span></a>' : '')+
          '</section>'
        : '';
      const activityTimeline = activities.length
        ? '<ol class="activity-timeline">'+activities.map((activity, index, all) => activityCard(activity, index, all, currentDecisionRequest?.id)).join("")+'</ol>'
        : '<div class="activity-empty"><b>尚无进展记录</b><span>节点完成汇报后会按时间出现在这里。</span></div>';
      const controls = [
        task.status === "blocked" && !task.currentExecution?.scheduledResume ? '<button class="action-button" data-retry data-live-sync-key="task-retry">重试</button>' : ''
      ].filter(Boolean).join("");
      host.innerHTML =
        '<header class="detail-head"><strong>任务详情</strong><button id="close-detail" class="icon-button" type="button" aria-label="关闭任务详情">×</button></header>'+
        '<div class="detail-body">'+
          '<div class="detail-status"><span></span>'+escapeHtml(label(task.status))+'</div>'+
          '<div class="task-id-row"><code title="'+escapeHtml(task.id)+'">'+escapeHtml(task.id)+'</code><button class="copy-id-button" type="button" data-copy-task-id data-live-sync-key="task-copy-id" aria-label="复制任务 ID" aria-live="polite">复制 ID</button></div>'+
          '<h2>'+escapeHtml(task.title)+'</h2><p class="detail-description">'+escapeHtml(task.description)+'</p>'+
          (controls ? '<div class="detail-actions">'+controls+'</div>' : '')+cancellation+scheduledResume+currentConversation+
          '<section class="detail-section"><h3>验收标准 <span>'+task.acceptanceCriteria.length+'</span></h3>'+criteria+'</section>'+
          '<section class="detail-section activity-section"><h3>进展记录 <span>'+activities.length+'</span></h3>'+activityTimeline+'</section>'+
          '<section class="detail-section"><h3>执行信息</h3><dl class="detail-meta"><dt>当前阶段</dt><dd>'+escapeHtml(label(task.executionStatus === "retry_scheduled" ? task.executionStatus : task.requestedAction || task.status))+'</dd>'+
            (task.modelRouting ? '<dt>当前模型</dt><dd>'+escapeHtml(task.modelRouting.model)+' · '+escapeHtml(label(task.modelRouting.route))+'</dd>'+(task.modelRouting.circuitBreaker ? '<dt>主模型熔断</dt><dd>'+escapeHtml(label(task.modelRouting.circuitBreaker.state))+(task.modelRouting.circuitBreaker.primaryProbeAt ? ' · '+escapeHtml(formatTime(task.modelRouting.circuitBreaker.primaryProbeAt)) : '')+'</dd>' : '')+'<dt>容量重试</dt><dd>'+task.modelRouting.retryCount+(task.modelRouting.nextRetryAt ? ' · '+escapeHtml(formatTime(task.modelRouting.nextRetryAt)) : '')+'</dd>' : '')+
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
      });
      host.querySelector("[data-continue-now]")?.addEventListener("click", async () => {
        await command("task.control", { taskId: task.id, action: "continue" });
      });
      host.querySelector("[data-reschedule]")?.addEventListener("click", async () => {
        const localValue = host.querySelector("[data-reschedule-at]").value;
        if (!localValue) return;
        await command("task.control", {
          taskId: task.id,
          action: "reschedule",
          resumeAt: new Date(localValue).toISOString()
        });
      });
    }

    function activityCard(activity, index, all, currentDecisionActivityId) {
      const evidence = activity.evidence || {};
      const isCurrentDecision = activity.id === currentDecisionActivityId;
      const rows = [
        ["工作树", evidence.workspacePath],
        ["基础提交", evidence.baseCommit],
        ["候选提交", evidence.candidateCommit],
        ["审查基线", evidence.reviewedMainCommit],
        ["合入提交", evidence.mergedCommit]
      ].filter(([, value]) => value);
      const question = evidence.question
        ? '<div class="activity-question '+(isCurrentDecision ? "current" : "historical")+'"><b>'+(isCurrentDecision ? "当前需要决定" : "历史决定请求")+'</b><p>'+escapeHtml(evidence.question)+'</p>'+(isCurrentDecision && activity.threadId ? '<a class="detail-link primary" data-live-sync-key="activity-decision:'+escapeHtml(activity.id)+'" href="codex://threads/'+escapeHtml(activity.threadId)+'">前往对应对话回复 <span>↗</span></a>' : '<small>'+(isCurrentDecision ? "当前执行未关联 Codex 对话。" : "此问题保留为历史活动。")+'</small>')+'</div>'
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
      const conversation = activity.threadId
        ? '<a class="activity-conversation-link" data-activity-thread data-live-sync-key="activity-conversation:'+escapeHtml(activity.id)+'" href="codex://threads/'+escapeHtml(activity.threadId)+'">打开对话 <span>↗</span></a>'
        : '';
      return '<li class="activity-item '+escapeHtml(activity.type)+'" '+(index === all.length - 1 ? 'data-latest-activity' : '')+'><span class="activity-node"></span><article class="activity-card"><header><b>'+escapeHtml(label(activity.type))+'</b><div class="activity-card-actions">'+conversation+'<time>'+escapeHtml(formatTime(activity.occurredAt))+'</time></div></header><p class="activity-summary">'+escapeHtml(activity.summary)+'</p>'+(hasEvidence ? '<div class="activity-evidence">'+question+findings+tests+git+'</div>' : '')+'</article></li>';
    }

    function closeDetail() {
      selectedTaskId = null;
      taskDetail = null;
      document.body.classList.remove("detail-open");
      render();
    }

    document.getElementById("update-trigger").onclick = openUpdateDialog;
    document.getElementById("update-close").onclick = closeUpdateDialog;
    document.getElementById("update-check").onclick = checkForUpdates;
    document.getElementById("update-primary").onclick = runPrimaryUpdateAction;
    document.getElementById("update-copy-command").onclick = async event => {
      try {
        await navigator.clipboard.writeText("codrive upgrade");
        event.currentTarget.textContent = "已复制";
      } catch {
        event.currentTarget.textContent = "复制失败";
      }
    };
    document.getElementById("nav-backdrop").onclick = () => document.body.classList.remove("nav-open");
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (selectedTaskId) closeDetail();
      else if (document.body.classList.contains("nav-open")) document.body.classList.remove("nav-open");
      else if (!document.getElementById("update-dialog").hidden) closeUpdateDialog();
    });
    function renderLiveConnectionStatus(status) {
      const offline = document.getElementById("offline");
      if (status === "connected") {
        offline.style.display = "none";
        return;
      }
      const activeUpgrade = systemUpdate?.upgrade && activeUpdatePhases.includes(systemUpdate.upgrade.phase);
      offline.textContent = status === "protocol_error"
        ? "实时同步协议错误，正在重新同步权威状态..."
        : activeUpgrade
          ? "Codrive 正在升级重启，页面会自动恢复连接..."
          : status === "connecting"
            ? "正在建立本机实时连接..."
            : "实时连接中断，正在重新连接...";
      offline.style.display = "block";
    }

    const liveProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const liveSync = createLiveSyncController({
      createSocket: () => new WebSocket(liveProtocol+"//"+window.location.host+"/api/live?token="+encodeURIComponent(TOKEN)),
      applyEvent: event => refreshFromPlan(liveSyncRefreshPlan(event, currentLiveSyncState())),
      resync: () => refreshFromPlan(liveSyncRefreshPlan(null, currentLiveSyncState())),
      onStatus: renderLiveConnectionStatus
    });
    let bootstrapTimer = null;
    async function bootstrapBoard() {
      try {
        await refreshFromPlan(liveSyncRefreshPlan(null, currentLiveSyncState()));
        liveSync.start();
      } catch {
        renderLiveConnectionStatus("reconnecting");
        bootstrapTimer = window.setTimeout(bootstrapBoard, 1000);
      }
    }
    window.addEventListener("beforeunload", () => {
      if (bootstrapTimer) window.clearTimeout(bootstrapTimer);
      liveSync.stop();
    }, { once: true });
    bootstrapBoard();
  </script>`;
}
