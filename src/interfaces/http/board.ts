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
      <section class="archived-projects">
        <button id="archived-projects-trigger" class="archived-projects-trigger" type="button" aria-expanded="false" aria-controls="archived-projects-panel">
          <span><b>已归档</b><small>可恢复并保留本地数据</small></span><strong id="archived-project-count">0</strong>
        </button>
        <div id="archived-projects-panel" class="archived-projects-panel" hidden>
          <nav id="archived-project-list" aria-label="已归档项目"></nav>
          <p id="archived-projects-status" class="archived-projects-status" role="status" aria-live="polite"></p>
        </div>
      </section>
      <div class="sidebar-footer">
        <a class="sidebar-settings" href="/settings">
          <span>⚙</span><span>运行设置<small>并发与模型路由</small></span>
        </a>
        <button id="update-trigger" class="update-trigger" type="button" aria-haspopup="dialog">
          <span id="update-trigger-icon" class="update-icon" aria-hidden="true">↑</span>
          <span>Codrive 更新<small id="update-trigger-copy">正在读取本机状态</small></span>
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

  <div id="project-archive-dialog" class="archive-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-archive-title" hidden>
    <section class="archive-panel" tabindex="-1">
      <div class="archive-symbol" aria-hidden="true">A</div>
      <div>
        <div class="archive-kicker">LOCAL PROJECT VAULT</div>
        <h2 id="project-archive-title">归档项目</h2>
        <p id="project-archive-copy">归档会暂停后续调度并从默认列表隐藏项目。PROJECT.md、任务、活动记录和 Codex 对话引用都会保留在本机。</p>
        <p id="project-archive-status" class="archive-status" role="status" aria-live="polite"></p>
        <div class="archive-actions">
          <button id="project-archive-confirm" class="primary-button" type="button">确认归档</button>
          <button id="project-archive-cancel" class="quiet-button" type="button">返回</button>
        </div>
      </div>
    </section>
  </div>

  <div id="update-dialog" class="update-backdrop" role="dialog" aria-modal="true" aria-labelledby="update-title" hidden>
    <section class="update-panel" tabindex="-1">
      <header class="update-head">
        <div><div class="update-kicker">LOCAL RELEASE CONTROL</div><h2 id="update-title">Codrive 更新</h2></div>
        <button id="update-close" class="icon-button" type="button" aria-label="关闭 Codrive 更新">×</button>
      </header>
      <p id="update-summary" class="update-summary">正在读取当前版本与托管资源。</p>
      <div class="version-ledger" aria-label="版本状态">
        <div><span>当前运行</span><strong id="update-current-version">—</strong></div>
        <div><span>最新稳定版</span><strong id="update-latest-version">—</strong></div>
        <div><span>托管 Skills</span><strong id="update-skills">—</strong></div>
        <div><span>Codex Hook</span><strong id="update-hook">—</strong></div>
      </div>
      <div id="update-progress" class="update-progress" hidden>
        <div class="update-progress-track"><span id="update-progress-bar"></span></div>
        <div class="update-progress-meta"><b id="update-phase">准备更新</b><time id="update-phase-time">—</time></div>
      </div>
      <div id="update-timeline" class="update-timeline" aria-label="更新阶段时间" hidden></div>
      <div id="update-hook-trust" class="update-hook-trust" hidden></div>
      <div id="update-conflict" class="update-conflict" hidden></div>
      <dl class="update-meta">
        <dt>最后检查</dt><dd id="update-checked-at">—</dd>
        <dt>检查结果</dt><dd id="update-check-result">尚未检查</dd>
      </dl>
      <div class="update-actions">
        <button id="update-primary" class="primary-button" type="button" disabled>正在读取</button>
        <button id="update-check" class="quiet-button" type="button">重新检查</button>
      </div>
      <p id="update-status" class="update-status" role="status" aria-live="polite"></p>
      <div id="update-fallback" class="update-fallback" hidden>也可以在终端运行 <code>codrive upgrade</code><button id="update-copy-command" class="copy-id-button" type="button">复制命令</button></div>
    </section>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  ${renderBoardClient(accessToken)}
</body>
</html>`;
}
