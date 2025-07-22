@echo off
echo 正在安装 CAUCOJ 用户绑定插件...
echo.

REM 检查是否在正确的目录
if not exist "package.json" (
    echo 错误：请在插件根目录下运行此脚本
    pause
    exit /b 1
)

echo 1. 检查 HydroOJ 环境...
hydrooj --version >nul 2>&1
if errorlevel 1 (
    echo 错误：未找到 HydroOJ 安装，请先安装 HydroOJ
    pause
    exit /b 1
)

echo 2. 添加插件到 HydroOJ...
hydrooj addon add "%cd%"
if errorlevel 1 (
    echo 错误：插件添加失败
    pause
    exit /b 1
)

echo 3. 重启 HydroOJ 服务...
pm2 restart hydrooj
if errorlevel 1 (
    echo 警告：无法重启 PM2 服务，请手动重启 HydroOJ
)

echo.
echo 安装完成！
echo.
echo 使用指南：
echo - 管理界面：/user-bind/manage
echo - 批量导入：/user-bind/import
echo - 详细说明请查看 README.md
echo.
pause
