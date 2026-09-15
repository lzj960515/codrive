# 任务拆分方法

把已确认的产品结果整理成可独立交付和验收的任务。主 Skill 负责目标归属、已有授权、必要产品事实同步、任务写入和交接；本页负责拆分粒度、前置结果和迁移顺序。

## 复用已有决定

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

以当前产品契约、已确认里程碑、规格和已有任务为范围依据，区分确认结果、未决选择和候选增强。任务引用已有规格的相关决定，补充本任务的结果边界与验收；已经明确的事项沿用现有决定。

## 完整行为切片

- A completed slice is demoable or verifiable on its own

每项任务贯通完成一个业务结果所必需的层次。后端任务以接口、处理流程、数据和直接验证形成完整结果；只有当前目标包含界面时才纳入 UI。按业务结果拆分，避免把表、接口、页面和测试分别变成无法独立验收的任务。

任务大小以独立交付和审查所需的上下文为参考，保持职责完整。只有当前结果确实依赖某项前置重构时，才把该重构安排为前序任务；能直接完成的局部变化保留直接路径。

## 真实前置结果

Give each ticket its **blocking edges**: the other tickets that must complete before it can start.

在任务 `description` 中写明需要哪个任务交付的什么结果，以及缺少它为什么不能开始；可独立推进的任务保持独立。同一模块、排列顺序或可能的文件冲突本身不构成业务前置依赖。展示计划时一并展示这些理由，沿用主 Skill 的已有授权判断。

使用现有的 `title`、`description` 和 `acceptanceCriteria` 结构。Codrive 任务选择会结合当前代码、任务状态和容量重新判断关系；本页中的依赖是规划依据，实际启动仍由 Codrive 负责。

## 大范围机械迁移

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch.

先确认当前迁移确实需要分批兼容；能在一个可验证任务内完成的机械修改直接完成。每个迁移任务按 Codrive 独立工作、审查和合入的生命周期交付；批次不能独立通过必要验证时，重新划分边界或把相互依赖的改动合为一个可完整验收的任务。外部兼容及旧形式退出条件以既有契约和真实调用方证据为准。

## 任务命名与信息归属

标题直接表达业务动作和对象，让人从看板上看懂交付结果。排序交给看板顺序，任务引用使用业务名称；已有路线图编号放在来源引用中，用户明确指定的任务名保持原样。目标项目已经唯一确定仓库时沿用项目上下文；跨仓库任务才在描述中明确各仓库的交付边界。

描述先写本任务交付什么，再保留会改变执行判断的范围、前置结果和证据引用。只为存在的依赖写前置条件，直接可开始的任务省略空的启动说明。必要依赖在一处说明，验收标准检查结果；执行顺序与通用工作树、Review、合入流程由对应生命周期负责。

验收标准以可观察结果和关键不变量为依据，合并重复表达。产品行为、真实数据边界、发布条件和用户已确认的安全约束保留完整；常规工程规范沿用项目约定。测试和文档要求指明它们要证明或交付的结果，避免用一串工具名称代替完成标准。

## 任务正文与验收

The end-to-end behaviour this ticket makes work, from the user's perspective, not layer-by-layer implementation.

`description` 描述本任务的交付结果、边界、前置结果及规格依据；`acceptanceCriteria` 描述如何观察确认行为和必要失败语义。已有任务能完整承载结果时继续使用它，任务状态决定修改或新增路径，按主 Skill 处理。

In either form, avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
