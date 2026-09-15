; DSH Desktop NSIS 定制脚本（electron-builder `nsis.include`）。
;
; 适配自 DeepSeek Harness 官方桌面端（MIT License）：
;   apps/desktop/scripts/installer.nsh
; 上游项目：DeepSeek Harness（apps/desktop）。本文件是衍生作品，遵循同一 MIT 许可。
;
; 与上游保持一致，只做一件事：customInstall 结束时清掉 7z 解压临时目录
; `$PLUGINSDIR\7z-out`。Finish 页可以立刻启动应用，而 NSIS 之后还要清理
; $PLUGINSDIR；残留的插件解压目录既占空间，也可能与应用启动抢文件。
;
; 不使用任何注册表键（上游同样不使用）；错误标志按上游语义保存/还原：
; electron-builder 后续的安装脚本仍要靠 `Errors` 判断前面步骤是否失败，
; 这里先取出、再按原值恢复，避免误报或吞掉真实错误。
; 幂等：不修改安装目录树，不创建快捷方式（快捷方式由 electron-builder 生成）。

!include "LogicLib.nsh"

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
