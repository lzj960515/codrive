# Codrive Slack 头像

文件：[codrive-slack-avatar.png](codrive-slack-avatar.png)。通过用户本机 `imagegen` Skill 的 CLI 生成，图像模型 `gpt-image-2.5-sunburst`，画质 `max`；服务默认宿主 `gpt-5.5` 已退役，本次使用 `gpt-6.1-sol` 宿主。请求尺寸为 1024 × 1024，服务实际返回 1254 × 1254，符合 Slack 正方形头像范围。

生成提示词：

```text
Create one polished square Slack bot avatar for Codrive, a personal AI coding co-pilot. A friendly compact navigator robot, viewed straight on, with a simple rounded ivory shell and a dark glass face with two expressive warm amber eyes. Subtle steering-wheel arc integrated into the lower silhouette, suggesting a calm capable co-pilot rather than a toy. Tactile soft 3D editorial illustration, restrained teal accents, deep midnight blue solid background, crisp silhouette with generous padding so it remains recognizable at 32 pixels and in a circular crop. One centered character fills most of the frame. Professional, approachable, distinctive. No text, no letters, no watermark, no surrounding objects.
```
