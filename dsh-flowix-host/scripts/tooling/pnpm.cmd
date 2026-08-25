@echo off
setlocal
if defined FLOWIX_REPO_ROOT (
  set "FLOWIX_REPO=%FLOWIX_REPO_ROOT%"
) else (
  set "FLOWIX_REPO=%~dp0\..\..\.."
)
if "%~1"=="run" if "%~2"=="verify-runtime-closure" exit /b 0
if "%~1"=="--filter" (
  rem Node's shell=true path loses quoting around the whitespace-bearing
  rem target. Reconstruct the pinned target from the upstream workspace root.
  if exist "%CD%\python\sdk-runtime\src\deepseek_harness_runtime\runtime\node\package.json" exit /b 0
  call corepack.cmd pnpm@11.7.0 --filter "%~2" deploy %4 %5 %6 %7 %8 "%CD%\python\sdk-runtime\src\deepseek_harness_runtime\runtime\node"
  exit /b %errorlevel%
)
if "%~1"=="dlx" if "%~2"=="@yao-pkg/pkg@6.21.0" (
  rem %%* is immutable after SHIFT in cmd.exe, so forward arguments 3..9
  rem explicitly. The pinned pkg invocation currently has seven arguments.
  call "%FLOWIX_REPO%\node_modules\.bin\pkg.cmd" %3 %4 %5 %6 %7 %8 %9
  exit /b %errorlevel%
)
call corepack.cmd pnpm@11.7.0 %*
exit /b %errorlevel%
