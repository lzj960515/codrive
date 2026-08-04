import { renderBoardClient } from "./board-client.js";
import { boardStyles } from "./board-styles.js";

export function renderBoardPage(accessToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Codrive — Product Workbench</title>
  <style>${boardStyles}</style>
</head>
<body>
  <div id="app-shell" class="app-shell">
    <aside id="project-sidebar" class="project-sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><span>C</span></div>
        <div><strong>Codrive</strong><small>Product workbench</small></div>
      </div>
      <div class="local-status"><span></span> Running locally</div>
      <div class="sidebar-heading"><span>Projects</span><span id="project-count">0</span></div>
      <nav id="projects" class="project-list" aria-label="Codrive projects"></nav>
      <div class="sidebar-footer">
        <button id="setup-trigger" class="setup-trigger" type="button" hidden>
          <span class="setup-icon">↻</span>
          <span>Codrive Skills<small id="setup-trigger-copy">Setup available</small></span>
        </button>
        <div class="local-note"><span>LOCAL</span><small>State stays on this Mac</small></div>
      </div>
    </aside>

    <main class="workspace">
      <div id="offline" class="offline">Connection paused — reconnecting to the local service.</div>
      <section id="project" class="project-workspace"></section>
    </main>

    <aside id="task-detail" class="task-detail" aria-hidden="true" aria-label="Task details">
      <div id="task-detail-content" class="task-detail-content"></div>
    </aside>
  </div>

  <button id="nav-backdrop" class="nav-backdrop" type="button" aria-label="Close projects"></button>

  <div id="setup-dialog" class="setup-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-title" hidden>
    <section class="setup-panel">
      <div class="setup-kicker">Local connection</div>
      <h2 id="setup-title">Give Codex the keys to the workbench.</h2>
      <p id="setup-copy">Install four local Skills so Codex can plan products, read tasks, report results, and control the workflow.</p>
      <div class="setup-steps" aria-label="Setup steps">
        <div><b>01</b><span>Install bundled Skills locally</span></div>
        <div><b>02</b><span>Use them from Codex App</span></div>
        <div><b>03</b><span>Watch work move here</span></div>
      </div>
      <div class="setup-actions">
        <button id="setup-install" class="primary-button" type="button">Install Skills</button>
        <button id="setup-later" class="quiet-button" type="button">Later</button>
      </div>
      <p id="setup-status" class="setup-status" role="status"></p>
    </section>
  </div>

  ${renderBoardClient(accessToken)}
</body>
</html>`;
}
