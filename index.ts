import {
    db, Context, UserModel, Handler, NotFoundError, ForbiddenError, 
    PRIV, Types, SettingModel, moment, _
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
    async createInvite(studentId: string, studentName: string): Promise<string> {
        const inviteCode = _.randomString(32);
        await coll.insertOne({
            _id: inviteCode,
            studentId,
            studentName,
            createTime: new Date(),
            used: false
        });
        return inviteCode;
    },

    async getInvite(inviteCode: string): Promise<UserBindInvite | null> {
        return await coll.findOne({ _id: inviteCode });
    },

    async useInvite(inviteCode: string, userId: number): Promise<void> {
        await coll.updateOne(
            { _id: inviteCode },
            {
                $set: {
                    used: true,
                    usedBy: userId,
                    usedTime: new Date()
                }
            }
        );
    },

    async getAllInvites(page: number, limit: number = 50) {
        const skip = (page - 1) * limit;
        const total = await coll.countDocuments();
        const invites = await coll.find().sort({ createTime: -1 }).skip(skip).limit(limit).toArray();
        return { invites, total, pageCount: Math.ceil(total / limit) };
    },

    async deleteInvite(inviteCode: string): Promise<void> {
        await coll.deleteOne({ _id: inviteCode });
    },

    async bindUser(userId: number, studentId: string, studentName: string): Promise<void> {
        await UserModel.setById(userId, {
            studentId,
            studentName,
            isSchoolStudent: true
        });
    },

    async isUserBound(userId: number): Promise<boolean> {
        const user = await UserModel.getById('system', userId);
        return !!(user.studentId && user.studentName);
    },

    async getDisplayName(userId: number, showRealName = false): Promise<string> {
        const user = await UserModel.getById('system', userId);
        if (showRealName && user.isSchoolStudent && user.studentName) {
            return `${user.studentName}(${user.uname})`;
        }
        return user.uname;
    }
};

global.Hydro.model.userBind = userBindModel;

// 管理界面 - 显示所有邀请链接
class UserBindManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_CREATE_DOMAIN);
        const page = +(this.request.query.page || '1');
        const { invites, total, pageCount } = await userBindModel.getAllInvites(page);
        
        // 获取用户信息
        const userIds = invites.filter(i => i.usedBy).map(i => i.usedBy!);
        const users = await UserModel.getList('system', userIds);

        this.response.template = 'user_bind_manage.html';
        this.response.body = { invites, total, pageCount, page, users };
    }
}

// 管理界面 - 批量导入学生信息
class UserBindImportHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_CREATE_DOMAIN);
        this.response.template = 'user_bind_import.html';
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_CREATE_DOMAIN);
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
                const inviteCode = await userBindModel.createInvite(studentId, studentName);
                results.push({
                    studentId,
                    studentName,
                    inviteCode,
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
        this.response.body = { results };
    }
}

// 用户绑定界面
class UserBindHandler extends Handler {
    async get(domainId: string) {
        const { code } = this.request.params;
        const invite = await userBindModel.getInvite(code);
        if (!invite) {
            throw new NotFoundError('邀请链接不存在或已失效');
        }

        if (invite.used) {
            throw new ForbiddenError('此邀请链接已被使用');
        }

        // 检查用户是否已经绑定
        if (this.user._id && await userBindModel.isUserBound(this.user._id)) {
            throw new ForbiddenError('您已经绑定过学号，无法重复绑定');
        }

        this.response.template = 'user_bind.html';
        this.response.body = { invite };
    }

    async post(domainId: string) {
        if (!this.user._id) {
            throw new ForbiddenError('请先登录');
        }

        const { code } = this.request.params;
        const invite = await userBindModel.getInvite(code);
        if (!invite) {
            throw new NotFoundError('邀请链接不存在或已失效');
        }

        if (invite.used) {
            throw new ForbiddenError('此邀请链接已被使用');
        }

        // 检查用户是否已经绑定
        if (await userBindModel.isUserBound(this.user._id)) {
            throw new ForbiddenError('您已经绑定过学号，无法重复绑定');
        }

        // 执行绑定
        await userBindModel.bindUser(this.user._id, invite.studentId, invite.studentName);
        await userBindModel.useInvite(code, this.user._id);

        this.response.redirect = '/';
    }
}

// 强制绑定检查处理器
class UserBindCheckHandler extends Handler {
    async get() {
        if (!this.user._id) {
            this.response.redirect = '/login';
            return;
        }

        const user = await UserModel.getById('system', this.user._id);
        if (user.isSchoolStudent && !await userBindModel.isUserBound(this.user._id)) {
            this.response.template = 'user_bind_required.html';
        } else {
            this.response.redirect = '/';
        }
    }
}

// 删除邀请链接
class UserBindDeleteHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_CREATE_DOMAIN);
        const { code } = this.request.params;
        await userBindModel.deleteInvite(code);
        this.response.redirect = '/user-bind/manage';
    }
}

// 插件配置和路由
export async function apply(ctx: Context) {
    // 添加用户设置项
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('user_info', 'studentId', '', 'text', '学号', '学生学号', 10),
            SettingModel.Setting('user_info', 'studentName', '', 'text', '姓名', '真实姓名', 11),
            SettingModel.Setting('user_info', 'isSchoolStudent', false, 'boolean', '本校学生', '是否为本校学生', 12)
        );
    });

    // 注册路由
    ctx.Route('user_bind_manage', '/user-bind/manage', UserBindManageHandler, PRIV.PRIV_CREATE_DOMAIN);
    ctx.Route('user_bind_import', '/user-bind/import', UserBindImportHandler, PRIV.PRIV_CREATE_DOMAIN);
    ctx.Route('user_bind', '/user-bind/:code', UserBindHandler);
    ctx.Route('user_bind_check', '/user-bind/check', UserBindCheckHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_bind_delete', '/user-bind/delete/:code', UserBindDeleteHandler, PRIV.PRIV_CREATE_DOMAIN);
    
    // 使用 hook 在所有路由处理前检查本校学生绑定状态
    ctx.on('handler/before-prepare', async (h) => {
        if (h.user && h.user._id) {
            const user = await UserModel.getById('system', h.user._id);
            if (user.isSchoolStudent && !await userBindModel.isUserBound(h.user._id)) {
                // 排除特定路径，避免循环重定向
                const excludePaths = ['/user-bind/', '/logout', '/api/', '/login', '/register'];
                const shouldRedirect = !excludePaths.some(path => h.request.path.startsWith(path));
                
                if (shouldRedirect) {
                    h.response.redirect = '/user-bind/check';
                    return;
                }
            }
        }
    });

    // 在用户登录成功后检查绑定状态
    ctx.on('handler/after/UserLogin#post', async (h) => {
        if (h.user && h.user._id) {
            const user = await UserModel.getById('system', h.user._id);
            if (user.isSchoolStudent && !await userBindModel.isUserBound(h.user._id)) {
                h.response.redirect = '/user-bind/check';
            }
        }
    });

    // 在用户详情页面添加绑定信息显示
    ctx.on('handler/after/UserDetail#get', async (h) => {
        if (h.response.body.udoc.isSchoolStudent) {
            h.response.body.showBindInfo = true;
            h.response.body.bindInfo = {
                studentId: h.response.body.udoc.studentId || '未绑定',
                studentName: h.response.body.udoc.studentName || '未绑定',
                isBound: !!(h.response.body.udoc.studentId && h.response.body.udoc.studentName)
            };
        }
    });

    // 在比赛排行榜中显示真实姓名
    ctx.on('handler/after/ContestScoreboard#get', async (h) => {
        if (h.user && h.checkPriv(PRIV.PRIV_CREATE_DOMAIN, false)) {
            const rows = h.response.body.rows || [];
            for (const row of rows) {
                if (row[1] && row[1].isSchoolStudent && row[1].studentName) {
                    row[1].displayName = `${row[1].studentName}(${row[1].uname})`;
                }
            }
        }
    });
}
