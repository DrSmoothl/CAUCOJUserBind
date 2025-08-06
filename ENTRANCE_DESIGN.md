# 用户绑定系统入口设计说明

## 概述
用户绑定系统提供了两个主要入口，分别针对普通用户和系统管理员。

## 入口位置

### 1. 普通用户入口
**位置**: 用户个人页面侧边栏
**文件**: `templates/components/home.html`
**访问路径**: 用户登录后在个人中心侧边栏可见

**功能菜单**:
- 🏫 学校绑定 - 绑定学校信息
- ✏️ 修改昵称 - 自定义显示昵称
- ⚙️ 系统管理 - 仅管理员可见

**主页面**: `templates/user_bind_home.html`
- 提供用户友好的卡片式界面
- 包含学校绑定、昵称修改、状态查看等功能
- 管理员可见系统管理入口

### 2. 系统管理员入口
**位置**: 独立的管理界面
**Base模板**: `templates/layout/userbind_manage_base.html`
**主界面**: `templates/management_dashboard.html`

**管理功能**:
- 📊 管理总览 - 系统统计和概览
- 🏫 学校组管理 - 创建和管理学校组
- 👥 用户组管理 - 创建和管理用户组  
- 🔐 绕过权限管理 - 管理特殊用户权限
- ✏️ 昵称管理 - 管理用户昵称

## 权限控制
- 普通用户: 可访问个人绑定功能
- 管理员 (`PERM_EDIT_DOMAIN`): 可访问所有管理功能

## 模板结构
```
templates/
├── components/
│   ├── home.html              # 用户个人页面侧边栏
│   └── sidemenu.html          # 侧边栏菜单组件
├── layout/
│   ├── home_base.html         # 用户个人页面基础模板
│   └── userbind_manage_base.html  # 管理页面基础模板
├── user_bind_home.html        # 用户绑定主页
├── management_dashboard.html   # 管理总览页面
└── school_group_bypass_manage.html  # 绕过权限管理页面
```

## 导航体验
1. **用户路径**: 登录 → 个人中心 → 用户绑定系统 → 相关功能
2. **管理员路径**: 登录 → 个人中心 → 用户绑定系统 → 系统管理 → 具体管理功能

## CSS 命名空间
所有样式都使用 `userbind-` 前缀，避免与 HydroOJ 原有样式冲突。
