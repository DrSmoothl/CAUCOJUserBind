import {
    db, Context, UserModel, Handler, NotFoundError, ForbiddenError, 
    PRIV, Types, SettingModel, moment
} from 'hydrooj';

const coll = db.collection('user_bind_invites');

interface UserBindInvite {
    _id: string;
    studentId: string;
    studentName: string;
    createTime: Date;
    used: boolean;
    usedBy?: number;
    usedTime?: Date;
}

declare module 'hydrooj' {
    interface Model {
        userBind: typeof userBindModel;
    }
    interface Collections {
        user_bind_invites: UserBindInvite;
    }
    interface UserDocument {
        studentId?: string;
        studentName?: string;
        isSchoolStudent?: boolean;
    }
}

// 用户绑定数据模型
const userBindModel = {
    // 创建学生记录（不再生成邀请码）
    async createStudentRecord(studentId: string, studentName: string): Promise<void> {
        // 检查是否已存在
        const existing = await coll.findOne({ studentId, studentName });
        if (existing) {
            throw new Error(`学生记录已存在: ${studentId} ${studentName}`);
        }
        
        await coll.insertOne({
            _id: `${studentId}_${studentName}`,
            studentId,
            studentName,
            createTime: new Date(),
            used: false
        });
    },

    // 根据学号或姓名查找学生记录
    async findStudentRecord(studentId: string, studentName: string): Promise<UserBindInvite | null> {
        return await coll.findOne({
            $or: [
                { studentId, studentName }, // 完全匹配
                { studentId }, // 学号匹配
                { studentName } // 姓名匹配
            ],
            used: false
        });
    },

    async useStudentRecord(recordId: string, userId: number): Promise<void> {
        await coll.updateOne(
            { _id: recordId },
            {
                $set: {
                    used: true,
                    usedBy: userId,
                    usedTime: new Date()
                }
            }
        );
    },

    async getAllStudents(page: number, limit: number = 50) {
        const skip = (page - 1) * limit;
        const total = await coll.countDocuments();
        const students = await coll.find().sort({ createTime: -1 }).skip(skip).limit(limit).toArray();
        return { students, total, pageCount: Math.ceil(total / limit) };
    },

    async deleteStudentRecord(studentId: string, studentName: string): Promise<void> {
        await coll.deleteOne({ studentId, studentName });
    },

    async bindUser(userId: number, studentId: string, studentName: string): Promise<void> {
        // 使用直接数据库操作而不是UserModel.setById
        const userColl = db.collection('user');
        await userColl.updateOne(
            { _id: userId },
            { 
                $set: { 
                    studentId,
                    studentName,
                    isSchoolStudent: true  // 绑定成功后自动设置为本校学生
                }
            }
        );
    },

    async isUserBound(userId: number): Promise<boolean> {
        const user = await UserModel.getById('system', userId);
        return !!(user.studentId && user.studentName);
    },

    async getDisplayName(userId: number, showRealName = false): Promise<string> {
        const user = await UserModel.getById('system', userId);
        // 直接从数据库获取 isSchoolStudent 状态
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        if (showRealName && dbUser?.isSchoolStudent && user.studentName) {
            return `${user.studentName}(${user.uname})`;
        }
        return user.uname;
    },

    // 直接从数据库获取用户的 isSchoolStudent 状态
    async getUserSchoolStudentStatus(userId: number): Promise<boolean> {
        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        return user?.isSchoolStudent === true;
    },

    // 管理员设置用户为本校学生
    async setUserAsSchoolStudent(userId: number, isSchoolStudent: boolean): Promise<void> {
        console.log(`setUserAsSchoolStudent 调用: userId=${userId}, isSchoolStudent=${isSchoolStudent}`);
        
        try {
            // 直接操作数据库，而不是使用UserModel.setById
            const userColl = db.collection('user');
            const result = await userColl.updateOne(
                { _id: userId },
                { $set: { isSchoolStudent: isSchoolStudent } }
            );
            
            console.log(`setUserAsSchoolStudent 数据库操作结果:`, result);
            
            if (result.matchedCount === 0) {
                throw new Error(`用户 ${userId} 不存在`);
            }
            
            console.log(`setUserAsSchoolStudent 成功: 用户 ${userId} 设置为 ${isSchoolStudent}`);
        } catch (error) {
            console.error(`setUserAsSchoolStudent 失败: userId=${userId}, error=`, error);
            throw error;
        }
    }
};

global.Hydro.model.userBind = userBindModel;

// 管理界面 - 显示所有学生记录
class UserBindManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const page = +(this.request.query.page || '1');
        const { students, total, pageCount } = await userBindModel.getAllStudents(page);
        
        // 获取用户信息
        const userIds = students.filter(s => s.usedBy).map(s => s.usedBy!);
        const users = await UserModel.getList('system', userIds);

        this.response.template = 'user_bind_manage.html';
        this.response.body = { students, total, pageCount, page, users };
    }
}

// 管理界面 - 批量导入学生信息
class UserBindImportHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        this.response.template = 'user_bind_import.html';
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const studentsData = this.request.body.studentsData || '';
        
        const lines = studentsData.trim().split('\n');
        const results: any[] = [];
        
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2) {
                continue;
            }
            
            const studentId = parts[0];
            const studentName = parts.slice(1).join(' ');
            
            try {
                await userBindModel.createStudentRecord(studentId, studentName);
                results.push({
                    studentId,
                    studentName,
                    success: true
                });
            } catch (error: any) {
                results.push({
                    studentId,
                    studentName,
                    error: error.message,
                    success: false
                });
            }
        }

        this.response.template = 'user_bind_import_result.html';
        this.response.body = { results, bindUrl: '/user-bind/form' };
    }
}

// 用户绑定表单界面
class UserBindFormHandler extends Handler {
    async get(domainId: string) {
        // 检查用户是否已经绑定
        if (this.user && this.user._id && await userBindModel.isUserBound(this.user._id)) {
            throw new ForbiddenError('您已经绑定过学号，无法重复绑定');
        }

        this.response.template = 'user_bind_form.html';
    }

    async post(domainId: string) {
        if (!this.user._id) {
            throw new ForbiddenError('请先登录');
        }

        // 检查用户是否已经绑定
        if (await userBindModel.isUserBound(this.user._id)) {
            throw new ForbiddenError('您已经绑定过学号，无法重复绑定');
        }

        const { studentId, studentName } = this.request.body;
        if (!studentId || !studentName) {
            this.response.template = 'user_bind_form.html';
            this.response.body = { 
                error: '请填写学号和姓名',
                studentId,
                studentName
            };
            return;
        }

        // 查找匹配的学生记录
        const studentRecord = await userBindModel.findStudentRecord(studentId, studentName);
        if (!studentRecord) {
            this.response.template = 'user_bind_form.html';
            this.response.body = { 
                error: '未找到匹配的学生信息，请检查学号和姓名是否正确',
                studentId,
                studentName
            };
            return;
        }

        if (studentRecord.used) {
            this.response.template = 'user_bind_form.html';
            this.response.body = { 
                error: '该学生信息已被其他用户绑定',
                studentId,
                studentName
            };
            return;
        }

        // 执行绑定
        await userBindModel.bindUser(this.user._id, studentRecord.studentId, studentRecord.studentName);
        await userBindModel.useStudentRecord(studentRecord._id, this.user._id);

        this.response.redirect = '/user-bind/success';
    }
}

// 绑定成功页面
class UserBindSuccessHandler extends Handler {
    async get() {
        if (!this.user._id) {
            this.response.redirect = '/login';
            return;
        }

        const user = await UserModel.getById('system', this.user._id);
        if (!user.studentId || !user.studentName) {
            this.response.redirect = '/user-bind/form';
            return;
        }

        this.response.template = 'user_bind_success.html';
        this.response.body = { 
            studentId: user.studentId,
            studentName: user.studentName
        };
    }
}

// 删除学生记录
class UserBindDeleteHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { studentId, studentName } = this.request.body;
        await userBindModel.deleteStudentRecord(studentId, studentName);
        this.response.redirect = '/user-bind/manage';
    }
}

// 管理员设置用户为本校学生
class UserBindSetSchoolStudentHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { userId, isSchoolStudent, userIds } = this.request.body;
        
        // 批量操作
        if (userIds) {
            console.log('批量设置本校学生 - 收到请求:', { userIds, isSchoolStudent });
            
            try {
                // 解析 userIds，可能是 JSON 字符串或数组
                let parsedUserIds: string[];
                if (typeof userIds === 'string') {
                    try {
                        parsedUserIds = JSON.parse(userIds);
                    } catch {
                        // 如果不是 JSON，尝试按逗号分割
                        parsedUserIds = userIds.split(',').map(id => id.trim()).filter(id => id);
                    }
                } else if (Array.isArray(userIds)) {
                    parsedUserIds = userIds;
                } else {
                    throw new Error('无效的用户ID列表格式');
                }
                
                const isSchoolStudentBool = isSchoolStudent === 'true';
                const results: Array<{
                    userId: number | string;
                    username: string;
                    success: boolean;
                    error?: string;
                }> = [];
                
                for (const uid of parsedUserIds) {
                    try {
                        const parsedUserId = parseInt(uid);
                        if (isNaN(parsedUserId)) {
                            throw new Error(`无效的用户ID: ${uid}`);
                        }
                        
                        await userBindModel.setUserAsSchoolStudent(parsedUserId, isSchoolStudentBool);
                        
                        const user = await UserModel.getById('system', parsedUserId);
                        results.push({
                            userId: parsedUserId,
                            username: user.uname,
                            success: true
                        });
                    } catch (error: any) {
                        results.push({
                            userId: uid,
                            username: '未知',
                            success: false,
                            error: error.message
                        });
                    }
                }
                
                const successCount = results.filter(r => r.success).length;
                const failCount = results.filter(r => !r.success).length;
                
                this.response.body = {
                    success: true,
                    message: `批量操作完成：成功 ${successCount} 个，失败 ${failCount} 个`,
                    results,
                    isSchoolStudent: isSchoolStudentBool
                };
                this.response.type = 'application/json';
                return;
            } catch (error: any) {
                console.error('批量设置本校学生失败:', error);
                this.response.body = { success: false, error: error.message };
                this.response.type = 'application/json';
                return;
            }
        }
        
        // 单个操作
        console.log('设置本校学生 - 收到请求:', { userId, isSchoolStudent });
        
        if (!userId) {
            console.log('设置本校学生 - 错误: 缺少用户ID');
            throw new Error('缺少用户ID');
        }
        
        try {
            const parsedUserId = parseInt(userId);
            const isSchoolStudentBool = isSchoolStudent === 'true';
            
            console.log('设置本校学生 - 解析参数:', { parsedUserId, isSchoolStudentBool });
            
            // 先检查用户是否存在
            const existingUser = await UserModel.getById('system', parsedUserId);
            console.log('设置本校学生 - 现有用户状态:', { 
                username: existingUser.uname, 
                currentIsSchoolStudent: existingUser.isSchoolStudent 
            });
            
            await userBindModel.setUserAsSchoolStudent(parsedUserId, isSchoolStudentBool);
            
            // 验证设置是否成功 - 直接从数据库读取而不是通过UserModel
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: parsedUserId });
            console.log('设置本校学生 - 数据库中的实际数据:', {
                username: dbUser?.uname,
                isSchoolStudent: dbUser?.isSchoolStudent,
                _id: dbUser?._id
            });
            
            // 同时也检查UserModel的结果
            const updatedUser = await UserModel.getById('system', parsedUserId);
            console.log('设置本校学生 - UserModel读取结果:', { 
                username: updatedUser.uname, 
                newIsSchoolStudent: updatedUser.isSchoolStudent 
            });
            
            // 返回JSON响应用于AJAX调用
            this.response.body = { 
                success: true, 
                message: `用户 ${updatedUser.uname} 已${isSchoolStudentBool ? '设置为' : '取消'}本校学生状态`,
                isSchoolStudent: dbUser?.isSchoolStudent,  // 使用数据库中的实际值
                userModelValue: updatedUser.isSchoolStudent  // 显示UserModel的值用于对比
            };
            this.response.type = 'application/json';
        } catch (error: any) {
            console.error('设置本校学生失败:', error);
            this.response.body = { success: false, error: error.message };
            this.response.type = 'application/json';
        }
    }
}

// 用户管理界面 - 设置本校学生
class UserBindUserManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const page = +(this.request.query.page || '1');
        const search = this.request.query.search || '';
        const limit = 20;
        const skip = (page - 1) * limit;
        
        // 构建搜索条件
        let filter: any = {};
        if (search) {
            filter.$or = [
                { uname: { $regex: search, $options: 'i' } },
                { mail: { $regex: search, $options: 'i' } }
            ];
        }
        
        // 获取用户列表
        const userColl = db.collection('user');
        const total = await userColl.countDocuments(filter);
        const users = await userColl
            .find(filter)
            .sort({ _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        const pageCount = Math.ceil(total / limit);
        
        this.response.template = 'user_bind_user_manage.html';
        this.response.body = { users, total, page, pageCount, search };
    }
}

// // 调试接口 - 检查当前用户状态
class UserBindDebugHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        const userColl = db.collection('user');
        const users = await userColl.find().limit(10).toArray();
        
        this.response.body = {
            currentUser: {
                _id: this.user._id,
                hasPriv: this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
            },
            sampleUsers: users.map(u => ({
                _id: u._id,
                uname: u.uname,
                isSchoolStudent: u.isSchoolStudent,
                studentId: u.studentId,
                studentName: u.studentName
            }))
        };
        this.response.type = 'application/json';
    }
}

// 插件配置和路由
export async function apply(ctx: Context) {
    // 添加用户设置项
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('user_info', 'studentId', '', 'text', '学号', '学生学号', 10),
            SettingModel.Setting('user_info', 'studentName', '', 'text', '姓名', '真实姓名', 11)
        );
    });

    // 注册路由
    ctx.Route('user_bind_manage', '/user-bind/manage', UserBindManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_bind_import', '/user-bind/import', UserBindImportHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_bind_user_manage', '/user-bind/user-manage', UserBindUserManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_bind_debug', '/user-bind/debug', UserBindDebugHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_bind_form', '/user-bind', UserBindFormHandler);
    ctx.Route('user_bind_success', '/user-bind/success', UserBindSuccessHandler);
    ctx.Route('user_bind_delete', '/user-bind/delete', UserBindDeleteHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_bind_set_school_student', '/user-bind/set-school-student', UserBindSetSchoolStudentHandler, PRIV.PRIV_EDIT_SYSTEM);
    
    // 使用 hook 在所有路由处理前检查本校学生绑定状态和访问权限
    ctx.on('handler/before-prepare', async (h) => {
        // 确保用户已登录且有用户信息
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            const currentPath = h.request.path;
            
            // 超级管理员 root（uid=2）可以访问所有页面，无需检查
            if (h.user._id === 2) {
                return;
            }
            
            // 定义只有本校学生才能访问的路径
            const schoolStudentOnlyPaths = [
                '/training',
                '/homework',
                '/contest',
                '/p'
            ];
            
            // 需要排除的路径（不进行任何检查）
            const excludePaths = [
                '/user-bind',
                '/logout', 
                '/api/', 
                '/login', 
                '/register',
                '/assets/',
                '/favicon.ico',
                '.js',
                '.css',
                '.map',
                '.png',
                '.jpg',
                '.jpeg',
                '.gif',
                '.svg',
                '.woff',
                '.woff2',
                '.ttf'
            ];
            
            // 检查是否应该跳过此路径
            const shouldSkip = excludePaths.some(path => 
                currentPath === path || 
                currentPath.startsWith(path) ||
                currentPath.endsWith(path)
            );
            
            if (shouldSkip) {
                return;
            }

            const user = await UserModel.getById('system', h.user._id);
            // 使用直接数据库查询获取 isSchoolStudent 状态
            const isSchoolStudent = await userBindModel.getUserSchoolStudentStatus(h.user._id);
            const isBound = await userBindModel.isUserBound(h.user._id);
            
            // 检查是否访问本校学生专用路径
            const isSchoolStudentOnlyPath = schoolStudentOnlyPaths.some(path => 
                currentPath === path || currentPath.startsWith(path + '/')
            );
            
            if (isSchoolStudentOnlyPath) {
                // 非本校学生禁止访问
                if (!isSchoolStudent) {
                    console.log(`访问控制 - 用户 ${user.uname} 试图访问本校学生专用路径: ${currentPath}`);
                    throw new ForbiddenError('此功能仅限本校学生使用，请联系管理员');
                }
                
                // 本校学生但未绑定，重定向到绑定页面
                if (!isBound) {
                    console.log(`绑定检查 - 本校学生 ${user.uname} 未绑定，重定向到绑定页面`);
                    h.response.redirect = '/user-bind';
                    return;
                }
                
                console.log(`访问允许 - 本校学生 ${user.uname} 访问路径: ${currentPath}`);
            } else if (isSchoolStudent && !isBound) {
                // 非本校学生专用路径，只检查本校学生的绑定状态
                console.log(`绑定检查 - 本校学生 ${user.uname} 未绑定，重定向到绑定页面`);
                h.response.redirect = '/user-bind';
                return;
            }
        } catch (error) {
            // 如果是权限错误，直接抛出
            if (error instanceof ForbiddenError) {
                throw error;
            }
            // 如果获取用户信息失败，不执行重定向
            console.error('用户绑定检查失败:', error);
        }
    });

    // 在用户登录成功后检查绑定状态
    ctx.on('handler/after/UserLogin#post', async (h) => {
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            // 超级管理员 root（uid=2）无需检查绑定状态
            if (h.user._id === 2) {
                return;
            }
            
            const user = await UserModel.getById('system', h.user._id);
            // 使用直接数据库查询获取 isSchoolStudent 状态
            const isSchoolStudent = await userBindModel.getUserSchoolStudentStatus(h.user._id);
            // 只有被明确标记为本校学生的用户才需要强制绑定
            if (isSchoolStudent && !await userBindModel.isUserBound(h.user._id)) {
                h.response.redirect = '/user-bind';
            }
        } catch (error) {
            console.error('登录后绑定检查失败:', error);
        }
    });

    // 在用户详情页面添加绑定信息显示
    ctx.on('handler/after/UserDetail#get', async (h) => {
        if (h.response.body.udoc) {
            // 直接从数据库获取 isSchoolStudent 状态
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: h.response.body.udoc._id });
            if (dbUser?.isSchoolStudent) {
                h.response.body.showBindInfo = true;
                h.response.body.bindInfo = {
                    studentId: h.response.body.udoc.studentId || '未绑定',
                    studentName: h.response.body.udoc.studentName || '未绑定',
                    isBound: !!(h.response.body.udoc.studentId && h.response.body.udoc.studentName)
                };
            }
        }
    });

    // 在比赛排行榜中显示真实姓名
    ctx.on('handler/after/ContestScoreboard#get', async (h) => {
        console.log('ContestScoreboard hook triggered, user:', h.user?._id, 'hasPriv:', h.user?.hasPriv(PRIV.PRIV_EDIT_SYSTEM));
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const rows = h.response.body.rows || [];
            const userColl = db.collection('user');
            console.log('Processing', rows.length, 'rows');
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (i === 0) {
                    continue; // 跳过表头
                }
                
                // 寻找用户列 (type === 'user')
                for (let j = 0; j < row.length; j++) {
                    const col = row[j];
                    if (col && col.type === 'user') {
                        console.log('Found user column at row', i, 'col', j);
                        console.log('User column structure:', {
                            type: col.type,
                            value: col.value,
                            raw: col.raw,
                            allKeys: Object.keys(col)
                        });
                        
                        // 在比赛排行榜中，用户信息的结构是：
                        // col.value = 用户名 (uname)
                        // col.raw = 用户ID (_id)
                        const userId = col.raw;
                        const userName = col.value;
                        
                        if (userId && userName) {
                            console.log('Found user info:', {
                                _id: userId,
                                uname: userName
                            });
                            
                            // 直接从数据库检查 isSchoolStudent 状态和学生信息
                            const dbUser = await userColl.findOne({ _id: userId });
                            console.log('User', userId, 'dbUser:', {
                                isSchoolStudent: dbUser?.isSchoolStudent,
                                studentName: dbUser?.studentName,
                                studentId: dbUser?.studentId
                            });
                            
                            if (dbUser?.isSchoolStudent && dbUser.studentName && dbUser.studentId) {
                                const oldName = userName;
                                // 修改显示值为真实姓名
                                col.value = `${dbUser.studentName}(${userName})`;
                                console.log('Set display name for user', userId, 'from', oldName, 'to', col.value);
                            }
                        }
                    }
                }
            }
        }
    });

    // 为训练、作业等其他地方也添加相似的处理
    ctx.on('handler/after/TrainingScoreboard#get', async (h) => {
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const rows = h.response.body.rows || [];
            const userColl = db.collection('user');
            for (const row of rows) {
                if (row[1] && row[1]._id) {
                    const dbUser = await userColl.findOne({ _id: row[1]._id });
                    if (dbUser?.isSchoolStudent && dbUser.studentName && dbUser.studentId) {
                        row[1].displayName = `${dbUser.studentName}(${row[1].uname})`;
                    }
                }
            }
        }
    });

    // 为作业排行榜添加处理
    ctx.on('handler/after/HomeworkScoreboard#get', async (h) => {
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const rows = h.response.body.rows || [];
            const userColl = db.collection('user');
            for (const row of rows) {
                if (row[1] && row[1]._id) {
                    const dbUser = await userColl.findOne({ _id: row[1]._id });
                    if (dbUser?.isSchoolStudent && dbUser.studentName && dbUser.studentId) {
                        row[1].displayName = `${dbUser.studentName}(${row[1].uname})`;
                    }
                }
            }
        }
    });

    // 为记录页面添加处理，管理员查看时显示真实姓名
    ctx.on('handler/after/RecordList#get', async (h) => {
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const udict = h.response.body.udict || {};
            const userColl = db.collection('user');
            
            for (const uid in udict) {
                const user = udict[uid];
                if (user._id) {
                    const dbUser = await userColl.findOne({ _id: user._id });
                    if (dbUser?.isSchoolStudent && dbUser.studentName && dbUser.studentId) {
                        user.displayName = `${dbUser.studentName}(${user.uname})`;
                    }
                }
            }
        }
    });

    // 为排名页面添加处理，管理员查看时显示真实姓名
    ctx.on('handler/after/Ranking#get', async (h) => {
        console.log('Ranking hook triggered, user:', h.user?._id, 'hasPriv:', h.user?.hasPriv(PRIV.PRIV_EDIT_SYSTEM));
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const udocs = h.response.body.udocs || [];
            const userColl = db.collection('user');
            console.log('Processing', udocs.length, 'users in ranking');
            
            for (const udoc of udocs) {
                if (udoc._id) {
                    const dbUser = await userColl.findOne({ _id: udoc._id });
                    console.log('Ranking user', udoc._id, 'dbUser:', {
                        isSchoolStudent: dbUser?.isSchoolStudent,
                        studentName: dbUser?.studentName,
                        studentId: dbUser?.studentId
                    });
                    if (dbUser?.isSchoolStudent && dbUser.studentName && dbUser.studentId) {
                        const oldName = udoc.uname;
                        udoc.displayName = `${dbUser.studentName}(${udoc.uname})`;
                        console.log('Set displayName for ranking user', udoc._id, 'from', oldName, 'to', udoc.displayName);
                    }
                }
            }
        }
    });
}
