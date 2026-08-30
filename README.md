# pi-caffeinate

Agent 运行期间保持 Mac 唤醒的 [pi](https://pi.dev) 扩展。通过调用 macOS 原生的 `caffeinate`,在 agent 工作时阻止显示器熄屏和系统空闲睡眠,空闲时立即释放。

## 工作原理

| 事件 | 动作 |
|------|------|
| `agent_start` | 启动 `caffeinate -di`,标题加 `☕️` 前缀 |
| `agent_settled` | `SIGTERM` 终止 caffeinate 并还原标题(仅在 pi 确定不会自动继续时触发,重试/排队消息期间保持唤醒) |
| `session_info_changed` / `session_start` | 若 caffeinate 仍在运行,延迟重新断言 `☕️` 标题(pi 在这些时机会重写标题) |
| `session_shutdown` | 兜底清理进程 |

`-d` 阻止显示器熄屏,`-i` 阻止系统空闲睡眠。非 macOS 平台直接 no-op,可安全同步到 Linux 机器。

## 终端标题标记

caffeinate 运行期间,终端标题会变为 `☕️ π - [会话名 -] 目录名`(与 pi 原生标题格式一致,仅加前缀);agent 结束后自动还原。pi 在 `/name` 改名、切换/新建/恢复会话时会重写标题,扩展监听 `session_info_changed` 和 `session_start` 延迟重新断言标记。

## 安装

```bash
# 方式一:pi install 直接指向本目录(本地路径,写入 ~/.pi/agent/settings.json)
pi install /path/to/pi-caffeinate

# 方式二:推到 git 后按 ref 安装
pi install git:github.com/<you>/pi-caffeinate@v1

# 方式三:symlink 单文件到全局扩展目录(无需 settings.json)
ln -s /path/to/pi-caffeinate/extensions/caffeinate.ts ~/.pi/agent/extensions/caffeinate.ts
```

## 已知边界

pi 被 `kill -9` 强杀时 `session_shutdown` 不会触发,caffeinate 子进程会成为孤儿进程继续阻止睡眠。改进方向:spawn 时改用 `caffeinate -di -w <pi-pid>`,让 caffeinate 自行监听 pi 进程退出。
