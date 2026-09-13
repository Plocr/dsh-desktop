# Reasonix v1.36.0 侧边栏设计规格（供 ui-dashboard 右侧栏改造参照）

> 提取自 `E:\Deepseek-Reasonix\Reasonix\versions\v1.36.0\reasonix-desktop.exe`
> （Wails shell / Go kernel / Vite 前端内嵌资源，:root CSS 变量 + 组件名还原）。
> 用途：ui-dashboard 右侧 `details` 栏按 Reasonix 侧边栏的内容维度、
> 布局语义与视觉基调改造。参照内容维度，不追求像素级一致。

## 1. 视觉基调（设计 token）

| token | 值 | 语义 |
| --- | --- | --- |
| `--bg` | `#090a0c` | 页面底（最深） |
| `--bg-soft` | `#111319` | 次级面板底 |
| `--bg-elev` | `#191b22` | 抬升面板底 |
| `--bg-elev-2` | `#222631` | 再抬升（输入框/hover 层） |
| **`--sidebar-bg`** | **`#0c0e12`** | **侧边栏专属底：比主背景更暗一档，形成「嵌入式内凹」** |
| `--sidebar-hover` | `#181c24` | 条目 hover |
| `--sidebar-active` | `color-mix(in srgb, var(--accent) 10%, …)` | 激活条目：accent 10% 淡染 |
| `--border` | `#343945` | 主边框 |
| `--border-soft` | `#252a34` | 细分隔 |
| `--fg` | `#f4f5f7` | 主文字 |
| `--fg-dim` | `#c0c4cc` | 次级文字 |
| `--fg-faint` | `#858b96` | 弱文字（时间戳/角标） |
| `--accent` | 橙 `#d97757` 系（多主题变体含青/蓝/紫） | 强调：激活条、进度、关键数字 |
| `--theme-row-h` | `34px` | 条目基准行高 |
| `--theme-density-pad/gap` | `10px` | 密度间距 |

侧边栏结构变量：`--sidebar-width` / `--sidebar-expanded-width`（折叠⇄展开两档）、
`--sidebar-topic-indent`（会话层级缩进）、`--sidebar-topic-marker-gutter`（状态标记列）、
`--sidebar-topic-time-col`（时间列）、`--sidebar-workbench-active-border`、`--topicbar-height`。

## 2. 侧边栏内容维度（自上而下）

Reasonix 侧边栏以「会话（topic）列表」为核心，附工作台区：

1. **话题列表**（核心区，可滚动）：
   - 条目 = 标题（两行截断）+ 时间列（`--sidebar-topic-time-col`，弱文字）
   - 层级缩进（`--sidebar-topic-indent`）：多轮/子话题缩进展示
   - 状态标记 gutter（`--sidebar-topic-marker-gutter`）：进行中/未读/完成等圆点或小竖条
   - 悬停/激活态：`--sidebar-hover` 底色 + `--sidebar-active` 淡染 + 左侧激活竖条
2. **固定（pinned）与归档（archive）分组**：会话可按固定/归档归类，组头可折叠
3. **工程树（workbench）**：项目目录树（`project-tree__folder-icon` 文件夹图标），
   选中态 = `--workspace-selection-bg/--workspace-selection-bar`（accent 条）
4. **动作**：新建会话（新对话）、删除话题（DeleteTopic）、重命名话题（RenameTopic）、
   归档/固定；上下文菜单操作

Go kernel 侧会话元数据文件：`desktop-topic-titles.json` / `desktop-topic-created-at.json` /
`desktop-topic-title-sources.json`（自动标题来源）、`desktop-topic-auto-title-meta.json`。

## 3. 对 ui-dashboard 右侧栏的映射建议

| Reasonix 维度 | ui-dashboard 现卡片 | 改造方向 |
| --- | --- | --- |
| 会话列表语义（时间列/标记） | 会话统计/工作区卡 | 统计数字用 accent 强调 + 弱文字时间戳、层级缩进 |
| 状态标记 gutter | 上下文圆环占位 | 卡片头部加状态竖条（进行中=accent 圆点） |
| hover/active 淡染 | 无（静态卡片） | 卡片 hover 底 `#181c24`、激活条 accent 10% 淡染 |
| pinned/archive 分组 | 目标/待办/任务卡 | 组标题弱文字 + 可折叠分组头 |
| workbench 工程树 | 文件树页（已有 tab） | 文件树选中态用 accent 条 |
| 密度 | 卡片间距较大 | 按 `--theme-row-h:34px`、pad/gap 10px 收紧 |

样式基调：侧边栏底比主区暗一档（内凹感）、accent 橙色系（与官方 `#d97757` 近似）、
弱文字三级灰阶（fg / fg-dim / fg-faint）、1px `--border-soft` 分隔。