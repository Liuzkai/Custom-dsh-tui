@echo off
REM `dst` is the short alias npm installs for the very same dsh-tui launcher.
REM Route it through the sync shim so both spellings get the tt-switch refresh.
call "%~dp0dsh-tui.cmd" %*
exit /b %ERRORLEVEL%
