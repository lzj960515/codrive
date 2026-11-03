# Codrive 文档

## 当前产品如何工作

- [里程碑与持续规划](architecture/milestones.md)：任务选择、阶段验收和会话生命周期。
- [产品事实生命周期](architecture/product-facts.md)：`PROJECT.md`、任务文档与已接受版本。
- [看板实时同步](architecture/realtime-sync.md)：HTTP 数据与 Socket.IO 通知的职责。
- [Semantic Atlas 自动维护](architecture/semantic-atlas-maintenance.md)：可选业务地图维护。
- [Slack 接入与 Mac 运行](operations/slack.md)：应用权限、私有配置、频道绑定、原生定时提示词和实机检查。
- [Mac mini 安装与验收](operations/mac-mini-install.md)：可直接交给另一台 Mac 上的 AI 执行，从 npm 安装、Token 设置到启动与验收。

## 规格与方案

- [本地 Slack 助理规格](plans/2026-11-03-slack-assistant-spec.md)：机器人私信全局交流、项目频道免艾特、根消息讨论串会话，以及原生巡检和开发交付；包含需求、流程、现有 Skill 扩展、已确认数据变更和验收。当前 Mac 的真实 Slack 会话、命令与双向文件传输已验收，Mac mini 和工程发布保留独立边界。
- [原始讨论与取舍](plans/2026-11-03-slack-assistant.md)：保留方案形成过程、源码调查与参考资料，交付契约已转入规格。

## 记录

- 新的文档维护记录位于 `docs/changes/`。
- [既有文档日志](log.md)保留原有历史。
