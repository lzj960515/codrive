# npm 版本检查兼容单元素数组

发布 Slack 功能后，在本机执行 `codrive upgrade`，版本检查返回
`invalid_registry_response`。同一台机器上的 npm 12.2.1 执行
`npm view codrive dist-tags.latest --json` 实际返回 `["0.15.0"]`，原解析只接受字符串。

在现有 npm 查询边界统一读取字符串和单元素数组，后续继续使用原来的稳定版本校验、缓存与升级流程。多个版本仍作为无效响应处理。本次没有改变配置、持久化结构或升级生命周期。

回归测试通过 `PackageVersionService.refresh` 验证真实响应格式产生有效的更新提示，并保留模糊响应的失败语义。原实现稳定复现数组响应失败，修复后再以本机真实 npm 查询和完整升级结果核实。
