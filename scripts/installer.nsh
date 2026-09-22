; DSH Desktop NSIS 定制脚本（electron-builder `nsis.include`）。
;
; 适配自 DeepSeek Harness 官方桌面端（MIT License）：
;   apps/desktop/scripts/installer.nsh
; 上游项目：DeepSeek Harness（apps/desktop）。本文件是衍生作品，遵循同一 MIT 许可。
;
; 本文件由 electron-builder 作为**公共脚本头**插入（早于 installer.nsi 与 MUI 页面
; 定义），因此这里可以：
;   1. 定义 MUI2 的页面外观（欢迎页/目录页/完成页文案、进度条样式）——这些 `!define`
;      必须在页面插入之前生效，放在其它钩子里就晚了；
;   2. 提供 `customWelcomePage` / `customInstall` 等钩子宏（electron-builder 在
;      assistedInstaller.nsh 的对应位置 `!ifmacrodef` 调用）。
;
; 外观之外的行为与上游保持一致，只做一件事：customInstall 结束时清掉 7z 解压临时目录
; `$PLUGINSDIR\7z-out`。Finish 页可以立刻启动应用，而 NSIS 之后还要清理
; $PLUGINSDIR；残留的插件解压目录既占空间，也可能与应用启动抢文件。
;
; 不使用任何注册表键（上游同样不使用）；错误标志按上游语义保存/还原：
; electron-builder 后续的安装脚本仍要靠 `Errors` 判断前面步骤是否失败，
; 这里先取出、再按原值恢复，避免误报或吞掉真实错误。
; 幂等：不修改安装目录树，不创建快捷方式（快捷方式由 electron-builder 生成）。

!include "LogicLib.nsh"

; ── 安装向导外观 ────────────────────────────────────────────────────────

; 关闭向导时二次确认（避免误触「取消」把安装中断在半途）
!define MUI_ABORTWARNING

; 进度条：smooth（连续）比默认的 colored（绿色分块）更接近现代应用；
; 页头/侧栏品牌图由 electron-builder 的 installerHeader / installerSidebar 注入。
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; 欢迎页：electron-builder 的 assisted installer 默认**没有**欢迎页（直接进目录选择），
; 这里补一页，用侧栏品牌图 + 三行说明把「自带运行时、离线可用」讲清楚。
!define MUI_WELCOMEPAGE_TITLE "安装 DSH Desktop"
!define MUI_WELCOMEPAGE_TEXT "DSH Desktop 是 DeepSeek Harness 的桌面工作台。$\r$\n$\r$\n运行时（Node.js、harness、pnpm）已随安装包内置，安装后离线即可使用，无需另行安装 Node.js 或全局 dsh。$\r$\n$\r$\n点击「下一步」开始安装。"

; 目录页：说明体积与卸载边界（用户最关心的两件事）
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 DSH Desktop 的安装位置。安装后约 600 MB（内置完整运行时与依赖），卸载不会删除你的会话与设置。"

; 完成页：说明下一步会发生什么 + 一键启动
!define MUI_FINISHPAGE_TITLE "DSH Desktop 已安装"
!define MUI_FINISHPAGE_TEXT "首次启动会自动创建桌面 profile 并引导内嵌 harness（约几秒，无需联网）。$\r$\n$\r$\n会话、工作区与凭据保存在 $APPDATA\DSH Desktop 下，重装或升级不会丢失。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 DSH Desktop"

; 卸载确认页：明确「只删程序，不删数据」
!define MUI_UNCONFIRMPAGE_TEXT_TOP "将从本机移除 DSH Desktop 的程序文件。$\r$\n$\r$\n你的会话、工作区、插件与凭据保存在 $APPDATA\DSH Desktop 下，卸载不会删除它们（如需彻底清理请手动删除该目录）。"

; 补一页欢迎页（MUI_PAGE_WELCOME 必须在目录页之前插入）
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── 安装动作（与上游一致） ──────────────────────────────────────────────

!macro customInstall
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  ; Finish can launch the app while NSIS removes its remaining plugin directory.
  RMDir /r "$PLUGINSDIR\7z-out"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
!macroend
