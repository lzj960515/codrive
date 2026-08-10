import { renderBoardClient } from "./board-client.js";
import { boardStyles } from "./board-styles.js";

export function renderBoardPage(accessToken: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Codrive - 产品工作台</title>
  <style>${boardStyles}</style>
</head>
<body>
  <div id="app-shell" class="app-shell">
    <aside id="project-sidebar" class="project-sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><span>C</span></div>
        <div><strong>Codrive</strong><small>产品工作台</small></div>
      </div>
      <div class="local-status"><span></span> 运行中</div>
      <div class="sidebar-heading"><span>项目</span><span id="project-count">0</span></div>
      <nav id="projects" class="project-list" aria-label="Codrive 项目"></nav>
      <div class="sidebar-footer">
        <a class="sidebar-settings" href="/settings">
          <span>⚙</span><span>运行设置<small>并发与模型路由</small></span>
        </a>
        <button id="setup-trigger" class="setup-trigger" type="button" hidden>
          <span class="setup-icon">↻</span>
          <span>连接 Codex<small id="setup-trigger-copy">完成一次设置即可使用</small></span>
        </button>
        <div class="local-note">数据保存在本机</div>
      </div>
    </aside>

    <main class="workspace">
      <div id="offline" class="offline">正在重新连接本机服务...</div>
      <section id="project" class="project-workspace"></section>
    </main>

    <aside id="task-detail" class="task-detail" aria-hidden="true" aria-label="任务详情">
      <div id="task-detail-content" class="task-detail-content"></div>
    </aside>
  </div>

  <button id="nav-backdrop" class="nav-backdrop" type="button" aria-label="关闭项目列表"></button>

  <div id="setup-dialog" class="setup-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-title" hidden>
    <section class="setup-panel">
      <div class="setup-kicker">首次设置</div>
      <h2 id="setup-title">让 Codex 连接到 Codrive</h2>
      <p id="setup-copy">完成一次本机设置后，就可以在 Codex 中用自然语言创建和推进项目。</p>
      <div class="setup-steps" aria-label="设置步骤">
        <div><b>01</b><span>连接 Codex</span></div>
        <div><b>02</b><span>直接说出想法</span></div>
        <div><b>03</b><span>自动推进任务</span></div>
      </div>
      <div class="setup-actions">
        <button id="setup-install" class="primary-button" type="button">立即设置</button>
        <button id="setup-later" class="quiet-button" type="button">稍后</button>
      </div>
      <p id="setup-status" class="setup-status" role="status"></p>
    </section>
  </div>

  ${renderBoardClient(accessToken)}
</body>
</html>`;
}
