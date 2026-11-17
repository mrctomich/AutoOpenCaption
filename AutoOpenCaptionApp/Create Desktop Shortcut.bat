@echo off
title AutoOpenCaption - Desktop Shortcut
REM Creates a desktop shortcut that starts AutoOpenCaption with its own icon.
REM (Windows cannot store a custom icon inside a .bat file itself, so the
REM shortcut carries the icon instead.)

set "TARGET=%~dp0Start AutoOpenCaption.bat"
set "ICON=%~dp0icons\AutoOpenCaption-icon.ico"

if not exist "%ICON%" (
    echo Icon file not found: "%ICON%"
    echo Re-extract the AutoOpenCaption zip without moving individual files.
    pause >nul
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoOpenCaption.lnk')); $lnk.TargetPath = '%TARGET%'; $lnk.WorkingDirectory = '%~dp0.'; $lnk.IconLocation = '%ICON%,0'; $lnk.Description = 'Start AutoOpenCaption'; $lnk.Save()"

if errorlevel 1 (
    echo Could not create the desktop shortcut.
    pause >nul
    exit /b 1
)

echo Desktop shortcut "AutoOpenCaption" created with the app icon.
timeout /t 3 /nobreak >nul
