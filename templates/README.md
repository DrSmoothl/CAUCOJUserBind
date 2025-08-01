# 模板文件说明

本目录包含了重构后的用户绑定系统的所有模板文件。

## 文件列表

### 学校组管理
- `school_group_manage.html` - 学校组管理列表页面
- `school_group_create.html` - 创建学校组表单页面  
- `school_group_created.html` - 学校组创建成功页面

### 用户组管理
- `user_group_manage.html` - 用户组管理列表页面
- `user_group_create.html` - 创建用户组表单页面
- `user_group_created.html` - 用户组创建成功页面

### 绑定流程
- `bind_form.html` - 用户绑定表单页面
- `bind_success.html` - 绑定成功页面
- `bind_conflict.html` - 绑定冲突处理页面

## 模板特性

### 1. 响应式设计
所有模板都使用了响应式布局，适配不同设备。

### 2. 用户体验优化
- 清晰的表单验证提示
- 友好的错误和成功消息
- 直观的操作按钮和链接

### 3. 功能特性
- 一键复制绑定链接
- 示例数据填充
- 分页导航
- 搜索和筛选（预留）

### 4. 安全性
- 所有用户输入都经过适当的转义
- 表单包含CSRF保护（依赖框架）
- 敏感信息的适当处理

## 使用说明

### 管理员功能流程
1. 访问 `/school-group/manage` 查看和管理学校组
2. 使用 `/school-group/create` 创建新的学校组
3. 访问 `/user-group/manage` 查看和管理用户组
4. 使用 `/user-group/create` 创建用户组并导入学生

### 学生绑定流程
1. 学生收到绑定链接（如：`/bind/abc123...`）
2. 访问链接显示 `bind_form.html`
3. 填写学号和姓名提交
4. 成功后显示 `bind_success.html`
5. 如有冲突显示 `bind_conflict.html`

## 自定义说明

### 样式定制
模板使用了标准的CSS类名，可以根据需要自定义样式：
- `.button` - 按钮样式
- `.form__*` - 表单相关样式
- `.alert` - 提示消息样式
- `.card` - 卡片布局样式

### 功能扩展
模板中预留了扩展点，如：
- JavaScript函数（如复制功能）
- 额外的表单字段
- 更多的操作按钮

### 本地化
模板中的文本都可以根据需要进行本地化处理。

## 注意事项

1. 确保所有模板文件都放在正确的目录中
2. 模板依赖于HydroOJ的基础布局文件
3. 某些功能（如JavaScript）可能需要额外的库支持
4. 生产环境中建议压缩CSS和JavaScript文件
