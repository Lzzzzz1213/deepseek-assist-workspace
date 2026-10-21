; =====================================================================
; DeepSeek协助工作区 · Windows x64 安装/卸载脚本（NSIS 3.x Unicode）
; 说明：只安装到当前用户目录，不请求管理员权限；不联网、不自动下载、
;       不写开机启动、不调用任何模型服务；不声称任何官方产品。
; 编译期参数（由主构建脚本 Build-Installer.ps1 提供）：
;   PRODUCT_VERSION   版本号，例如 1.0.0
;   INSTALLER_OUT     输出 EXE 的绝对路径
;   INSTALL_FILES     主线程从发布白名单生成的安装清单 .nsh（SetOutPath + File）
;   UNINSTALL_FILES   主线程生成的卸载清单 .nsh（精确 Delete + 非递归 RMDir）
; 本脚本不包含 File /r、不包含 RMDir /r，也不自行拼接通配清理。
; 编码：本文件按 UTF-8 保存（带 BOM）。若编译时中文出现乱码，请确认 BOM
;       未被编辑器去除，或使用 makensis -INPUTCHARSET UTF8 编译。
; =====================================================================

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; ------------------------------ 编译期参数 ------------------------------
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.0"
!endif
!ifndef INSTALLER_OUT
  !error "缺少 INSTALLER_OUT：请用 /DINSTALLER_OUT=<绝对输出exe> 指定安装包输出路径"
!endif
!ifndef INSTALL_FILES
  !error "缺少 INSTALL_FILES：请用 /DINSTALL_FILES=<安装清单nsh> 指定主线程生成的安装清单"
!endif
!ifndef UNINSTALL_FILES
  !error "缺少 UNINSTALL_FILES：请用 /DUNINSTALL_FILES=<卸载清单nsh> 指定主线程生成的卸载清单"
!endif

; ------------------------------ 产品信息 ------------------------------
!define PRODUCT_NAME "DeepSeek协助工作区"
!define PRODUCT_PUBLISHER "个人协作工具"
!define PRODUCT_VERSION_FOUR "${PRODUCT_VERSION}.0"
!define APP_REG_KEY "Software\DeepSeekAssistWorkspace"
!define UNINST_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekAssistWorkspace"
!define MAIN_EXE "Workroom.exe"
!define HOST_EXE "host\WorkroomHost.exe"
!define UNINST_EXE "Uninstall.exe"
!define WINDOW_TITLE "DeepSeek协助工作区"
!define LEGACY_WINDOW_TITLE "DeepSeek协助工作区"
!define STARTMENU_FOLDER "DeepSeek协助工作区"
!define DEFAULT_INSTALL_DIR "$LOCALAPPDATA\Programs\DeepSeekAssistWorkspace"

Name "${PRODUCT_NAME}"
Caption "${PRODUCT_NAME}"

OutFile "${INSTALLER_OUT}"
InstallDir "${DEFAULT_INSTALL_DIR}"
InstallDirRegKey HKCU "${APP_REG_KEY}" "InstallDir"

RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck force

VIProductVersion "${PRODUCT_VERSION_FOUR}"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=2052 "FileDescription" "DeepSeek协助工作区 - 本机个人协作工具 Windows x64 客户端安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION_FOUR}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "本机个人协作工具，不属于任何官方发行版"

; ------------------------------ 界面文本 ------------------------------
!define MUI_ABORTWARNING
!define MUI_ICON "${__FILEDIR__}\..\web\assets\app\workroom.ico"
!define MUI_UNICON "${__FILEDIR__}\..\web\assets\app\workroom.ico"

!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${PRODUCT_NAME}"
!define MUI_WELCOMEPAGE_TEXT "“${PRODUCT_NAME}”是一款可直接在 Windows 运行的个人协作工具，用于在本机查看协作记录。$\r$\n$\r$\n安装只面向当前用户，不需要管理员权限，不会联网下载，也不会调用模型服务。$\r$\n$\r$\n聊天记录保存在 AppData，卸载时予以保留。$\r$\n$\r$\n单击“下一步”继续。"

!define MUI_DIRECTORYPAGE_TEXT_TOP "“${PRODUCT_NAME}”将安装到当前用户目录，无需管理员权限。也可以单击“浏览”选择其它子目录；请勿选择磁盘根目录、Windows 目录或用户配置目录本身。"

!define MUI_FINISHPAGE_TITLE "“${PRODUCT_NAME}”安装完成"
!define MUI_FINISHPAGE_TEXT "“${PRODUCT_NAME}”已安装，可直接在 Windows 运行。$\r$\n$\r$\n聊天记录保存在 AppData，卸载时予以保留。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAIN_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "运行 ${PRODUCT_NAME}"

!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将移除“${PRODUCT_NAME}”（仅当前用户安装）的程序文件、快捷方式与本产品注册表项。$\r$\n$\r$\n聊天记录保存在 AppData，卸载时予以保留。"

; ------------------------------ 向导页面 ------------------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE CheckInstallDirPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 仅中文界面，不提供语言选择对话框
!insertmacro MUI_LANGUAGE "SimpChinese"

; ------------------------------ 变量 ------------------------------
Var ValidateError   ; 安装目录校验结果：空字符串表示合格
Var gRunning        ; 运行中检查结果：1 表示本产品正在运行

; =====================================================================
; 安装目录校验：结果写入 $ValidateError
; 拒绝：空目录、盘符根目录、当前盘根目录、UNC 共享根、$PROFILE、$WINDIR、
;       $SYSDIR、$LOCALAPPDATA 本身；正常子目录（含空格与中文）允许通过。
; 目录选择页回调、安装 Section 开头和静默 /D 场景都会调用本函数。
; 为避免影响 MUI 页面内部使用的低编号寄存器，这里只使用 $6-$9 / $R6-$R9。
; =====================================================================
Function CheckInstallDir
  StrCpy $ValidateError ""
  StrCmp $INSTDIR "" check_dir_empty

  ; 归一化：去掉末尾反斜杠，便于精确比较
  ; Win32 归一化不要求目标已存在，允许首次安装时创建新目录。
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r17, p 0) i .r16'
  StrCmp $R6 0 check_dir_empty
  IntCmp $R6 ${NSIS_MAX_STRLEN} check_dir_empty 0 check_dir_empty
  StrCmp $R7 "" check_dir_empty
check_dir_strip:
  StrCpy $6 $R7 1 -1
  StrCmp $6 "\" 0 check_dir_stripped
  StrCpy $R7 $R7 -1
  Goto check_dir_strip
check_dir_stripped:
  StrCmp $R7 "" check_dir_root
  StrCpy $6 $R7 1 -1
  StrCmp $6 ":" check_dir_root       ; C:、D: 这类盘符根
  StrCmp $R7 "/" check_dir_root

  ; UNC 共享根 \\服务器\共享 也是根目录
  StrCpy $6 $R7 2
  StrCmp $6 "\\" 0 check_dir_system
  StrCpy $R8 $R7 "" 2
  StrLen $7 $R8
  StrCpy $8 0
  StrCpy $9 0
check_dir_unc_loop:
  StrCmp $9 $7 check_dir_unc_done
  StrCpy $6 $R8 1 $9
  StrCmp $6 "\" 0 check_dir_unc_next
  IntOp $8 $8 + 1
check_dir_unc_next:
  IntOp $9 $9 + 1
  Goto check_dir_unc_loop
check_dir_unc_done:
  IntCmp $8 2 check_dir_system check_dir_root check_dir_system

check_dir_system:
  ; StrCmp 不区分大小写，适合做路径精确比较
  StrCmp $R7 "$PROFILE" check_dir_system_hit
  StrCmp $R7 "$WINDIR" check_dir_system_hit
  StrCmp $R7 "$SYSDIR" check_dir_system_hit
  StrCmp $R7 "$LOCALAPPDATA" check_dir_system_hit
  Return

check_dir_empty:
  StrCpy $ValidateError "安装目录不能为空。请选择当前用户目录下的子目录。"
  Return
check_dir_root:
  StrCpy $ValidateError "不能把“${PRODUCT_NAME}”安装到磁盘或共享根目录，请选择其下的子目录（例如 $LOCALAPPDATA\Programs\DeepSeekAssistWorkspace）。"
  Return
check_dir_system_hit:
  StrCpy $ValidateError "不能把“${PRODUCT_NAME}”直接安装到 Windows、系统目录或用户配置目录本身，请选择这些目录下的子目录。"
  Return
FunctionEnd

; 目录选择页离开时强制复核（不允许仅靠页面本身放行）
Function CheckInstallDirPageLeave
  Call CheckInstallDir
  StrCmp $ValidateError "" check_dir_leave_done
  MessageBox MB_ICONEXCLAMATION|MB_OK "$ValidateError"
  Abort
check_dir_leave_done:
FunctionEnd

; 目录选择页每次变化时复核，保持 $ValidateError 为最新状态
Function .onVerifyInstDir
  Call CheckInstallDir
  StrCmp $ValidateError "" verify_dir_done
  Abort
verify_dir_done:
FunctionEnd

; =====================================================================
; 运行中检查：按精确窗口标题查找本产品主窗口（含被隐藏到托盘的情况，
; 此时用安装目录内程序文件的写入占用做补充判定）。
; 结果写入 $gRunning：1 = 正在运行。不结束任何进程，也不调用 --exit。
; =====================================================================
Function CheckWorkroomRunning
  StrCpy $gRunning 0

  FindWindow $R5 "" "${WINDOW_TITLE}"
  StrCmp $R5 0 0 check_running_found
  FindWindow $R5 "" "${LEGACY_WINDOW_TITLE}"
  StrCmp $R5 0 check_running_file
check_running_found:
  StrCpy $gRunning 1
  Return

check_running_file:
  ; 追加方式打开：不截断、不创建文件，仅用于判断是否被运行中的程序占用
  IfFileExists "$INSTDIR\${MAIN_EXE}" 0 check_running_host
  FileOpen $R5 "$INSTDIR\${MAIN_EXE}" "a"
  StrCmp $R5 "" check_running_locked
  FileClose $R5
check_running_host:
  IfFileExists "$INSTDIR\${HOST_EXE}" 0 check_running_done
  FileOpen $R5 "$INSTDIR\${HOST_EXE}" "a"
  StrCmp $R5 "" check_running_locked
  FileClose $R5
check_running_done:
  Return
check_running_locked:
  StrCpy $gRunning 1
  Return
FunctionEnd

; 正在运行时的统一处理：非静默提示从托盘退出，静默直接非零退出
Function AbortIfRunning
  Call CheckWorkroomRunning
  StrCmp $gRunning 1 0 abort_if_running_done
  IfSilent abort_if_running_quiet
  MessageBox MB_ICONEXCLAMATION|MB_OK "检测到“${PRODUCT_NAME}”正在运行（可能已最小化到任务栏通知区域）。$\r$\n$\r$\n请右键单击通知区域的“${PRODUCT_NAME}”图标并选择“退出”，然后重试。"
abort_if_running_quiet:
  SetErrorLevel 2
  Abort
abort_if_running_done:
FunctionEnd

; ------------------------------ 卸载侧同名函数 ------------------------------
Function un.CheckWorkroomRunning
  StrCpy $gRunning 0

  FindWindow $R5 "" "${WINDOW_TITLE}"
  StrCmp $R5 0 0 un_check_running_found
  FindWindow $R5 "" "${LEGACY_WINDOW_TITLE}"
  StrCmp $R5 0 un_check_running_file
un_check_running_found:
  StrCpy $gRunning 1
  Return

un_check_running_file:
  IfFileExists "$INSTDIR\${MAIN_EXE}" 0 un_check_running_host
  FileOpen $R5 "$INSTDIR\${MAIN_EXE}" "a"
  StrCmp $R5 "" un_check_running_locked
  FileClose $R5
un_check_running_host:
  IfFileExists "$INSTDIR\${HOST_EXE}" 0 un_check_running_done
  FileOpen $R5 "$INSTDIR\${HOST_EXE}" "a"
  StrCmp $R5 "" un_check_running_locked
  FileClose $R5
un_check_running_done:
  Return
un_check_running_locked:
  StrCpy $gRunning 1
  Return
FunctionEnd

Function un.AbortIfRunning
  Call un.CheckWorkroomRunning
  StrCmp $gRunning 1 0 un_abort_if_running_done
  IfSilent un_abort_if_running_quiet
  MessageBox MB_ICONEXCLAMATION|MB_OK "检测到“${PRODUCT_NAME}”正在运行（可能已最小化到任务栏通知区域）。$\r$\n$\r$\n请右键单击通知区域的“${PRODUCT_NAME}”图标并选择“退出”，然后重试卸载。"
un_abort_if_running_quiet:
  SetErrorLevel 2
  Abort
un_abort_if_running_done:
FunctionEnd

; =====================================================================
; 安装初始化
; =====================================================================
Function .onInit
  SetRegView 64
  SetShellVarContext current

  ; 只支持 64 位 Windows
  ${If} ${RunningX64}
    DetailPrint "已确认 64 位 Windows。"
  ${Else}
    IfSilent init_x64_quiet
    MessageBox MB_ICONSTOP|MB_OK "“${PRODUCT_NAME}”是 Windows x64 客户端，只支持 64 位 Windows。"
init_x64_quiet:
    SetErrorLevel 3
    Abort
  ${EndIf}

  ; 安装目录保护：目录选择页之外的入口（含静默 /D）同样复核
  Call CheckInstallDir
  StrCmp $ValidateError "" init_dir_ok
  IfSilent init_dir_quiet
  MessageBox MB_ICONSTOP|MB_OK "$ValidateError"
init_dir_quiet:
  SetErrorLevel 4
  Abort
init_dir_ok:

  ; 本产品正在运行时不覆盖安装
  Call AbortIfRunning
FunctionEnd

; =====================================================================
; 主程序（必需）
; =====================================================================
Section "主程序（必需）" SEC_MAIN
  SectionIn RO

  ; Section 开头再次复核安装目标（静默 /D 也必须受保护）
  Call CheckInstallDir
  StrCmp $ValidateError "" sec_main_dir_ok
  IfSilent sec_main_dir_quiet
  MessageBox MB_ICONSTOP|MB_OK "$ValidateError"
sec_main_dir_quiet:
  SetErrorLevel 4
  Abort
sec_main_dir_ok:
  Call AbortIfRunning

  ; 安装文件清单由主构建脚本生成（SetOutPath + File），此处只 include
  ClearErrors
  !include "${INSTALL_FILES}"
  IfErrors sec_main_files_failed

  WriteUninstaller "$INSTDIR\${UNINST_EXE}"

  ; 记录安装目录（仅本产品键）
  WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir" "$INSTDIR"

  ; 当前用户开始菜单：启动与卸载快捷方式
  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\${STARTMENU_FOLDER}"
  CreateShortCut "$SMPROGRAMS\${STARTMENU_FOLDER}\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${STARTMENU_FOLDER}\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINST_EXE}" "" "$INSTDIR\${UNINST_EXE}" 0

  ; 控制面板“应用”列表信息（只写本产品卸载键）
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayIcon" "$INSTDIR\${MAIN_EXE}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_REG_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoRepair" 1
  Goto sec_main_done
sec_main_files_failed:
  IfSilent sec_main_files_quiet
  MessageBox MB_ICONSTOP|MB_OK "部分程序文件未能安装，请退出正在运行的客户端后重新安装。"
sec_main_files_quiet:
  SetErrorLevel 6
  Abort
sec_main_done:
SectionEnd

; =====================================================================
; 桌面快捷方式（可选；静默安装跳过，避免干扰自动化验收）
; =====================================================================
Section "桌面快捷方式" SEC_DESKTOP
  IfSilent sec_desktop_done
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${MAIN_EXE}" "" "$INSTDIR\${MAIN_EXE}" 0
  WriteRegDWORD HKCU "${APP_REG_KEY}" "DesktopShortcut" 1
sec_desktop_done:
SectionEnd

; =====================================================================
; 卸载初始化：确认是本产品的卸载器，且本产品未在运行
; =====================================================================
Function un.onInit
  SetRegView 64
  SetShellVarContext current

  ; 被复制到别处的卸载器找不到本产品文件时直接中止
  IfFileExists "$INSTDIR\${MAIN_EXE}" 0 un_init_invalid
  IfFileExists "$INSTDIR\${HOST_EXE}" 0 un_init_invalid
  ReadRegStr $R0 HKCU "${APP_REG_KEY}" "InstallDir"
  StrCmp $R0 $INSTDIR un_init_target_ok
un_init_invalid:
  IfSilent un_init_invalid_quiet
  MessageBox MB_ICONSTOP|MB_OK "未在安装目录中找到“${PRODUCT_NAME}”的程序文件，这个卸载程序不属于本产品安装，已取消卸载。"
un_init_invalid_quiet:
  SetErrorLevel 5
  Abort
un_init_target_ok:

  Call un.AbortIfRunning
FunctionEnd

; =====================================================================
; 卸载：精确删除清单中的文件、本产品快捷方式与两个产品注册表键；
; 只对开始菜单文件夹和安装目录做非递归 RMDir，不触碰 AppData 中的
; CodexDeepSeekHelper、DeepSeekAssistWorkspace 或任何用户新增文件。
; =====================================================================
Section "Uninstall"
  SetShellVarContext current
  SetRegView 64

  ; 卸载文件清单由主构建脚本生成（精确 Delete + 各子目录非递归 RMDir）
  !include "${UNINSTALL_FILES}"

  ; 本产品快捷方式
  Delete "$SMPROGRAMS\${STARTMENU_FOLDER}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${STARTMENU_FOLDER}\卸载 ${PRODUCT_NAME}.lnk"
  ReadRegDWORD $R0 HKCU "${APP_REG_KEY}" "DesktopShortcut"
  ${If} $R0 == 1
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${EndIf}
  RMDir "$SMPROGRAMS\${STARTMENU_FOLDER}"

  ; 卸载器自身与安装目录（非递归；目录非空则保留）
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"

  ; 仅删除本产品自己的两个注册表键
  DeleteRegKey HKCU "${UNINST_REG_KEY}"
  DeleteRegKey HKCU "${APP_REG_KEY}"
SectionEnd

; ------------------------------ 组件说明 ------------------------------
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} "DeepSeek协助工作区客户端及其本机所需文件。必需组件。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "在当前用户桌面创建“DeepSeek协助工作区”快捷方式。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END
