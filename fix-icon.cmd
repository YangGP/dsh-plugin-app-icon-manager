@ECHO OFF
REM ===========================================================================
REM DSH app icon - fix/restore launcher.
REM
REM Why this wrapper exists: this machine's execution policy is RemoteSigned and
REM fix-icon.ps1 has no digital signature, so running the .ps1 directly is
REM refused ("is not digitally signed"). Only -ExecutionPolicy Bypass gets past
REM it. Double-clicking this .cmd passes that switch for you.
REM
REM Usage:
REM   fix-icon.cmd                recreate the shortcut files with a PNG icon (default)
REM   fix-icon.cmd list           show the icon library and current shortcut icons
REM   fix-icon.cmd apply <name>   apply one library icon (png or ico)
REM   fix-icon.cmd restore        restore the original icons
REM   fix-icon.cmd clear          only rebuild the Windows icon cache
REM ===========================================================================
SETLOCAL
SET "ACTION=%~1"
IF "%ACTION%"=="" SET "ACTION=recreate"
SET "ICONNAME=%~2"

SET "SCRIPT=%~dp0fix-icon.ps1"
IF NOT EXIST "%SCRIPT%" (
  ECHO [ERROR] fix-icon.ps1 not found next to this launcher:
  ECHO         %SCRIPT%
  PAUSE
  EXIT /B 1
)

IF /I "%ACTION%"=="apply" (
  IF "%ICONNAME%"=="" (
    ECHO [ERROR] "apply" needs an icon name, for example:
    ECHO         fix-icon.cmd apply dsh-icon-v3
    ECHO         run "fix-icon.cmd list" to see available names
    PAUSE
    EXIT /B 1
  )
  ECHO Running: fix-icon.ps1 -Action apply -IconName %ICONNAME%
  ECHO.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action apply -IconName "%ICONNAME%"
) ELSE (
  ECHO Running: fix-icon.ps1 -Action %ACTION%
  ECHO.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action %ACTION%
)
SET "CODE=%ERRORLEVEL%"

ECHO.
IF "%CODE%"=="0" (ECHO Done.) ELSE (ECHO Finished with exit code %CODE%.)
ECHO.
PAUSE
EXIT /B %CODE%
