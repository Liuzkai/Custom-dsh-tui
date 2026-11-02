@echo off
REM ---------------------------------------------------------------------------
REM dsh-tui launcher shim.
REM
REM Lives in %USERPROFILE%\.dsh\bin, which is placed BEFORE the npm global bin
REM dir on PATH, so a plain `dsh-tui` goes through here first. This file is
REM outside the dsh-tui package and profile, so `dsh-tui update` / reinstalling
REM the npm package never overwrites it.
REM
REM On every launch it refreshes the tt-switch model routes (copied out of the
REM web profile, which tt-switch itself maintains) into the dsh-tui profile,
REM then hands over to the real launcher. Self-healing: if an update resets the
REM profile patch, the next launch restores it.
REM
REM It also incrementally imports local CodeBuddy conversations into the dsh-tui
REM session store (dsh-tui has no CodeBuddy migration source of its own; see
REM sync-dsh-tui-codebuddy.mjs). Imports are idempotent and only touch sessions
REM that changed since the last sync, so a steady-state launch pays one
REM directory walk.
REM
REM Escape hatches:
REM   set DSH_TUI_NO_TT_SWITCH_SYNC=1    skip the tt-switch sync
REM   set DSH_TUI_NO_CODEBUDDY_SYNC=1    skip the CodeBuddy import
REM   set DSH_TUI_LAUNCHER=<path>        bypass launcher discovery
REM ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"

if defined DSH_TUI_NO_TT_SWITCH_SYNC goto codebuddy
node "%HERE%sync-dsh-tui-tt-switch.mjs" --quiet
if errorlevel 2 echo dsh-tui: tt-switch sync skipped, continuing. 1>&2

:codebuddy
if defined DSH_TUI_NO_CODEBUDDY_SYNC goto launch
REM 2 = no CodeBuddy data on this machine, 3 = profile not ready, 4 = another
REM instance is already syncing: all three are quiet no-ops. Only a real
REM failure (errorlevel 1) deserves a line.
node "%HERE%sync-dsh-tui-codebuddy.mjs" --quiet
if errorlevel 1 echo dsh-tui: codebuddy sync failed, continuing. 1>&2

:launch
set "REAL="
if defined DSH_TUI_LAUNCHER set "REAL=%DSH_TUI_LAUNCHER%"
if not defined REAL for /f "delims=" %%I in ('where dsh-tui.cmd 2^>nul') do (
  if not defined REAL if /I not "%%~dpI"=="%HERE%" set "REAL=%%~fI"
)
if not defined REAL goto missing

call "%REAL%" %*
exit /b %ERRORLEVEL%

:missing
echo dsh-tui: cannot find the real launcher - no dsh-tui.cmd on PATH outside "%HERE%". 1>&2
echo dsh-tui: run "npm i -g @deepseek-harness-tui/dsh-tui", or set DSH_TUI_LAUNCHER to the npm shim path. 1>&2
exit /b 1
