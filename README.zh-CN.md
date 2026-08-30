# pi-espresso ☕️

[English](README.md) | 简体中文

一个 [pi](https://pi.dev) 扩展:agent 工作期间保持 Mac 唤醒——**连显示器一起**——并在终端标题加上 ☕️,一眼可见。

名字就是功能清单:大多数防休眠扩展只跑 `caffeinate -i`(阻止系统空闲睡眠),pi-espresso 则是一份**双份浓缩**——`-d -i`,连屏幕一起管。agent 一停下来,Mac 立刻恢复自主入睡,不留任何残留。

## 为什么需要它

pi 一跑起来经常是好几分钟——大型重构、测试套件、多步任务。人一走开,macOS 就会熄屏甚至整机入睡,任务被打断。合盖、手动睡眠这些主动操作应当始终生效;只有**无人值守的空闲路径**应该在 agent 运行期间被挂起。

## 工作原理

扩展监听 pi 的 agent 生命周期事件,围绕它们管理一个 `caffeinate` 子进程:

| 事件 | 动作 |
|------|------|
| `agent_start` | 启动 `caffeinate -di`,设置 ☕️ 标题标记 |
| `agent_settled` | `SIGTERM` 终止 caffeinate 并还原标题。`agent_settled` 只在 pi 确定不会自动继续时触发——自动重试、自动压缩、排队的后续消息期间断言持续存在,间隙不会抖动 |
| `session_info_changed` / `session_start` | 若 caffeinate 仍在运行,短暂延迟后重新断言 ☕️ 标题(pi 在 `/name` 改名、切换/新建/恢复/fork 会话时会重写标题) |
| `session_shutdown` | 兜底清理 |

- `-d` 阻止**显示器**熄屏;`-i` 阻止**系统空闲**睡眠。
- 非 macOS 平台完全 no-op——跨机器同步无副作用。
- 标题操作受 `ctx.hasUI` 保护,print/JSON 模式下自动跳过。

## 终端标题标记

caffeinate 运行期间,终端标题变为:

```
☕️ π - [会话名 - ]目录名
```

与 pi 原生标题格式完全一致,仅加前缀。标记在 `agent_start` 时设置,`agent_settled` 时还原。由于 pi 会在改名和切换会话时自行重写标题,扩展在断言存活期间监听 `session_info_changed` 和 `session_start`,延迟 50ms 重新断言(确保总是落在 pi 自身 handler 之后)。

## 环境要求

- **macOS** —— `caffeinate` 是 macOS 自带的,无需额外安装。
- **pi** —— 任意较新版本;只使用公开的扩展 API。

## 安装

```bash
# 方式一:从本地路径安装(记录到 ~/.pi/agent/settings.json)
pi install /path/to/pi-espresso

# 方式二:从 git 仓库按 ref 安装
pi install git:github.com/<you>/pi-espresso@v1

# 方式三:把单文件 symlink 进全局扩展目录
ln -s /path/to/pi-espresso/extensions/espresso.ts ~/.pi/agent/extensions/espresso.ts
```

然后重启 pi,或在已打开的会话里执行 `/reload`。

## 和 `pi-caffeinate` 有什么不同?

[`pi-caffeinate`](https://www.npmjs.com/package/pi-caffeinate) 是个成熟的跨平台扩展,但在熄屏问题上做了相反的取舍:

| | pi-caffeinate | pi-espresso |
|---|---|---|
| 平台 | macOS / Linux / Windows | 仅 macOS(其余 no-op) |
| 显示器熄屏 | 刻意不受影响 | **agent 运行期间阻止** |
| 参数 | `caffeinate -i` | `caffeinate -di` |
| 停止时机 | `agent_end`(排队消息和重试的间隙会反复启停) | `agent_settled`(无抖动) |
| 崩溃清理 | `process.on("exit")` 兜底 | 仅 `session_shutdown` |
| 标题标记 | 无 | ☕️,且在 pi 重写后自动重新断言 |

如果你想保持熄屏行为不变,用 `pi-caffeinate`;如果你的痛点是任务跑到一半屏幕变黑,那就是这个。

## 已知限制

- **`kill -9`**:`SIGKILL` 无事件可捕获,caffeinate 会变成孤儿进程,持续阻止睡眠直到手动 kill。改进思路:用 `caffeinate -di -w <pi-pid>` 启动,让 caffeinate 自己监听 pi 的 pid、随之退出。(`pi-caffeinate` 的 `process.on("exit")` 兜底覆盖了崩溃、SIGINT、SIGTERM——值得借鉴;但 SIGKILL 谁也拦不住。)
- **定制品牌的 pi 构建**:标题按 `π - …` 组合以匹配 pi 默认的 `APP_TITLE`。如果你的 pi 构建通过 `piConfig.name` 改了名,组合出的标题会略有出入,直到下一次 pi 主动重写标题时自愈。

## 开发

```
pi-espresso/
├── extensions/
│   └── espresso.ts    # 全部实现(单文件,零运行时依赖)
├── package.json       # pi 包清单
└── README.md
```

- 语法检查:`node --check extensions/espresso.ts`
- 运行时只依赖 Node 内置模块;对 `@earendil-works/pi-coding-agent` 的导入是纯类型导入。
- 本地使用:symlink `extensions/espresso.ts` 到 `~/.pi/agent/extensions/` 后直接在仓库里改,pi 的加载器支持 symlink。

## 许可证

[MIT](LICENSE) © fxtack
