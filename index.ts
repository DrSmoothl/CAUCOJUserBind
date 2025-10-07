import {
    db, Context, UserModel, Handler, NotFoundError, ForbiddenError, 
    PRIV, Types, SettingModel, moment, PERM
} from 'hydrooj';
import * as crypto from 'crypto';

// 集合定义
const userGroupsColl = db.collection('user_groups');
const schoolGroupsColl = db.collection('school_groups');
const bindTokensColl = db.collection('bind_tokens');
const bindingRequestsColl = db.collection('binding_requests');

// 接口定义
interface UserGroup {
    _id?: any;
    name: string;
    createdAt: Date;
    createdBy: number;
    parentSchoolId: any;
    groupType?: number; // 0: 普通用户组, 1: 比赛专用用户组
    students: Array<{
        studentId: string;
        realName: string;
        bound: boolean;
        boundBy?: number;
        boundAt?: Date;
        contestFinished?: boolean; // 比赛是否已结束
        contestFinishedAt?: Date; // 比赛结束时间
    }>;
}

interface SchoolGroup {
    _id?: any;
    name: string;
    createdAt: Date;
    createdBy: number;
    members: Array<{
        studentId: string;
        realName: string;
        bound: boolean;
        boundBy?: number;
        boundAt?: Date;
    }>;
    extraInfo: Array<any>;
}

interface BindToken {
    _id: string; // 绑定令牌（哈希值）
    type: 'user_group' | 'school_group';
    targetId: any; // 用户组或学校组的ID
    createdAt: Date;
    createdBy: number;
    expiresAt?: Date;
}

interface BindingRequest {
    _id?: any;
    userId: number; // 申请用户ID
    schoolGroupId: any; // 选择的学校组ID
    studentId: string; // 学号
    realName: string; // 姓名
    status: 'pending' | 'approved' | 'rejected'; // 申请状态
    createdAt: Date; // 创建时间
    updatedAt: Date; // 更新时间
    reviewedBy?: number; // 审核者ID
    reviewedAt?: Date; // 审核时间
    reviewComment?: string; // 审核备注
}

declare module 'hydrooj' {
    interface Model {
        userBind: typeof userBindModel;
    }
    interface Collections {
        user_groups: UserGroup;
        school_groups: SchoolGroup;
        bind_tokens: BindToken;
        binding_requests: BindingRequest;
        document: any; // 添加document集合类型
    }
    interface UserDocument {
        realName?: string;
        studentId?: string;
        parentUserGroupId?: any[];
        parentSchoolId?: any[];
    }
}

// 用户绑定数据模型
const userBindModel = {
    // 生成绑定令牌
    generateBindToken(): string {
        return crypto.randomBytes(32).toString('hex');
    },

    // 创建学校组
    async createSchoolGroup(name: string, createdBy: number, members: Array<{studentId: string, realName: string}>): Promise<any> {
        // 检查是否已存在同名学校
        const existing = await schoolGroupsColl.findOne({ name });
        if (existing) {
            throw new Error(`学校组已存在: ${name}`);
        }
        
        const membersData = members.map(m => ({
            studentId: m.studentId,
            realName: m.realName,
            bound: false
        }));
        
        const result = await schoolGroupsColl.insertOne({
            name,
            createdAt: new Date(),
            createdBy,
            members: membersData,
            extraInfo: []
        });
        
        return result.insertedId;
    },

    // 创建用户组
    async createUserGroup(name: string, parentSchoolId: any, createdBy: number, students: Array<{studentId: string, realName: string}>, groupType: number = 0): Promise<any> {
        // 统一使用字符串匹配查找学校组
        let school: SchoolGroup | null = null;
        const allSchools = await schoolGroupsColl.find().toArray();
        school = allSchools.find(s => s._id.toString() === parentSchoolId.toString()) || null;
        
        if (!school) {
            throw new Error('指定的学校组不存在');
        }

        // 获取用户集合，用于检查已绑定的用户
        const userColl = db.collection('user');
        
        // 处理每个学生，检查是否已绑定用户
        const studentsData = [];
        const autoBindResults = { success: 0, failed: 0 };
        
        for (const student of students) {
            // 查找已绑定该学号和姓名的用户（使用精确匹配）
            const boundUser = await userColl.findOne({
                studentId: student.studentId,
                realName: student.realName
            });
            
            if (boundUser) {
                // 用户已绑定，检查学校组是否一致（使用字符串匹配）
                let schoolMatched = false;
                
                if (boundUser.parentSchoolId && Array.isArray(boundUser.parentSchoolId)) {
                    // 使用字符串匹配检查学校组
                    schoolMatched = boundUser.parentSchoolId.some((userSchoolId: any) => {
                        try {
                            return userSchoolId.toString() === school!._id.toString();
                        } catch (e) {
                            return false;
                        }
                    });
                }
                
                if (schoolMatched) {
                    // 学校组一致，自动绑定到用户组
                    studentsData.push({
                        studentId: student.studentId,
                        realName: student.realName,
                        bound: true,
                        boundBy: boundUser._id,
                        boundAt: new Date()
                    });
                    autoBindResults.success++;
                } else {
                    // 学校组不一致，需要链接绑定
                    studentsData.push({
                        studentId: student.studentId,
                        realName: student.realName,
                        bound: false
                    });
                    autoBindResults.failed++;
                }
            } else {
                // 用户未绑定，需要链接绑定
                studentsData.push({
                    studentId: student.studentId,
                    realName: student.realName,
                    bound: false
                });
            }
        }

        // 创建用户组
        const result = await userGroupsColl.insertOne({
            name,
            createdAt: new Date(),
            createdBy,
            parentSchoolId: school._id, // 使用查找到的实际学校ID
            groupType: groupType, // 用户组种类
            students: studentsData
        });
        
        const userGroupId = result.insertedId;
        
        // 将自动绑定成功的用户添加到用户组（使用字符串匹配更新）
        if (autoBindResults.success > 0) {
            const boundUserIds = studentsData
                .filter(s => s.bound && s.boundBy)
                .map(s => s.boundBy)
                .filter((id): id is number => id !== undefined); // 过滤undefined并断言类型
            
            if (boundUserIds.length > 0) {
                // 批量更新用户，将用户组ID添加到用户的parentUserGroupId数组
                await userColl.updateMany(
                    { _id: { $in: boundUserIds } },
                    { $addToSet: { parentUserGroupId: userGroupId } }
                );
            }
        }
        
        // 记录自动绑定结果
        console.log(`用户组创建完成: ${name}, 自动绑定: ${autoBindResults.success}/${students.length}`);
        
        // 返回用户组ID和自动绑定统计
        return {
            userGroupId,
            autoBindStats: {
                total: students.length,
                autoBound: autoBindResults.success,
                needManualBind: students.length - autoBindResults.success
            }
        };
    },

    // 为用户组创建绑定令牌
    async createUserGroupBindToken(userGroupId: any, createdBy: number): Promise<string> {
        const token = this.generateBindToken();
        
        await bindTokensColl.insertOne({
            _id: token,
            type: 'user_group',
            targetId: userGroupId,
            createdAt: new Date(),
            createdBy
        });
        
        return token;
    },

    // 为学校组创建绑定令牌
    async createSchoolGroupBindToken(schoolGroupId: any, createdBy: number): Promise<string> {
        const token = this.generateBindToken();
        
        const insertResult = await bindTokensColl.insertOne({
            _id: token,
            type: 'school_group',
            targetId: schoolGroupId,
            createdAt: new Date(),
            createdBy
        });
        
        return token;
    },

    // 根据令牌获取绑定信息
    async getBindInfo(token: string): Promise<{
        type: 'user_group' | 'school_group';
        target: UserGroup | SchoolGroup;
        bindToken: BindToken;
    } | null> {
        const bindToken = await bindTokensColl.findOne({ _id: token });
        
        if (!bindToken) {
            return null;
        }

        let target;
        if (bindToken.type === 'user_group') {
            // 使用字符串匹配查找用户组
            const allUserGroups = await userGroupsColl.find().toArray();
            target = allUserGroups.find(g => g._id.toString() === bindToken.targetId.toString()) || null;
        } else {
            // 使用字符串匹配查找学校组
            const allSchoolGroups = await schoolGroupsColl.find().toArray();
            target = allSchoolGroups.find(s => s._id.toString() === bindToken.targetId.toString()) || null;
        }

        if (!target) {
            return null;
        }

        return { type: bindToken.type, target, bindToken };
    },

    // 用户绑定到用户组
    async bindUserToGroup(userId: number, token: string, studentId: string, realName: string): Promise<void> {
        const bindInfo = await this.getBindInfo(token);
        if (!bindInfo || bindInfo.type !== 'user_group') {
            throw new Error('无效的绑定令牌');
        }

        const userGroup = bindInfo.target as UserGroup;
        
        // 检查学生是否在用户组中
        const student = userGroup.students.find(s => s.studentId === studentId && s.realName === realName);
        if (!student) {
            throw new Error('学号或姓名不匹配，请检查输入信息');
        }

        if (student.bound) {
            throw new Error('该学生信息已被绑定');
        }

        // 检查用户是否已有学校组
        const user = await UserModel.getById('system', userId);
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });

        if (dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0) {
            // 用户已有学校组，检查是否一致（使用字符串匹配）
            const userSchoolId = dbUser.parentSchoolId[0];
            const schoolMatches = userSchoolId.toString() === userGroup.parentSchoolId.toString();
            
            if (!schoolMatches) {
                throw new Error('您已属于其他学校，无法绑定到此用户组');
            }
        }

        // 更新用户信息
        const updateData: any = {
            realName,
            studentId,
            $addToSet: {
                parentUserGroupId: userGroup._id
            }
        };

        // 如果用户还没有学校组，添加学校组
        if (!dbUser?.parentSchoolId || dbUser.parentSchoolId.length === 0) {
            updateData.$addToSet.parentSchoolId = userGroup.parentSchoolId;
        }

        await userColl.updateOne({ _id: userId }, updateData);

        // 更新用户组中的学生状态 - 统一使用字符串匹配查找并更新
        const allUserGroups = await userGroupsColl.find().toArray();
        const targetUserGroup = allUserGroups.find(g => g._id.toString() === userGroup._id.toString());
        
        if (targetUserGroup) {
            const updateResult = await userGroupsColl.updateOne(
                { _id: targetUserGroup._id, 'students.studentId': studentId, 'students.realName': realName },
                {
                    $set: {
                        'students.$.bound': true,
                        'students.$.boundBy': userId,
                        'students.$.boundAt': new Date()
                    }
                }
            );
            
            if (updateResult.matchedCount === 0) {
                console.warn(`用户组绑定状态更新失败: 未找到匹配的学生记录 (学号: ${studentId}, 姓名: ${realName})`);
            } else {
                console.log(`用户组绑定状态更新成功: 用户 ${userId} 绑定到学生 ${studentId} ${realName}`);
            }
        } else {
            console.warn('用户组绑定状态更新失败: 未找到目标用户组，但用户信息已更新');
        }
    },

    // 用户绑定到学校组
    async bindUserToSchoolGroup(userId: number, token: string, studentId: string, realName: string): Promise<void> {
        const bindInfo = await this.getBindInfo(token);
        if (!bindInfo || bindInfo.type !== 'school_group') {
            throw new Error('无效的绑定令牌');
        }

        const schoolGroup = bindInfo.target as SchoolGroup;
        
        // 检查学校组是否有成员数据结构
        if (!schoolGroup.members || !Array.isArray(schoolGroup.members)) {
            throw new Error('此学校组缺少成员信息，请联系管理员重新创建学校组');
        }
        
        // 检查学生是否在学校组中
        const member = schoolGroup.members.find(m => m.studentId === studentId && m.realName === realName);
        
        if (!member) {
            throw new Error('学号或姓名不匹配，请检查输入信息或联系管理员');
        }

        if (member.bound) {
            throw new Error('该学生信息已被绑定');
        }

        const userColl = db.collection('user');

        // 检查用户是否已有学校组
        const dbUser = await userColl.findOne({ _id: userId });
        
        if (dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0) {
            throw new Error('您已属于其他学校组');
        }

        // 更新用户信息
        await userColl.updateOne(
            { _id: userId },
            {
                $set: {
                    realName,
                    studentId
                },
                $addToSet: {
                    parentSchoolId: schoolGroup._id
                }
            }
        );

        // 更新学校组中的成员状态 - 统一使用字符串匹配查找并更新
        const allSchoolGroups = await schoolGroupsColl.find().toArray();
        const targetSchoolGroup = allSchoolGroups.find(s => s._id.toString() === schoolGroup._id.toString());
        
        if (targetSchoolGroup) {
            const updateResult = await schoolGroupsColl.updateOne(
                { 
                    _id: targetSchoolGroup._id, 
                    'members': {
                        $elemMatch: {
                            'studentId': studentId,
                            'realName': realName,
                            'bound': false
                        }
                    }
                },
                {
                    $set: {
                        'members.$.bound': true,
                        'members.$.boundBy': userId,
                        'members.$.boundAt': new Date()
                    }
                }
            );
            
            if (updateResult.matchedCount === 0) {
                console.warn(`学校组绑定状态更新失败: 未找到匹配的成员记录 (学号: ${studentId}, 姓名: ${realName})`);
            } else {
                console.log(`学校组绑定状态更新成功: 用户 ${userId} 绑定到成员 ${studentId} ${realName}`);
            }
        } else {
            console.warn('学校组绑定状态更新失败: 未找到目标学校组，但用户信息已更新');
        }
    },

    // 获取用户的学校组信息
    async getUserSchoolGroups(userId: number): Promise<SchoolGroup[]> {
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        
        if (!dbUser?.parentSchoolId || dbUser.parentSchoolId.length === 0) {
            return [];
        }

        return await schoolGroupsColl.find({
            _id: { $in: dbUser.parentSchoolId }
        }).toArray();
    },

    // 获取用户的用户组信息
    async getUserGroups(userId: number): Promise<UserGroup[]> {
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        
        if (!dbUser?.parentUserGroupId || dbUser.parentUserGroupId.length === 0) {
            return [];
        }

        return await userGroupsColl.find({
            _id: { $in: dbUser.parentUserGroupId }
        }).toArray();
    },

    // 检查用户是否已绑定
    async isUserBound(userId: number): Promise<boolean> {
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        return !!(dbUser?.realName && dbUser?.studentId);
    },

    // 获取学校组列表（管理员用）
    async getSchoolGroups(page: number = 1, limit: number = 20): Promise<{
        schools: SchoolGroup[];
        total: number;
        pageCount: number;
    }> {
        const skip = (page - 1) * limit;
        const total = await schoolGroupsColl.countDocuments();
        const schools = await schoolGroupsColl
            .find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        return {
            schools,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 获取用户组列表（管理员用）
    async getUserGroupsList(page: number = 1, limit: number = 20): Promise<{
        userGroups: UserGroup[];
        total: number;
        pageCount: number;
    }> {
        const skip = (page - 1) * limit;
        const total = await userGroupsColl.countDocuments();
        let userGroups = await userGroupsColl
            .find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        // 为了向后兼容，给没有groupType字段的用户组添加默认值0
        userGroups = userGroups.map(group => ({
            ...group,
            groupType: group.groupType !== undefined ? group.groupType : 0
        }));
        
        // 为每个用户组添加学校名称
        const schoolIds = [...new Set(userGroups.map(g => g.parentSchoolId?.toString()).filter(Boolean))];
        const schools = await schoolGroupsColl.find({}).toArray();
        const schoolMap = new Map(schools.map(s => [s._id.toString(), s.name]));
        
        userGroups = userGroups.map(group => ({
            ...group,
            schoolName: group.parentSchoolId ? schoolMap.get(group.parentSchoolId.toString()) : undefined
        }));
        
        return {
            userGroups,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 根据类型获取用户组列表
    async getUserGroupsByType(groupType: number, page: number = 1, limit: number = 20): Promise<{
        userGroups: UserGroup[];
        total: number;
        pageCount: number;
    }> {
        const skip = (page - 1) * limit;
        // 构建查询条件，兼容没有groupType字段的旧数据
        const query = groupType === 0 
            ? { $or: [{ groupType: 0 }, { groupType: { $exists: false } }] } 
            : { groupType: groupType };
            
        const total = await userGroupsColl.countDocuments(query);
        let userGroups = await userGroupsColl
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        // 为了向后兼容，给没有groupType字段的用户组添加默认值0
        userGroups = userGroups.map(group => ({
            ...group,
            groupType: group.groupType !== undefined ? group.groupType : 0
        }));
        
        // 为每个用户组添加学校名称
        const schoolIds = [...new Set(userGroups.map(g => g.parentSchoolId?.toString()).filter(Boolean))];
        const schools = await schoolGroupsColl.find({}).toArray();
        const schoolMap = new Map(schools.map(s => [s._id.toString(), s.name]));
        
        userGroups = userGroups.map(group => ({
            ...group,
            schoolName: group.parentSchoolId ? schoolMap.get(group.parentSchoolId.toString()) : undefined
        }));
        
        return {
            userGroups,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 检查用户是否属于某个学校组
    async isUserInSchool(userId: number): Promise<boolean> {
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        
        return !!(dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0);
    },

    // 向学校组添加成员
    async addSchoolGroupMembers(schoolGroupId: any, members: Array<{studentId: string, realName: string}>): Promise<void> {
        // 使用灵活的查询方式
        let school: SchoolGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            school = await schoolGroupsColl.findOne({ _id: schoolGroupId });
        } catch (error) {
            // 查询失败，继续尝试其他方式
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!school) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                school = allSchools.find(s => s._id.toString() === schoolGroupId.toString()) || null;
            } catch (error) {
                // 查询失败
            }
        }
        
        if (!school) {
            throw new Error('学校组不存在');
        }

        const newMembers = members.map(m => ({
            studentId: m.studentId,
            realName: m.realName,
            bound: false
        }));

        // 检查是否有重复的学号
        const existingIds = school.members?.map(m => m.studentId) || [];
        const duplicateIds = newMembers.filter(m => existingIds.includes(m.studentId));
        if (duplicateIds.length > 0) {
            throw new Error(`以下学号已存在: ${duplicateIds.map(m => m.studentId).join(', ')}`);
        }

        // 使用查找到的实际学校ID进行更新
        await schoolGroupsColl.updateOne(
            { _id: school._id },
            { $push: { members: { $each: newMembers } } }
        );
    },

    // 从学校组移除成员
    async removeSchoolGroupMembers(schoolGroupId: any, studentIds: string[]): Promise<void> {
        // 使用灵活的查询方式
        let school: SchoolGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            school = await schoolGroupsColl.findOne({ _id: schoolGroupId });
        } catch (error) {
            // 查询失败，继续尝试其他方式
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!school) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                school = allSchools.find(s => s._id.toString() === schoolGroupId.toString()) || null;
            } catch (error) {
                // 查询失败
            }
        }
        
        if (!school) {
            throw new Error('学校组不存在');
        }

        // 检查要删除的成员是否已绑定
        const boundMembers = school.members?.filter(m => 
            studentIds.includes(m.studentId) && m.bound
        ) || [];
        
        if (boundMembers.length > 0) {
            throw new Error(`以下成员已绑定，无法删除: ${boundMembers.map(m => `${m.studentId}(${m.realName})`).join(', ')}`);
        }

        await schoolGroupsColl.updateOne(
            { _id: school._id },
            { $pull: { members: { studentId: { $in: studentIds } } } }
        );
    },

    // 向用户组添加学生
    async addUserGroupStudents(userGroupId: any, students: Array<{studentId: string, realName: string}>): Promise<void> {
        // 统一使用字符串匹配
        const allGroups = await userGroupsColl.find().toArray();
        const userGroup = allGroups.find(g => g._id.toString() === userGroupId.toString());
        
        if (!userGroup) {
            throw new Error('用户组不存在');
        }

        const newStudents = students.map(s => ({
            studentId: s.studentId,
            realName: s.realName,
            bound: false
        }));

        // 检查是否有重复的学号
        const existingIds = userGroup.students?.map(s => s.studentId) || [];
        const duplicateIds = newStudents.filter(s => existingIds.includes(s.studentId));
        if (duplicateIds.length > 0) {
            throw new Error(`以下学号已存在: ${duplicateIds.map(s => s.studentId).join(', ')}`);
        }

        await userGroupsColl.updateOne(
            { _id: userGroup._id },
            { $push: { students: { $each: newStudents } } }
        );
    },

    // 从用户组移除学生
    async removeUserGroupStudents(userGroupId: any, studentIds: string[]): Promise<void> {
        // 统一使用字符串匹配
        const allGroups = await userGroupsColl.find().toArray();
        const userGroup = allGroups.find(g => g._id.toString() === userGroupId.toString());
        
        if (!userGroup) {
            throw new Error('用户组不存在');
        }

        // 检查要删除的学生是否已绑定
        const boundStudents = userGroup.students?.filter(s => 
            studentIds.includes(s.studentId) && s.bound
        ) || [];
        
        if (boundStudents.length > 0) {
            throw new Error(`以下学生已绑定，无法删除: ${boundStudents.map(s => `${s.studentId}(${s.realName})`).join(', ')}`);
        }

        await userGroupsColl.updateOne(
            { _id: userGroup._id },
            { $pull: { students: { studentId: { $in: studentIds } } } }
        );
    },

    // 获取学校组详情
    async getSchoolGroupById(schoolGroupId: any): Promise<SchoolGroup | null> {
        // 统一使用字符串匹配
        const allSchools = await schoolGroupsColl.find().toArray();
        return allSchools.find(school => school._id.toString() === schoolGroupId.toString()) || null;
    },

    // 获取用户组详情
    async getUserGroupById(userGroupId: any): Promise<UserGroup | null> {
        // 统一使用字符串匹配
        const allGroups = await userGroupsColl.find().toArray();
        return allGroups.find(group => group._id.toString() === userGroupId.toString()) || null;
    },

    // 删除学校组（包括解绑所有成员、删除相关用户组）
    async deleteSchoolGroup(schoolGroupId: any): Promise<void> {
        const school = await this.getSchoolGroupById(schoolGroupId);
        if (!school) {
            throw new Error('学校组不存在');
        }

        // 1. 解绑所有已绑定的成员
        if (school.members && school.members.length > 0) {
            const boundMembers = school.members.filter(m => m.bound && m.boundBy);
            
            for (const member of boundMembers) {
                if (member.boundBy) {
                    try {
                        // 从用户文档中移除学校组信息
                        await db.collection('user').updateOne(
                            { _id: member.boundBy },
                            { 
                                $unset: { 
                                    realName: '',
                                    studentId: '',
                                    parentSchoolId: ''
                                }
                            }
                        );
                    } catch (error) {
                        // 解绑失败，继续处理其他成员
                    }
                }
            }
        }

        // 2. 删除属于该学校的所有用户组
        const userGroups = await userGroupsColl.find({ parentSchoolId: school._id }).toArray();
        for (const userGroup of userGroups) {
            // 解绑用户组中的所有已绑定学生
            if (userGroup.students && userGroup.students.length > 0) {
                const boundStudents = userGroup.students.filter(s => s.bound && s.boundBy);
                
                for (const student of boundStudents) {
                    if (student.boundBy) {
                        try {
                            // 只清除学生信息，不操作不存在的字段
                            await db.collection('user').updateOne(
                                { _id: student.boundBy },
                                { 
                                    $unset: { 
                                        realName: '',
                                        studentId: '',
                                        parentUserGroupId: ''
                                    }
                                }
                            );
                        } catch (error) {
                            // 解绑失败，继续处理其他学生
                        }
                    }
                }
            }
            
            // 删除用户组
            await userGroupsColl.deleteOne({ _id: userGroup._id });
        }

        // 3. 删除学校组
        await schoolGroupsColl.deleteOne({ _id: school._id });
    },

    // 编辑学校组成员信息
    async editSchoolGroupMember(schoolGroupId: any, oldStudentId: string, newStudentId: string, newRealName: string): Promise<void> {
        const school = await this.getSchoolGroupById(schoolGroupId);
        if (!school) {
            throw new Error('学校组不存在');
        }

        const member = school.members?.find(m => m.studentId === oldStudentId);
        if (!member) {
            throw new Error('成员不存在');
        }

        // 如果学号发生变化，检查新学号是否已存在
        if (oldStudentId !== newStudentId) {
            const existingMember = school.members?.find(m => m.studentId === newStudentId);
            if (existingMember) {
                throw new Error('新学号已存在');
            }
        }

        // 更新学校组中的成员信息
        await schoolGroupsColl.updateOne(
            { _id: school._id, 'members.studentId': oldStudentId },
            { 
                $set: { 
                    'members.$.studentId': newStudentId,
                    'members.$.realName': newRealName
                } 
            }
        );

        // 如果成员已绑定，同时更新用户信息
        if (member.bound && member.boundBy) {
            await db.collection('user').updateOne(
                { _id: member.boundBy },
                { 
                    $set: { 
                        studentId: newStudentId,
                        realName: newRealName
                    }
                }
            );
        }

        // 同时更新相关用户组中的学生信息
        const userGroups = await userGroupsColl.find({ parentSchoolId: school._id }).toArray();
        for (const userGroup of userGroups) {
            const student = userGroup.students?.find(s => s.studentId === oldStudentId);
            if (student) {
                await userGroupsColl.updateOne(
                    { _id: userGroup._id, 'students.studentId': oldStudentId },
                    { 
                        $set: { 
                            'students.$.studentId': newStudentId,
                            'students.$.realName': newRealName
                        } 
                    }
                );
            }
        }
    },

    // 删除学校组成员（包括解绑操作）
    async deleteSchoolGroupMember(schoolGroupId: any, studentId: string): Promise<void> {
        const school = await this.getSchoolGroupById(schoolGroupId);
        if (!school) {
            throw new Error('学校组不存在');
        }

        const member = school.members?.find(m => m.studentId === studentId);
        if (!member) {
            throw new Error('成员不存在');
        }

        // 如果成员已绑定，先解绑
        if (member.bound && member.boundBy) {
            await db.collection('user').updateOne(
                { _id: member.boundBy },
                { 
                    $unset: { 
                        realName: '',
                        studentId: '',
                        parentSchoolId: ''
                    }
                }
            );
        }

        // 从学校组中移除成员
        await schoolGroupsColl.updateOne(
            { _id: school._id },
            { $pull: { members: { studentId: studentId } } }
        );

        // 从相关用户组中移除学生
        const userGroups = await userGroupsColl.find({ parentSchoolId: school._id }).toArray();
        for (const userGroup of userGroups) {
            const student = userGroup.students?.find(s => s.studentId === studentId);
            if (student) {
                // 如果学生已绑定，解绑
                if (student.bound && student.boundBy) {
                    await db.collection('user').updateOne(
                        { _id: student.boundBy },
                        { 
                            $unset: { 
                                realName: '', 
                                studentId: '',
                                parentUserGroupId: ''
                            }
                        }
                    );
                }
                
                // 从用户组中移除学生
                await userGroupsColl.updateOne(
                    { _id: userGroup._id },
                    { $pull: { students: { studentId: studentId } } }
                );
            }
        }
    },

    // 检查用户是否有参加比赛的权限
    async checkContestPermission(userId: number, contestId: any): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const documentColl = db.collection('document');
            let contest: any = null;
            
            // 尝试多种查询方式
            try {
                // 方式1: 直接查询
                contest = await documentColl.findOne({ 
                    _id: contestId,
                    docType: 30 // 比赛文档类型
                });
            } catch (error) {
                // 查询失败，继续尝试其他方式
            }
            
            // 方式2: 如果直接查询失败，尝试字符串匹配
            if (!contest) {
                try {
                    const allContests = await documentColl.find({ docType: 30 }).toArray();
                    
                    // 尝试字符串匹配
                    contest = allContests.find(c => {
                        return c._id.toString() === contestId.toString();
                    }) || null;
                } catch (error) {
                    // 查询失败
                }
            }
            
            if (!contest) {
                return { allowed: false, reason: '比赛不存在' };
            }
            
            const permission = contest.userBindPermission;
            
            // 如果未启用权限控制，允许所有用户参加
            if (!permission || !permission.enabled) {
                return { allowed: true };
            }

            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: userId });
            
            if (!dbUser) {
                return { allowed: false, reason: '用户不存在' };
            }

            // 检查用户是否拥有学校组绕过权限
            if (dbUser.schoolGroupBypass === true) {
                return { allowed: true };
            }

            if (permission.mode === 'school') {
                // 学校组模式
                if (!dbUser.parentSchoolId || dbUser.parentSchoolId.length === 0) {
                    return { allowed: false, reason: '您不属于任何学校组' };
                }

                // 检查用户的学校组是否在允许列表中
                const userSchoolIds = dbUser.parentSchoolId.map((id: any) => id.toString());
                const allowedSchoolIds = permission.allowedGroups.map((id: string) => id.toString());
                
                const hasPermission = userSchoolIds.some((schoolId: string) => 
                    allowedSchoolIds.includes(schoolId)
                );

                if (!hasPermission) {
                    return { allowed: false, reason: '您所在的学校组无权参加此比赛' };
                }
                
            } else if (permission.mode === 'user_group') {
                // 用户组模式
                if (!dbUser.parentUserGroupId || dbUser.parentUserGroupId.length === 0) {
                    return { allowed: false, reason: '您不属于任何用户组' };
                }

                // 检查用户的用户组是否在允许列表中
                const userGroupIds = dbUser.parentUserGroupId.map((id: any) => id.toString());
                const allowedGroupIds = permission.allowedGroups.map((id: string) => id.toString());
                
                const hasPermission = userGroupIds.some((groupId: string) => 
                    allowedGroupIds.includes(groupId)
                );

                if (!hasPermission) {
                    return { allowed: false, reason: '您所在的用户组无权参加此比赛' };
                }

                // 检查用户是否在比赛用户组中被标记为比赛已结束
                for (const groupIdStr of allowedGroupIds) {
                    if (userGroupIds.includes(groupIdStr)) {
                        // 找到用户所在的比赛用户组
                        const allUserGroups = await userGroupsColl.find().toArray();
                        const userGroup = allUserGroups.find(g => g._id.toString() === groupIdStr);
                        
                        if (userGroup && userGroup.groupType === 1) {
                            // 这是一个比赛类型的用户组，检查用户是否被标记为比赛结束
                            const student = userGroup.students?.find(s => s.boundBy === userId);
                            if (student && student.contestFinished === true) {
                                return { allowed: false, reason: '您在此比赛组中的比赛已结束，无法继续参加' };
                            }
                        }
                    }
                }
            }

            return { allowed: true };
        } catch (error) {
            return { allowed: false, reason: '权限检查失败' };
        }
    },

    // 获取拥有绕过权限的用户列表
    async getBypassUsers(page: number = 1, limit: number = 20, search?: string, status?: string): Promise<{
        users: any[];
        total: number;
        pageCount: number;
    }> {
        const userColl = db.collection('user');
        const skip = (page - 1) * limit;
        
        // 构建查询条件
        let query: any = {};
        
        // 如果指定了状态筛选
        if (status === 'enabled') {
            query.schoolGroupBypass = true;
        } else if (status === 'disabled') {
            query.schoolGroupBypass = { $ne: true };
        }
        
        // 如果有搜索条件
        if (search && search.trim()) {
            const searchTerm = search.trim();
            const searchQuery: any = { $or: [] };
            
            // 如果搜索词是数字，按UID搜索
            if (/^\d+$/.test(searchTerm)) {
                searchQuery.$or.push({ _id: parseInt(searchTerm) });
            }
            
            // 按用户名搜索
            searchQuery.$or.push({ 
                uname: { $regex: searchTerm, $options: 'i' } 
            });
            
            // 合并搜索条件
            if (Object.keys(query).length > 0) {
                query = { $and: [query, searchQuery] };
            } else {
                query = searchQuery;
            }
        }
        
        // 只查询有绕过权限设置的用户（包括已启用和已禁用）
        if (!search && !status) {
            query.$or = [
                { schoolGroupBypass: true },
                { schoolGroupBypass: false },
                { schoolGroupBypass: { $exists: true } }
            ];
        }
        
        const total = await userColl.countDocuments(query);
        const users = await userColl.find(query)
            .sort({ bypassSetAt: -1, _id: 1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        return {
            users,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 添加绕过权限（单个用户）
    async addBypassPermission(userId: number): Promise<void> {
        const userColl = db.collection('user');
        
        const user = await userColl.findOne({ _id: userId });
        if (!user) {
            throw new Error('用户不存在');
        }
        
        await userColl.updateOne(
            { _id: userId },
            { 
                $set: { 
                    schoolGroupBypass: true,
                    bypassSetAt: new Date()
                }
            }
        );
    },

    // 批量添加绕过权限（通过用户名）
    async addBypassPermissionByUsernames(usernames: string[]): Promise<{ success: number; failed: string[] }> {
        const userColl = db.collection('user');
        let success = 0;
        const failed: string[] = [];
        
        for (const username of usernames) {
            if (!username.trim()) {
                continue;
            }
            
            try {
                const result = await userColl.updateOne(
                    { uname: username.trim() },
                    { 
                        $set: { 
                            schoolGroupBypass: true,
                            bypassSetAt: new Date()
                        }
                    }
                );
                
                if (result.matchedCount > 0) {
                    success++;
                } else {
                    failed.push(username);
                }
            } catch (error) {
                failed.push(username);
            }
        }
        
        return { success, failed };
    },

    // 批量添加绕过权限（通过UID）
    async addBypassPermissionByUids(uids: number[]): Promise<{ success: number; failed: number[] }> {
        const userColl = db.collection('user');
        let success = 0;
        const failed: number[] = [];
        
        for (const uid of uids) {
            try {
                const result = await userColl.updateOne(
                    { _id: uid },
                    { 
                        $set: { 
                            schoolGroupBypass: true,
                            bypassSetAt: new Date()
                        }
                    }
                );
                
                if (result.matchedCount > 0) {
                    success++;
                } else {
                    failed.push(uid);
                }
            } catch (error) {
                failed.push(uid);
            }
        }
        
        return { success, failed };
    },

    // 启用绕过权限
    async enableBypassPermission(userId: number): Promise<void> {
        const userColl = db.collection('user');
        
        const result = await userColl.updateOne(
            { _id: userId },
            { 
                $set: { 
                    schoolGroupBypass: true,
                    bypassSetAt: new Date()
                }
            }
        );
        
        if (result.matchedCount === 0) {
            throw new Error('用户不存在');
        }
    },

    // 禁用绕过权限
    async disableBypassPermission(userId: number): Promise<void> {
        const userColl = db.collection('user');
        
        const result = await userColl.updateOne(
            { _id: userId },
            { 
                $set: { 
                    schoolGroupBypass: false,
                    bypassSetAt: new Date()
                }
            }
        );
        
        if (result.matchedCount === 0) {
            throw new Error('用户不存在');
        }
    },

    // 移除绕过权限记录
    async removeBypassPermission(userId: number): Promise<void> {
        const userColl = db.collection('user');
        
        const result = await userColl.updateOne(
            { _id: userId },
            { 
                $unset: { 
                    schoolGroupBypass: '',
                    bypassSetAt: ''
                }
            }
        );
        
        if (result.matchedCount === 0) {
            throw new Error('用户不存在');
        }
    },

    // 批量启用绕过权限
    async batchEnableBypassPermission(userIds: number[]): Promise<{ success: number; failed: number[] }> {
        const userColl = db.collection('user');
        let success = 0;
        const failed: number[] = [];
        
        for (const userId of userIds) {
            try {
                const result = await userColl.updateOne(
                    { _id: userId },
                    { 
                        $set: { 
                            schoolGroupBypass: true,
                            bypassSetAt: new Date()
                        }
                    }
                );
                
                if (result.matchedCount > 0) {
                    success++;
                } else {
                    failed.push(userId);
                }
            } catch (error) {
                failed.push(userId);
            }
        }
        
        return { success, failed };
    },

    // 批量禁用绕过权限
    async batchDisableBypassPermission(userIds: number[]): Promise<{ success: number; failed: number[] }> {
        const userColl = db.collection('user');
        let success = 0;
        const failed: number[] = [];
        
        for (const userId of userIds) {
            try {
                const result = await userColl.updateOne(
                    { _id: userId },
                    { 
                        $set: { 
                            schoolGroupBypass: false,
                            bypassSetAt: new Date()
                        }
                    }
                );
                
                if (result.matchedCount > 0) {
                    success++;
                } else {
                    failed.push(userId);
                }
            } catch (error) {
                failed.push(userId);
            }
        }
        
        return { success, failed };
    },

    // 批量移除绕过权限记录
    async batchRemoveBypassPermission(userIds: number[]): Promise<{ success: number; failed: number[] }> {
        const userColl = db.collection('user');
        let success = 0;
        const failed: number[] = [];
        
        for (const userId of userIds) {
            try {
                const result = await userColl.updateOne(
                    { _id: userId },
                    { 
                        $unset: { 
                            schoolGroupBypass: '',
                            bypassSetAt: ''
                        }
                    }
                );
                
                if (result.matchedCount > 0) {
                    success++;
                } else {
                    failed.push(userId);
                }
            } catch (error) {
                failed.push(userId);
            }
        }
        
        return { success, failed };
    },

    // ========== 绑定申请相关方法 ==========

    // 创建绑定申请
    async createBindingRequest(userId: number, schoolGroupId: any, studentId: string, realName: string): Promise<any> {
        // 检查用户是否已有待审核的申请
        const existingRequest = await bindingRequestsColl.findOne({
            userId: userId,
            status: 'pending'
        });
        
        if (existingRequest) {
            throw new Error('您已有待审核的绑定申请，请耐心等待');
        }

        // 检查用户是否已绑定
        if (await this.isUserBound(userId)) {
            throw new Error('您已经绑定过了');
        }

        // 验证学校组是否存在
        const school = await this.getSchoolGroupById(schoolGroupId);
        if (!school) {
            throw new Error('选择的学校组不存在');
        }

        // 检查学校组是否有成员数据结构
        if (!school.members || !Array.isArray(school.members)) {
            // 如果学校组没有成员信息，需要申请审核
            const result = await bindingRequestsColl.insertOne({
                userId: userId,
                schoolGroupId: schoolGroupId,
                studentId: studentId,
                realName: realName,
                status: 'pending',
                createdAt: new Date(),
                updatedAt: new Date()
            });
            
            return { type: 'request', id: result.insertedId };
        }

        // 检查学号姓名是否在学校组中存在
        const member = school.members.find(m => m.studentId === studentId && m.realName === realName);
        
        if (member) {
            // 存在匹配的成员
            if (member.bound) {
                throw new Error('该学生信息已被绑定');
            }
            
            // 直接绑定成功
            const userColl = db.collection('user');
            
            // 检查用户是否已有学校组
            const dbUser = await userColl.findOne({ _id: userId });
            
            if (dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0) {
                throw new Error('您已属于其他学校组');
            }

            // 更新用户信息
            await userColl.updateOne(
                { _id: userId },
                {
                    $set: {
                        realName,
                        studentId
                    },
                    $addToSet: {
                        parentSchoolId: schoolGroupId
                    }
                }
            );

            // 更新学校组中的成员状态
            await schoolGroupsColl.updateOne(
                { 
                    _id: school._id, 
                    'members': {
                        $elemMatch: {
                            'studentId': studentId,
                            'realName': realName,
                            'bound': false
                        }
                    }
                },
                {
                    $set: {
                        'members.$.bound': true,
                        'members.$.boundBy': userId,
                        'members.$.boundAt': new Date()
                    }
                }
            );
            
            return { type: 'direct_bind', success: true };
        } else {
            // 不存在匹配的成员，需要申请审核
            const result = await bindingRequestsColl.insertOne({
                userId: userId,
                schoolGroupId: schoolGroupId,
                studentId: studentId,
                realName: realName,
                status: 'pending',
                createdAt: new Date(),
                updatedAt: new Date()
            });
            
            return { type: 'request', id: result.insertedId };
        }
    },

    // 获取绑定申请列表（管理员用）
    async getBindingRequests(page: number = 1, limit: number = 20, status?: string): Promise<{
        requests: any[];
        total: number;
        pageCount: number;
    }> {
        const skip = (page - 1) * limit;
        let query: any = {};
        
        if (status && ['pending', 'approved', 'rejected'].includes(status)) {
            query.status = status;
        }
        
        const total = await bindingRequestsColl.countDocuments(query);
        const requests = await bindingRequestsColl
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        // 补充用户信息和学校组信息
        const userColl = db.collection('user');
        for (const request of requests) {
            // 获取申请用户信息
            const user = await userColl.findOne({ _id: request.userId });
            (request as any).user = user ? { _id: user._id, uname: user.uname } : null;
            
            // 获取学校组信息
            const school = await this.getSchoolGroupById(request.schoolGroupId);
            (request as any).school = school ? { _id: school._id, name: school.name } : null;
            
            // 格式化日期
            if (request.createdAt) {
                (request as any).createdAtFormatted = new Date(request.createdAt).toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
            
            // 获取审核者信息
            if (request.reviewedBy) {
                const reviewer = await userColl.findOne({ _id: request.reviewedBy });
                (request as any).reviewer = reviewer ? { _id: reviewer._id, uname: reviewer.uname } : null;
            }
            
            // 格式化审核时间
            if (request.reviewedAt) {
                (request as any).reviewedAtFormatted = new Date(request.reviewedAt).toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
        }
        
        return {
            requests,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 获取用户的绑定申请
    async getUserBindingRequest(userId: number): Promise<any> {
        const request = await bindingRequestsColl.findOne({
            userId: userId,
            status: 'pending'
        });
        
        if (request) {
            // 补充学校组信息
            const school = await this.getSchoolGroupById(request.schoolGroupId);
            (request as any).school = school ? { _id: school._id, name: school.name } : null;
            
            // 格式化日期
            if (request.createdAt) {
                (request as any).createdAtFormatted = new Date(request.createdAt).toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            }
        }
        
        return request;
    },

    // 审核绑定申请
    async reviewBindingRequest(requestId: any, action: 'approve' | 'reject', reviewerId: number, reviewComment?: string): Promise<void> {
        // 使用灵活的查询方式
        let request: any = null;
        
        try {
            // 方式1: 直接使用传入的ID查询
            request = await bindingRequestsColl.findOne({ _id: requestId });
        } catch (error) {
            // 查询失败，继续尝试其他方式
        }
        
        // 方式2: 字符串匹配查找
        if (!request && requestId) {
            try {
                const allRequests = await bindingRequestsColl.find().toArray();
                request = allRequests.find(r => r._id.toString() === requestId.toString()) || null;
            } catch (error) {
                // 查询失败
            }
        }
        
        if (!request) {
            throw new Error('绑定申请不存在');
        }
        
        if (request.status !== 'pending') {
            throw new Error('该申请已被处理');
        }

        const updateData: any = {
            status: action === 'approve' ? 'approved' : 'rejected',
            reviewedBy: reviewerId,
            reviewedAt: new Date(),
            updatedAt: new Date()
        };
        
        if (reviewComment) {
            updateData.reviewComment = reviewComment;
        }

        // 更新申请状态
        await bindingRequestsColl.updateOne(
            { _id: request._id },
            { $set: updateData }
        );

        // 如果是同意，更新用户信息
        if (action === 'approve') {
            const userColl = db.collection('user');
            
            await userColl.updateOne(
                { _id: request.userId },
                {
                    $set: {
                        realName: request.realName,
                        studentId: request.studentId
                    },
                    $addToSet: {
                        parentSchoolId: request.schoolGroupId
                    }
                }
            );

            // 处理学校组成员信息 - 重新获取最新的学校组数据
            const school = await this.getSchoolGroupById(request.schoolGroupId);
            if (school) {
                // 确保学校组有members数组
                if (!school.members || !Array.isArray(school.members)) {
                    // 如果学校组没有members数组，初始化并添加新成员
                    const newMember = {
                        studentId: request.studentId,
                        realName: request.realName,
                        bound: true,
                        boundBy: request.userId,
                        boundAt: new Date()
                    };
                    
                    await schoolGroupsColl.updateOne(
                        { _id: school._id },
                        { $set: { members: [newMember] } }
                    );
                } else {
                    // 重新检查是否已有对应成员记录（可能在申请期间已导入）
                    const existingMember = school.members.find((m: { studentId: any; realName: any; }) => 
                        m.studentId === request.studentId && m.realName === request.realName
                    );
                    
                    if (existingMember) {
                        // 情况1：在申请期间已经导入了该学号姓名，更新现有记录的绑定状态
                        if (!existingMember.bound) {
                            await schoolGroupsColl.updateOne(
                                { 
                                    _id: school._id, 
                                    'members': {
                                        $elemMatch: {
                                            'studentId': request.studentId,
                                            'realName': request.realName,
                                            'bound': false
                                        }
                                    }
                                },
                                {
                                    $set: {
                                        'members.$.bound': true,
                                        'members.$.boundBy': request.userId,
                                        'members.$.boundAt': new Date()
                                    }
                                }
                            );
                        }
                        // 如果已经绑定，说明可能有并发操作，但用户信息已更新，可以忽略
                    } else {
                        // 情况2：学校组中没有该成员，添加新成员
                        const newMember = {
                            studentId: request.studentId,
                            realName: request.realName,
                            bound: true,
                            boundBy: request.userId,
                            boundAt: new Date()
                        };
                        
                        await schoolGroupsColl.updateOne(
                            { _id: school._id },
                            { $push: { members: newMember } }
                        );
                    }
                }
            }
        }
    },

    // 获取所有可申请的学校组
    async getAvailableSchoolGroups(): Promise<SchoolGroup[]> {
        return await schoolGroupsColl.find().sort({ name: 1 }).toArray();
    },

    // ========== 用户管理API ==========
    
    // API 1: 添加用户到用户组
    async addUserToUserGroup(userId: number, userGroupId: any): Promise<{ success: boolean; message: string }> {
        // 统一使用字符串匹配查找用户组
        let userGroup: UserGroup | null = null;
        const allUserGroups = await userGroupsColl.find().toArray();
        userGroup = allUserGroups.find(group => group._id.toString() === userGroupId.toString()) || null;
        
        if (!userGroup) {
            return { success: false, message: '用户组不存在' };
        }

        // 检查用户是否已在此用户组中
        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        
        if (!user) {
            return { success: false, message: '用户不存在' };
        }

        if (user.parentUserGroupId && user.parentUserGroupId.some((id: any) => id.toString() === userGroupId.toString())) {
            return { success: false, message: '用户已在此用户组中' };
        }

        // 检查用户是否属于用户组的学校
        const targetSchool = await this.getSchoolGroupById(userGroup.parentSchoolId);
        if (!targetSchool) {
            return { success: false, message: '用户组所属学校不存在' };
        }

        // 检查用户是否已属于该学校
        const userSchoolMatched = user.parentSchoolId && user.parentSchoolId.some((id: any) => 
            id.toString() === targetSchool._id.toString()
        );

        if (!userSchoolMatched) {
            return { success: false, message: '用户不属于该用户组的学校，请先添加到学校组' };
        }

        // 添加用户到用户组
        await userColl.updateOne(
            { _id: userId },
            { $addToSet: { parentUserGroupId: userGroup._id } }
        );

        return { success: true, message: '用户已成功添加到用户组' };
    },

    // API 2: 从用户组移除用户
    async removeUserFromUserGroup(userId: number, userGroupId: any): Promise<{ success: boolean; message: string }> {
        // 统一使用字符串匹配查找用户组
        let userGroup: UserGroup | null = null;
        const allUserGroups = await userGroupsColl.find().toArray();
        userGroup = allUserGroups.find(group => group._id.toString() === userGroupId.toString()) || null;
        
        if (!userGroup) {
            return { success: false, message: '用户组不存在' };
        }

        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        
        if (!user) {
            return { success: false, message: '用户不存在' };
        }

        // 检查用户是否在此用户组中
        if (!user.parentUserGroupId || !user.parentUserGroupId.some((id: any) => id.toString() === userGroupId.toString())) {
            return { success: false, message: '用户不在此用户组中' };
        }

        // 从用户组中移除用户
        await userColl.updateOne(
            { _id: userId },
            { $pull: { 'parentUserGroupId': userGroup._id } } as any
        );

        // 检查用户组中是否有该用户的绑定记录，如果有则解绑
        const boundStudent = userGroup.students?.find(s => s.boundBy === userId);
        if (boundStudent) {
            // 解绑用户组中的学生记录
            await userGroupsColl.updateOne(
                { _id: userGroup._id, 'students.boundBy': userId },
                {
                    $set: {
                        'students.$.bound': false,
                        'students.$.boundBy': null,
                        'students.$.boundAt': null
                    }
                }
            );

            // 清除用户的绑定信息（如果用户没有其他用户组）
            const updatedUser = await userColl.findOne({ _id: userId });
            if (!updatedUser?.parentUserGroupId || updatedUser.parentUserGroupId.length === 0) {
                await userColl.updateOne(
                    { _id: userId },
                    { 
                        $unset: { 
                            realName: '',
                            studentId: ''
                        }
                    }
                );
            }
        }

        return { success: true, message: '用户已成功从用户组移除' };
    },

    // API 3: 添加用户到学校组
    async addUserToSchoolGroup(userId: number, schoolGroupId: any): Promise<{ success: boolean; message: string }> {
        // 统一使用字符串匹配查找学校组
        let schoolGroup: SchoolGroup | null = null;
        const allSchoolGroups = await schoolGroupsColl.find().toArray();
        schoolGroup = allSchoolGroups.find(school => school._id.toString() === schoolGroupId.toString()) || null;
        
        if (!schoolGroup) {
            return { success: false, message: '学校组不存在' };
        }

        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        
        if (!user) {
            return { success: false, message: '用户不存在' };
        }

        // 检查用户是否已在此学校组中
        if (user.parentSchoolId && user.parentSchoolId.some((id: any) => id.toString() === schoolGroupId.toString())) {
            return { success: false, message: '用户已在此学校组中' };
        }

        // 添加用户到学校组
        await userColl.updateOne(
            { _id: userId },
            { $addToSet: { parentSchoolId: schoolGroup._id } }
        );

        return { success: true, message: '用户已成功添加到学校组' };
    },

    // API 4: 从学校组移除用户
    async removeUserFromSchoolGroup(userId: number, schoolGroupId: any): Promise<{ success: boolean; message: string }> {
        // 统一使用字符串匹配查找学校组
        let schoolGroup: SchoolGroup | null = null;
        const allSchoolGroups = await schoolGroupsColl.find().toArray();
        schoolGroup = allSchoolGroups.find(school => school._id.toString() === schoolGroupId.toString()) || null;
        
        if (!schoolGroup) {
            return { success: false, message: '学校组不存在' };
        }

        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        
        if (!user) {
            return { success: false, message: '用户不存在' };
        }

        // 检查用户是否在此学校组中
        if (!user.parentSchoolId || !user.parentSchoolId.some((id: any) => id.toString() === schoolGroupId.toString())) {
            return { success: false, message: '用户不在此学校组中' };
        }

        // 1. 找到所有属于该学校组的用户组
        const allUserGroups = await userGroupsColl.find().toArray();
        const relatedUserGroups = allUserGroups.filter(group => 
            group.parentSchoolId && group.parentSchoolId.toString() === schoolGroupId.toString()
        );

        // 2. 从所有相关用户组中移除用户并解绑
        for (const userGroup of relatedUserGroups) {
            // 从用户组中移除用户
            await userColl.updateOne(
                { _id: userId },
                { $pull: { 'parentUserGroupId': userGroup._id } } as any
            );

            // 解绑用户组中的学生记录
            const boundStudent = userGroup.students?.find(s => s.boundBy === userId);
            if (boundStudent) {
                await userGroupsColl.updateOne(
                    { _id: userGroup._id, 'students.boundBy': userId },
                    {
                        $set: {
                            'students.$.bound': false,
                            'students.$.boundBy': null,
                            'students.$.boundAt': null
                        }
                    }
                );
            }
        }

        // 3. 从学校组中移除用户
        await userColl.updateOne(
            { _id: userId },
            { $pull: { 'parentSchoolId': schoolGroup._id } } as any
        );

        // 4. 解绑学校组中的成员记录
        if (schoolGroup.members) {
            const boundMember = schoolGroup.members.find(m => m.boundBy === userId);
            if (boundMember) {
                await schoolGroupsColl.updateOne(
                    { _id: schoolGroup._id, 'members.boundBy': userId },
                    {
                        $set: {
                            'members.$.bound': false,
                            'members.$.boundBy': null,
                            'members.$.boundAt': null
                        }
                    }
                );
            }
        }

        // 5. 清除用户的绑定信息（如果用户没有其他学校组）
        const updatedUser = await userColl.findOne({ _id: userId });
        if (!updatedUser?.parentSchoolId || updatedUser.parentSchoolId.length === 0) {
            await userColl.updateOne(
                { _id: userId },
                { 
                    $unset: { 
                        realName: '',
                        studentId: '',
                        parentUserGroupId: ''
                    }
                }
            );
        }

        return { success: true, message: '用户已成功从学校组移除，相关用户组绑定已解除' };
    },

    // API 5: 标记比赛用户组中的用户结束比赛
    async markUserContestFinished(userId: number, contestUserGroupId: any): Promise<{ success: boolean; message: string }> {
        // 统一使用字符串匹配查找用户组
        let userGroup: UserGroup | null = null;
        const allUserGroups = await userGroupsColl.find().toArray();
        userGroup = allUserGroups.find(group => group._id.toString() === contestUserGroupId.toString()) || null;
        
        if (!userGroup) {
            return { success: false, message: '比赛用户组不存在' };
        }

        // 检查是否为比赛类型的用户组 (groupType = 1)
        if (userGroup.groupType !== 1) {
            return { success: false, message: '该用户组不是比赛类型用户组' };
        }

        const userColl = db.collection('user');
        const user = await userColl.findOne({ _id: userId });
        
        if (!user) {
            return { success: false, message: '用户不存在' };
        }

        // 检查用户是否在此用户组中
        if (!user.parentUserGroupId || !user.parentUserGroupId.some((id: any) => id.toString() === contestUserGroupId.toString())) {
            return { success: false, message: '用户不在此比赛用户组中' };
        }

        // 查找用户组中该用户的绑定记录
        const boundStudent = userGroup.students?.find(s => s.boundBy === userId);
        if (!boundStudent) {
            return { success: false, message: '未找到用户在该比赛组中的绑定记录' };
        }

        // 标记用户比赛结束
        await userGroupsColl.updateOne(
            { _id: userGroup._id, 'students.boundBy': userId },
            {
                $set: {
                    'students.$.contestFinished': true,
                    'students.$.contestFinishedAt': new Date()
                }
            }
        );

        return { success: true, message: '用户已成功标记为比赛结束' };
    }
};

global.Hydro.model.userBind = userBindModel;

// 比赛权限管理界面
class ContestPermissionHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { contestId } = this.request.params;
        
        if (!contestId) {
            throw new NotFoundError('比赛ID无效');
        }

        // 获取比赛信息（从document集合中获取docType为30的文档）
        const documentColl = db.collection('document');
        
        let contest: any = null;
        
        try {
            // 方式1: 直接查询
            contest = await documentColl.findOne({ 
                _id: contestId,
                docType: 30 // 比赛文档类型
            });
        } catch (error) {
            // 查询失败，继续尝试其他方式
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!contest) {
            try {
                const allContests = await documentColl.find({ docType: 30 }).toArray();
                
                // 尝试字符串匹配
                contest = allContests.find(c => {
                    return c._id.toString() === contestId.toString();
                }) || null;
            } catch (error) {
                // 查询失败
            }
        }
        
        if (!contest) {
            throw new NotFoundError('比赛不存在');
        }

        // 获取所有学校组和比赛类型的用户组
        const { schools } = await userBindModel.getSchoolGroups(1, 1000);
        
        // 优先获取比赛类型的用户组(type=1)，如果没有则获取所有用户组
        let { userGroups } = await userBindModel.getUserGroupsByType(1, 1, 1000);
        
        // 如果没有比赛类型的用户组，则获取所有用户组作为备选
        if (!userGroups || userGroups.length === 0) {
            const allGroups = await userBindModel.getUserGroupsList(1, 1000);
            userGroups = allGroups.userGroups;
        }

        // 获取比赛的权限设置
        const contestPermission = contest.userBindPermission || {
            enabled: false,
            mode: 'school', // 'school' 或 'user_group'
            allowedGroups: []
        };

        // 检查是否有成功消息
        const { success, message } = this.request.query;

        this.response.template = 'contest_permission.html';
        this.response.body = {
            contest,
            schools,
            userGroups,
            contestPermission,
            success: success === '1',
            message: message ? decodeURIComponent(message as string) : null
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { contestId } = this.request.params;
        const { enabled, mode, allowedGroups } = this.request.body;

        if (!contestId) {
            throw new NotFoundError('比赛ID无效');
        }

        try {
            const documentColl = db.collection('document');
            let contest: any = null;
            
            // 使用与get方法相同的查询逻辑
            try {
                // 方式1: 先尝试直接查询
                contest = await documentColl.findOne({ 
                    _id: contestId,
                    docType: 30 // 比赛文档类型
                });
            } catch (error) {
                // 直接查询失败
            }
            
            // 方式2: 如果直接查询失败或未找到，使用字符串匹配
            if (!contest) {
                try {
                    // 获取所有比赛并进行字符串匹配
                    const allContests = await documentColl.find({ docType: 30 }).toArray();
                    contest = allContests.find(c => {
                        try {
                            // 尝试多种匹配方式
                            return c._id.toString() === contestId.toString() || 
                                   c._id === contestId ||
                                   (typeof c._id === 'object' && c._id.equals && c._id.equals(contestId));
                        } catch (e) {
                            return false;
                        }
                    }) || null;
                } catch (error) {
                    console.warn('查找比赛失败:', error);
                }
            }
            
            if (!contest) {
                throw new Error('比赛不存在');
            }

            // 构建权限配置
            const permissionConfig = {
                enabled: enabled === 'true',
                mode: mode || 'school',
                allowedGroups: Array.isArray(allowedGroups) ? allowedGroups : (allowedGroups ? [allowedGroups] : [])
            };

            // 更新比赛权限配置 - 使用找到的实际比赛ID
            await documentColl.updateOne(
                { _id: contest._id, docType: 30 },
                { $set: { userBindPermission: permissionConfig } }
            );

            this.response.redirect = `/contest/${contestId}/permission?success=1&message=${encodeURIComponent('权限配置更新成功')}`;
        } catch (error: any) {
            const { schools } = await userBindModel.getSchoolGroups(1, 1000);
            const { userGroups } = await userBindModel.getUserGroupsList(1, 1000);
            
            this.response.template = 'contest_permission.html';
            this.response.body = {
                contest: { _id: contestId },
                schools,
                userGroups,
                contestPermission: {
                    enabled: enabled === 'true',
                    mode: mode || 'school',
                    allowedGroups: Array.isArray(allowedGroups) ? allowedGroups : (allowedGroups ? [allowedGroups] : [])
                },
                error: error.message
            };
        }
    }
}

// 学校组管理界面
class SchoolGroupManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const page = +(this.request.query.page || '1');
        const { schools, total, pageCount } = await userBindModel.getSchoolGroups(page);
        
        // 检查是否有成功消息
        const { success, message } = this.request.query;
        
        this.response.template = 'school_group_manage.html';
        this.response.body = { 
            schools, 
            total, 
            pageCount, 
            page,
            success: success === '1',
            message: message ? decodeURIComponent(message as string) : null
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { action, schoolId } = this.request.body;
        
        try {
            if (action === 'delete_school') {
                if (!schoolId) {
                    throw new Error('学校组ID无效');
                }
                
                // 获取学校组信息用于显示
                const school = await userBindModel.getSchoolGroupById(schoolId);
                if (!school) {
                    throw new Error('学校组不存在');
                }
                
                await userBindModel.deleteSchoolGroup(schoolId);
                
                // 跳转到成功页面，带上成功信息
                this.response.redirect = `/school-group/manage?success=1&message=${encodeURIComponent(`学校组"${school.name}"删除成功`)}`;
            } else {
                throw new Error('未知操作');
            }
        } catch (error: any) {
            const page = +(this.request.query.page || '1');
            const { schools, total, pageCount } = await userBindModel.getSchoolGroups(page);
            
            this.response.template = 'school_group_manage.html';
            this.response.body = { 
                schools, 
                total, 
                pageCount, 
                page,
                error: error.message 
            };
        }
    }
}

// 学校组详情和成员管理界面
class SchoolGroupDetailHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { schoolId } = this.request.params;
        
        if (!schoolId) {
            throw new NotFoundError('学校组ID无效');
        }
        
        const school = await userBindModel.getSchoolGroupById(schoolId);
        
        if (!school) {
            throw new NotFoundError('学校组不存在');
        }
        
        // 检查是否有成功消息
        const { success, message } = this.request.query;
        
        this.response.template = 'school_group_detail.html';
        this.response.body = { 
            school,
            success: success === '1',
            message: message ? decodeURIComponent(message as string) : null
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { schoolId } = this.request.params;
        const { action, membersData, selectedMembers, studentId, newStudentId, newRealName } = this.request.body;
        
        if (!schoolId) {
            throw new NotFoundError('学校组ID无效');
        }

        try {
            if (action === 'add_members') {
                // 添加成员
                const members: Array<{studentId: string, realName: string}> = [];
                if (membersData) {
                    const lines = membersData.trim().split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const studentId = parts[0];
                            const realName = parts.slice(1).join(' ');
                            members.push({ studentId, realName });
                        }
                    }
                }

                if (members.length === 0) {
                    throw new Error('请添加成员信息');
                }

                await userBindModel.addSchoolGroupMembers(schoolId, members);
                this.response.redirect = `/school-group/detail/${schoolId}?success=1&message=${encodeURIComponent(`成功添加 ${members.length} 个成员`)}`;
                
            } else if (action === 'remove_members') {
                // 移除成员（旧版本，只能删除未绑定的）
                if (!selectedMembers || selectedMembers.length === 0) {
                    throw new Error('请选择要删除的成员');
                }
                
                const studentIds = Array.isArray(selectedMembers) ? selectedMembers : [selectedMembers];
                await userBindModel.removeSchoolGroupMembers(schoolId, studentIds);
                this.response.redirect = `/school-group/detail/${schoolId}?success=1&message=${encodeURIComponent(`成功删除 ${studentIds.length} 个成员`)}`;
                
            } else if (action === 'edit_member') {
                // 编辑成员信息
                if (!studentId || !newStudentId || !newRealName) {
                    throw new Error('请提供完整的编辑信息');
                }
                
                await userBindModel.editSchoolGroupMember(schoolId, studentId, newStudentId, newRealName);
                this.response.redirect = `/school-group/detail/${schoolId}?success=1&message=${encodeURIComponent(`成功编辑成员信息：${newStudentId} ${newRealName}`)}`;
                
            } else if (action === 'delete_member') {
                // 删除成员（支持已绑定的成员）
                if (!studentId) {
                    throw new Error('请提供要删除的成员学号');
                }
                
                await userBindModel.deleteSchoolGroupMember(schoolId, studentId);
                this.response.redirect = `/school-group/detail/${schoolId}?success=1&message=${encodeURIComponent(`成功删除成员：${studentId}`)}`;
            }

            this.response.redirect = `/school-group/detail/${schoolId}`;
        } catch (error: any) {
            const school = await userBindModel.getSchoolGroupById(schoolId);
            this.response.template = 'school_group_detail.html';
            this.response.body = { 
                school,
                error: error.message,
                membersData: this.request.body.membersData
            };
        }
    }
}

// 创建学校组界面
class SchoolGroupCreateHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        this.response.template = 'school_group_create.html';
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { name, membersData } = this.request.body;
        
        if (!name) {
            this.response.template = 'school_group_create.html';
            this.response.body = { error: '请输入学校名称', name, membersData };
            return;
        }

        // 解析成员数据
        const members: Array<{studentId: string, realName: string}> = [];
        if (membersData) {
            const lines = membersData.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const studentId = parts[0];
                    const realName = parts.slice(1).join(' ');
                    members.push({ studentId, realName });
                }
            }
        }

        if (members.length === 0) {
            this.response.template = 'school_group_create.html';
            this.response.body = { 
                error: '请添加学校成员信息', 
                name, 
                membersData 
            };
            return;
        }

        try {
            const schoolId = await userBindModel.createSchoolGroup(name, this.user._id, members);
            const bindToken = await userBindModel.createSchoolGroupBindToken(schoolId, this.user._id);
            
            this.response.template = 'school_group_created.html';
            this.response.body = {
                school: { _id: schoolId, name },
                bindToken,
                bindUrl: `/bind/${bindToken}`,
                membersCount: members.length
            };
        } catch (error: any) {
            this.response.template = 'school_group_create.html';
            this.response.body = { error: error.message, name, membersData };
        }
    }
}

// 用户组管理界面
class UserGroupManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const page = +(this.request.query.page || '1');
        const { userGroups, total, pageCount } = await userBindModel.getUserGroupsList(page);
        
        this.response.template = 'user_group_manage.html';
        this.response.body = { userGroups, total, pageCount, page };
    }
}

// 用户组详情和成员管理界面
class UserGroupDetailHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { groupId } = this.request.params;
        
        if (!groupId) {
            throw new NotFoundError('用户组ID无效');
        }
        
        const userGroup = await userBindModel.getUserGroupById(groupId);
        if (!userGroup) {
            throw new NotFoundError('用户组不存在');
        }

        // 获取所属学校信息
        const school = await userBindModel.getSchoolGroupById(userGroup.parentSchoolId);
        
        this.response.template = 'user_group_detail.html';
        this.response.body = { userGroup, school };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { groupId } = this.request.params;
        const { action, studentsData, selectedStudents } = this.request.body;
        
        if (!groupId) {
            throw new NotFoundError('用户组ID无效');
        }

        try {
            if (action === 'add_students') {
                // 添加学生
                const students: Array<{studentId: string, realName: string}> = [];
                if (studentsData) {
                    const lines = studentsData.trim().split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const studentId = parts[0];
                            const realName = parts.slice(1).join(' ');
                            students.push({ studentId, realName });
                        }
                    }
                }

                if (students.length === 0) {
                    throw new Error('请添加学生信息');
                }

                await userBindModel.addUserGroupStudents(groupId, students);
                
            } else if (action === 'remove_students') {
                // 移除学生
                if (!selectedStudents || selectedStudents.length === 0) {
                    throw new Error('请选择要删除的学生');
                }
                
                const studentIds = Array.isArray(selectedStudents) ? selectedStudents : [selectedStudents];
                await userBindModel.removeUserGroupStudents(groupId, studentIds);
            }

            this.response.redirect = `/user-group/detail/${groupId}`;
        } catch (error: any) {
            const userGroup = await userBindModel.getUserGroupById(groupId);
            const school = await userBindModel.getSchoolGroupById(userGroup?.parentSchoolId);
            this.response.template = 'user_group_detail.html';
            this.response.body = { 
                userGroup,
                school,
                error: error.message,
                studentsData: this.request.body.studentsData
            };
        }
    }
}

// 创建用户组界面
class UserGroupCreateHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { schools } = await userBindModel.getSchoolGroups(1, 1000); // 获取所有学校
        this.response.template = 'user_group_create.html';
        this.response.body = { schools };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { name, parentSchoolId, studentsData, groupType } = this.request.body;
        
        if (!name || !parentSchoolId) {
            const { schools } = await userBindModel.getSchoolGroups(1, 1000);
            this.response.template = 'user_group_create.html';
            this.response.body = { 
                error: '请输入用户组名称并选择学校', 
                name, 
                parentSchoolId, 
                studentsData,
                groupType,
                schools 
            };
            return;
        }

        // 解析学生数据
        const students: Array<{studentId: string, realName: string}> = [];
        if (studentsData) {
            const lines = studentsData.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const studentId = parts[0];
                    const realName = parts.slice(1).join(' ');
                    students.push({ studentId, realName });
                }
            }
        }

        try {
            // 解析用户组种类,默认为0(普通用户组)
            const parsedGroupType = parseInt(groupType) || 0;
            const { userGroupId, autoBindStats } = await userBindModel.createUserGroup(name, parentSchoolId, this.user._id, students, parsedGroupType);
            const bindToken = await userBindModel.createUserGroupBindToken(userGroupId, this.user._id);
            
            this.response.template = 'user_group_created.html';
            this.response.body = {
                userGroup: { _id: userGroupId, name },
                bindToken,
                bindUrl: `/bind/${bindToken}`,
                studentsCount: students.length,
                autoBindStats  // 添加自动绑定统计信息
            };
        } catch (error: any) {
            const { schools } = await userBindModel.getSchoolGroups(1, 1000);
            this.response.template = 'user_group_create.html';
            this.response.body = { 
                error: error.message, 
                name, 
                parentSchoolId, 
                studentsData,
                groupType,
                schools 
            };
        }
    }
}

// 昵称修改界面
class NicknameHandler extends Handler {
    async get() {
        if (!this.user._id) {
            this.response.redirect = `/login?redirect=${encodeURIComponent(this.request.path)}`;
            return;
        }

        // 获取当前用户信息
        const userColl = db.collection('user');
        const currentUser = await userColl.findOne({ _id: this.user._id });
        
        this.response.template = 'nickname_edit.html';
        this.response.body = {
            currentNickname: currentUser?.uname || '',
            currentUser: currentUser
        };
    }

    async post() {
        if (!this.user._id) {
            throw new ForbiddenError('请先登录');
        }

        const { nickname } = this.request.body;
        
        if (!nickname || !nickname.trim()) {
            const userColl = db.collection('user');
            const currentUser = await userColl.findOne({ _id: this.user._id });
            
            this.response.template = 'nickname_edit.html';
            this.response.body = {
                error: '请输入昵称',
                currentNickname: currentUser?.uname || '',
                currentUser: currentUser,
                nickname: nickname
            };
            return;
        }

        try {
            const userColl = db.collection('user');
            const trimmedNickname = nickname.trim();
            
            // 检查昵称是否已被其他用户使用
            const existingUser = await userColl.findOne({ 
                uname: trimmedNickname, 
                _id: { $ne: this.user._id } 
            });
            
            if (existingUser) {
                const currentUser = await userColl.findOne({ _id: this.user._id });
                
                this.response.template = 'nickname_edit.html';
                this.response.body = {
                    error: '该昵称已被其他用户使用，请选择其他昵称',
                    currentNickname: currentUser?.uname || '',
                    currentUser: currentUser,
                    nickname: trimmedNickname
                };
                return;
            }
            
            // 更新用户昵称
            const updateResult = await userColl.updateOne(
                { _id: this.user._id },
                { 
                    $set: { 
                        uname: trimmedNickname,
                        unameLower: trimmedNickname.toLowerCase()
                    }
                }
            );
            
            // 获取更新后的用户信息
            const updatedUser = await userColl.findOne({ _id: this.user._id });
            
            // 格式化时间
            const now = new Date();
            const modifyTime = now.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            const lastLoginTime = updatedUser?.loginat 
                ? new Date(updatedUser.loginat).toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                }) 
                : null;
            
            // 跳转到成功页面
            this.response.template = 'nickname_success.html';
            this.response.body = {
                oldNickname: this.user.uname || '未设置',
                newNickname: updatedUser?.uname || '',
                currentUser: updatedUser,
                modifyTime: modifyTime,
                lastLoginTime: lastLoginTime
            };
            
        } catch (error: any) {
            const userColl = db.collection('user');
            const currentUser = await userColl.findOne({ _id: this.user._id });
            
            this.response.template = 'nickname_edit.html';
            this.response.body = {
                error: '昵称修改失败: ' + error.message,
                currentNickname: currentUser?.uname || '',
                currentUser: currentUser,
                nickname: nickname
            };
        }
    }
}

// 管理主页界面
class ManagementDashboardHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        // 获取统计信息
        const userColl = db.collection('user');
        
        // 学校组数量
        const schoolCount = await schoolGroupsColl.countDocuments();
        
        // 用户组数量
        const userGroupCount = await userGroupsColl.countDocuments();
        
        // 已绑定用户数量（有学号和姓名的用户）
        const boundUserCount = await userColl.countDocuments({
            studentId: { $exists: true, $nin: [null, ''] },
            realName: { $exists: true, $nin: [null, ''] }
        });
        
        // 拥有绕过权限的用户数量
        const bypassUserCount = await userColl.countDocuments({
            schoolGroupBypass: true
        });
        
        // 待审核绑定申请数量
        const pendingRequestCount = await bindingRequestsColl.countDocuments({
            status: 'pending'
        });
        
        this.response.template = 'management_dashboard.html';
        this.response.body = {
            schoolCount,
            userGroupCount,
            boundUserCount,
            bypassUserCount,
            pendingRequestCount
        };
    }
}

// 学校组绕过权限管理界面
class SchoolGroupBypassManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        const page = +(this.request.query.page || '1');
        const search = this.request.query.search as string;
        const status = this.request.query.status as string;
        
        const { users, total, pageCount } = await userBindModel.getBypassUsers(page, 20, search, status);
        
        // 检查是否有成功消息
        const { success, message } = this.request.query;
        
        this.response.template = 'school_group_bypass_manage.html';
        this.response.body = { 
            users, 
            total, 
            pageCount, 
            page,
            search,
            status,
            success: success === '1',
            message: message ? decodeURIComponent(message as string) : null
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { action } = this.request.body;
        
        try {
            if (action === 'add_bypass') {
                const { addMethod, username, usernames, uids } = this.request.body;
                
                if (addMethod === 'single') {
                    if (!username) {
                        throw new Error('请输入用户名');
                    }
                    
                    const userColl = db.collection('user');
                    const user = await userColl.findOne({ uname: username });
                    if (!user) {
                        throw new Error(`用户「${username}」不存在`);
                    }
                    
                    await userBindModel.addBypassPermission(user._id);
                    this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(`成功为用户「${username}」添加绕过权限`)}`;
                    
                } else if (addMethod === 'batch_username') {
                    if (!usernames) {
                        throw new Error('请输入用户名列表');
                    }
                    
                    const usernameList = usernames.trim().split('\n').map((u: string) => u.trim()).filter((u: string) => u);
                    if (usernameList.length === 0) {
                        throw new Error('请输入有效的用户名列表');
                    }
                    
                    const result = await userBindModel.addBypassPermissionByUsernames(usernameList);
                    let message = `批量添加完成：成功 ${result.success} 个`;
                    if (result.failed.length > 0) {
                        message += `，失败 ${result.failed.length} 个（${result.failed.join(', ')}）`;
                    }
                    
                    this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(message)}`;
                    
                } else if (addMethod === 'batch_uid') {
                    if (!uids) {
                        throw new Error('请输入UID列表');
                    }
                    
                    const uidList = uids.trim().split('\n').map((u: string) => {
                        const uid = parseInt(u.trim());
                        return isNaN(uid) ? null : uid;
                    }).filter((u: number | null) => u !== null) as number[];
                    
                    if (uidList.length === 0) {
                        throw new Error('请输入有效的UID列表');
                    }
                    
                    const result = await userBindModel.addBypassPermissionByUids(uidList);
                    let message = `批量添加完成：成功 ${result.success} 个`;
                    if (result.failed.length > 0) {
                        message += `，失败 ${result.failed.length} 个（${result.failed.join(', ')}）`;
                    }
                    
                    this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(message)}`;
                } else {
                    throw new Error('请选择添加方式');
                }
                
            } else if (action === 'enable_bypass') {
                const { userId } = this.request.body;
                if (!userId) {
                    throw new Error('用户ID无效');
                }
                
                await userBindModel.enableBypassPermission(parseInt(userId));
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent('权限启用成功')}`;
                
            } else if (action === 'disable_bypass') {
                const { userId } = this.request.body;
                if (!userId) {
                    throw new Error('用户ID无效');
                }
                
                await userBindModel.disableBypassPermission(parseInt(userId));
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent('权限禁用成功')}`;
                
            } else if (action === 'remove_bypass') {
                const { userId } = this.request.body;
                if (!userId) {
                    throw new Error('用户ID无效');
                }
                
                await userBindModel.removeBypassPermission(parseInt(userId));
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent('权限记录移除成功')}`;
                
            } else if (action === 'batch_enable') {
                const { userIds } = this.request.body;
                if (!userIds) {
                    throw new Error('请选择要操作的用户');
                }
                
                const userIdList = userIds.split(',').map((id: string) => parseInt(id.trim()));
                const result = await userBindModel.batchEnableBypassPermission(userIdList);
                
                let message = `批量启用完成：成功 ${result.success} 个`;
                if (result.failed.length > 0) {
                    message += `，失败 ${result.failed.length} 个`;
                }
                
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(message)}`;
                
            } else if (action === 'batch_disable') {
                const { userIds } = this.request.body;
                if (!userIds) {
                    throw new Error('请选择要操作的用户');
                }
                
                const userIdList = userIds.split(',').map((id: string) => parseInt(id.trim()));
                const result = await userBindModel.batchDisableBypassPermission(userIdList);
                
                let message = `批量禁用完成：成功 ${result.success} 个`;
                if (result.failed.length > 0) {
                    message += `，失败 ${result.failed.length} 个`;
                }
                
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(message)}`;
                
            } else if (action === 'batch_remove') {
                const { userIds } = this.request.body;
                if (!userIds) {
                    throw new Error('请选择要操作的用户');
                }
                
                const userIdList = userIds.split(',').map((id: string) => parseInt(id.trim()));
                const result = await userBindModel.batchRemoveBypassPermission(userIdList);
                
                let message = `批量移除完成：成功 ${result.success} 个`;
                if (result.failed.length > 0) {
                    message += `，失败 ${result.failed.length} 个`;
                }
                
                this.response.redirect = `/school-group-bypass/manage?success=1&message=${encodeURIComponent(message)}`;
            } else {
                throw new Error('未知操作');
            }
        } catch (error: any) {
            const page = +(this.request.query.page || '1');
            const search = this.request.query.search as string;
            const status = this.request.query.status as string;
            
            const { users, total, pageCount } = await userBindModel.getBypassUsers(page, 20, search, status);
            
            this.response.template = 'school_group_bypass_manage.html';
            this.response.body = { 
                users, 
                total, 
                pageCount, 
                page,
                search,
                status,
                error: error.message 
            };
        }
    }
}

// 绑定界面 - 处理令牌绑定
class BindHandler extends Handler {
    async get() {
        const { token } = this.request.params;
        
        if (!token) {
            throw new NotFoundError('绑定链接格式错误');
        }
        
        if (!this.user._id) {
            this.response.redirect = `/login?redirect=${encodeURIComponent(this.request.path)}`;
            return;
        }

        const bindInfo = await userBindModel.getBindInfo(token);
        
        if (!bindInfo) {
            // 使用专门的绑定失败页面
            this.response.template = 'bind_failure.html';
            this.response.body = { 
                error: '绑定链接无效或已过期',
                errorType: 'invalid_token',
                token: token,
                studentId: null,
                realName: null,
                groupName: null
            };
            return;
        }

        // 检查用户是否已经绑定
        if (await userBindModel.isUserBound(this.user._id) && bindInfo.type === 'user_group') {
            // 用户已绑定，检查学校组是否一致
            const userSchools = await userBindModel.getUserSchoolGroups(this.user._id);
            const targetGroup = bindInfo.target as UserGroup;
            
            const hasMatchingSchool = userSchools.some(school => {
                // 使用灵活的ID比较方式
                try {
                    // 尝试ObjectId比较
                    return school._id.equals && school._id.equals(targetGroup.parentSchoolId);
                } catch (error) {
                    // 如果ObjectId比较失败，使用字符串比较
                    return school._id.toString() === targetGroup.parentSchoolId.toString();
                }
            });

            if (hasMatchingSchool) {
                // 学校组一致，直接加入用户组
                const userColl = db.collection('user');
                await userColl.updateOne(
                    { _id: this.user._id },
                    { $addToSet: { parentUserGroupId: targetGroup._id } }
                );
                
                this.response.template = 'bind_success.html';
                this.response.body = { 
                    message: '成功加入用户组',
                    groupName: targetGroup.name
                };
                return;
            } else {
                // 学校组不一致，需要重新绑定学校
                // 获取目标用户组所属的学校信息
                const targetSchool = await userBindModel.getSchoolGroupById(targetGroup.parentSchoolId);
                
                this.response.template = 'bind_conflict.html';
                this.response.body = {
                    message: '您当前所属的学校组与目标用户组不匹配',
                    currentSchools: userSchools,
                    targetGroup: {
                        ...targetGroup,
                        schoolName: targetSchool ? targetSchool.name : '未知学校'
                    }
                };
                return;
            }
        }

        this.response.template = 'bind_form.html';
        this.response.body = { 
            bindInfo,
            token
        };
    }

    async post() {
        const { token } = this.request.params;
        
        if (!this.user._id) {
            throw new ForbiddenError('请先登录');
        }

        if (!token) {
            throw new NotFoundError('绑定链接格式错误');
        }

        const { studentId, realName } = this.request.body;
        if (!studentId || !realName) {
            const bindInfo = await userBindModel.getBindInfo(token);
            this.response.template = 'bind_form.html';
            this.response.body = { 
                error: '请填写学号和姓名',
                bindInfo,
                token,
                studentId,
                realName
            };
            return;
        }

        try {
            const bindInfo = await userBindModel.getBindInfo(token);
            if (!bindInfo) {
                throw new Error('绑定链接无效或已过期');
            }
            
            if (bindInfo.type === 'user_group') {
                await userBindModel.bindUserToGroup(this.user._id, token, studentId, realName);
            } else {
                await userBindModel.bindUserToSchoolGroup(this.user._id, token, studentId, realName);
            }

            this.response.template = 'bind_success.html';
            this.response.body = { 
                studentId,
                realName,
                groupName: bindInfo.target.name
            };
        } catch (error: any) {
            // 根据错误类型确定错误分类
            let errorType = 'general';
            if (error.message.includes('学号或姓名不匹配') || error.message.includes('不匹配')) {
                errorType = 'mismatch';
            } else if (error.message.includes('已被绑定') || error.message.includes('已绑定')) {
                errorType = 'already_bound';
            } else if (error.message.includes('无效') || error.message.includes('过期')) {
                errorType = 'invalid_token';
            }
            
            const bindInfo = await userBindModel.getBindInfo(token);
            
            // 使用专门的绑定失败页面
            this.response.template = 'bind_failure.html';
            this.response.body = { 
                error: error.message,
                errorType: errorType,
                token: token,
                studentId: studentId,
                realName: realName,
                groupName: bindInfo ? bindInfo.target.name : null
            };
        }
    }
}

// 用户绑定主页
class UserBindHomeHandler extends Handler {
    async get(domainId: string) {
        // 获取用户的绑定状态
        const { isSchoolStudent = false, studentId = '', realName = '', nickname = '' } = this.user;
        
        // 检查是否是管理员
        const isAdmin = this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        this.response.template = 'user_bind_home.html';
        this.response.body = {
            isSchoolStudent,
            studentId,
            realName,
            nickname,
            isAdmin
        };
    }
}

// 绑定说明界面
class BindingNoticeHandler extends Handler {
    async get(domainId: string) {
        if (!this.user._id) {
            this.response.redirect = `/login?redirect=${encodeURIComponent(this.request.path)}`;
            return;
        }

        this.response.template = 'binding_notice.html';
        this.response.body = {};
    }
}

// 绑定申请界面
class BindingRequestHandler extends Handler {
    async get(domainId: string) {
        if (!this.user._id) {
            this.response.redirect = `/login?redirect=${encodeURIComponent(this.request.path)}`;
            return;
        }

        // 检查用户是否已绑定
        if (await userBindModel.isUserBound(this.user._id)) {
            this.response.redirect = '/user-bind';
            return;
        }

        // 检查是否已有待审核申请
        const existingRequest = await userBindModel.getUserBindingRequest(this.user._id);
        if (existingRequest) {
            this.response.template = 'binding_request_pending.html';
            this.response.body = {
                request: existingRequest
            };
            return;
        }

        // 获取所有可申请的学校组
        const schools = await userBindModel.getAvailableSchoolGroups();
        
        this.response.template = 'binding_request_form.html';
        this.response.body = {
            schools
        };
    }

    async post(domainId: string) {
        if (!this.user._id) {
            throw new ForbiddenError('请先登录');
        }

        const { schoolGroupId, studentId, realName } = this.request.body;

        if (!schoolGroupId || !studentId || !realName) {
            const schools = await userBindModel.getAvailableSchoolGroups();
            this.response.template = 'binding_request_form.html';
            this.response.body = {
                schools,
                error: '请填写完整信息',
                schoolGroupId,
                studentId,
                realName
            };
            return;
        }

        try {
            const result = await userBindModel.createBindingRequest(this.user._id, schoolGroupId, studentId.trim(), realName.trim());
            
            if (result.type === 'direct_bind') {
                // 直接绑定成功
                this.response.template = 'binding_request_success.html';
                this.response.body = {
                    studentId: studentId.trim(),
                    realName: realName.trim(),
                    directBind: true,
                    message: '绑定成功！您的学号姓名已在学校组中找到，已直接完成绑定。'
                };
            } else if (result.type === 'request') {
                // 提交申请成功
                this.response.template = 'binding_request_success.html';
                this.response.body = {
                    studentId: studentId.trim(),
                    realName: realName.trim(),
                    directBind: false,
                    message: '申请已提交！请等待管理员审核您的绑定申请。'
                };
            }
        } catch (error: any) {
            const schools = await userBindModel.getAvailableSchoolGroups();
            this.response.template = 'binding_request_form.html';
            this.response.body = {
                schools,
                error: error.message,
                schoolGroupId,
                studentId,
                realName
            };
        }
    }
}

// 管理员审核绑定申请界面
class BindingRequestManageHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        const page = +(this.request.query.page || '1');
        const status = this.request.query.status as string;
        
        const { requests, total, pageCount } = await userBindModel.getBindingRequests(page, 20, status);
        
        // 检查是否有成功消息
        const { success, message } = this.request.query;
        
        this.response.template = 'binding_request_manage.html';
        this.response.body = {
            requests,
            total,
            pageCount,
            page,
            status,
            success: success === '1',
            message: message ? decodeURIComponent(message as string) : null
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const { action, requestId, reviewComment } = this.request.body;

        if (!requestId || !['approve', 'reject'].includes(action)) {
            throw new Error('无效的操作参数');
        }

        try {
            await userBindModel.reviewBindingRequest(requestId, action, this.user._id, reviewComment);
            
            const actionText = action === 'approve' ? '同意' : '拒绝';
            this.response.redirect = `/binding-request/manage?success=1&message=${encodeURIComponent(`申请${actionText}成功`)}`;
        } catch (error: any) {
            const page = +(this.request.query.page || '1');
            const status = this.request.query.status as string;
            
            const { requests, total, pageCount } = await userBindModel.getBindingRequests(page, 20, status);
            
            this.response.template = 'binding_request_manage.html';
            this.response.body = {
                requests,
                total,
                pageCount,
                page,
                status,
                error: error.message
            };
        }
    }
}

// ========== 用户管理 API Handler ==========

// API 1: 添加用户到用户组
class UserGroupAddUserHandler extends Handler {
    async post(domainId: string) {
        // API认证检查 - 支持header和body两种方式
        const apiKey = this.request.headers['x-api-key'] || this.request.body.auth_key;
        if (apiKey !== 'motricseven') {
            this.response.body = { 
                success: false, 
                message: '无效的API密钥' 
            };
            this.response.type = 'application/json';
            this.response.status = 401;
            return;
        }
        
        // 从路径参数获取用户组ID
        const { groupId } = this.request.params;
        const { userId, studentId, realName } = this.request.body;
        
        if (!userId) {
            this.response.body = { 
                success: false, 
                message: '缺少必要参数: userId' 
            };
            this.response.type = 'application/json';
            this.response.status = 400;
            return;
        }

        try {
            const result = await userBindModel.addUserToUserGroup(parseInt(userId), groupId);
            this.response.body = result;
            this.response.type = 'application/json';
        } catch (error: any) {
            this.response.body = { 
                success: false, 
                message: error.message || '添加用户到用户组失败' 
            };
            this.response.type = 'application/json';
            this.response.status = 500;
        }
    }
}

// API 2: 从用户组移除用户
class UserGroupRemoveUserHandler extends Handler {
    async post(domainId: string) {
        // API认证检查 - 支持header和body两种方式
        const apiKey = this.request.headers['x-api-key'] || this.request.body.auth_key;
        if (apiKey !== 'motricseven') {
            this.response.body = { 
                success: false, 
                message: '无效的API密钥' 
            };
            this.response.type = 'application/json';
            this.response.status = 401;
            return;
        }
        
        // 从路径参数获取用户组ID
        const { groupId } = this.request.params;
        const { userId } = this.request.body;
        
        if (!userId) {
            this.response.body = { 
                success: false, 
                message: '缺少必要参数: userId' 
            };
            this.response.type = 'application/json';
            this.response.status = 400;
            return;
        }

        try {
            const result = await userBindModel.removeUserFromUserGroup(parseInt(userId), groupId);
            this.response.body = result;
            this.response.type = 'application/json';
        } catch (error: any) {
            this.response.body = { 
                success: false, 
                message: error.message || '从用户组移除用户失败' 
            };
            this.response.type = 'application/json';
            this.response.status = 500;
        }
    }
}

// API 3: 添加用户到学校组
class SchoolGroupAddUserHandler extends Handler {
    async post(domainId: string) {
        // API认证检查 - 支持header和body两种方式
        const apiKey = this.request.headers['x-api-key'] || this.request.body.auth_key;
        if (apiKey !== 'motricseven') {
            this.response.body = { 
                success: false, 
                message: '无效的API密钥' 
            };
            this.response.type = 'application/json';
            this.response.status = 401;
            return;
        }
        
        // 从路径参数获取学校组ID
        const { schoolId } = this.request.params;
        const { userId, studentId, realName } = this.request.body;
        
        if (!userId) {
            this.response.body = { 
                success: false, 
                message: '缺少必要参数: userId' 
            };
            this.response.type = 'application/json';
            this.response.status = 400;
            return;
        }

        try {
            const result = await userBindModel.addUserToSchoolGroup(parseInt(userId), schoolId);
            this.response.body = result;
            this.response.type = 'application/json';
        } catch (error: any) {
            this.response.body = { 
                success: false, 
                message: error.message || '添加用户到学校组失败' 
            };
            this.response.type = 'application/json';
            this.response.status = 500;
        }
    }
}

// API 4: 从学校组移除用户
class SchoolGroupRemoveUserHandler extends Handler {
    async post(domainId: string) {
        // API认证检查 - 支持header和body两种方式
        const apiKey = this.request.headers['x-api-key'] || this.request.body.auth_key;
        if (apiKey !== 'motricseven') {
            this.response.body = { 
                success: false, 
                message: '无效的API密钥' 
            };
            this.response.type = 'application/json';
            this.response.status = 401;
            return;
        }
        
        // 从路径参数获取学校组ID
        const { schoolId } = this.request.params;
        const { userId } = this.request.body;
        
        if (!userId) {
            this.response.body = { 
                success: false, 
                message: '缺少必要参数: userId' 
            };
            this.response.type = 'application/json';
            this.response.status = 400;
            return;
        }

        try {
            const result = await userBindModel.removeUserFromSchoolGroup(parseInt(userId), schoolId);
            this.response.body = result;
            this.response.type = 'application/json';
        } catch (error: any) {
            this.response.body = { 
                success: false, 
                message: error.message || '从学校组移除用户失败' 
            };
            this.response.type = 'application/json';
            this.response.status = 500;
        }
    }
}

// API 5: 标记比赛用户组中的用户结束比赛
class ContestUserGroupMarkFinishedHandler extends Handler {
    async post(domainId: string) {
        // API认证检查 - 支持header和body两种方式
        const apiKey = this.request.headers['x-api-key'] || this.request.body.auth_key;
        if (apiKey !== 'motricseven') {
            this.response.body = { 
                success: false, 
                message: '无效的API密钥' 
            };
            this.response.type = 'application/json';
            this.response.status = 401;
            return;
        }
        
        // 从路径参数获取比赛用户组ID
        const { groupId } = this.request.params;
        const { userId } = this.request.body;
        
        if (!userId) {
            this.response.body = { 
                success: false, 
                message: '缺少必要参数: userId' 
            };
            this.response.type = 'application/json';
            this.response.status = 400;
            return;
        }

        try {
            const result = await userBindModel.markUserContestFinished(parseInt(userId), groupId);
            this.response.body = result;
            this.response.type = 'application/json';
        } catch (error: any) {
            this.response.body = { 
                success: false, 
                message: error.message || '标记用户比赛结束失败' 
            };
            this.response.type = 'application/json';
            this.response.status = 500;
        }
    }
}

// // // 调试接口 - 检查当前用户状态
// class UserBindDebugHandler extends Handler {
//     async get(domainId: string) {
//         this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
//         const userColl = db.collection('user');
//         const users = await userColl.find().limit(10).toArray();
        
//         this.response.body = {
//             currentUser: {
//                 _id: this.user._id,
//                 hasPriv: this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
//             },
//             sampleUsers: users.map(u => ({
//                 _id: u._id,
//                 uname: u.uname,
//                 isSchoolStudent: u.isSchoolStudent,
//                 studentId: u.studentId,
//                 studentName: u.studentName
//             }))
//         };
//         this.response.type = 'application/json';
//     }
// }

// 插件配置和路由
export async function apply(ctx: Context) {
    
    // 注册路由
    ctx.Route('school_group_manage', '/school-group/manage', SchoolGroupManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('school_group_detail', '/school-group/detail/:schoolId', SchoolGroupDetailHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('school_group_create', '/school-group/create', SchoolGroupCreateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_manage', '/user-group/manage', UserGroupManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_detail', '/user-group/detail/:groupId', UserGroupDetailHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_create', '/user-group/create', UserGroupCreateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('contest_permission', '/contest/:contestId/permission', ContestPermissionHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('bind', '/bind/:token', BindHandler);
    ctx.Route('user_bind', '/user-bind', UserBindHomeHandler); // 用户绑定主页
    ctx.Route('nickname', '/nickname', NicknameHandler); // 昵称修改页面
    ctx.Route('school_group_bypass_manage', '/school-group-bypass/manage', SchoolGroupBypassManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('management_dashboard', '/management', ManagementDashboardHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('binding_request', '/binding-request', BindingRequestHandler); // 绑定申请页面
    ctx.Route('binding_notice', '/binding-notice', BindingNoticeHandler); // 绑定说明页面
    ctx.Route('binding_request_manage', '/binding-request/manage', BindingRequestManageHandler, PRIV.PRIV_EDIT_SYSTEM); // 管理员审核页面
    
    // 用户管理API路由 - RESTful风格，支持认证密钥访问
    ctx.Route('api_user_group_add_user', '/api/user-groups/:groupId/add-user', UserGroupAddUserHandler); // API: 添加用户到用户组
    ctx.Route('api_user_group_remove_user', '/api/user-groups/:groupId/remove-user', UserGroupRemoveUserHandler); // API: 从用户组移除用户
    ctx.Route('api_school_group_add_user', '/api/school-groups/:schoolId/add-user', SchoolGroupAddUserHandler); // API: 添加用户到学校组
    ctx.Route('api_school_group_remove_user', '/api/school-groups/:schoolId/remove-user', SchoolGroupRemoveUserHandler); // API: 从学校组移除用户
    ctx.Route('api_contest_user_group_mark_finished', '/api/contest-user-groups/:groupId/mark-finished', ContestUserGroupMarkFinishedHandler); // API: 标记比赛用户组中的用户结束比赛
    // 使用 hook 在所有路由处理前检查用户绑定状态和访问权限
    ctx.on('handler/before-prepare', async (h) => {
        // 确保用户已登录且有用户信息
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            const currentPath = h.request.path;
            
            // 超级管理员 root（uid=2）可以访问所有页面，无需检查
            if (h.user._id === 2) {
                console.log(`[Admin Notification - Before-Prepare] Root user (${h.user._id}) detected on path: ${currentPath}`);
                return;
            }
            
            // 检查用户是否拥有学校组绕过权限
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: h.user._id });
            if (dbUser && dbUser.schoolGroupBypass === true) {
                return;
            }
            
            // 定义需要学校组权限的路径
            const schoolGroupRequiredPaths = [
                '/training',
                '/homework',
                '/contest'
            ];
            
            // 需要排除的路径（不进行任何检查）
            const excludePaths = [
                '/bind',
                '/binding-request', // 添加绑定申请路径
                '/binding-notice', // 添加绑定说明页面路径
                '/school-group',
                '/user-group',
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
                '.ttf',
                '.chunk.js',
                '.chunk.css'
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
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.user._id);
            const isBound = await userBindModel.isUserBound(h.user._id);
            
            // 学校组成员未绑定时，强制重定向到绑定说明页面（无论访问什么页面）
            if (isInSchool && !isBound) {
                h.response.redirect = '/binding-notice';
                return;
            }
            
            // 检查是否访问需要学校组权限的路径
            const isSchoolGroupRequiredPath = schoolGroupRequiredPaths.some(path => 
                currentPath === path || currentPath.startsWith(path + '/')
            );
            
            // 非学校组成员访问需要学校组权限的路径时，也重定向到绑定说明页面
            if (isSchoolGroupRequiredPath && !isInSchool) {
                h.response.redirect = '/binding-notice';
                return;
            }
        } catch (error) {
            // 如果是权限错误，直接抛出
            if (error instanceof ForbiddenError) {
                throw error;
            }
            // 如果获取用户信息失败，不执行重定向
        }
    });

    // 添加根用户通知的函数
    async function addRootNotification(handler: any): Promise<any> {
        try {
            console.log('[addRootNotification] 开始执行');
            
            if (!handler.user || handler.user._id !== 2) {
                console.log('[addRootNotification] 不是root用户，返回null');
                return null;
            }

            console.log('[addRootNotification] 正在查询未处理的绑定申请...');
            const pendingCount = await bindingRequestsColl.countDocuments({ 
                $or: [
                    { status: 'pending' },
                    { status: { $exists: false } }
                ]
            });
            console.log(`[addRootNotification] 查询结果: ${pendingCount} 个未处理申请`);

            if (pendingCount > 0) {
                const rootNotification = {
                    showNotification: true,
                    pendingCount: pendingCount,
                    message: `您有 ${pendingCount} 个待处理的用户绑定申请`
                };
                console.log('[addRootNotification] 返回通知对象:', rootNotification);
                return rootNotification;
            }
            
            console.log('[addRootNotification] 没有未处理申请，返回null');
            return null;
        } catch (error) {
            console.error('[addRootNotification] 执行出错:', error);
            return null;
        }
    }

    // 为 root 用户添加 rootNotification
    ctx.on('handler/after', async (h) => {
        // 为所有页面的root用户添加通知
        if (h.request.method === 'get' && h.user?._id === 2) {
            const currentPath = h.request.path;
            
            // 需要排除的路径（不进行通知处理）
            const excludePaths = [
                '/api/', 
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
                '.ttf',
                '.chunk.js',
                '.chunk.css',
                '.ico'
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
            
            console.log(`=== Root用户检测到，路径: ${currentPath} ===`);
            
            const rootNotification = await addRootNotification(h);
            if (rootNotification) {
                console.log('[RootNotification] 添加 rootNotification 到 response.body');
                h.response.body = h.response.body || {};
                h.response.body.rootNotification = rootNotification;
                console.log('[RootNotification] response.body.rootNotification:', h.response.body.rootNotification);
            }
        }
    });

    // 在用户登录成功后检查绑定状态
    ctx.on('handler/after/UserLogin#post', async (h) => {
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            // 超级管理员 root（uid=2）的处理已在 before-prepare 中完成
            if (h.user._id === 2) {
                return;
            }
            
            // 检查用户是否拥有学校组绕过权限
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: h.user._id });
            if (dbUser && dbUser.schoolGroupBypass === true) {
                return;
            }
            
            const user = await UserModel.getById('system', h.user._id);
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.user._id);
            // 学校组成员必须完成绑定，强制重定向到绑定说明页面
            if (isInSchool && !await userBindModel.isUserBound(h.user._id)) {
                h.response.redirect = '/binding-notice';
                return;
            }
        } catch (error) {
            // 处理错误但不记录日志
        }
    });

    // 在用户详情页面添加绑定信息显示
    ctx.on('handler/after/UserDetail#get', async (h) => {
        if (h.response.body.udoc) {
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.response.body.udoc._id);
            
            if (isInSchool) {
                // 从数据库重新获取用户信息，确保数据完整
                const userColl = db.collection('user');
                const dbUser = await userColl.findOne({ _id: h.response.body.udoc._id });
                
                h.response.body.showBindInfo = true;
                h.response.body.bindInfo = {
                    studentId: (dbUser?.studentId || h.response.body.udoc.studentId) || '未绑定',
                    realName: (dbUser?.realName || h.response.body.udoc.realName) || '未绑定',
                    isBound: !!((dbUser?.studentId || h.response.body.udoc.studentId) && (dbUser?.realName || h.response.body.udoc.realName))
                };
                
                // 获取用户所属的学校组和用户组信息
                const userSchools = await userBindModel.getUserSchoolGroups(h.response.body.udoc._id);
                const userGroups = await userBindModel.getUserGroups(h.response.body.udoc._id);
                
                h.response.body.bindInfo.schools = userSchools;
                h.response.body.bindInfo.userGroups = userGroups;
            }
        }
    });

    // 在比赛排行榜中显示真实姓名（管理员查看时）
    ctx.on('handler/after/ContestScoreboard#get', async (h) => {
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const rows = h.response.body.rows || [];
            const userColl = db.collection('user');
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (i === 0) {
                    // 处理表头，在用户名列后添加学号姓名列
                    for (let j = 0; j < row.length; j++) {
                        const col = row[j];
                        if (col && col.type === 'user') {
                            // 在用户名列后插入学号姓名列
                            row.splice(j + 1, 0, {
                                type: 'student_info',
                                value: '学号姓名'
                            });
                            break;
                        }
                    }
                } else {
                    // 处理数据行，在用户名列后添加学号姓名数据
                    for (let j = 0; j < row.length; j++) {
                        const col = row[j];
                        if (col && col.type === 'user') {
                            const userId = col.raw;
                            let studentInfo = '';
                            
                            if (userId) {
                                // 检查用户是否有绑定信息
                                const dbUser = await userColl.findOne({ _id: userId });
                                const isInSchool = await userBindModel.isUserInSchool(userId);
                                
                                if (isInSchool && dbUser?.realName && dbUser?.studentId) {
                                    studentInfo = `${dbUser.studentId} ${dbUser.realName}`;
                                }
                            }
                            
                            // 在用户名列后插入学号姓名列
                            row.splice(j + 1, 0, {
                                type: 'student_info',
                                value: studentInfo,
                                raw: userId
                            });
                            break;
                        }
                    }
                }
            }
        }
    });

    // 比赛参赛权限检查
    ctx.on('handler/before/ContestDetail#get', async (h) => {
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            const contestId = h.request.params.tid || h.request.params.contestId;
            
            if (!contestId) {
                return;
            }

            // 超级管理员跳过权限检查
            if (h.user._id === 2 || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
                return;
            }

            // 检查用户是否拥有学校组绕过权限
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: h.user._id });
            if (dbUser && dbUser.schoolGroupBypass === true) {
                return;
            }

            const permissionCheck = await userBindModel.checkContestPermission(h.user._id, contestId);
            
            if (!permissionCheck.allowed) {
                throw new ForbiddenError(permissionCheck.reason || '您无权访问此比赛');
            }
        } catch (error) {
            if (error instanceof ForbiddenError) {
                throw error;
            }
        }
    });

    // 比赛报名权限检查
    ctx.on('handler/before/ContestDetail#post', async (h) => {
        if (!h.user || !h.user._id) {
            return;
        }

        try {
            const contestId = h.request.params.tid || h.request.params.contestId;
            
            if (!contestId) {
                return;
            }

            // 超级管理员跳过权限检查
            if (h.user._id === 2 || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
                return;
            }

            // 检查用户是否拥有学校组绕过权限
            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: h.user._id });
            if (dbUser && dbUser.schoolGroupBypass === true) {
                return;
            }

            const action = h.request.body.operation || h.request.body.action;
            
            // 只对报名操作进行权限检查
            if (action === 'attend' || action === 'register') {
                const permissionCheck = await userBindModel.checkContestPermission(h.user._id, contestId);
                
                if (!permissionCheck.allowed) {
                    throw new ForbiddenError(permissionCheck.reason || '您无权参加此比赛');
                }
            }
        } catch (error) {
            if (error instanceof ForbiddenError) {
                throw error;
            }
        }
    });

    // 为排名页面添加处理，所有人都能看到真实姓名
    ctx.on('handler/after/DomainRank#get', async (h) => {
        const udocs = h.response.body.udocs || [];
        const userColl = db.collection('user');
        
        // 处理当前用户的学号姓名信息
        if (h.user && h.user._id) {
            const isCurrentUserInSchool = await userBindModel.isUserInSchool(h.user._id);
            
            if (isCurrentUserInSchool) {
                const currentDbUser = await userColl.findOne({ _id: h.user._id });
                
                if (currentDbUser?.realName && currentDbUser?.studentId) {
                    h.user.studentInfo = `${currentDbUser.studentId} ${currentDbUser.realName}`;
                }
            }
        }
        
        // 处理排名列表中的用户 - 所有人都能看到学号姓名
        for (const udoc of udocs) {
            if (udoc._id) {
                const isInSchool = await userBindModel.isUserInSchool(udoc._id);
                
                if (isInSchool) {
                    const dbUser = await userColl.findOne({ _id: udoc._id });
                    
                    if (dbUser?.realName && dbUser?.studentId) {
                        // 添加学号姓名信息，而不是修改用户名
                        udoc.studentInfo = `${dbUser.studentId} ${dbUser.realName}`;
                    }
                }
            }
        }
    });

}
