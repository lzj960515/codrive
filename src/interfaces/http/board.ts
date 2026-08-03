export function renderBoardPage(accessToken: string): string {
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codrive — Local Mission Control</title>
  <style>
    :root {
      --paper: #f2ecdf;
      --paper-raised: #fffaf0;
      --ink: #17211d;
      --muted: #667068;
      --line: #b9b09f;
      --signal: #ed5b2a;
      --signal-soft: #ffd8bd;
      --moss: #2d5b46;
      --sun: #f2b53d;
      --shadow: 5px 6px 0 rgba(23, 33, 29, .16);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", serif;
      background:
        linear-gradient(rgba(23,33,29,.055) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23,33,29,.055) 1px, transparent 1px),
        radial-gradient(circle at 80% 5%, rgba(242,181,61,.28), transparent 27%),
        var(--paper);
      background-size: 24px 24px, 24px 24px, 100% 100%, auto;
    }
    button, a { font: inherit; }
    .shell { width: min(1680px, 100%); margin: 0 auto; padding: 30px 28px 60px; }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 28px;
      align-items: end;
      padding: 18px 0 24px;
      border-bottom: 3px solid var(--ink);
    }
    .eyebrow, .meta, .column-title, .status, button {
      font-family: "Avenir Next Condensed", "Futura", sans-serif;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-weight: 700;
    }
    .eyebrow { color: var(--signal); font-size: 12px; }
    h1 { margin: 2px 0 0; font-size: clamp(44px, 8vw, 104px); line-height: .82; letter-spacing: -.055em; }
    .clock { text-align: right; }
    .clock strong { display: block; font-size: 28px; }
    .clock span { color: var(--muted); }
    .project-strip { display: flex; gap: 12px; padding: 20px 0; overflow-x: auto; }
    .project-tab {
      min-width: 230px;
      padding: 14px 16px;
      border: 1px solid var(--ink);
      background: rgba(255,250,240,.62);
      cursor: pointer;
      text-align: left;
      box-shadow: 3px 3px 0 rgba(23,33,29,.12);
    }
    .project-tab.active { background: var(--ink); color: var(--paper-raised); transform: translate(-2px,-2px); }
    .project-tab b { display:block; font-size: 18px; }
    .project-tab small { opacity: .68; }
    .project-head { display:flex; justify-content:space-between; gap:20px; align-items:center; margin: 12px 0 18px; }
    .project-head h2 { font-size: clamp(28px, 4vw, 52px); margin: 0; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    button {
      border: 1px solid var(--ink);
      padding: 9px 12px;
      color: var(--ink);
      background: var(--paper-raised);
      cursor: pointer;
      font-size: 11px;
    }
    button:hover { background: var(--signal-soft); transform: translateY(-2px); }
    .board { display:grid; grid-template-columns: repeat(6, minmax(250px, 1fr)); gap: 14px; overflow-x:auto; padding: 4px 4px 24px; }
    .column { min-height: 360px; border-top: 7px solid var(--ink); padding-top: 10px; }
    .column:nth-child(3) { border-color: var(--signal); }
    .column:nth-child(4) { border-color: var(--sun); }
    .column:nth-child(5) { border-color: var(--moss); }
    .column-title { display:flex; justify-content:space-between; margin-bottom: 12px; font-size: 12px; }
    .card {
      position: relative;
      margin-bottom: 13px;
      padding: 16px;
      border: 1px solid var(--ink);
      background: var(--paper-raised);
      box-shadow: var(--shadow);
      animation: arrive .38s both;
    }
    .card::before { content:""; position:absolute; left:-1px; top:-1px; bottom:-1px; width:5px; background:var(--signal); }
    .card h3 { margin: 6px 0 12px; font-size: 21px; line-height: 1.05; }
    .status { color:var(--muted); font-size:10px; }
    .card p { margin: 0 0 13px; color:#3f4942; font-size:14px; line-height:1.45; }
    .card-footer { border-top:1px dashed var(--line); padding-top:10px; display:flex; flex-wrap:wrap; gap:7px; }
    .card-footer a { color:var(--moss); font-weight:700; text-decoration-thickness:2px; }
    .empty { padding:20px 10px; color:var(--muted); font-style:italic; border:1px dashed var(--line); }
    .offline { display:none; background:var(--signal); color:white; padding:8px 12px; font-weight:700; }
    .setup-trigger {
      position: fixed;
      z-index: 20;
      left: 20px;
      bottom: 20px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: center;
      max-width: min(330px, calc(100vw - 40px));
      padding: 12px 15px;
      color: var(--paper-raised);
      background: var(--ink);
      border: 1px solid var(--ink);
      box-shadow: 4px 5px 0 rgba(237,91,42,.38);
      text-align: left;
    }
    .setup-trigger::before {
      content: "!";
      display: grid;
      width: 25px;
      height: 25px;
      place-items: center;
      color: var(--ink);
      background: var(--sun);
      border-radius: 50%;
      font-size: 14px;
    }
    .setup-trigger small { display: block; margin-top: 2px; opacity: .7; letter-spacing: .04em; text-transform: none; }
    .setup-backdrop {
      position: fixed;
      z-index: 30;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(23,33,29,.68);
      backdrop-filter: blur(5px);
    }
    .setup-panel {
      position: relative;
      width: min(760px, 100%);
      padding: clamp(26px, 5vw, 58px);
      overflow: hidden;
      border: 2px solid var(--ink);
      background:
        linear-gradient(135deg, transparent 76%, rgba(242,181,61,.32) 76%),
        var(--paper-raised);
      box-shadow: 12px 14px 0 rgba(0,0,0,.28);
      animation: setup-arrive .32s both;
    }
    .setup-panel::before {
      content: "01";
      position: absolute;
      top: -24px;
      right: 18px;
      color: rgba(23,33,29,.08);
      font-family: "Avenir Next Condensed", "Futura", sans-serif;
      font-size: 150px;
      font-weight: 900;
      line-height: 1;
    }
    .setup-panel h2 { position: relative; max-width: 600px; margin: 7px 0 14px; font-size: clamp(36px, 7vw, 66px); line-height: .92; letter-spacing: -.045em; }
    .setup-intro { position: relative; max-width: 590px; color: #3f4942; font-size: 17px; line-height: 1.55; }
    .setup-grid { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin: 28px 0; background: var(--line); border: 1px solid var(--line); }
    .setup-step { min-height: 116px; padding: 17px; background: var(--paper-raised); }
    .setup-step b { display: block; margin-bottom: 8px; color: var(--signal); font-family: "Avenir Next Condensed", "Futura", sans-serif; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
    .setup-step span { color: var(--ink); font-size: 15px; line-height: 1.35; }
    .setup-actions { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .setup-actions .primary { color: white; background: var(--signal); border-color: var(--signal); }
    .setup-actions button:disabled { cursor: wait; opacity: .55; transform: none; }
    .setup-status { min-height: 22px; margin: 12px 0 0; color: var(--moss); font-weight: 700; }
    @keyframes arrive { from { opacity:0; transform:translateY(10px) rotate(.4deg); } }
    @keyframes setup-arrive { from { opacity:0; transform:translateY(18px) scale(.985); } }
    @media (max-width: 720px) {
      .shell { padding:18px 14px 40px; }
      header { grid-template-columns:1fr; }
      .clock { text-align:left; display:flex; gap:10px; align-items:baseline; }
      .project-head { align-items:flex-start; flex-direction:column; }
      .board { grid-template-columns: repeat(6, 84vw); }
      .setup-grid { grid-template-columns: 1fr; }
      .setup-step { min-height: auto; }
      .setup-backdrop { align-items: end; padding: 10px; }
      .setup-panel { max-height: calc(100vh - 20px); overflow-y: auto; }
    }
    @media (prefers-reduced-motion: reduce) { .card, .setup-panel { animation:none; } button:hover { transform:none; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div><div class="eyebrow">Local autonomous product operations</div><h1>CODRIVE</h1></div>
      <div class="clock meta"><strong id="clock">--:--</strong><span>mission control / local</span></div>
    </header>
    <div id="offline" class="offline">Codrive is reconnecting…</div>
    <nav id="projects" class="project-strip"></nav>
    <section id="project"></section>
  </main>
  <button id="setup-trigger" class="setup-trigger" type="button" hidden>
    <span>Codrive Skills<small id="setup-trigger-copy">Setup available</small></span>
  </button>
  <div id="setup-dialog" class="setup-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-title" hidden>
    <section class="setup-panel">
      <div class="eyebrow">One-time local setup</div>
      <h2 id="setup-title">Connect Codex to Codrive.</h2>
      <p id="setup-copy" class="setup-intro">Install four local Skills so Codex can create projects, read tasks, report results, and control the workflow.</p>
      <div class="setup-grid" aria-label="Setup steps">
        <div class="setup-step"><b>01 / Install</b><span>Copy the bundled Codrive Skills into your local agent library.</span></div>
        <div class="setup-step"><b>02 / Discover</b><span>Codex App discovers the Skills and can register work from your conversations.</span></div>
        <div class="setup-step"><b>03 / Drive</b><span>Codrive starts separate development and review tasks automatically.</span></div>
      </div>
      <div class="setup-actions">
        <button id="setup-install" class="primary" type="button">Install Skills</button>
        <button id="setup-later" type="button">Later</button>
      </div>
      <p id="setup-status" class="setup-status" role="status"></p>
    </section>
  </div>
  <script>
    const TOKEN = ${token};
    const columns = [
      ["backlog", "Backlog"], ["developing", "Developing"],
      ["reviewing", "Reviewing"], ["integrating", "Integrating"],
      ["waiting", "Waiting"], ["done", "Done"]
    ];
    let snapshots = [];
    let selectedProjectId = null;
    let skillStatus = null;
    const headers = { "x-codrive-token": TOKEN, "content-type": "application/json" };
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
    const bucket = status => ["changes_requested","waiting_for_input","blocked"].includes(status) ? "waiting" : status;
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
      document.getElementById("setup-install").textContent = skillStatus.state === "missing" ? "Install Skills" : "Update Skills";
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
        if (!selectedProjectId || !snapshots.some(s => s.project.id === selectedProjectId)) selectedProjectId = snapshots[0]?.project.id;
        render();
      } catch { document.getElementById("offline").style.display = "block"; }
    }
    function render() {
      const tabs = document.getElementById("projects");
      tabs.innerHTML = snapshots.map(({project,tasks}) =>
        '<button class="project-tab '+(project.id===selectedProjectId?'active':'')+'" data-project="'+escapeHtml(project.id)+'"><b>'+escapeHtml(project.name)+'</b><small>'+escapeHtml(project.status)+' · '+tasks.length+' tasks</small></button>'
      ).join("");
      tabs.querySelectorAll("button").forEach(button => button.onclick = () => { selectedProjectId = button.dataset.project; render(); });
      const snapshot = snapshots.find(({project}) => project.id === selectedProjectId);
      const host = document.getElementById("project");
      if (!snapshot) { host.innerHTML = '<div class="empty">No projects yet. Use $codrive-forge or import a project.</div>'; return; }
      const {project,tasks} = snapshot;
      const terminal = ["completed", "cancelled"].includes(project.status);
      const actions = terminal ? [] : [project.scheduling === "paused" ? '<button data-action="resume">Resume</button>' : '<button data-action="pause">Pause</button>'];
      if (project.status !== "cancelled") actions.push('<button data-action="cancel">Cancel</button>');
      const report = project.question || project.summary;
      const projectReport = report ? '<p>'+escapeHtml(report)+'</p>' : '';
      const appHint = project.status === "waiting_for_input" ? '<p class="meta">Continue in Codex App and use $codrive-control to record the decision.</p>' : '';
      host.innerHTML = '<div class="project-head"><div><div class="eyebrow">'+escapeHtml(project.status)+' · '+escapeHtml(project.scheduling)+'</div><h2>'+escapeHtml(project.name)+'</h2>'+projectReport+appHint+'</div><div class="actions">'+actions.join("")+'</div></div>'+
        '<div class="board">'+columns.map(([key,label]) => {
          const cards = tasks.filter(task => bucket(task.status) === key);
          return '<section class="column"><div class="column-title"><span>'+label+'</span><span>'+cards.length+'</span></div>'+(cards.length ? cards.map(card).join("") : '<div class="empty">clear</div>')+'</section>';
        }).join("")+'</div>';
      host.querySelectorAll("[data-action]").forEach(button => button.onclick = async () => { await command('project.control', {projectId:project.id, action:button.dataset.action}); await refresh(); });
      host.querySelectorAll("[data-retry]").forEach(button => button.onclick = async () => { await command('task.control', {taskId:button.dataset.retry, action:'retry'}); await refresh(); });
      host.querySelectorAll("[data-cancel-task]").forEach(button => button.onclick = async () => {
        if (!window.confirm("Cancel this task?")) return;
        await command('task.control', {taskId:button.dataset.cancelTask, action:'cancel'});
        await refresh();
      });
    }
    function card(task) {
      const links = [];
      if (task.developmentThreadId) links.push('<a href="codex://threads/'+escapeHtml(task.developmentThreadId)+'">development</a>');
      if (task.reviewThreadId) links.push('<a href="codex://threads/'+escapeHtml(task.reviewThreadId)+'">review</a>');
      if (task.status === "blocked") links.push('<button data-retry="'+escapeHtml(task.id)+'">Retry</button>');
      if (!["done","cancelled"].includes(task.status)) links.push('<button data-cancel-task="'+escapeHtml(task.id)+'">Cancel</button>');
      const report = task.question || task.summary || task.description;
      const appHint = task.status === "waiting_for_input" ? '<p class="meta">Reply in the linked Codex task.</p>' : '';
      return '<article class="card"><div class="status">'+escapeHtml(task.status)+(task.requestedAction?' / '+escapeHtml(task.requestedAction):'')+'</div><h3>'+escapeHtml(task.title)+'</h3><p>'+escapeHtml(report)+'</p>'+appHint+'<div class="card-footer">'+(links.join("") || '<span class="meta">queued</span>')+'</div></article>';
    }
    document.getElementById("setup-install").onclick = installSkills;
    document.getElementById("setup-later").onclick = () => {
      localStorage.setItem("codrive:skills-dismissed", skillStatus.bundledVersion);
      document.getElementById("setup-dialog").hidden = true;
      document.getElementById("setup-trigger").hidden = false;
    };
    document.getElementById("setup-trigger").onclick = () => {
      document.getElementById("setup-dialog").hidden = false;
    };
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && skillStatus?.state !== "current") {
        document.getElementById("setup-later").click();
      }
    });
    setInterval(() => document.getElementById("clock").textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), 1000);
    const events = new EventSource('/api/events?token='+encodeURIComponent(TOKEN));
    events.onmessage = refresh; events.onerror = () => document.getElementById("offline").style.display = "block";
    refreshSetup();
    refresh();
  </script>
</body>
</html>`;
}
