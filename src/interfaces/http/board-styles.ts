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
    --ui: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
    --condensed: "Avenir Next Condensed", "PingFang SC", "Microsoft YaHei", sans-serif;
    --display: "Songti SC", "STSong", "Iowan Old Style", serif;
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
  .project-item { position: relative; display: grid; grid-template-columns: 18px minmax(0,1fr); gap: 2px; align-items: stretch; }
  .project-item.dragging { opacity: .42; }
  .project-item.drop-before::before, .project-item.drop-after::after { content: ""; position: absolute; z-index: 2; right: 4px; left: 4px; height: 2px; background: var(--mint); border-radius: 99px; box-shadow: 0 0 0 3px rgba(112,214,178,.18); pointer-events: none; }
  .project-item.drop-before::before { top: -3px; }
  .project-item.drop-after::after { bottom: -3px; }
  .project-drag-handle { display: grid; width: 18px; place-items: center; padding: 0; color: rgba(255,255,255,.45); background: transparent; border: 0; border-radius: 7px; cursor: grab; opacity: .52; transition: color .16s ease, background .16s ease, opacity .16s ease; }
  .project-drag-handle:hover, .project-drag-handle:focus-visible { color: white; background: rgba(255,255,255,.11); opacity: 1; }
  .project-drag-handle:active { cursor: grabbing; }
  .project-drag-mark { width: 8px; height: 14px; background-image: radial-gradient(circle, currentColor 1.2px, transparent 1.4px); background-position: 0 0; background-size: 4px 4px; }
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
  .project-item:nth-child(3n+2) .project-glyph { background: #f4c989; }
  .project-item:nth-child(3n+3) .project-glyph { background: #9ed8e7; }
  .project-label { min-width: 0; }
  .project-label b { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .project-label small { display: block; margin-top: 3px; color: rgba(255,255,255,.44); font: 700 10px/1 var(--condensed); text-transform: capitalize; }
  .project-total { display: grid; min-width: 24px; height: 22px; place-items: center; padding: 0 6px; color: rgba(255,255,255,.6); background: rgba(0,0,0,.18); border-radius: 8px; font-size: 10px; }
  .sidebar-footer { display: grid; gap: 9px; margin-top: auto; }
  .sidebar-settings {
    display: grid;
    grid-template-columns: 27px 1fr;
    gap: 10px;
    align-items: center;
    padding: 10px;
    color: rgba(255,255,255,.78);
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px;
    text-decoration: none;
  }
  .sidebar-settings:hover { color: white; background: rgba(255,255,255,.07); }
  .sidebar-settings > span:first-child { display: grid; width: 27px; height: 27px; place-items: center; background: rgba(255,255,255,.09); border-radius: 8px; }
  .sidebar-settings > span:last-child { font-size: 12px; font-weight: 700; }
  .sidebar-settings small { display: block; margin-top: 2px; color: rgba(255,255,255,.43); font-size: 9px; font-weight: 500; }
  .update-trigger {
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 9px;
    align-items: center;
    width: 100%;
    padding: 10px;
    color: white;
    background: rgba(255,255,255,.055);
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
  }
  .update-trigger:hover { background: rgba(255,255,255,.1); }
  .update-trigger[data-state="attention"] { background: rgba(244,91,53,.16); border-color: rgba(244,91,53,.5); }
  .update-trigger[data-state="active"] { background: rgba(125,205,227,.13); border-color: rgba(125,205,227,.45); }
  .update-trigger > span:last-child { font-size: 12px; font-weight: 700; }
  .update-trigger small { display: block; margin-top: 2px; overflow: hidden; color: rgba(255,255,255,.57); font-size: 9px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .update-icon { display: grid; width: 27px; height: 27px; place-items: center; color: #09251b; background: var(--mint); border-radius: 8px; font-weight: 900; }
  .update-trigger[data-state="attention"] .update-icon { color: white; background: var(--signal); }
  .update-trigger[data-state="active"] .update-icon { background: var(--sky); animation: update-spin 1.3s linear infinite; }
  .local-note { padding: 10px 8px 1px; color: rgba(255,255,255,.42); border-top: 1px solid rgba(255,255,255,.1); font-size: 10px; }

  .workspace {
    min-width: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 86% 0, rgba(125,205,227,.16), transparent 28%),
      linear-gradient(180deg, #f7f8f5 0, var(--canvas) 100%);
  }
  .project-workspace { height: 100%; overflow: hidden; }
  .offline { position: absolute; z-index: 40; top: 10px; left: 50%; display: none; padding: 8px 13px; color: white; background: #a93d30; border-radius: 9px; box-shadow: var(--shadow); font-size: 11px; transform: translateX(-50%); }
  .workspace-header { height: 184px; padding: 24px 28px 18px; background: rgba(255,255,255,.82); border-bottom: 1px solid var(--line); backdrop-filter: blur(14px); }
  .workspace-topline { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
  .project-identity { display: flex; min-width: 0; gap: 13px; align-items: flex-start; }
  .mobile-projects { display: none; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 9px; background: white; cursor: pointer; }
  .project-status-dot { width: 11px; height: 11px; margin-top: 9px; background: var(--mint); border: 3px solid rgba(112,214,178,.25); border-radius: 50%; box-sizing: content-box; }
  .project-title { min-width: 0; }
  .project-title h1 { margin: 0; overflow: hidden; font-size: clamp(25px, 3vw, 36px); line-height: 1.08; letter-spacing: -.04em; text-overflow: ellipsis; white-space: nowrap; }
  .project-title h1 a { color: inherit; text-decoration: none; }
  .project-title h1 a:hover { color: #a94628; }
  .project-title p { margin: 7px 0 0; max-width: 780px; overflow: hidden; color: var(--muted); font-size: 12px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
  .planning-notice { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 8px; align-items: center; max-width: 800px; margin-top: 8px; padding: 7px 9px; color: #66502c; background: #fff7e4; border: 1px solid #eed7a2; border-radius: 9px; font-size: 11px; }
  .planning-notice b { color: #9b6324; font: 900 9px/1 var(--condensed); letter-spacing: .08em; }
  .planning-notice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .planning-notice a { color: #8c5520; font-weight: 800; text-decoration: none; white-space: nowrap; }
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

  .board-wrap { height: calc(100dvh - 184px); overflow: auto; }
  .board {
    display: grid;
    grid-template-columns: repeat(7, minmax(252px, 1fr));
    gap: 12px;
    min-width: 1764px;
    min-height: 100%;
    padding: 18px 20px 34px;
  }
  .column { min-width: 0; animation: column-arrive .42s both; }
  .column:nth-child(2) { animation-delay: .035s; }
  .column:nth-child(3) { animation-delay: .07s; }
  .column:nth-child(4) { animation-delay: .105s; }
  .column:nth-child(5) { animation-delay: .14s; }
  .column:nth-child(6) { animation-delay: .175s; }
  .column:nth-child(7) { animation-delay: .21s; }
  .column-head { display: flex; justify-content: space-between; align-items: center; height: 38px; padding: 0 10px; margin-bottom: 8px; border-radius: 9px; font-size: 11px; font-weight: 800; }
  .column-title { display: flex; gap: 7px; align-items: center; }
  .column-head i { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
  .column-head b { display: grid; min-width: 21px; height: 21px; place-items: center; padding: 0 5px; background: rgba(255,255,255,.63); border-radius: 7px; font-size: 9px; }
  .column-sort { display: grid; width: 23px; height: 23px; margin-left: -2px; padding: 0; place-items: center; color: currentColor; background: rgba(255,255,255,.48); border: 1px solid rgba(72,88,80,.12); border-radius: 7px; cursor: pointer; font: 900 12px/1 var(--ui); transition: background .15s ease, border-color .15s ease, transform .15s ease; }
  .column-sort:hover { background: rgba(255,255,255,.82); border-color: rgba(72,88,80,.25); transform: translateY(-1px); }
  .column-sort:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .column-sort.active { color: white; background: #52615a; border-color: transparent; }
  .column[data-column="backlog"] .column-head { color: #626b67; background: #e3e6e2; }
  .column[data-column="developing"] .column-head { color: #a94628; background: #fee0d4; }
  .column[data-column="reviewing"] .column-head { color: #267187; background: #d9f1f7; }
  .column[data-column="integrating"] .column-head { color: #28725b; background: #daf0e7; }
  .column[data-column="waiting"] .column-head { color: #8c6325; background: #f8e9c4; }
  .column[data-column="done"] .column-head { color: #59645f; background: #dde5df; }
  .column[data-column="cancelled"] .column-head { color: #87545c; background: #f2e0e3; }
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
  .task-card[data-status="cancelled"]::before { background: var(--rose); }
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
  .empty-card { width: min(560px, 100%); padding: 44px; background: rgba(255,255,255,.82); border: 1px solid var(--line); border-radius: 22px; box-shadow: var(--shadow); }
  .empty-kicker { color: var(--signal); font: 800 11px/1 var(--ui); }
  .empty-card h1 { margin: 15px 0 13px; font: 600 clamp(34px, 6vw, 54px)/1.06 var(--display); letter-spacing: -.035em; }
  .empty-card p { max-width: 450px; color: var(--muted); font-size: 14px; line-height: 1.7; }
  .starter-example { margin-top: 24px; padding: 15px 17px; color: #71402e; background: var(--signal-soft); border: 1px solid #f2c8b7; border-radius: 11px; font: 600 13px/1.55 var(--ui); }

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
  .task-detail-content { width: 100%; max-width: 100%; height: 100%; overflow-x: hidden; overflow-y: auto; }
  .detail-head { position: sticky; z-index: 2; top: 0; display: flex; justify-content: space-between; align-items: center; height: 58px; padding: 0 20px; background: rgba(255,255,255,.93); border-bottom: 1px solid var(--line); backdrop-filter: blur(14px); }
  .detail-head strong { font-size: 12px; }
  .icon-button { display: grid; width: 32px; height: 32px; place-items: center; color: var(--muted); background: var(--surface-soft); border: 1px solid var(--line); border-radius: 9px; cursor: pointer; font-size: 18px; }
  .icon-button:hover { color: var(--ink); border-color: #aeb6af; }
  .detail-body { min-width: 0; max-width: 100%; padding: 22px 22px 42px; }
  .detail-status { display: flex; gap: 7px; align-items: center; margin-bottom: 11px; color: var(--signal); font: 900 10px/1 var(--condensed); letter-spacing: .1em; text-transform: uppercase; }
  .detail-status span { width: 8px; height: 8px; background: currentColor; border-radius: 50%; }
  .task-id-row { display: flex; gap: 8px; align-items: center; margin-bottom: 13px; }
  .task-id-row code { min-width: 0; overflow: hidden; color: #64706a; font: 600 10px/1.3 ui-monospace, "SFMono-Regular", monospace; text-overflow: ellipsis; white-space: nowrap; }
  .copy-id-button { flex: none; padding: 5px 8px; color: #41504a; background: #eef1ed; border: 1px solid #d8ddd8; border-radius: 7px; cursor: pointer; font: 800 9px/1 var(--condensed); letter-spacing: .04em; }
  .copy-id-button:hover { color: #a94628; background: var(--signal-soft); border-color: #f2c8b7; }
  .copy-id-button.copied { color: #28725b; background: #dff4eb; border-color: #b9dfcf; }
  .detail-body h2 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.035em; }
  .detail-description { margin: 13px 0 0; color: #56615b; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
  .detail-actions { display: flex; gap: 8px; margin-top: 19px; }
  .scheduled-resume-card { display: grid; gap: 14px; margin-top: 20px; padding: 16px; color: #6d4a15; background: linear-gradient(135deg, #fff8e5, #f8e9c4); border: 1px solid #e5cb87; border-radius: 13px; }
  .scheduled-resume-card p { margin: 7px 0; color: #705c37; font-size: 12px; line-height: 1.55; }
  .scheduled-resume-card time { font: 800 11px/1.4 var(--condensed); letter-spacing: .035em; }
  .scheduled-resume-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  .scheduled-resume-actions label { display: grid; gap: 5px; color: #78653f; font: 800 9px/1 var(--condensed); letter-spacing: .08em; text-transform: uppercase; }
  .scheduled-resume-actions input { min-height: 34px; padding: 6px 9px; color: var(--ink); background: rgba(255,255,255,.78); border: 1px solid #d8bf80; border-radius: 8px; font: 700 11px/1 var(--condensed); }
  .detail-section { min-width: 0; max-width: 100%; margin-top: 27px; padding-top: 22px; border-top: 1px solid var(--line); }
  .detail-section h3 { display: flex; justify-content: space-between; margin: 0 0 13px; font: 900 10px/1 var(--condensed); letter-spacing: .12em; }
  .detail-section h3 span { color: #9aa19d; }
  .criteria-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
  .criteria-list li { display: grid; grid-template-columns: 18px 1fr; gap: 9px; color: #46514b; font-size: 12px; line-height: 1.5; }
  .criteria-list i { display: grid; width: 17px; height: 17px; place-items: center; color: white; background: #d7dcd8; border-radius: 50%; font-size: 9px; font-style: normal; }
  .criteria-list.complete i { background: #3f9477; }
  .criteria-empty, .cancellation-card { padding: 14px; border-radius: 11px; }
  .criteria-empty { color: #3f4b45; background: var(--surface-soft); border: 1px solid var(--line); font-size: 12px; line-height: 1.55; }
  .cancellation-card { margin-top: 16px; color: #71342b; background: #fff0ed; border: 1px solid #e9b8af; }
  .cancellation-card b { display: block; margin-bottom: 6px; font-size: 11px; }
  .cancellation-card p { margin: 0; font-size: 12px; line-height: 1.55; }
  .cancellation-card small, .cancellation-meta { display: block; margin-top: 9px; color: #9d655c; font-size: 10px; }
  .planning-notice.cancellation, .planning-panel.cancellation { color: #71342b; background: #fff0ed; border-color: #e9b8af; }
  .planning-notice.blocked, .planning-panel.blocked { color: #71342b; background: #fff0ed; border-color: #e9b8af; }
  .current-conversation { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 14px; align-items: center; margin-top: 20px; padding: 14px; background: linear-gradient(135deg, #f8fbf8, #edf4f0); border: 1px solid #cbdcd3; border-radius: 13px; box-shadow: 0 8px 22px rgba(25,39,33,.055); }
  .current-conversation-copy { display: grid; min-width: 0; gap: 7px; }
  .current-conversation-copy > span { color: #75817b; font: 900 9px/1 var(--condensed); letter-spacing: .12em; text-transform: uppercase; }
  .current-conversation-copy > div { display: flex; min-width: 0; gap: 7px; align-items: center; color: #24483d; font-size: 12px; }
  .current-conversation-copy b, .current-conversation-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .current-conversation-copy i { color: #a3aea8; font-style: normal; }
  .current-conversation .detail-link { min-height: 34px; padding-inline: 12px; white-space: nowrap; }
  .current-execution-activity { position: relative; display: grid; grid-column: 1 / -1; min-height: 35px; overflow: hidden; border-top: 1px solid rgba(89,119,105,.16); }
  .current-activity-entry { display: grid; grid-area: 1 / 1; grid-template-columns: auto minmax(0,1fr) auto; gap: 9px; align-items: center; padding: 10px 2px 0; color: #31594b; font-size: 11px; font-weight: 750; }
  .current-activity-entry.entering { animation: activity-roll-in .3s cubic-bezier(.2,.8,.2,1) both; }
  .current-activity-entry.leaving { animation: activity-roll-out .3s cubic-bezier(.2,.8,.2,1) both; }
  .current-activity-marker { width: 7px; height: 7px; background: var(--signal); border-radius: 50%; box-shadow: 0 0 0 4px rgba(244,91,53,.11); }
  .current-activity-entry time { color: #8a9690; font-size: 9px; font-weight: 600; white-space: nowrap; }
  .current-activity-waiting { color: #84908a; font-weight: 600; }
  .current-activity-waiting .current-activity-marker { background: #aeb8b2; box-shadow: 0 0 0 4px rgba(112,130,120,.09); }
  .activity-section { margin-inline: 0; }
  .activity-timeline { position: relative; display: grid; min-width: 0; max-width: 100%; gap: 14px; margin: 0; padding: 2px 0 2px 24px; list-style: none; }
  .activity-timeline::before { content: ""; position: absolute; top: 5px; bottom: 5px; left: 7px; width: 1px; background: linear-gradient(#cfd6d1, #e3e7e3 90%, transparent); }
  .activity-item { position: relative; min-width: 0; max-width: 100%; animation: column-arrive .28s both; }
  .activity-node { position: absolute; z-index: 1; top: 17px; left: -21px; width: 9px; height: 9px; background: #fff; border: 2px solid #9ca9a2; border-radius: 50%; box-shadow: 0 0 0 4px var(--surface); }
  .activity-card { min-width: 0; max-width: 100%; overflow: hidden; background: #fbfcf9; border: 1px solid #dfe4df; border-radius: 13px; box-shadow: 0 5px 16px rgba(25,39,33,.045); }
  .activity-card header { display: flex; min-width: 0; justify-content: space-between; gap: 12px; align-items: center; padding: 11px 13px 9px; border-bottom: 1px solid #e7ebe7; }
  .activity-card header b { color: #44514b; font: 900 9px/1 var(--condensed); letter-spacing: .09em; text-transform: uppercase; }
  .activity-card-actions { display: flex; flex: none; gap: 9px; align-items: center; }
  .activity-conversation-link { color: #397960; font: 800 9px/1 var(--condensed); text-decoration: none; white-space: nowrap; }
  .activity-conversation-link:hover { color: var(--signal); }
  .activity-card time { flex: none; color: #929b96; font-size: 9px; }
  .activity-summary { min-width: 0; margin: 0; padding: 12px 13px 13px; overflow-wrap: anywhere; color: #39463f; font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
  .activity-evidence { display: grid; min-width: 0; gap: 9px; padding: 0 13px 13px; }
  .activity-evidence-block, .activity-question { padding: 10px 11px; background: #f0f3ef; border-radius: 9px; }
  .activity-evidence-block b, .activity-question b { display: block; margin-bottom: 6px; color: #68736d; font: 900 8px/1 var(--condensed); letter-spacing: .1em; text-transform: uppercase; }
  .activity-evidence-block p, .activity-question p { margin: 0; overflow-wrap: anywhere; color: #445049; font-size: 10px; line-height: 1.6; white-space: pre-wrap; }
  .activity-evidence-block ul { display: grid; gap: 6px; margin: 0; padding-left: 16px; color: #554840; font-size: 10px; line-height: 1.55; }
  .activity-question { display: grid; color: #6d4819; background: #fff3d5; border: 1px solid #ecd08f; }
  .activity-question.historical { color: #6d6456; background: #f4f1e9; border-color: #ded8c9; }
  .activity-question .detail-link { min-height: 34px; margin-top: 10px; padding-inline: 12px; }
  .activity-question small { display: block; margin-top: 7px; color: #8e6d3d; font-size: 9px; }
  .activity-git { display: grid; min-width: 0; max-width: 100%; grid-template-columns: minmax(0,68px) minmax(0,1fr); gap: 7px 9px; margin: 0; padding: 10px 11px; background: #eef3f0; border-radius: 9px; font-size: 9px; }
  .activity-git dt { color: #7d8882; }
  .activity-git dd { min-width: 0; margin: 0; overflow: hidden; color: #34463e; text-overflow: ellipsis; white-space: nowrap; }
  .activity-git code { font: 600 9px/1.3 ui-monospace, "SFMono-Regular", monospace; }
  .activity-item.review_approved .activity-node, .activity-item.integration_completed .activity-node { border-color: #3f9477; background: #dff3ea; }
  .activity-item.review_changes_requested .activity-node, .activity-item.blocked .activity-node, .activity-item.execution_failed .activity-node { border-color: #ba593e; background: #ffe6df; }
  .activity-item.decision_requested .activity-node { border-color: #bc8527; background: #fff0c9; }
  .activity-item[data-latest-activity] .activity-card { border-color: #bcc8c1; box-shadow: 0 8px 22px rgba(25,39,33,.075); }
  .activity-empty { display: grid; gap: 6px; padding: 18px; color: #8b948f; background: #f7f8f5; border: 1px dashed #cfd5d0; border-radius: 12px; text-align: center; }
  .activity-empty b { color: #66716b; font-size: 11px; }
  .activity-empty span { font-size: 10px; }
  .detail-link { justify-content: space-between; color: #24483d; background: #edf4f0; border: 1px solid #cbdcd3; }
  .detail-link:hover { background: #e1f0e8; }
  .detail-meta { display: grid; grid-template-columns: 72px 1fr; gap: 10px 12px; margin: 0; font-size: 11px; }
  .detail-meta dt { color: #919995; }
  .detail-meta dd { margin: 0; overflow-wrap: anywhere; color: #46504b; }

  .page-screen { height: 100%; overflow-y: auto; padding: clamp(24px, 4vw, 54px); }
  .page-hero { max-width: 980px; margin: 0 auto 26px; animation: column-arrive .35s both; }
  .page-hero h1 { margin: 10px 0 12px; font: 600 clamp(36px, 6vw, 68px)/1 var(--display); letter-spacing: -.05em; }
  .page-hero > p { max-width: 720px; color: var(--muted); font-size: 13px; line-height: 1.65; }
  .page-kicker { margin-top: 24px; color: var(--signal); font: 900 10px/1 var(--condensed); letter-spacing: .17em; text-transform: uppercase; }
  .eyebrow-link { color: #51605a; font-size: 11px; font-weight: 800; text-decoration: none; }
  .eyebrow-link:hover { color: var(--signal); }
  .settings-screen { padding-top: clamp(24px, 3vw, 36px); }
  .settings-header { display: grid; gap: 11px; max-width: 980px; margin: 0 auto 18px; animation: column-arrive .35s both; }
  .settings-header h1 { margin: 0; font: 750 clamp(27px, 3vw, 36px)/1.1 var(--ui); letter-spacing: -.045em; }
  .settings-header p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .settings-form { display: grid; max-width: 980px; margin: 0 auto; overflow: hidden; background: rgba(255,255,255,.92); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 6px 20px rgba(18,31,26,.04); animation: column-arrive .45s .06s both; }
  .setting-field { display: grid; grid-template-columns: minmax(260px,1fr) minmax(240px,360px); gap: 28px; align-items: center; padding: 24px 28px; border-bottom: 1px solid var(--line); }
  .setting-field b, .setting-field small { display: block; }
  .setting-field b { margin-bottom: 6px; font-size: 14px; }
  .setting-field small { color: var(--muted); font-size: 11px; line-height: 1.5; }
  .setting-field input, .setting-field select { width: 100%; min-height: 44px; padding: 0 12px; color: var(--ink); background: var(--surface-soft); border: 1px solid var(--line-strong); border-radius: 10px; font: 700 12px/1 var(--ui); }
  .setting-field input:focus, .setting-field select:focus { outline: 3px solid rgba(244,91,53,.16); border-color: var(--signal); }
  .settings-actions { display: flex; gap: 14px; align-items: center; padding: 20px 28px; }
  .settings-actions span { color: #34735d; font-size: 11px; font-weight: 700; }

  .product-hero { max-width: 1180px; }
  .product-hero-row { display: flex; gap: 20px; align-items: flex-end; justify-content: space-between; }
  .product-hero-row h1 { font-size: clamp(34px, 5vw, 58px); }
  .product-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; max-width: 1180px; margin: 0 auto; }
  .product-main, .product-rail { display: grid; align-content: start; gap: 16px; }
  .product-panel { padding: 24px; background: rgba(255,255,255,.93); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 28px rgba(18,31,26,.055); }
  .product-panel.compact { padding: 19px; }
  .panel-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; font: 900 10px/1 var(--condensed); letter-spacing: .12em; text-transform: uppercase; }
  .panel-heading b { color: var(--muted); font-size: 9px; }
  .planning-panel { color: #674b22; background: linear-gradient(135deg, #fff8e9, #fffdf5); border-color: #ecd5a2; }
  .planning-panel p { margin: 0; font: 600 14px/1.7 var(--ui); white-space: pre-wrap; }
  .planning-panel.quiet { color: var(--muted); background: rgba(255,255,255,.72); border-color: var(--line); }
  .decision-question { margin-top: 14px; padding: 12px 14px; background: rgba(234,191,99,.18); border-left: 3px solid var(--amber); border-radius: 4px 9px 9px 4px; font-size: 12px; font-weight: 700; }
  .markdown-body { color: #37443e; font-size: 13px; line-height: 1.7; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { color: var(--ink); font-family: var(--display); letter-spacing: -.02em; }
  .markdown-body h1 { margin: 2px 0 18px; font-size: 30px; }
  .markdown-body h2 { margin: 26px 0 10px; font-size: 22px; }
  .markdown-body h3 { margin: 20px 0 8px; font-size: 17px; }
  .markdown-body p { margin: 8px 0; white-space: pre-wrap; }
  .markdown-list-item { position: relative; margin: 7px 0; padding-left: 18px; }
  .markdown-list-item::before { content: ""; position: absolute; top: 9px; left: 2px; width: 6px; height: 6px; background: var(--signal); border-radius: 50%; }
  .markdown-space { height: 7px; }
  .product-task-list { display: grid; gap: 8px; }
  .product-task { display: grid; grid-template-columns: 64px minmax(0,1fr) auto; gap: 14px; align-items: center; padding: 14px; background: var(--surface-soft); border: 1px solid #e5e8e3; border-radius: 11px; }
  .product-task h3 { margin: 0 0 4px; font-size: 13px; }
  .product-task p { margin: 0; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .context-notes { display: grid; gap: 8px; margin: 0; padding-left: 18px; color: #46514b; font-size: 11px; line-height: 1.55; }
  .empty-copy { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
  .project-model-form { display: grid; gap: 11px; }
  .project-model-inherit { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 9px; align-items: start; padding: 10px; background: #f2f5f1; border: 1px solid #e0e5df; border-radius: 10px; cursor: pointer; }
  .project-model-inherit input { margin-top: 2px; accent-color: var(--signal); }
  .project-model-inherit b, .project-model-inherit small { display: block; }
  .project-model-inherit b { font-size: 11px; }
  .project-model-inherit small { margin-top: 4px; overflow-wrap: anywhere; color: var(--muted); font-size: 9px; line-height: 1.45; }
  .project-model-field { display: grid; gap: 6px; color: var(--muted); font-size: 9px; font-weight: 800; }
  .project-model-field select { width: 100%; min-height: 38px; padding: 0 9px; color: var(--ink); background: white; border: 1px solid var(--line-strong); border-radius: 9px; font: 700 10px/1 var(--ui); }
  .project-model-field select:disabled { color: #8e9892; background: #f1f3ef; cursor: not-allowed; }
  .project-model-field select:focus { outline: 3px solid rgba(244,91,53,.14); border-color: var(--signal); }
  .project-model-actions { display: grid; gap: 8px; margin-top: 2px; }
  .project-model-actions .primary-button { width: 100%; }
  .project-model-actions span { min-height: 14px; color: #34735d; font-size: 9px; font-weight: 700; line-height: 1.45; }

  .update-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 22px; background: rgba(8,21,16,.72); backdrop-filter: blur(9px); }
  .update-panel { width: min(680px, 100%); max-height: calc(100dvh - 44px); padding: clamp(25px, 4vw, 40px); overflow-y: auto; background: linear-gradient(145deg, #fff 0%, #f1f4ed 100%); border: 1px solid rgba(255,255,255,.72); border-radius: 22px; box-shadow: 0 32px 100px rgba(0,0,0,.34); animation: modal-arrive .28s both; }
  .update-panel:focus { outline: none; }
  .update-head { display: flex; justify-content: space-between; gap: 22px; align-items: flex-start; }
  .update-kicker { color: var(--signal); font: 900 9px/1 var(--condensed); letter-spacing: .18em; }
  .update-head h2 { margin: 10px 0 0; font: 600 clamp(30px, 5vw, 46px)/1 var(--display); letter-spacing: -.045em; }
  .update-summary { max-width: 570px; margin: 18px 0 22px; color: #56615b; font-size: 13px; line-height: 1.65; }
  .version-ledger { display: grid; grid-template-columns: repeat(2, 1fr); overflow: hidden; background: #13251f; border-radius: 13px; box-shadow: 0 15px 34px rgba(11,31,23,.13); }
  .version-ledger div { min-width: 0; padding: 16px; border-right: 1px solid rgba(255,255,255,.09); border-bottom: 1px solid rgba(255,255,255,.09); }
  .version-ledger div:nth-child(2n) { border-right: 0; }
  .version-ledger div:nth-last-child(-n+2) { border-bottom: 0; }
  .version-ledger span, .version-ledger strong { display: block; }
  .version-ledger span { color: rgba(255,255,255,.52); font: 800 8px/1 var(--condensed); letter-spacing: .1em; text-transform: uppercase; }
  .version-ledger strong { margin-top: 9px; overflow: hidden; color: white; font: 800 16px/1.2 var(--ui); text-overflow: ellipsis; white-space: nowrap; }
  .update-progress { margin-top: 18px; padding: 16px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
  .update-progress-track { height: 6px; overflow: hidden; background: #e7eae4; border-radius: 99px; }
  .update-progress-track span { display: block; width: 0; height: 100%; background: linear-gradient(90deg, var(--signal), #f2aa52); border-radius: inherit; transition: width .45s ease; }
  .update-progress[data-phase="failed"] .update-progress-track span { background: #bc4c3f; }
  .update-progress[data-phase="succeeded"] .update-progress-track span { background: #3f9477; }
  .update-progress-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; }
  .update-progress-meta b { font-size: 11px; }
  .update-progress-meta time { color: var(--muted); font-size: 9px; }
  .update-timeline { display: grid; margin-top: 9px; overflow: hidden; background: rgba(255,255,255,.62); border: 1px solid var(--line); border-radius: 10px; }
  .update-timeline div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 11px; border-bottom: 1px solid #e7eae5; font-size: 9px; }
  .update-timeline div:last-child { border-bottom: 0; }
  .update-timeline span { color: #52615a; font-weight: 800; }
  .update-timeline time { color: #87908b; }
  .update-meta { display: grid; grid-template-columns: 88px minmax(0,1fr); gap: 9px 12px; margin: 19px 0; padding: 0 3px; font-size: 10px; line-height: 1.45; }
  .update-meta dt { color: #89928d; }
  .update-meta dd { margin: 0; color: #46514b; }
  .update-conflict { margin-top: 16px; padding: 14px; color: #773c2e; background: #fff0ea; border: 1px solid #e9b9aa; border-radius: 11px; }
  .update-conflict b, .update-conflict p, .update-conflict code { display: block; }
  .update-conflict b { font-size: 11px; }
  .update-conflict p { margin: 7px 0; font-size: 10px; line-height: 1.5; }
  .update-conflict code { overflow-wrap: anywhere; font-size: 9px; line-height: 1.55; white-space: pre-wrap; }
  .update-hook-trust { margin-top: 16px; padding: 14px; color: #67470f; background: #fff7df; border: 1px solid #e7cf91; border-radius: 11px; }
  .update-hook-trust b, .update-hook-trust p { display: block; }
  .update-hook-trust b { margin-bottom: 6px; font-size: 11px; }
  .update-hook-trust p { margin: 0; font-size: 10px; line-height: 1.6; }
  .update-hook-trust code { padding: 1px 5px; color: #513708; background: #f4e5b9; border-radius: 4px; }
  .update-actions { display: flex; gap: 8px; }
  .update-status { min-height: 19px; margin: 12px 0 0; color: #4d665d; font-size: 10px; font-weight: 700; line-height: 1.5; }
  .update-fallback { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px; color: #6c4835; background: #fff4e8; border-radius: 9px; font-size: 10px; }
  .update-fallback code { padding: 3px 6px; color: #713f28; background: rgba(255,255,255,.7); border-radius: 5px; font: 700 10px/1.4 ui-monospace, "SFMono-Regular", monospace; }
  .nav-backdrop { display: none; }

  @keyframes column-arrive { from { opacity: 0; transform: translateY(10px); } }
  @keyframes modal-arrive { from { opacity: 0; transform: translateY(14px) scale(.985); } }
  @keyframes update-spin { to { transform: rotate(360deg); } }
  @keyframes activity-roll-in { from { opacity: 0; transform: translateY(110%); } }
  @keyframes activity-roll-out { to { opacity: 0; transform: translateY(-110%); } }

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
    .workspace-header { height: 174px; padding: 18px 16px 15px; }
    .mobile-projects { display: grid; flex: 0 0 auto; place-items: center; }
    .project-status-dot { display: none; }
    .project-title { max-width: calc(100vw - 190px); }
    .project-title h1 { font-size: 25px; }
    .project-title p { display: none; }
    .planning-notice { grid-template-columns: auto minmax(0,1fr); max-width: calc(100vw - 58px); }
    .planning-notice a { display: none; }
    .project-actions { position: absolute; top: 18px; right: 16px; }
    .project-stats { gap: 14px; margin: 18px 0 0 49px; }
    .board-wrap { height: calc(100dvh - 174px); }
    .board { grid-template-columns: repeat(7, minmax(82vw, 1fr)); min-width: 574vw; padding: 14px 14px 30px; scroll-snap-type: x proximity; }
    .column { scroll-snap-align: start; }
    .task-detail { width: 100vw; }
    .detail-body { padding: 20px 18px 38px; }
    .current-conversation { grid-template-columns: 1fr; }
    .current-conversation .detail-link { width: 100%; }
    .activity-card header { align-items: flex-start; flex-direction: column; gap: 7px; }
    .activity-card-actions { width: 100%; justify-content: space-between; }
    .activity-git { grid-template-columns: 60px minmax(0,1fr); }
    .update-backdrop { align-items: end; padding: 8px; }
    .update-panel { max-height: calc(100dvh - 16px); padding: 26px 20px; border-radius: 20px; }
    .version-ledger { grid-template-columns: 1fr; }
    .version-ledger div, .version-ledger div:nth-child(2n), .version-ledger div:nth-last-child(-n+2) { padding: 13px 15px; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.09); }
    .version-ledger div:last-child { border-bottom: 0; }
    .version-ledger strong { margin-top: 5px; font-size: 14px; }
    .update-actions { align-items: stretch; flex-direction: column; }
    .page-screen { padding: 22px 16px 42px; }
    .page-hero h1 { font-size: 38px; }
    .setting-field { grid-template-columns: 1fr; gap: 13px; padding: 20px; }
    .settings-actions { align-items: flex-start; flex-direction: column; padding: 18px 20px; }
    .product-hero-row { align-items: flex-start; flex-direction: column; }
    .product-grid { grid-template-columns: 1fr; }
    .product-rail { grid-row: 1; }
    .product-panel { padding: 19px; }
    .product-task { grid-template-columns: 52px minmax(0,1fr); }
    .product-task .status-pill { grid-column: 2; justify-self: start; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;
