@echo off
setlocal
set "FLOWIX_REPO=%~dp0\..\..\.."
if "%~1"=="dlx" if "%~2"=="@yao-pkg/pkg@6.21.0" (
  shift
  shift
  call "%FLOWIX_REPO%\node_modules\.bin\pkg.cmd" %*
  exit /b %errorlevel%
)
call corepack.cmd pnpm@11.7.0 %*
exit /b %errorlevel%
