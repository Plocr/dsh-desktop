# better-setting

DSH Desktop 更好的设置中心插件（插件管理 + 个性化设置）。

## 功能

### 插件管理（设置 → 插件）
- **官方插件**：harness 已加载插件（pluginInventory 只读投影，运行状态徽章，按分类聚合）
- **Desktop 插件**：随安装包内置（启停开关，bridge 锁定）
- **用户插件**：用户安装（启用/停用/删除）
- **插件市场**：GitHub `topic:dsh-plugin` 生态，默认 Top 15（按 star），可搜索/安装

### 个性化（设置 → 通用设置 → 外观 下方二级菜单）
- **皮肤**：默认 / 深海 / 石墨 / 晨雾 四套整体色调预设（互斥，token 级覆盖）
- **主题配色**：强调色预设 + 自定义取色器 + 恢复默认
- **壁纸**：
  - 自上传：图片（png/jpg/gif/webp/svg）、视频（mp4/webm/mov）、HTML 壁纸
  - **Wallpaper Engine**：自动发现本机 WE 安装（Steam 注册表 + `libraryfolders.vdf`），
    枚举 workshop 与默认/我的项目的 **Video / Web** 类型壁纸（Scene/Application 无法内嵌）
  - 媒体经宿主 `webServer` 同源路由流式加载（`/dsh-desktop-wallpapers/inventory` +
    `media/<token>`，支持 Range 拖动/seek），不走 base64
- **旋钮**（壁纸激活后显示，即时生效）：壁纸模糊 0-60px / 暗化 0-90% / 边框 0-90% / 玻璃 0-40px
- **液态玻璃**（壁纸激活时自动启用，iOS 风格）：面板与气泡半透明化 +
  `backdrop-filter: blur + saturate + brightness` + 顶部高光 + 软阴影，
  实现参考 [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)

个性化设置持久化在壳 `settings.json` 的 `personalization` 字段（经宿主 `/pm-rpc`）。

## 架构

- **宿主** `lib/index.js`：connection RPC `/pm-rpc`（插件列表/启停/市场/个性化读写/壁纸 CRUD）+
  `webServer` 壁纸媒体路由（inventory JSON + Range 流式文件服务）
- **客户端** `lib/client.js`（由 `src/client.js` 经 `node build-client.js` 生成）：
  插件 tab、个性化设置行（`settings.general.item` order 11）、
  全局应用器（`shell.overlay` 常驻渲染 null，负责 token 覆盖 / 壁纸层 / 遮罩 / CSS 变量落地）

## 构建

```sh
node build-client.js   # 从 src/client.js 重新生成 lib/client.js
```

测试：`node --test test/personalization.test.mjs`（宿主个性化持久化 + 壁纸 CRUD + inventory）。
