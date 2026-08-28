import { createRealtimeWatchCoordinator } from "./board-realtime-client.js";
import { createExecutionActivityRenderer } from "./execution-activity-renderer.js";
import { createSystemUpdateRenderer } from "./system-update-renderer.js";
import {
  moveProjectInOrder,
  projectOrderStorageKey,
  reconcileProjectOrder,
} from "./project-ordering.js";
import { taskBoardLayout } from "./task-board-layout.js";
import { sortTerminalTasks } from "./task-terminal-ordering.js";

export function renderBoardClient(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  const layout = JSON.stringify(taskBoardLayout);
  // The board is inline JavaScript, so embed the same coordinator exercised by unit tests.
  const watchCoordinator = createRealtimeWatchCoordinator.toString();
  const activityRenderer = createExecutionActivityRenderer.toString();
  const systemUpdateRenderer = createSystemUpdateRenderer.toString();
  const reorderProjects = moveProjectInOrder.toString();
  const reconcileProjects = reconcileProjectOrder.toString();
  const orderTerminalTasks = sortTerminalTasks.toString();
  return `<script>
    const TOKEN = ${token};
    const boardLayout = ${layout};
    const columns = boardLayout.columns;
    const statusLabels = {
      active: "进行中", selecting_tasks: "安排任务中", idle: "当前无待办",
      archived: "已归档",
      waiting_for_input: "等待决定",
      waiting_for_resume: "计划等待",
      blocked: "已阻塞", cancelled: "已取消", backlog: "待安排", working: "工作中",
      reviewing: "审查中", integrating: "合入中", done: "已完成",
      running: "自动推进", paused: "已暂停", work: "工作", review: "审查",
      integrate: "合入", pending: "待开始", awaiting_report: "等待汇报", failed: "执行失败",
      interrupted: "已中断", approved: "审查通过", needs_review: "等待审查",
      needs_input: "等待决定", queued: "待安排",
      selected: "已完成本轮安排", waiting_for_task: "等待任务完成",
      retry_scheduled: "等待模型重试", active_paused: "执行中 · 后续已暂停",
      primary: "默认", fallback: "备用", user_confirmed: "用户确认",
      closed: "正常", open: "已熔断", half_open: "主模型探测",
      agent_decision: "Codex 判断", codex: "Codex", user: "用户",
      missing: "待补齐", outdated: "待同步", current: "已对齐", conflict: "存在冲突",
      work_completed: "工作完成", integration_work_required: "合入后继续工作",
      review_approved: "审查通过", review_changes_requested: "审查退回",
      integration_completed: "合入完成",
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
    let archivedSnapshots = [];
    let selectedProjectId = null;
    let selectedTaskId = null;
    let systemUpdate = null;
    let updatePoll = null;
    let productDetail = null;
    let taskDetail = null;
    let currentActivity = null;
    let systemSettings = null;
    let projectSettings = null;
    let updateActionError = null;
    let draggedProjectId = null;
    let archivedProjectsExpanded = false;
    let archiveProjectId = null;
    let archiveReturnFocus = null;
    let projectListRefreshQueue = Promise.resolve();
    let projectReadRevision = 0;
    let taskReadRevision = 0;
    const terminalTaskSort = { done: null, cancelled: null };
    const socket = io({ auth: { token: TOKEN }, autoConnect: false });
    const createWatchCoordinator = ${watchCoordinator};
    const projectOrderStorageKey = ${JSON.stringify(projectOrderStorageKey)};
    const moveProjectInOrder = ${reorderProjects};
    const reconcileProjectOrder = ${reconcileProjects};
    const sortTerminalTasks = ${orderTerminalTasks};
    const headers = { "x-codrive-token": TOKEN, "content-type": "application/json" };
    const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[character]));
    const bucket = status => boardLayout.statusColumns[status] || status;
    const label = status => statusLabels[status] || String(status || "").replaceAll("_", " ");
    const formatTime = value => value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "—";
    const initials = value => String(value || "C").trim().split(/\\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    const createActivityRenderer = ${activityRenderer};
    const renderActivityEntry = createActivityRenderer({
      getHost: () => document.getElementById("current-execution-activity"),
      createElement: tagName => document.createElement(tagName),
      formatTime,
      schedule: (callback, delay) => window.setTimeout(callback, delay)
    });
    const createUpdateRenderer = ${systemUpdateRenderer};
    const renderSystemUpdateView = createUpdateRenderer({
      getElementById: id => document.getElementById(id),
      label,
      formatTime,
      escapeHtml
    });

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

    const activeUpdatePhases = ["checking", "installing", "stopping", "migrating", "syncing_resources", "restarting"];
    async function refreshSystem() {
      let refreshed;
      try {
        refreshed = await api("/api/system");
      } catch {
        if (systemUpdate?.upgrade && activeUpdatePhases.includes(systemUpdate.upgrade.phase)) {
          document.getElementById("update-status").textContent = "本机服务正在重启，恢复连接后会继续显示进度。";
          scheduleUpdatePoll();
          return;
        }
        document.getElementById("update-status").textContent = "暂时无法读取更新状态。";
        return;
      }
      systemUpdate = refreshed;
      renderSystemUpdate();
    }

    function renderSystemUpdate() {
      if (!systemUpdate) return;
      const result = renderSystemUpdateView(systemUpdate, updateActionError);
      if (result.shouldPoll) scheduleUpdatePoll();
      else if (updatePoll) {
        window.clearTimeout(updatePoll);
        updatePoll = null;
      }
    }

    function scheduleUpdatePoll() {
      if (updatePoll) window.clearTimeout(updatePoll);
      updatePoll = window.setTimeout(refreshSystem, 1000);
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
          systemUpdate.resources.state !== "current";
        if (systemUpdate.version?.updateAvailable && !repairCurrentVersion) {
          status.textContent = "正在启动独立更新进程...";
          systemUpdate = await command("system.start_upgrade", { targetVersion: systemUpdate.version.latestVersion });
        } else {
          status.textContent = "正在同步托管资源...";
          systemUpdate = await command("system.install_resources", {});
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
      void refreshSystem();
    }

    function closeUpdateDialog() {
      document.getElementById("update-dialog").hidden = true;
      document.getElementById("update-trigger").focus();
    }

    async function refresh() {
      try {
        const requests = [api("/api/board"), api("/api/board/archived")];
        if (route.type === "project") {
          const projectPath = "/api/projects/"+encodeURIComponent(route.projectId);
          requests.push(api(projectPath), api(projectPath+"/settings"));
        }
        if (route.type === "settings") requests.push(api("/api/system/settings"));
        const results = await Promise.all(requests);
        snapshots = results[0];
        archivedSnapshots = results[1].projects;
        productDetail = route.type === "project" ? results[2] : null;
        projectSettings = route.type === "project" ? results[3] : null;
        systemSettings = route.type === "settings" ? results[2] : null;
        document.getElementById("offline").style.display = "none";
        if (route.type === "project") selectedProjectId = route.projectId;
        if (route.type === "board" && (!selectedProjectId || !snapshots.some(snapshot => snapshot.project.id === selectedProjectId))) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
        }
        if (route.type === "project" && archivedSnapshots.some(snapshot => snapshot.project.id === route.projectId)) {
          archivedProjectsExpanded = true;
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
        const activeUpgrade = systemUpdate?.upgrade && activeUpdatePhases.includes(systemUpdate.upgrade.phase);
        const offline = document.getElementById("offline");
        offline.textContent = activeUpgrade ? "Codrive 正在重启，页面会自动恢复连接..." : "正在重新连接本机服务...";
        offline.style.display = "block";
      }
    }

    function refreshProjectLists(options = {}) {
      const refresh = async () => {
        const previousFocus = captureProjectListFocus();
        const [activeProjects, archivedProjects] = await Promise.all([
          api("/api/board"),
          api("/api/board/archived")
        ]);
        snapshots = activeProjects;
        archivedSnapshots = archivedProjects.projects;
        if (route.type === "board" && !snapshots.some(snapshot => snapshot.project.id === selectedProjectId)) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
          taskDetail = null;
          currentActivity = null;
          taskReadRevision += 1;
          document.body.classList.remove("detail-open");
          document.getElementById("task-detail").setAttribute("aria-hidden", "true");
          document.getElementById("task-detail-content").innerHTML = "";
          await syncCurrentWatches();
        }
        if (route.type === "project" && archivedSnapshots.some(snapshot => snapshot.project.id === route.projectId)) {
          archivedProjectsExpanded = true;
        }
        renderProjects();
        if (route.type === "board") renderWorkspace();
        if (options.focusAfterArchive) focusCurrentProjectOrArchive();
        else if (options.focusProjectId) {
          restoreProjectListFocus({ projectId: options.focusProjectId });
        } else restoreProjectListFocus(previousFocus);
      };
      const requestedRefresh = projectListRefreshQueue.then(refresh, refresh);
      projectListRefreshQueue = requestedRefresh.catch(() => undefined);
      return requestedRefresh;
    }

    function captureProjectListFocus() {
      const activeElement = document.activeElement;
      if (activeElement?.id === "archived-projects-trigger") return { archived: true };
      const projectId = activeElement?.dataset?.project;
      return projectId ? { projectId } : null;
    }

    function restoreProjectListFocus(target) {
      if (!target) return;
      const element = target.projectId
        ? document.querySelector('[data-project="'+CSS.escape(target.projectId)+'"]')
        : document.getElementById("archived-projects-trigger");
      element?.focus();
    }

    function focusCurrentProjectOrArchive() {
      restoreProjectListFocus(selectedProjectId
        ? { projectId: selectedProjectId }
        : { archived: true });
    }

    async function refreshSelectedProject(projectId = selectedProjectId) {
      if (!projectId || route.type === "settings") return;
      const revision = ++projectReadRevision;
      try {
        const requests = [api("/api/board/projects/"+encodeURIComponent(projectId))];
        if (route.type === "project" && route.projectId === projectId) {
          const projectPath = "/api/projects/"+encodeURIComponent(projectId);
          requests.push(api(projectPath), api(projectPath+"/settings"));
        }
        const results = await Promise.all(requests);
        if (revision !== projectReadRevision || selectedProjectId !== projectId) return;
        const snapshotIndex = snapshots.findIndex(snapshot => snapshot.project.id === projectId);
        const archivedIndex = archivedSnapshots.findIndex(snapshot => snapshot.project.id === projectId);
        if (snapshotIndex >= 0) snapshots.splice(snapshotIndex, 1);
        if (archivedIndex >= 0) archivedSnapshots.splice(archivedIndex, 1);
        if (results[0].project.archivedAt) archivedSnapshots.push(results[0]);
        else if (snapshotIndex >= 0) snapshots.splice(snapshotIndex, 0, results[0]);
        else snapshots.push(results[0]);
        if (route.type === "project") {
          productDetail = results[1];
          projectSettings = results[2];
        }
        if (route.type === "board" && results[0].project.archivedAt) {
          selectedProjectId = snapshots[0]?.project.id ?? null;
          selectedTaskId = null;
          taskDetail = null;
          currentActivity = null;
          taskReadRevision += 1;
          document.body.classList.remove("detail-open");
          document.getElementById("task-detail").setAttribute("aria-hidden", "true");
          document.getElementById("task-detail-content").innerHTML = "";
          await syncCurrentWatches();
        } else if (selectedTaskId && !results[0].tasks.some(task => task.id === selectedTaskId)) {
          selectedTaskId = null;
          taskDetail = null;
          void syncCurrentWatches();
        }
        const viewState = captureViewState();
        renderProjects();
        if (route.type === "project") renderProductDetail();
        else renderWorkspace();
        restoreViewState(viewState);
        document.getElementById("offline").style.display = "none";
      } catch {
        showOffline();
      }
    }

    async function refreshSelectedTask(taskId = selectedTaskId) {
      if (!taskId || route.type !== "board") return;
      const revision = ++taskReadRevision;
      try {
        const detail = await api("/api/tasks/"+encodeURIComponent(taskId));
        if (revision !== taskReadRevision || selectedTaskId !== taskId) return;
        const viewState = taskDetail?.task.id === taskId ? captureViewState() : null;
        taskDetail = detail;
        if (!activityMatchesCurrentExecution(currentActivity)) currentActivity = null;
        document.body.classList.add("detail-open");
        renderTaskDetail();
        if (viewState) restoreViewState(viewState);
        document.getElementById("offline").style.display = "none";
      } catch {
        showOffline();
      }
    }

    async function refreshCurrentTaskAndProject() {
      await Promise.all([refreshSelectedProject(), refreshSelectedTask()]);
    }

    function showOffline() {
      const activeUpgrade = systemUpdate?.upgrade && activeUpdatePhases.includes(systemUpdate.upgrade.phase);
      const offline = document.getElementById("offline");
      offline.textContent = activeUpgrade
        ? "Codrive 正在重启，页面会自动恢复连接..."
        : "正在重新连接本机服务...";
      offline.style.display = "block";
    }

    function captureViewState() {
      const active = elementIdentity(document.activeElement);
      const values = Array.from(document.querySelectorAll("input, textarea, select"))
        .map(element => ({
          identity: elementIdentity(element),
          value: element.value,
          checked: "checked" in element ? element.checked : null,
          disabled: "disabled" in element ? element.disabled : null,
          selectionStart: typeof element.selectionStart === "number" ? element.selectionStart : null,
          selectionEnd: typeof element.selectionEnd === "number" ? element.selectionEnd : null
        }))
        .filter(entry => entry.identity);
      return {
        active,
        values,
        documentScroll: document.scrollingElement?.scrollTop ?? 0,
        boardScrollLeft: document.querySelector(".board-wrap")?.scrollLeft ?? 0,
        boardScrollTop: document.querySelector(".board-wrap")?.scrollTop ?? 0,
        detailScroll: document.getElementById("task-detail-content")?.scrollTop ?? 0,
        sidebarScroll: document.getElementById("projects")?.scrollTop ?? 0
      };
    }

    function restoreViewState(state) {
      for (const entry of state.values) {
        const element = findIdentifiedElement(entry.identity);
        if (!element || !("value" in element)) continue;
        element.value = entry.value;
        if (entry.checked !== null && "checked" in element) element.checked = entry.checked;
        if (entry.disabled !== null && "disabled" in element) element.disabled = entry.disabled;
        if (entry.selectionStart !== null && typeof element.setSelectionRange === "function") {
          element.setSelectionRange(entry.selectionStart, entry.selectionEnd);
        }
      }
      if (document.scrollingElement) document.scrollingElement.scrollTop = state.documentScroll;
      const board = document.querySelector(".board-wrap");
      if (board) {
        board.scrollLeft = state.boardScrollLeft;
        board.scrollTop = state.boardScrollTop;
      }
      const detail = document.getElementById("task-detail-content");
      if (detail) detail.scrollTop = state.detailScroll;
      const projects = document.getElementById("projects");
      if (projects) projects.scrollTop = state.sidebarScroll;
      findIdentifiedElement(state.active)?.focus({ preventScroll: true });
    }

    function elementIdentity(element) {
      if (!(element instanceof HTMLElement)) return null;
      if (element.id) return { attribute: "id", value: element.id };
      const attributes = [
        "data-task", "data-project", "data-project-action", "data-copy-task-id",
        "data-task-sort",
        "data-retry", "data-continue-now", "data-reschedule", "data-reschedule-at",
        "data-activity-thread", "name"
      ];
      for (const attribute of attributes) {
        if (element.hasAttribute(attribute)) {
          return { attribute, value: element.getAttribute(attribute) };
        }
      }
      return null;
    }

    function findIdentifiedElement(identity) {
      if (!identity) return null;
      if (identity.attribute === "id") return document.getElementById(identity.value);
      return Array.from(document.querySelectorAll("["+identity.attribute+"]"))
        .find(element => element.getAttribute(identity.attribute) === identity.value) || null;
    }

    function readProjectOrder() {
      try {
        const serializedOrder = window.localStorage.getItem(projectOrderStorageKey);
        return serializedOrder === null ? [] : JSON.parse(serializedOrder);
      } catch {
        return [];
      }
    }

    function persistProjectOrder(projectIds) {
      try {
        window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(projectIds));
      } catch {}
    }

    function projectOrdersMatch(left, right) {
      return left.length === right.length && left.every((projectId, index) => projectId === right[index]);
    }

    function getOrderedProjectSnapshots() {
      const savedOrder = readProjectOrder();
      const persistedOrder = Array.isArray(savedOrder) ? savedOrder : [];
      const projectIds = snapshots.map(snapshot => snapshot.project.id);
      const orderedProjectIds = reconcileProjectOrder(projectIds, persistedOrder);
      if (!projectOrdersMatch(persistedOrder, orderedProjectIds)) {
        persistProjectOrder(orderedProjectIds);
      }
      const snapshotsByProjectId = new Map(snapshots.map(snapshot => [snapshot.project.id, snapshot]));
      return orderedProjectIds.map(projectId => snapshotsByProjectId.get(projectId)).filter(Boolean);
    }

    function clearProjectDropIndicators() {
      document.querySelectorAll("[data-project-row]").forEach(row => {
        row.classList.remove("dragging", "drop-before", "drop-after");
      });
    }

    function projectDropPosition(event, row) {
      const bounds = row.getBoundingClientRect();
      return event.clientY - bounds.top < bounds.height / 2 ? "before" : "after";
    }

    function enableProjectSorting(host) {
      host.querySelectorAll("[data-project-drag]").forEach(handle => {
        handle.addEventListener("dragstart", event => {
          draggedProjectId = handle.dataset.projectDrag;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", draggedProjectId);
          handle.closest("[data-project-row]").classList.add("dragging");
        });
        handle.addEventListener("dragend", () => {
          draggedProjectId = null;
          clearProjectDropIndicators();
        });
      });
      host.querySelectorAll("[data-project-row]").forEach(row => {
        row.addEventListener("dragover", event => {
          if (!draggedProjectId || draggedProjectId === row.dataset.projectRow) return;
          event.preventDefault();
          clearProjectDropIndicators();
          row.classList.add(projectDropPosition(event, row) === "before" ? "drop-before" : "drop-after");
          event.dataTransfer.dropEffect = "move";
        });
        row.addEventListener("dragleave", event => {
          if (!row.contains(event.relatedTarget)) {
            row.classList.remove("drop-before", "drop-after");
          }
        });
        row.addEventListener("drop", event => {
          event.preventDefault();
          const sourceProjectId = draggedProjectId || event.dataTransfer.getData("text/plain");
          const targetProjectId = row.dataset.projectRow;
          draggedProjectId = null;
          clearProjectDropIndicators();
          if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) return;
          const projectIds = getOrderedProjectSnapshots().map(snapshot => snapshot.project.id);
          persistProjectOrder(moveProjectInOrder(
            projectIds,
            sourceProjectId,
            targetProjectId,
            projectDropPosition(event, row),
          ));
          renderProjects();
        });
      });
    }

    const currentSnapshot = () => snapshots.find(snapshot => snapshot.project.id === selectedProjectId);

    async function realtimeRequest(event, payload = {}) {
      if (!socket.connected) throw new Error("Realtime connection unavailable");
      const result = await socket.timeout(2000).emitWithAck(event, payload);
      if (!result?.ok) throw new Error(result?.error || "Realtime watch failed");
      if (event === "watch:task" && payload.taskId) {
        setCurrentActivity(payload.taskId, result.activity ?? null);
      }
      return result;
    }

    const realtimeWatches = createWatchCoordinator({
      isConnected: () => socket.connected,
      readDesiredWatches: () => ({
        projectId: route.type === "settings" ? null : selectedProjectId,
        taskId: route.type === "board" ? selectedTaskId : null
      }),
      request: realtimeRequest
    });

    const syncCurrentWatches = () => realtimeWatches.sync();

    async function refreshRealtimeScopes() {
      await refreshProjectLists();
      const requests = [refreshSystem()];
      if (route.type !== "settings" && selectedProjectId) {
        requests.push(refreshSelectedProject());
      }
      if (route.type === "board" && selectedTaskId) {
        requests.push(refreshSelectedTask());
      }
      await Promise.all(requests);
    }

    async function selectProject(projectId) {
      if (!projectId || projectId === selectedProjectId) return;
      selectedTaskId = null;
      taskDetail = null;
      currentActivity = null;
      taskReadRevision += 1;
      document.body.classList.remove("detail-open", "nav-open");
      document.getElementById("task-detail").setAttribute("aria-hidden", "true");
      document.getElementById("task-detail-content").innerHTML = "";
      selectedProjectId = projectId;
      try {
        await syncCurrentWatches();
        await refreshSelectedProject(projectId);
      } catch {
        showOffline();
      }
    }

    async function openTask(taskId) {
      if (!taskId) return;
      selectedTaskId = taskId;
      taskDetail = null;
      currentActivity = null;
      try {
        await syncCurrentWatches();
        await refreshSelectedTask(taskId);
      } catch {
        showOffline();
      }
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
      document.getElementById("archived-project-count").textContent = archivedSnapshots.length;
      const host = document.getElementById("projects");
      const orderedSnapshots = getOrderedProjectSnapshots();
      host.innerHTML = snapshots.length
        ? orderedSnapshots.map(({ project, tasks }) =>
            '<div class="project-item" data-project-row="'+escapeHtml(project.id)+'">'+
              '<button class="project-drag-handle" type="button" draggable="true" data-project-drag="'+escapeHtml(project.id)+'" aria-label="拖拽排序 '+escapeHtml(project.name)+'" title="拖拽排序"><span class="project-drag-mark" aria-hidden="true"></span></button>'+
              '<button class="project-button '+(project.id === selectedProjectId ? 'active' : '')+'" type="button" data-project="'+escapeHtml(project.id)+'" aria-pressed="'+(project.id === selectedProjectId)+'">'+
                '<span class="project-glyph">'+escapeHtml(initials(project.name))+'</span>'+
                '<span class="project-label"><b>'+escapeHtml(project.name)+'</b><small>'+escapeHtml(label(project.displayStatus))+'</small></span>'+
                '<span class="project-total">'+tasks.length+'</span>'+
              '</button>'+
            '</div>'
          ).join("")
        : '';
      host.querySelectorAll("[data-project]").forEach(button => {
        button.onclick = () => {
          if (route.type !== "board") {
            window.location.href = "/projects/"+encodeURIComponent(button.dataset.project);
            return;
          }
          void selectProject(button.dataset.project);
        };
      });
      enableProjectSorting(host);

      const archivedTrigger = document.getElementById("archived-projects-trigger");
      const archivedPanel = document.getElementById("archived-projects-panel");
      const archivedHost = document.getElementById("archived-project-list");
      archivedTrigger.setAttribute("aria-expanded", String(archivedProjectsExpanded));
      archivedPanel.hidden = !archivedProjectsExpanded;
      archivedHost.innerHTML = archivedSnapshots.length
        ? archivedSnapshots.map(({ project, tasks }) =>
            '<div class="archived-project-row">'+
              '<a class="archived-project-link" href="/projects/'+encodeURIComponent(project.id)+'"><b>'+escapeHtml(project.name)+'</b><small>'+tasks.length+' 个任务 · '+escapeHtml(formatTime(project.archivedAt))+'</small></a>'+
              '<button class="archived-project-restore" type="button" data-unarchive-project="'+escapeHtml(project.id)+'">恢复</button>'+
            '</div>'
          ).join("")
        : '<div class="archived-empty">没有已归档项目。</div>';
      archivedTrigger.onclick = () => {
        archivedProjectsExpanded = !archivedProjectsExpanded;
        archivedTrigger.setAttribute("aria-expanded", String(archivedProjectsExpanded));
        archivedPanel.hidden = !archivedProjectsExpanded;
        if (archivedProjectsExpanded) archivedHost.querySelector("a, button")?.focus();
      };
      archivedHost.querySelectorAll("[data-unarchive-project]").forEach(button => {
        button.onclick = () => { void restoreArchivedProject(button.dataset.unarchiveProject, button); };
      });
    }

    function openProjectArchiveDialog(project, trigger) {
      archiveProjectId = project.id;
      archiveReturnFocus = trigger;
      const dialog = document.getElementById("project-archive-dialog");
      document.getElementById("project-archive-title").textContent = "归档 · "+project.name;
      document.getElementById("project-archive-status").textContent = "";
      document.getElementById("project-archive-confirm").disabled = false;
      dialog.hidden = false;
      dialog.querySelector(".archive-panel").focus();
    }

    function closeProjectArchiveDialog({ restoreFocus = true } = {}) {
      document.getElementById("project-archive-dialog").hidden = true;
      archiveProjectId = null;
      let focusTarget = null;
      if (restoreFocus) {
        focusTarget = archiveReturnFocus?.isConnected
          ? archiveReturnFocus
          : document.getElementById("archived-projects-trigger");
      }
      archiveReturnFocus = null;
      focusTarget?.focus();
    }

    async function confirmProjectArchive() {
      if (!archiveProjectId) return;
      const status = document.getElementById("project-archive-status");
      const confirm = document.getElementById("project-archive-confirm");
      confirm.disabled = true;
      status.textContent = "正在检查执行状态并归档...";
      try {
        await command("project.control", { projectId: archiveProjectId, action: "archive" });
        if (route.type === "project") {
          window.location.assign("/");
          return;
        }
        await refreshProjectLists({ focusAfterArchive: true });
        closeProjectArchiveDialog({ restoreFocus: false });
      } catch (error) {
        status.textContent = error.message;
        confirm.disabled = false;
        confirm.focus();
      }
    }

    async function restoreArchivedProject(projectId, trigger) {
      const status = document.getElementById("archived-projects-status");
      status.textContent = "正在恢复项目...";
      trigger.disabled = true;
      try {
        await command("project.control", { projectId, action: "unarchive" });
        await refreshProjectLists({ focusProjectId: projectId });
        if (route.type === "project" && route.projectId === projectId) {
          await refreshSelectedProject(projectId);
        }
        document.getElementById("archived-projects-status").textContent = "项目已恢复；调度仍保持暂停。";
      } catch (error) {
        status.textContent = error.message;
        trigger.disabled = false;
        trigger.focus();
      }
    }

    function renderWorkspace() {
      const snapshot = currentSnapshot();
      const host = document.getElementById("project");
      if (!snapshot) {
        host.innerHTML = '<div class="empty-workspace"><section class="empty-card"><div class="empty-kicker">从这里开始</div><h1>告诉 Codex 你的想法</h1><p>直接用自然语言描述，确认计划后，Codrive 会自动推进任务。</p><div class="starter-example">“用 Codrive 的方式帮我做一个经营太空货运公司的游戏。”</div></section></div>';
        return;
      }
      const { project, tasks } = snapshot;
      const active = tasks.filter(task => ["working", "reviewing", "integrating"].includes(task.status)).length;
      const waiting = tasks.filter(task => ["waiting_for_input", "blocked"].includes(task.status)).length;
      const done = tasks.filter(task => task.status === "done").length;
      const terminal = project.status === "cancelled";
      const actions = terminal ? [] : [project.scheduling === "paused"
        ? '<button class="action-button" data-project-action="resume">继续</button>'
        : '<button class="action-button" data-project-action="pause">暂停</button>'];
      actions.push('<button class="action-button danger" data-project-action="archive">归档</button>');
      actions.unshift('<a class="action-button" href="/projects/'+encodeURIComponent(project.id)+'">产品详情</a>');
      if (project.executionStatus === "failed" && project.requestedAction) actions.unshift('<button class="action-button" data-project-action="retry">重试失败执行</button>');
      if (["waiting_for_task", "needs_input", "blocked"].includes(project.planning.status)) actions.unshift('<button class="action-button" data-project-action="replan">重新判断任务</button>');
      const attention = project.attention;
      const attentionCopy = attention?.question || attention?.summary;
      const cancellationReason = project.status === "cancelled" && project.cancellation ? project.cancellation.reason : null;
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
            '<div class="project-controls"><div class="project-actions">'+actions.join("")+'</div><div id="project-action-status" class="project-action-status" role="status" aria-live="polite"></div></div>'+
          '</div>'+
          '<div class="project-stats"><span><b>'+tasks.length+'</b>总任务</span><span><b>'+active+'</b>进行中</span><span><b>'+waiting+'</b>等待</span><span><b>'+done+'</b>已完成</span></div>'+
        '</header>'+
        '<div class="board-wrap"><div class="board">'+columns.map(([key, columnLabel]) => {
          const cards = tasks.filter(task => bucket(task.status) === key);
          const direction = terminalTaskSort[key] || null;
          const visibleCards = key === "done" || key === "cancelled"
            ? sortTerminalTasks(cards, direction)
            : cards;
          const timeLabel = key === "done" ? "完成时间" : "取消时间";
          const nextDirection = direction === "desc" ? "正序" : "倒序";
          const sortButton = key === "done" || key === "cancelled"
            ? '<button class="column-sort '+(direction ? 'active' : '')+'" type="button" data-task-sort="'+key+'" aria-label="按'+timeLabel+nextDirection+'排列" title="按'+timeLabel+nextDirection+'排列"><span aria-hidden="true">'+(direction === "desc" ? "↓" : direction === "asc" ? "↑" : "⇅")+'</span></button>'
            : '';
          return '<section class="column" data-column="'+key+'"><div class="column-head"><span class="column-title"><i></i>'+columnLabel+sortButton+'</span><b>'+cards.length+'</b></div><div class="column-body">'+
            (visibleCards.length ? visibleCards.map(taskCard).join("") : '<div class="column-empty">暂无任务</div>')+
          '</div></section>';
        }).join("")+'</div></div>';

      document.getElementById("mobile-projects").onclick = () => document.body.classList.add("nav-open");
      host.querySelectorAll("[data-project-action]").forEach(button => {
        button.onclick = async () => {
          if (button.dataset.projectAction === "archive") {
            openProjectArchiveDialog(project, button);
            return;
          }
          const status = document.getElementById("project-action-status");
          status.textContent = "";
          try {
            await command("project.control", { projectId: project.id, action: button.dataset.projectAction });
            await refreshSelectedProject(project.id);
          } catch (error) {
            status.textContent = error.message;
            button.focus();
          }
        };
      });
      host.querySelectorAll("[data-task]").forEach(button => {
        button.onclick = () => { void openTask(button.dataset.task); };
      });
      host.querySelectorAll("[data-task-sort]").forEach(button => {
        button.onclick = () => {
          const column = button.dataset.taskSort;
          terminalTaskSort[column] = terminalTaskSort[column] === "desc" ? "asc" : "desc";
          const viewState = captureViewState();
          renderWorkspace();
          restoreViewState(viewState);
        };
      });
    }

    function taskCard(task) {
      const copy = task.status === "cancelled" ? task.cancellation.reason : task.description;
      const alert = ["waiting_for_input", "blocked"].includes(task.status) ? "task-alert" : "";
      const visibleStatus = ["retry_scheduled", "waiting_for_resume"].includes(task.executionStatus) ? task.executionStatus : task.status;
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
            '<label class="setting-field"><span><b>备用模型</b><small>默认模型容量重试三次后切换到这里；冷却后会在下一次自然 turn 探测默认模型。</small></span><select name="fallback">'+options(settings.models.fallback)+'</select></label>'+
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
      if (!productDetail || !projectSettings) return;
      const { project, productDocument, attention, tasks } = productDetail;
      const { settings: scopedModels, globalModels, availableModels } = projectSettings;
      const inheritsGlobalModels = scopedModels.source === "global";
      const selectedModels = scopedModels.modelConfig || scopedModels.effectiveModels;
      const modelOptions = selected => availableModels.map(model =>
        '<option value="'+escapeHtml(model.id)+'" '+(model.id === selected ? 'selected' : '')+'>'+escapeHtml(model.displayName)+'</option>'
      ).join("");
      const cancellationReason = project.status === "cancelled" ? project.cancellation.reason : null;
      const archiveNotice = project.archivedAt
        ? '<section class="product-panel archive-notice"><div><span>已归档</span><h2>本地资料完整保留</h2><p>项目已从默认列表隐藏，PROJECT.md、任务、活动记录、执行证据和 Codex 对话引用仍保留。恢复后调度继续保持暂停。</p></div><time>'+escapeHtml(formatTime(project.archivedAt))+'</time></section>'
        : '';
      const workflowNotice = cancellationReason
        ? '<section id="planning" class="product-panel planning-panel cancellation"><div class="panel-heading"><span>取消理由</span><b>'+escapeHtml(label(project.cancellation.decisionBasis))+'</b></div><p>'+escapeHtml(cancellationReason)+'</p><div class="cancellation-meta">'+escapeHtml(label(project.cancellation.cancelledBy))+' · '+escapeHtml(formatTime(project.cancellation.cancelledAt))+'</div></section>'
        : attention
        ? '<section id="attention" class="product-panel planning-panel '+escapeHtml(attention.kind)+'"><div class="panel-heading"><span>'+escapeHtml(attention.kind === "decision_requested" ? "请求决定" : "项目阻塞")+'</span><b>'+escapeHtml(formatTime(attention.occurredAt))+'</b></div><p>'+escapeHtml(attention.summary)+'</p>'+(attention.question ? '<div class="decision-question">'+escapeHtml(attention.question)+'</div>' : '')+'</section>'
        : '';
      const notice = archiveNotice+workflowNotice;
      const projectControls = project.archivedAt
        ? '<button class="action-button" type="button" data-product-unarchive>恢复项目</button>'
        : '<button class="action-button danger" type="button" data-product-archive>归档项目</button>';
      const productFactsLabel = project.productFacts.status === "current"
        ? "已同步 · v"+project.productFacts.revision
        : "磁盘有未记录修改 · v"+project.productFacts.revision;
      host.innerHTML =
        '<div class="page-screen product-screen">'+
          '<header class="page-hero product-hero"><a class="eyebrow-link" href="/">← 返回看板</a><div class="page-kicker">Product dossier</div><div class="product-hero-row"><div><div class="project-meta"><span class="status-pill">'+escapeHtml(label(project.displayStatus))+'</span><span>'+escapeHtml(label(project.scheduling))+'</span></div><h1>产品详情 · '+escapeHtml(project.name)+'</h1></div><div class="product-hero-actions">'+projectControls+'<a class="action-button" href="/settings">运行设置</a></div></div><p>'+escapeHtml(project.repositoryPath)+' · '+escapeHtml(project.defaultBranch)+'</p></header>'+
          '<div class="product-grid">'+
            '<div class="product-main">'+notice+
              '<section class="product-panel"><div class="panel-heading"><span>产品文档 · PROJECT.md</span><b>'+escapeHtml(productFactsLabel)+'</b></div><article class="markdown-body">'+renderMarkdown(productDocument)+'</article></section>'+
              '<section class="product-panel"><div class="panel-heading"><span>任务清单</span><b>'+tasks.length+'</b></div><div class="product-task-list">'+tasks.map(productTask).join("")+'</div></section>'+
            '</div>'+
            '<aside class="product-rail">'+
              '<section class="product-panel compact project-model-panel"><div class="panel-heading"><span>项目模型</span><b>'+escapeHtml(inheritsGlobalModels ? "继承全局" : "项目专用")+'</b></div>'+
                '<form id="project-model-form" class="project-model-form">'+
                  '<label class="project-model-inherit"><input name="inheritGlobal" type="checkbox" '+(inheritsGlobalModels ? 'checked' : '')+'><span><b>继承全局设置</b><small>'+escapeHtml(globalModels.primary)+' / '+escapeHtml(globalModels.fallback)+'</small></span></label>'+
                  '<label class="project-model-field"><span>默认模型</span><select name="primary" '+(inheritsGlobalModels ? 'disabled' : '')+'>'+modelOptions(selectedModels.primary)+'</select></label>'+
                  '<label class="project-model-field"><span>备用模型</span><select name="fallback" '+(inheritsGlobalModels ? 'disabled' : '')+'>'+modelOptions(selectedModels.fallback)+'</select></label>'+
                  '<div class="project-model-actions"><button class="primary-button" type="submit">保存模型</button><span id="project-model-status" role="status"></span></div>'+
                '</form></section>'+
              '<section class="product-panel compact"><div class="panel-heading"><span>注册信息</span></div><dl class="detail-meta"><dt>项目 ID</dt><dd>'+escapeHtml(project.id)+'</dd><dt>仓库</dt><dd>'+escapeHtml(project.repositoryPath)+'</dd><dt>默认分支</dt><dd>'+escapeHtml(project.defaultBranch)+'</dd>'+(project.archivedAt ? '<dt>归档时间</dt><dd>'+escapeHtml(formatTime(project.archivedAt))+'</dd>' : '')+'<dt>注册时间</dt><dd>'+escapeHtml(formatTime(project.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(project.updatedAt))+'</dd></dl></section>'+
            '</aside>'+
          '</div>'+
        '</div>';

      const projectModelForm = document.getElementById("project-model-form");
      host.querySelector("[data-product-archive]")?.addEventListener("click", event => {
        openProjectArchiveDialog(project, event.currentTarget);
      });
      host.querySelector("[data-product-unarchive]")?.addEventListener("click", event => {
        void restoreArchivedProject(project.id, event.currentTarget);
      });
      const inheritGlobal = projectModelForm.elements.inheritGlobal;
      const modelSelects = [projectModelForm.elements.primary, projectModelForm.elements.fallback];
      inheritGlobal.onchange = () => {
        for (const select of modelSelects) select.disabled = inheritGlobal.checked;
      };
      projectModelForm.onsubmit = async event => {
        event.preventDefault();
        const status = document.getElementById("project-model-status");
        status.textContent = "正在保存...";
        try {
          const modelConfig = inheritGlobal.checked
            ? null
            : {
                primary: String(projectModelForm.elements.primary.value),
                fallback: String(projectModelForm.elements.fallback.value)
              };
          projectSettings = await command("project.update_settings", {
            projectId: project.id,
            modelConfig
          });
          renderProductDetail();
          document.getElementById("project-model-status").textContent = "已应用到后续执行。";
        } catch (error) {
          status.textContent = error.message;
        }
      };
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
      const hadSelectedTask = Boolean(selectedTaskId);
      selectedTaskId = null;
      taskDetail = null;
      currentActivity = null;
      taskReadRevision += 1;
      if (hadSelectedTask) void syncCurrentWatches();
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
      const cancellation = task.status === "cancelled" && task.cancellation
        ? '<div class="cancellation-card"><b>取消理由</b><p>'+escapeHtml(task.cancellation.reason)+'</p><small>'+escapeHtml(label(task.cancellation.decisionBasis))+' · '+escapeHtml(label(task.cancellation.cancelledBy))+' · '+escapeHtml(formatTime(task.cancellation.cancelledAt))+'</small></div>'
        : task.status === "cancelled"
        ? '<div class="cancellation-card"><b>任务已取消</b><p>此任务来自旧版本，未保存结构化取消理由。</p><small>'+escapeHtml(formatTime(task.updatedAt))+'</small></div>'
        : '';
      const scheduledResume = task.currentExecution?.scheduledResume
        ? '<section class="scheduled-resume-card"><div><b>计划恢复</b><p>'+escapeHtml(task.currentExecution.scheduledResume.reason)+'</p><time>'+escapeHtml(formatTime(task.currentExecution.scheduledResume.resumeAt))+'</time></div><div class="scheduled-resume-actions"><button class="action-button" type="button" data-continue-now>提前继续</button><label>重新安排<input type="datetime-local" data-reschedule-at></label><button class="action-button" type="button" data-reschedule>保存时间</button></div></section>'
        : '';
      const currentConversation = task.currentExecution
        ? '<section class="current-conversation">'+
            '<div class="current-conversation-copy"><span>当前对话</span><div><b>'+escapeHtml(label(task.currentExecution.action))+'</b><i aria-hidden="true">·</i><strong>'+escapeHtml(label(task.currentExecution.status))+'</strong></div></div>'+
            (task.currentExecution.threadId ? '<a class="detail-link primary" href="codex://threads/'+escapeHtml(task.currentExecution.threadId)+'">'+(task.currentExecution.status === "waiting_for_input" ? "前往当前对话回复" : "打开当前对话")+' <span>↗</span></a>' : '')+
            '<div id="current-execution-activity" class="current-execution-activity" role="status" aria-live="polite" aria-atomic="true"></div>'+
          '</section>'
        : '';
      const activityTimeline = activities.length
        ? '<ol class="activity-timeline">'+activities.map((activity, index, all) => activityCard(activity, index, all, currentDecisionRequest?.id)).join("")+'</ol>'
        : '<div class="activity-empty"><b>尚无进展记录</b><span>节点完成汇报后会按时间出现在这里。</span></div>';
      const controls = [
        task.status === "blocked" && !task.currentExecution?.scheduledResume ? '<button class="action-button" data-retry>重试</button>' : ''
      ].filter(Boolean).join("");
      host.innerHTML =
        '<header class="detail-head"><strong>任务详情</strong><button id="close-detail" class="icon-button" type="button" aria-label="关闭任务详情">×</button></header>'+
        '<div class="detail-body">'+
          '<div class="detail-status"><span></span>'+escapeHtml(label(task.status))+'</div>'+
          '<div class="task-id-row"><code title="'+escapeHtml(task.id)+'">'+escapeHtml(task.id)+'</code><button class="copy-id-button" type="button" data-copy-task-id aria-label="复制任务 ID" aria-live="polite">复制 ID</button></div>'+
          '<h2>'+escapeHtml(task.title)+'</h2><p class="detail-description">'+escapeHtml(task.description)+'</p>'+
          (controls ? '<div class="detail-actions">'+controls+'</div>' : '')+cancellation+scheduledResume+currentConversation+
          '<section class="detail-section"><h3>验收标准 <span>'+task.acceptanceCriteria.length+'</span></h3>'+criteria+'</section>'+
          '<section class="detail-section activity-section"><h3>进展记录 <span>'+activities.length+'</span></h3>'+activityTimeline+'</section>'+
          '<section class="detail-section"><h3>执行信息</h3><dl class="detail-meta"><dt>当前阶段</dt><dd>'+escapeHtml(label(task.executionStatus === "retry_scheduled" ? task.executionStatus : task.requestedAction || task.status))+'</dd>'+
            (task.modelRouting ? '<dt>当前模型</dt><dd>'+escapeHtml(task.modelRouting.model)+' · '+escapeHtml(label(task.modelRouting.route))+'</dd>'+(task.modelRouting.circuitBreaker ? '<dt>主模型熔断</dt><dd>'+escapeHtml(label(task.modelRouting.circuitBreaker.state))+(task.modelRouting.circuitBreaker.primaryProbeAt ? ' · '+escapeHtml(formatTime(task.modelRouting.circuitBreaker.primaryProbeAt)) : '')+'</dd>' : '')+'<dt>容量重试</dt><dd>'+task.modelRouting.retryCount+(task.modelRouting.nextRetryAt ? ' · '+escapeHtml(formatTime(task.modelRouting.nextRetryAt)) : '')+'</dd>' : '')+
            '<dt>审查次数</dt><dd>'+task.reviewCount+'</dd><dt>创建时间</dt><dd>'+escapeHtml(formatTime(task.createdAt))+'</dd><dt>更新时间</dt><dd>'+escapeHtml(formatTime(task.updatedAt))+'</dd></dl></section>'+
        '</div>';
      host.querySelector("[data-latest-activity]")?.scrollIntoView({ block: "end", inline: "nearest" });
      renderCurrentActivity();
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
        await refreshCurrentTaskAndProject();
      });
      host.querySelector("[data-continue-now]")?.addEventListener("click", async () => {
        await command("task.control", { taskId: task.id, action: "continue" });
        await refreshCurrentTaskAndProject();
      });
      host.querySelector("[data-reschedule]")?.addEventListener("click", async () => {
        const localValue = host.querySelector("[data-reschedule-at]").value;
        if (!localValue) return;
        await command("task.control", {
          taskId: task.id,
          action: "reschedule",
          resumeAt: new Date(localValue).toISOString()
        });
        await refreshCurrentTaskAndProject();
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
        ? '<div class="activity-question '+(isCurrentDecision ? "current" : "historical")+'"><b>'+(isCurrentDecision ? "当前需要决定" : "历史决定请求")+'</b><p>'+escapeHtml(evidence.question)+'</p>'+(isCurrentDecision && activity.threadId ? '<a class="detail-link primary" href="codex://threads/'+escapeHtml(activity.threadId)+'">前往对应对话回复 <span>↗</span></a>' : '<small>'+(isCurrentDecision ? "当前执行未关联 Codex 对话。" : "此问题保留为历史活动。")+'</small>')+'</div>'
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
        ? '<a class="activity-conversation-link" data-activity-thread href="codex://threads/'+escapeHtml(activity.threadId)+'">打开对话 <span>↗</span></a>'
        : '';
      return '<li class="activity-item '+escapeHtml(activity.type)+'" '+(index === all.length - 1 ? 'data-latest-activity' : '')+'><span class="activity-node"></span><article class="activity-card"><header><b>'+escapeHtml(label(activity.type))+'</b><div class="activity-card-actions">'+conversation+'<time>'+escapeHtml(formatTime(activity.occurredAt))+'</time></div></header><p class="activity-summary">'+escapeHtml(activity.summary)+'</p>'+(hasEvidence ? '<div class="activity-evidence">'+question+findings+tests+git+'</div>' : '')+'</article></li>';
    }

    function setCurrentActivity(taskId, activity) {
      if (taskId !== selectedTaskId) return;
      currentActivity = activityMatchesCurrentExecution(activity) ? activity : null;
      renderCurrentActivity();
    }

    function activityMatchesCurrentExecution(activity) {
      const task = taskDetail?.task;
      const execution = task?.currentExecution;
      if (!activity) return false;
      if (!task || !execution) return taskDetail === null && activity.taskId === selectedTaskId;
      return activity.projectId === task.projectId &&
        activity.taskId === task.id &&
        activity.action === execution.action &&
        activity.attemptId === execution.attemptId &&
        activity.threadId === execution.threadId &&
        activity.turnId === execution.turnId;
    }

    function renderCurrentActivity() {
      const activity = activityMatchesCurrentExecution(currentActivity)
        ? currentActivity
        : null;
      const key = activity
        ? [activity.attemptId, activity.turnId, activity.occurredAt, activity.category].join(":")
        : "waiting";
      renderActivityEntry({
        key,
        label: activity?.label ?? "等待下一条活动信号",
        ...(activity ? { occurredAt: activity.occurredAt } : {}),
        waiting: !activity
      });
    }

    function closeDetail() {
      const viewState = captureViewState();
      selectedTaskId = null;
      taskDetail = null;
      currentActivity = null;
      taskReadRevision += 1;
      void syncCurrentWatches();
      document.body.classList.remove("detail-open");
      render();
      restoreViewState(viewState);
    }

    document.getElementById("update-trigger").onclick = openUpdateDialog;
    document.getElementById("project-archive-confirm").onclick = () => { void confirmProjectArchive(); };
    document.getElementById("project-archive-cancel").onclick = closeProjectArchiveDialog;
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
      const archiveDialog = document.getElementById("project-archive-dialog");
      if (event.key === "Tab" && !archiveDialog.hidden) {
        const focusable = Array.from(archiveDialog.querySelectorAll("button:not([disabled])"));
        if (!focusable.length) return;
        const currentIndex = focusable.indexOf(document.activeElement);
        const target = event.shiftKey
          ? currentIndex <= 0 ? focusable.at(-1) : null
          : currentIndex < 0 || currentIndex === focusable.length - 1 ? focusable[0] : null;
        if (target) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (!archiveDialog.hidden) closeProjectArchiveDialog();
      else if (selectedTaskId) closeDetail();
      else if (document.body.classList.contains("nav-open")) document.body.classList.remove("nav-open");
      else if (!document.getElementById("update-dialog").hidden) closeUpdateDialog();
    });
    socket.on("project:changed", event => {
      if (event.projectId === selectedProjectId) void refreshSelectedProject(event.projectId);
    });
    socket.on("projects:changed", () => {
      void refreshProjectLists().catch(showOffline);
    });
    socket.on("task:changed", event => {
      if (event.taskId === selectedTaskId) void refreshSelectedTask(event.taskId);
    });
    socket.on("task:activity", event => {
      setCurrentActivity(event.taskId, event.activity);
    });
    socket.on("system:changed", () => { void refreshSystem(); });
    socket.on("disconnect", () => {
      currentActivity = null;
      renderCurrentActivity();
      showOffline();
    });
    socket.on("connect_error", showOffline);
    socket.on("connect", () => {
      realtimeWatches.reset();
      void (async () => {
        try {
          await syncCurrentWatches();
          await refreshRealtimeScopes();
          document.getElementById("offline").style.display = "none";
        } catch {
          showOffline();
        }
      })();
    });

    void (async () => {
      await Promise.all([refreshSystem(), refresh()]);
      socket.connect();
    })();
  </script>`;
}
