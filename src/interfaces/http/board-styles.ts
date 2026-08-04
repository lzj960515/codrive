export const boardStyles = `
  :root {
    --sidebar: #11231d;
    --sidebar-deep: #091611;
    --canvas: #edf0eb;
    --surface: #ffffff;
    --surface-soft: #f6f7f3;
    --ink: #17201c;
    --muted: #69736e;
    --line: #d9ddd7;
    --line-strong: #c5cbc4;
    --signal: #f45b35;
    --signal-soft: #fff0e9;
    --mint: #70d6b2;
    --sky: #7dcde3;
    --amber: #eabf63;
    --rose: #e88d99;
    --shadow: 0 18px 50px rgba(18, 31, 26, .12);
    --ui: "Avenir Next", "Century Gothic", "Trebuchet MS", sans-serif;
    --condensed: "Avenir Next Condensed", "DIN Condensed", "Franklin Gothic Condensed", sans-serif;
    --display: "Iowan Old Style", "Baskerville", "Times New Roman", serif;
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; min-height: 100%; }
  body {
    overflow: hidden;
    color: var(--ink);
    font-family: var(--ui);
    background: var(--canvas);
  }
  button, a { font: inherit; }
  button { color: inherit; }
  button:focus-visible, a:focus-visible { outline: 3px solid rgba(244, 91, 53, .36); outline-offset: 2px; }

  .app-shell {
    display: grid;
    grid-template-columns: 252px minmax(0, 1fr) 0;
    height: 100dvh;
    overflow: hidden;
    transition: grid-template-columns .32s cubic-bezier(.2,.8,.2,1);
  }
  .detail-open .app-shell { grid-template-columns: 252px minmax(520px, 1fr) 420px; }

  .project-sidebar {
    position: relative;
    z-index: 20;
    display: flex;
    min-width: 0;
    flex-direction: column;
    padding: 22px 16px 16px;
    overflow: hidden;
    color: #f6f4ed;
    background:
      radial-gradient(circle at 18% -10%, rgba(112, 214, 178, .19), transparent 33%),
      linear-gradient(180deg, var(--sidebar), var(--sidebar-deep));
    border-right: 1px solid rgba(255,255,255,.08);
  }
  .project-sidebar::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: .15;
    background-image: linear-gradient(120deg, transparent 0 46%, rgba(255,255,255,.08) 47%, transparent 48%);
    background-size: 42px 42px;
  }
  .brand, .local-status, .sidebar-heading, .project-list, .sidebar-footer { position: relative; z-index: 1; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .brand-mark {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    overflow: hidden;
    color: var(--sidebar-deep);
    background: var(--mint);
    border-radius: 11px 11px 11px 3px;
    transform: rotate(-3deg);
  }
  .brand-mark span { font: 800 23px/1 var(--display); transform: rotate(3deg); }
  .brand strong { display: block; font-size: 17px; letter-spacing: -.02em; }
  .brand small { display: block; margin-top: 2px; color: rgba(255,255,255,.53); font: 700 10px/1.2 var(--condensed); letter-spacing: .11em; text-transform: uppercase; }
  .local-status { display: flex; gap: 7px; align-items: center; margin: 20px 2px 26px; color: rgba(255,255,255,.62); font-size: 11px; }
  .local-status span { width: 7px; height: 7px; background: var(--mint); border-radius: 50%; box-shadow: 0 0 0 4px rgba(112,214,178,.11); }
  .sidebar-heading { display: flex; justify-content: space-between; padding: 0 8px 9px; color: rgba(255,255,255,.42); font: 800 10px/1 var(--condensed); letter-spacing: .14em; text-transform: uppercase; }
  .sidebar-heading span:last-child { color: rgba(255,255,255,.75); }
  .project-list { display: grid; gap: 5px; margin: 0 -4px; padding: 0 4px 30px; overflow-y: auto; }
  .project-list::-webkit-scrollbar { width: 5px; }
  .project-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 10px; }
  .project-button {
    display: grid;
    grid-template-columns: 34px 1fr auto;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 10px;
    color: rgba(255,255,255,.72);
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: background .16s ease, color .16s ease, transform .16s ease;
  }
  .project-button:hover { color: white; background: rgba(255,255,255,.07); transform: translateX(2px); }
  .project-button.active { color: white; background: rgba(255,255,255,.12); box-shadow: inset 3px 0 var(--signal); }
  .project-glyph { display: grid; width: 32px; height: 32px; place-items: center; color: var(--sidebar); background: #dce7de; border-radius: 9px; font: 900 13px/1 var(--condensed); }
  .project-button:nth-child(3n+2) .project-glyph { background: #f4c989; }
  .project-button:nth-child(3n+3) .project-glyph { background: #9ed8e7; }
  .project-label { min-width: 0; }
  .project-label b { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .project-label small { display: block; margin-top: 3px; color: rgba(255,255,255,.44); font: 700 10px/1 var(--condensed); text-transform: capitalize; }
  .project-total { display: grid; min-width: 24px; height: 22px; place-items: center; padding: 0 6px; color: rgba(255,255,255,.6); background: rgba(0,0,0,.18); border-radius: 8px; font-size: 10px; }
  .project-list-empty { padding: 12px 9px; color: rgba(255,255,255,.48); font-size: 12px; line-height: 1.5; }
  .project-list-empty code { color: var(--mint); }
  .sidebar-footer { display: grid; gap: 9px; margin-top: auto; }
  .setup-trigger {
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 9px;
    align-items: center;
    width: 100%;
    padding: 10px;
    color: white;
    background: rgba(244,91,53,.16);
    border: 1px solid rgba(244,91,53,.5);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
  }
  .setup-trigger:hover { background: rgba(244,91,53,.25); }
  .setup-trigger > span:last-child { font-size: 12px; font-weight: 700; }
  .setup-trigger small { display: block; margin-top: 2px; color: rgba(255,255,255,.57); font-size: 9px; font-weight: 500; }
  .setup-icon { display: grid; width: 27px; height: 27px; place-items: center; background: var(--signal); border-radius: 8px; }
  .local-note { display: flex; justify-content: space-between; align-items: center; padding: 9px 10px 0; border-top: 1px solid rgba(255,255,255,.1); }
  .local-note span { color: var(--mint); font: 900 9px/1 var(--condensed); letter-spacing: .14em; }
  .local-note small { color: rgba(255,255,255,.38); font-size: 9px; }

  .workspace {
    min-width: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 86% 0, rgba(125,205,227,.16), transparent 28%),
      linear-gradient(180deg, #f7f8f5 0, var(--canvas) 100%);
  }
  .project-workspace { height: 100%; overflow: hidden; }
  .offline { position: absolute; z-index: 40; top: 10px; left: 50%; display: none; padding: 8px 13px; color: white; background: #a93d30; border-radius: 9px; box-shadow: var(--shadow); font-size: 11px; transform: translateX(-50%); }
  .workspace-header { height: 154px; padding: 24px 28px 18px; background: rgba(255,255,255,.82); border-bottom: 1px solid var(--line); backdrop-filter: blur(14px); }
  .workspace-topline { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
  .project-identity { display: flex; min-width: 0; gap: 13px; align-items: flex-start; }
  .mobile-projects { display: none; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 9px; background: white; cursor: pointer; }
  .project-status-dot { width: 11px; height: 11px; margin-top: 9px; background: var(--mint); border: 3px solid rgba(112,214,178,.25); border-radius: 50%; box-sizing: content-box; }
  .project-title { min-width: 0; }
  .project-title h1 { margin: 0; overflow: hidden; font-size: clamp(25px, 3vw, 36px); line-height: 1.08; letter-spacing: -.04em; text-overflow: ellipsis; white-space: nowrap; }
  .project-title p { margin: 7px 0 0; max-width: 780px; overflow: hidden; color: var(--muted); font-size: 12px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
  .project-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 5px; color: var(--muted); font: 800 10px/1 var(--condensed); letter-spacing: .1em; text-transform: uppercase; }
  .project-meta .status-pill { color: #28725b; background: #dff4eb; }
  .status-pill { display: inline-flex; align-items: center; padding: 5px 7px; border-radius: 7px; font: 800 9px/1 var(--condensed); letter-spacing: .08em; text-transform: uppercase; }
  .project-actions { display: flex; gap: 7px; }
  .action-button, .quiet-button, .primary-button, .detail-link {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    justify-content: center;
    padding: 0 13px;
    border-radius: 9px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    text-decoration: none;
  }
  .action-button, .quiet-button { color: var(--ink); background: white; border: 1px solid var(--line-strong); }
  .action-button:hover, .quiet-button:hover { background: var(--surface-soft); border-color: #afb7af; }
  .action-button.danger:hover { color: #9d3428; background: #fff0ed; border-color: #e9b8af; }
  .primary-button, .detail-link.primary { color: white; background: var(--signal); border: 1px solid var(--signal); }
  .primary-button:hover, .detail-link.primary:hover { background: #da4725; }
  .project-stats { display: flex; gap: 22px; align-items: flex-end; margin: 20px 0 0 24px; }
  .project-stats span { color: var(--muted); font: 800 9px/1 var(--condensed); letter-spacing: .09em; text-transform: uppercase; }
  .project-stats b { margin-right: 5px; color: var(--ink); font: 800 18px/1 var(--ui); letter-spacing: -.03em; }

  .board-wrap { height: calc(100dvh - 154px); overflow: auto; }
  .board {
    display: grid;
    grid-template-columns: repeat(6, minmax(252px, 1fr));
    gap: 12px;
    min-width: 1512px;
    min-height: 100%;
    padding: 18px 20px 34px;
  }
  .column { min-width: 0; animation: column-arrive .42s both; }
  .column:nth-child(2) { animation-delay: .035s; }
  .column:nth-child(3) { animation-delay: .07s; }
  .column:nth-child(4) { animation-delay: .105s; }
  .column:nth-child(5) { animation-delay: .14s; }
  .column:nth-child(6) { animation-delay: .175s; }
  .column-head { display: flex; justify-content: space-between; align-items: center; height: 38px; padding: 0 10px; margin-bottom: 8px; border-radius: 9px; font-size: 11px; font-weight: 800; }
  .column-head span:first-child { display: flex; gap: 7px; align-items: center; }
  .column-head i { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
  .column-head b { display: grid; min-width: 21px; height: 21px; place-items: center; padding: 0 5px; background: rgba(255,255,255,.63); border-radius: 7px; font-size: 9px; }
  .column[data-column="backlog"] .column-head { color: #626b67; background: #e3e6e2; }
  .column[data-column="developing"] .column-head { color: #a94628; background: #fee0d4; }
  .column[data-column="reviewing"] .column-head { color: #267187; background: #d9f1f7; }
  .column[data-column="integrating"] .column-head { color: #28725b; background: #daf0e7; }
  .column[data-column="waiting"] .column-head { color: #8c6325; background: #f8e9c4; }
  .column[data-column="done"] .column-head { color: #59645f; background: #dde5df; }
  .column-body { display: grid; gap: 8px; }
  .task-card {
    position: relative;
    width: 100%;
    padding: 14px 14px 12px;
    overflow: hidden;
    color: var(--ink);
    background: rgba(255,255,255,.9);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 2px 0 rgba(18,31,26,.025);
    cursor: pointer;
    text-align: left;
    transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
  }
  .task-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--line-strong); }
  .task-card:hover { border-color: #abb5ad; box-shadow: 0 10px 28px rgba(18,31,26,.08); transform: translateY(-2px); }
  .task-card.active { border-color: var(--signal); box-shadow: 0 0 0 2px rgba(244,91,53,.12), 0 10px 28px rgba(18,31,26,.08); }
  .task-card[data-status="developing"]::before, .task-card[data-status="changes_requested"]::before { background: var(--signal); }
  .task-card[data-status="reviewing"]::before { background: var(--sky); }
  .task-card[data-status="integrating"]::before, .task-card[data-status="done"]::before { background: var(--mint); }
  .task-card[data-status="waiting_for_input"]::before, .task-card[data-status="blocked"]::before { background: var(--amber); }
  .task-card-top, .task-card-footer { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
  .task-index { color: #929b96; font: 800 9px/1 var(--condensed); letter-spacing: .1em; }
  .task-state { display: inline-flex; gap: 5px; align-items: center; color: var(--muted); font: 800 9px/1 var(--condensed); text-transform: uppercase; }
  .task-state i { width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
  .task-card h3 { margin: 10px 0 7px; font-size: 14px; line-height: 1.28; letter-spacing: -.015em; }
  .task-card p { display: -webkit-box; min-height: 34px; margin: 0 0 14px; overflow: hidden; color: var(--muted); font-size: 11px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .task-card-footer { padding-top: 10px; border-top: 1px solid #edf0ec; color: #858e89; font-size: 9px; }
  .task-action { padding: 4px 6px; color: #41504a; background: #eef1ed; border-radius: 6px; font: 800 8px/1 var(--condensed); letter-spacing: .06em; text-transform: uppercase; }
  .task-alert { color: #a94628; }
  .column-empty { padding: 19px 12px; color: #9aa29e; border: 1px dashed #ccd1cc; border-radius: 11px; font-size: 10px; text-align: center; }

  .empty-workspace { display: grid; height: 100%; place-items: center; padding: 30px; }
  .empty-card { width: min(620px, 100%); padding: 48px; background: rgba(255,255,255,.78); border: 1px solid var(--line); border-radius: 22px; box-shadow: var(--shadow); }
  .empty-number { color: var(--signal); font: 900 11px/1 var(--condensed); letter-spacing: .16em; }
  .empty-card h1 { margin: 13px 0 12px; font: 600 clamp(34px, 6vw, 60px)/.98 var(--display); letter-spacing: -.045em; }
  .empty-card p { max-width: 480px; color: var(--muted); font-size: 14px; line-height: 1.65; }
  .starter-command { margin-top: 24px; padding: 14px 16px; color: #d8efe5; background: var(--sidebar); border-radius: 11px; font: 600 12px/1.5 ui-monospace, "SFMono-Regular", monospace; }

  .task-detail {
    position: relative;
    z-index: 18;
    min-width: 0;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    background: var(--surface);
    border-left: 1px solid var(--line);
    box-shadow: -18px 0 50px rgba(18,31,26,.07);
    transition: opacity .18s ease;
  }
  .detail-open .task-detail { opacity: 1; pointer-events: auto; }
  .task-detail-content { width: 420px; height: 100%; overflow-y: auto; }
  .detail-head { position: sticky; z-index: 2; top: 0; display: flex; justify-content: space-between; align-items: center; height: 58px; padding: 0 20px; background: rgba(255,255,255,.93); border-bottom: 1px solid var(--line); backdrop-filter: blur(14px); }
  .detail-head strong { font-size: 12px; }
  .icon-button { display: grid; width: 32px; height: 32px; place-items: center; color: var(--muted); background: var(--surface-soft); border: 1px solid var(--line); border-radius: 9px; cursor: pointer; font-size: 18px; }
  .icon-button:hover { color: var(--ink); border-color: #aeb6af; }
  .detail-body { padding: 22px 22px 42px; }
  .detail-status { display: flex; gap: 7px; align-items: center; margin-bottom: 11px; color: var(--signal); font: 900 10px/1 var(--condensed); letter-spacing: .1em; text-transform: uppercase; }
  .detail-status span { width: 8px; height: 8px; background: currentColor; border-radius: 50%; }
  .detail-body h2 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.035em; }
  .detail-description { margin: 13px 0 0; color: #56615b; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
  .detail-actions { display: flex; gap: 8px; margin-top: 19px; }
  .detail-section { margin-top: 27px; padding-top: 22px; border-top: 1px solid var(--line); }
  .detail-section h3 { display: flex; justify-content: space-between; margin: 0 0 13px; font: 900 10px/1 var(--condensed); letter-spacing: .12em; text-transform: uppercase; }
  .detail-section h3 span { color: #9aa19d; }
  .criteria-list, .finding-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
  .criteria-list li { display: grid; grid-template-columns: 18px 1fr; gap: 9px; color: #46514b; font-size: 12px; line-height: 1.5; }
  .criteria-list i { display: grid; width: 17px; height: 17px; place-items: center; color: white; background: #d7dcd8; border-radius: 50%; font-size: 9px; font-style: normal; }
  .criteria-list.complete i { background: #3f9477; }
  .report-card, .question-card, .tests-card { padding: 14px; border-radius: 11px; }
  .report-card { color: #3f4b45; background: var(--surface-soft); border: 1px solid var(--line); font-size: 12px; line-height: 1.55; }
  .question-card { color: #6d4819; background: #fff4d9; border: 1px solid #edcf8d; }
  .question-card b { display: block; margin-bottom: 6px; font-size: 11px; }
  .question-card p { margin: 0; font-size: 12px; line-height: 1.55; }
  .question-card small { display: block; margin-top: 9px; color: #947242; }
  .tests-card { margin-top: 9px; color: #315f51; background: #e8f6f0; font: 600 11px/1.55 ui-monospace, "SFMono-Regular", monospace; white-space: pre-wrap; }
  .finding-list li { position: relative; padding-left: 15px; color: #5d4b42; font-size: 11px; line-height: 1.5; }
  .finding-list li::before { content: ""; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; background: var(--rose); border-radius: 50%; }
  .conversation-list { display: grid; gap: 8px; }
  .detail-link { justify-content: space-between; color: #24483d; background: #edf4f0; border: 1px solid #cbdcd3; }
  .detail-link:hover { background: #e1f0e8; }
  .detail-meta { display: grid; grid-template-columns: 108px 1fr; gap: 10px 12px; margin: 0; font-size: 11px; }
  .detail-meta dt { color: #919995; }
  .detail-meta dd { margin: 0; overflow-wrap: anywhere; color: #46504b; }

  .setup-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 22px; background: rgba(8,21,16,.69); backdrop-filter: blur(8px); }
  .setup-panel { width: min(640px, 100%); padding: clamp(28px, 5vw, 48px); background: #fbfcf8; border: 1px solid rgba(255,255,255,.7); border-radius: 24px; box-shadow: 0 30px 90px rgba(0,0,0,.3); animation: modal-arrive .28s both; }
  .setup-kicker { color: var(--signal); font: 900 10px/1 var(--condensed); letter-spacing: .16em; text-transform: uppercase; }
  .setup-panel h2 { margin: 11px 0 13px; font: 600 clamp(31px, 5vw, 48px)/1 var(--display); letter-spacing: -.04em; }
  .setup-panel > p { color: var(--muted); font-size: 13px; line-height: 1.6; }
  .setup-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 25px 0; }
  .setup-steps div { min-height: 100px; padding: 14px; background: #f0f2ed; border-radius: 12px; }
  .setup-steps b { display: block; color: var(--signal); font: 900 10px/1 var(--condensed); }
  .setup-steps span { display: block; margin-top: 15px; color: #48534d; font-size: 11px; line-height: 1.4; }
  .setup-actions { display: flex; gap: 8px; }
  .setup-status { min-height: 20px; margin: 12px 0 0 !important; color: #397960 !important; font-weight: 700; }
  .nav-backdrop { display: none; }

  @keyframes column-arrive { from { opacity: 0; transform: translateY(10px); } }
  @keyframes modal-arrive { from { opacity: 0; transform: translateY(14px) scale(.985); } }

  @media (max-width: 1279px) {
    .app-shell, .detail-open .app-shell { grid-template-columns: 230px minmax(0,1fr); }
    .task-detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(430px, calc(100vw - 230px)); transform: translateX(102%); transition: transform .28s cubic-bezier(.2,.8,.2,1), opacity .18s ease; }
    .detail-open .task-detail { transform: translateX(0); }
    .task-detail-content { width: 100%; }
  }

  @media (max-width: 760px) {
    .app-shell, .detail-open .app-shell { display: block; }
    .project-sidebar { position: fixed; inset: 0 auto 0 0; width: min(284px, 86vw); transform: translateX(-102%); transition: transform .26s cubic-bezier(.2,.8,.2,1); }
    .nav-open .project-sidebar { transform: translateX(0); }
    .nav-backdrop { position: fixed; z-index: 19; inset: 0; display: block; visibility: hidden; opacity: 0; background: rgba(6,17,13,.48); border: 0; transition: opacity .2s ease, visibility .2s ease; }
    .nav-open .nav-backdrop { visibility: visible; opacity: 1; }
    .workspace { height: 100dvh; }
    .workspace-header { height: 148px; padding: 18px 16px 15px; }
    .mobile-projects { display: grid; flex: 0 0 auto; place-items: center; }
    .project-status-dot { display: none; }
    .project-title h1 { font-size: 25px; }
    .project-title p { max-width: calc(100vw - 88px); }
    .project-actions { position: absolute; top: 92px; right: 16px; }
    .project-stats { gap: 14px; margin: 18px 0 0 49px; }
    .board-wrap { height: calc(100dvh - 148px); }
    .board { grid-template-columns: repeat(6, minmax(82vw, 1fr)); min-width: 492vw; padding: 14px 14px 30px; scroll-snap-type: x proximity; }
    .column { scroll-snap-align: start; }
    .task-detail { width: 100vw; }
    .detail-body { padding: 20px 18px 38px; }
    .setup-backdrop { align-items: end; padding: 8px; }
    .setup-panel { max-height: calc(100dvh - 16px); padding: 28px 22px; overflow-y: auto; border-radius: 20px; }
    .setup-steps { grid-template-columns: 1fr; }
    .setup-steps div { min-height: auto; }
    .setup-steps span { margin-top: 6px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;
