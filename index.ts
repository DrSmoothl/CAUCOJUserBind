import {
    db, Context, UserModel, Handler, NotFoundError, ForbiddenError, 
    PRIV, Types, SettingModel, moment, PERM
} from 'hydrooj';
import * as crypto from 'crypto';

// 集合定义
const userGroupsColl = db.collection('user_groups');
const schoolGroupsColl = db.collection('school_groups');
const bindTokensColl = db.collection('bind_tokens');

// 接口定义
interface UserGroup {
    _id?: any;
    name: string;
    createdAt: Date;
    createdBy: number;
    parentSchoolId: any;
    students: Array<{
        studentId: string;
        realName: string;
        bound: boolean;
        boundBy?: number;
        boundAt?: Date;
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

declare module 'hydrooj' {
    interface Model {
        userBind: typeof userBindModel;
    }
    interface Collections {
        user_groups: UserGroup;
        school_groups: SchoolGroup;
        bind_tokens: BindToken;
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
    async createUserGroup(name: string, parentSchoolId: any, createdBy: number, students: Array<{studentId: string, realName: string}>): Promise<any> {
        console.log('createUserGroup: 传入的parentSchoolId:', parentSchoolId, '类型:', typeof parentSchoolId);
        
        // 使用灵活的查询方式验证学校组是否存在
        let school: SchoolGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            school = await schoolGroupsColl.findOne({ _id: parentSchoolId });
            console.log('createUserGroup: 直接查询结果:', school ? '找到' : '未找到');
        } catch (error) {
            console.log('createUserGroup: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!school) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                school = allSchools.find(s => s._id.toString() === parentSchoolId.toString()) || null;
                console.log('createUserGroup: 字符串匹配查询结果:', school ? '找到' : '未找到');
            } catch (error) {
                console.log('createUserGroup: 字符串匹配查询失败:', error);
            }
        }
        
        if (!school) {
            console.log('createUserGroup: 学校组不存在，parentSchoolId:', parentSchoolId);
            // 列出所有学校组用于调试
            const allSchools = await schoolGroupsColl.find().limit(5).toArray();
            console.log('createUserGroup: 现有学校组:');
            allSchools.forEach((s, i) => {
                console.log(`  ${i}: _id=${s._id} (${typeof s._id}) name=${s.name}`);
            });
            throw new Error('指定的学校组不存在');
        }

        console.log('createUserGroup: 找到学校组:', school.name);

        const studentsData = students.map(s => ({
            studentId: s.studentId,
            realName: s.realName,
            bound: false
        }));

        const result = await userGroupsColl.insertOne({
            name,
            createdAt: new Date(),
            createdBy,
            parentSchoolId: school._id, // 使用查找到的实际学校ID
            students: studentsData
        });
        
        console.log('createUserGroup: 用户组创建成功，ID:', result.insertedId);
        return result.insertedId;
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
        console.log('createSchoolGroupBindToken: 生成的令牌:', token);
        console.log('createSchoolGroupBindToken: 学校组ID:', schoolGroupId);
        console.log('createSchoolGroupBindToken: 创建者ID:', createdBy);
        
        const insertResult = await bindTokensColl.insertOne({
            _id: token,
            type: 'school_group',
            targetId: schoolGroupId,
            createdAt: new Date(),
            createdBy
        });
        
        console.log('createSchoolGroupBindToken: 插入结果:', insertResult);
        
        // 验证插入是否成功
        const verification = await bindTokensColl.findOne({ _id: token });
        console.log('createSchoolGroupBindToken: 验证插入的记录:', verification);
        
        return token;
    },

    // 根据令牌获取绑定信息
    async getBindInfo(token: string): Promise<{
        type: 'user_group' | 'school_group';
        target: UserGroup | SchoolGroup;
        bindToken: BindToken;
    } | null> {
        console.log('getBindInfo: 查询令牌:', token);
        
        const bindToken = await bindTokensColl.findOne({ _id: token });
        console.log('getBindInfo: 找到的绑定令牌:', bindToken);
        
        if (!bindToken) {
            console.log('getBindInfo: 绑定令牌不存在');
            return null;
        }

        let target;
        if (bindToken.type === 'user_group') {
            target = await userGroupsColl.findOne({ _id: bindToken.targetId });
            console.log('getBindInfo: 用户组目标:', target);
        } else {
            target = await schoolGroupsColl.findOne({ _id: bindToken.targetId });
            console.log('getBindInfo: 学校组目标:', target);
        }

        if (!target) {
            console.log('getBindInfo: 目标对象不存在');
            return null;
        }

        console.log('getBindInfo: 成功返回绑定信息');
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
            // 用户已有学校组，检查是否一致
            const userSchoolId = dbUser.parentSchoolId[0];
            
            // 使用灵活的ID比较方式
            let schoolMatches = false;
            try {
                // 尝试直接比较
                schoolMatches = userSchoolId.equals && userSchoolId.equals(userGroup.parentSchoolId);
            } catch (error) {
                // 如果直接比较失败，尝试字符串比较
                schoolMatches = userSchoolId.toString() === userGroup.parentSchoolId.toString();
            }
            
            console.log('bindUserToGroup: 学校组匹配检查:', {
                userSchoolId: userSchoolId.toString(),
                groupSchoolId: userGroup.parentSchoolId.toString(),
                matches: schoolMatches
            });
            
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

        // 更新用户组中的学生状态
        await userGroupsColl.updateOne(
            { _id: userGroup._id, 'students.studentId': studentId, 'students.realName': realName },
            {
                $set: {
                    'students.$.bound': true,
                    'students.$.boundBy': userId,
                    'students.$.boundAt': new Date()
                }
            }
        );
    },

    // 用户绑定到学校组
    async bindUserToSchoolGroup(userId: number, token: string, studentId: string, realName: string): Promise<void> {
        console.log('bindUserToSchoolGroup: 开始绑定');
        console.log('bindUserToSchoolGroup: userId:', userId);
        console.log('bindUserToSchoolGroup: token:', token);
        console.log('bindUserToSchoolGroup: studentId:', studentId);
        console.log('bindUserToSchoolGroup: realName:', realName);
        
        const bindInfo = await this.getBindInfo(token);
        if (!bindInfo || bindInfo.type !== 'school_group') {
            throw new Error('无效的绑定令牌');
        }

        const schoolGroup = bindInfo.target as SchoolGroup;
        console.log('bindUserToSchoolGroup: 学校组信息:', schoolGroup);
        console.log('bindUserToSchoolGroup: 学校组成员:', schoolGroup.members);
        
        // 检查学校组是否有成员数据结构
        if (!schoolGroup.members || !Array.isArray(schoolGroup.members)) {
            console.log('bindUserToSchoolGroup: 学校组没有成员数据结构');
            throw new Error('此学校组缺少成员信息，请联系管理员重新创建学校组');
        }
        
        // 检查学生是否在学校组中
        const member = schoolGroup.members.find(m => m.studentId === studentId && m.realName === realName);
        console.log('bindUserToSchoolGroup: 查找成员结果:', member);
        
        if (!member) {
            console.log('bindUserToSchoolGroup: 成员不存在，可用成员列表:');
            schoolGroup.members.forEach((m, index) => {
                console.log(`  ${index}: ${m.studentId} - ${m.realName}`);
            });
            throw new Error('学号或姓名不匹配，请检查输入信息或联系管理员');
        }

        if (member.bound) {
            console.log('bindUserToSchoolGroup: 成员已绑定');
            throw new Error('该学生信息已被绑定');
        }

        const userColl = db.collection('user');

        // 检查用户是否已有学校组
        const dbUser = await userColl.findOne({ _id: userId });
        console.log('bindUserToSchoolGroup: 用户信息:', dbUser);
        
        if (dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0) {
            console.log('bindUserToSchoolGroup: 用户已有学校组');
            throw new Error('您已属于其他学校组');
        }

        console.log('bindUserToSchoolGroup: 开始更新用户信息');
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

        console.log('bindUserToSchoolGroup: 开始更新学校组成员状态');
        // 更新学校组中的成员状态 - 使用更精确的查询条件
        const updateResult = await schoolGroupsColl.updateOne(
            { 
                _id: schoolGroup._id, 
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
        
        console.log('bindUserToSchoolGroup: 学校组更新结果:', updateResult);
        
        if (updateResult.matchedCount === 0) {
            console.log('bindUserToSchoolGroup: 警告 - 学校组成员状态更新失败，可能已经被绑定');
        }
        
        console.log('bindUserToSchoolGroup: 绑定完成');
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
        const userGroups = await userGroupsColl
            .find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        return {
            userGroups,
            total,
            pageCount: Math.ceil(total / limit)
        };
    },

    // 检查用户是否属于某个学校组
    async isUserInSchool(userId: number): Promise<boolean> {
        console.log('isUserInSchool: 检查用户是否属于学校组，用户ID:', userId, '类型:', typeof userId);
        const userColl = db.collection('user');
        const dbUser = await userColl.findOne({ _id: userId });
        console.log('isUserInSchool: 查找到的用户数据:', {
            found: !!dbUser,
            _id: dbUser?._id,
            uname: dbUser?.uname,
            parentSchoolId: dbUser?.parentSchoolId,
            parentSchoolIdLength: dbUser?.parentSchoolId?.length,
            parentSchoolIdType: typeof dbUser?.parentSchoolId
        });
        
        const result = !!(dbUser?.parentSchoolId && dbUser.parentSchoolId.length > 0);
        console.log('isUserInSchool: 判断结果:', result);
        return result;
    },

    // 向学校组添加成员
    async addSchoolGroupMembers(schoolGroupId: any, members: Array<{studentId: string, realName: string}>): Promise<void> {
        console.log('addSchoolGroupMembers: 传入的schoolGroupId:', schoolGroupId, '类型:', typeof schoolGroupId);
        
        // 使用灵活的查询方式
        let school: SchoolGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            school = await schoolGroupsColl.findOne({ _id: schoolGroupId });
            console.log('addSchoolGroupMembers: 直接查询结果:', school);
        } catch (error) {
            console.log('addSchoolGroupMembers: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!school) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                school = allSchools.find(s => s._id.toString() === schoolGroupId.toString()) || null;
                console.log('addSchoolGroupMembers: 字符串匹配查询结果:', school);
            } catch (error) {
                console.log('addSchoolGroupMembers: 字符串匹配查询失败:', error);
            }
        }
        
        if (!school) {
            console.log('addSchoolGroupMembers: 学校组不存在，schoolGroupId:', schoolGroupId);
            // 列出所有学校组用于调试
            const allSchools = await schoolGroupsColl.find().limit(5).toArray();
            console.log('addSchoolGroupMembers: 现有学校组:');
            allSchools.forEach((s, i) => {
                console.log(`  ${i}: _id=${s._id} (${typeof s._id}) name=${s.name}`);
            });
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
        console.log('addSchoolGroupMembers: 准备更新学校组，使用ID:', school._id);
        await schoolGroupsColl.updateOne(
            { _id: school._id },
            { $push: { members: { $each: newMembers } } }
        );
        console.log('addSchoolGroupMembers: 更新完成');
    },

    // 从学校组移除成员
    async removeSchoolGroupMembers(schoolGroupId: any, studentIds: string[]): Promise<void> {
        console.log('removeSchoolGroupMembers: 传入的schoolGroupId:', schoolGroupId);
        
        // 使用灵活的查询方式
        let school: SchoolGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            school = await schoolGroupsColl.findOne({ _id: schoolGroupId });
        } catch (error) {
            console.log('removeSchoolGroupMembers: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!school) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                school = allSchools.find(s => s._id.toString() === schoolGroupId.toString()) || null;
            } catch (error) {
                console.log('removeSchoolGroupMembers: 字符串匹配查询失败:', error);
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
        console.log('addUserGroupStudents: 传入的userGroupId:', userGroupId);
        
        // 使用灵活的查询方式
        let userGroup: UserGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            userGroup = await userGroupsColl.findOne({ _id: userGroupId });
        } catch (error) {
            console.log('addUserGroupStudents: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!userGroup) {
            try {
                const allGroups = await userGroupsColl.find().toArray();
                userGroup = allGroups.find(g => g._id.toString() === userGroupId.toString()) || null;
            } catch (error) {
                console.log('addUserGroupStudents: 字符串匹配查询失败:', error);
            }
        }
        
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
        console.log('removeUserGroupStudents: 传入的userGroupId:', userGroupId);
        
        // 使用灵活的查询方式
        let userGroup: UserGroup | null = null;
        
        // 方式1: 直接使用传入的ID查询
        try {
            userGroup = await userGroupsColl.findOne({ _id: userGroupId });
        } catch (error) {
            console.log('removeUserGroupStudents: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!userGroup) {
            try {
                const allGroups = await userGroupsColl.find().toArray();
                userGroup = allGroups.find(g => g._id.toString() === userGroupId.toString()) || null;
            } catch (error) {
                console.log('removeUserGroupStudents: 字符串匹配查询失败:', error);
            }
        }
        
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
        console.log('getSchoolGroupById: 传入的ID:', schoolGroupId, '类型:', typeof schoolGroupId);
        
        // 尝试多种查询方式
        let result: SchoolGroup | null = null;
        
        // 方式1: 直接查询
        try {
            result = await schoolGroupsColl.findOne({ _id: schoolGroupId });
            console.log('getSchoolGroupById: 直接查询结果:', result ? '找到' : '未找到');
        } catch (error) {
            console.log('getSchoolGroupById: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!result) {
            try {
                const allSchools = await schoolGroupsColl.find().toArray();
                console.log('getSchoolGroupById: 总共有', allSchools.length, '个学校组');
                
                // 尝试字符串匹配
                result = allSchools.find(school => {
                    const match = school._id.toString() === schoolGroupId.toString();
                    if (match) {
                        console.log('getSchoolGroupById: 字符串匹配成功，找到学校组:', school.name);
                    }
                    return match;
                }) || null;
                
                if (!result) {
                    console.log('getSchoolGroupById: 字符串匹配未找到，列出前5个学校组:');
                    allSchools.slice(0, 5).forEach((school, index) => {
                        console.log(`  ${index}: _id=${school._id} (${typeof school._id}) name=${school.name}`);
                    });
                }
            } catch (error) {
                console.log('getSchoolGroupById: 字符串匹配查询失败:', error);
            }
        }
        
        return result;
    },

    // 获取用户组详情
    async getUserGroupById(userGroupId: any): Promise<UserGroup | null> {
        console.log('getUserGroupById: 传入的ID:', userGroupId, '类型:', typeof userGroupId);
        
        // 尝试多种查询方式
        let result: UserGroup | null = null;
        
        // 方式1: 直接查询
        try {
            result = await userGroupsColl.findOne({ _id: userGroupId });
            console.log('getUserGroupById: 直接查询结果:', result ? '找到' : '未找到');
        } catch (error) {
            console.log('getUserGroupById: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!result) {
            try {
                const allGroups = await userGroupsColl.find().toArray();
                console.log('getUserGroupById: 总共有', allGroups.length, '个用户组');
                
                // 尝试字符串匹配
                result = allGroups.find(group => {
                    const match = group._id.toString() === userGroupId.toString();
                    if (match) {
                        console.log('getUserGroupById: 字符串匹配成功，找到用户组:', group.name);
                    }
                    return match;
                }) || null;
                
                if (!result) {
                    console.log('getUserGroupById: 字符串匹配未找到，列出前5个用户组:');
                    allGroups.slice(0, 5).forEach((group, index) => {
                        console.log(`  ${index}: _id=${group._id} (${typeof group._id}) name=${group.name}`);
                    });
                }
            } catch (error) {
                console.log('getUserGroupById: 字符串匹配查询失败:', error);
            }
        }
        
        return result;
    },

    // 删除学校组（包括解绑所有成员、删除相关用户组）
    async deleteSchoolGroup(schoolGroupId: any): Promise<void> {
        console.log('deleteSchoolGroup: 删除学校组ID:', schoolGroupId);
        
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
                        console.log(`deleteSchoolGroup: 解绑用户 ${member.boundBy} (${member.studentId})`);
                    } catch (error) {
                        console.log(`deleteSchoolGroup: 解绑用户 ${member.boundBy} 失败:`, error);
                    }
                }
            }
        }

        // 2. 删除属于该学校的所有用户组
        const userGroups = await userGroupsColl.find({ parentSchoolId: school._id }).toArray();
        for (const userGroup of userGroups) {
            console.log(`deleteSchoolGroup: 删除用户组 ${userGroup.name}`);
            
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
                            console.log(`deleteSchoolGroup: 从用户组解绑用户 ${student.boundBy} (${student.studentId})`);
                        } catch (error) {
                            console.log(`deleteSchoolGroup: 从用户组解绑用户 ${student.boundBy} 失败:`, error);
                        }
                    }
                }
            }
            
            // 删除用户组
            await userGroupsColl.deleteOne({ _id: userGroup._id });
        }

        // 3. 删除学校组
        await schoolGroupsColl.deleteOne({ _id: school._id });
        console.log(`deleteSchoolGroup: 学校组 ${school.name} 删除完成`);
    },

    // 编辑学校组成员信息
    async editSchoolGroupMember(schoolGroupId: any, oldStudentId: string, newStudentId: string, newRealName: string): Promise<void> {
        console.log('editSchoolGroupMember: 编辑成员信息', { schoolGroupId, oldStudentId, newStudentId, newRealName });
        
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

        console.log('editSchoolGroupMember: 成员信息编辑完成');
    },

    // 删除学校组成员（包括解绑操作）
    async deleteSchoolGroupMember(schoolGroupId: any, studentId: string): Promise<void> {
        console.log('deleteSchoolGroupMember: 删除成员', { schoolGroupId, studentId });
        
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
            console.log(`deleteSchoolGroupMember: 解绑用户 ${member.boundBy} (${studentId})`);
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

        console.log(`deleteSchoolGroupMember: 成员 ${studentId} 删除完成`);
    },

    // 检查用户是否有参加比赛的权限
    async checkContestPermission(userId: number, contestId: any): Promise<{ allowed: boolean; reason?: string }> {
        console.log('====== 开始比赛权限检查 ======');
        console.log('checkContestPermission: 用户ID:', userId, '类型:', typeof userId);
        console.log('checkContestPermission: 比赛ID:', contestId, '类型:', typeof contestId);
        
        try {
            const documentColl = db.collection('document');
            let contest: any = null;
            
            // 尝试多种查询方式
            try {
                console.log('checkContestPermission: 尝试直接查询比赛...');
                // 方式1: 直接查询
                contest = await documentColl.findOne({ 
                    _id: contestId,
                    docType: 30 // 比赛文档类型
                });
                console.log('checkContestPermission: 直接查询结果:', contest ? `找到比赛: ${contest.title}` : '未找到');
            } catch (error) {
                console.log('checkContestPermission: 直接查询失败:', error);
            }
            
            // 方式2: 如果直接查询失败，尝试字符串匹配
            if (!contest) {
                try {
                    console.log('checkContestPermission: 直接查询失败，尝试字符串匹配...');
                    const allContests = await documentColl.find({ docType: 30 }).toArray();
                    console.log('checkContestPermission: 总共有', allContests.length, '个比赛文档');
                    
                    // 尝试字符串匹配
                    contest = allContests.find(c => {
                        const match = c._id.toString() === contestId.toString();
                        if (match) {
                            console.log('checkContestPermission: 字符串匹配成功，找到比赛:', c.title);
                        }
                        return match;
                    }) || null;
                    
                    if (!contest) {
                        console.log('checkContestPermission: 字符串匹配未找到，列出前5个比赛:');
                        allContests.slice(0, 5).forEach((c, index) => {
                            console.log(`  ${index}: _id=${c._id} (${typeof c._id}) title=${c.title}`);
                        });
                    }
                } catch (error) {
                    console.log('checkContestPermission: 字符串匹配查询失败:', error);
                }
            }
            
            if (!contest) {
                console.log('checkContestPermission: 比赛不存在，返回拒绝访问');
                return { allowed: false, reason: '比赛不存在' };
            }

            console.log('checkContestPermission: 找到比赛:', contest.title);
            console.log('checkContestPermission: 比赛权限配置:', JSON.stringify(contest.userBindPermission, null, 2));
            
            const permission = contest.userBindPermission;
            
            // 如果未启用权限控制，允许所有用户参加
            if (!permission || !permission.enabled) {
                console.log('checkContestPermission: 权限控制未启用，允许所有用户参加');
                return { allowed: true };
            }

            console.log('checkContestPermission: 权限控制已启用，模式:', permission.mode);
            console.log('checkContestPermission: 允许的组列表:', permission.allowedGroups);

            const userColl = db.collection('user');
            const dbUser = await userColl.findOne({ _id: userId });
            
            if (!dbUser) {
                console.log('checkContestPermission: 用户不存在');
                return { allowed: false, reason: '用户不存在' };
            }

            console.log('checkContestPermission: 用户信息:');
            console.log('  - 用户名:', dbUser.uname);
            console.log('  - 学校组ID:', dbUser.parentSchoolId);
            console.log('  - 用户组ID:', dbUser.parentUserGroupId);

            if (permission.mode === 'school') {
                console.log('checkContestPermission: 进入学校组权限检查模式');
                // 学校组模式
                if (!dbUser.parentSchoolId || dbUser.parentSchoolId.length === 0) {
                    console.log('checkContestPermission: 用户不属于任何学校组');
                    return { allowed: false, reason: '您不属于任何学校组' };
                }

                // 检查用户的学校组是否在允许列表中
                const userSchoolIds = dbUser.parentSchoolId.map((id: any) => id.toString());
                const allowedSchoolIds = permission.allowedGroups.map((id: string) => id.toString());
                
                console.log('checkContestPermission: 用户的学校组ID (字符串):', userSchoolIds);
                console.log('checkContestPermission: 允许的学校组ID (字符串):', allowedSchoolIds);
                
                const hasPermission = userSchoolIds.some((schoolId: string) => 
                    allowedSchoolIds.includes(schoolId)
                );

                console.log('checkContestPermission: 学校组权限检查结果:', hasPermission);

                if (!hasPermission) {
                    console.log('checkContestPermission: 用户所在学校组无权参加此比赛');
                    return { allowed: false, reason: '您所在的学校组无权参加此比赛' };
                }
                
            } else if (permission.mode === 'user_group') {
                console.log('checkContestPermission: 进入用户组权限检查模式');
                // 用户组模式
                if (!dbUser.parentUserGroupId || dbUser.parentUserGroupId.length === 0) {
                    console.log('checkContestPermission: 用户不属于任何用户组');
                    return { allowed: false, reason: '您不属于任何用户组' };
                }

                // 检查用户的用户组是否在允许列表中
                const userGroupIds = dbUser.parentUserGroupId.map((id: any) => id.toString());
                const allowedGroupIds = permission.allowedGroups.map((id: string) => id.toString());
                
                console.log('checkContestPermission: 用户的用户组ID (字符串):', userGroupIds);
                console.log('checkContestPermission: 允许的用户组ID (字符串):', allowedGroupIds);
                
                const hasPermission = userGroupIds.some((groupId: string) => 
                    allowedGroupIds.includes(groupId)
                );

                console.log('checkContestPermission: 用户组权限检查结果:', hasPermission);

                if (!hasPermission) {
                    console.log('checkContestPermission: 用户所在用户组无权参加此比赛');
                    return { allowed: false, reason: '您所在的用户组无权参加此比赛' };
                }
            }

            console.log('checkContestPermission: 权限检查通过，允许访问');
            return { allowed: true };
        } catch (error) {
            console.error('checkContestPermission: 检查比赛权限失败:', error);
            return { allowed: false, reason: '权限检查失败' };
        } finally {
            console.log('====== 比赛权限检查结束 ======');
        }
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

        console.log('ContestPermissionHandler: 收到比赛ID:', contestId, '类型:', typeof contestId);

        // 获取比赛信息（从document集合中获取docType为30的文档）
        const documentColl = db.collection('document');
        
        let contest: any = null;
        
        try {
            // 方式1: 直接查询
            contest = await documentColl.findOne({ 
                _id: contestId,
                docType: 30 // 比赛文档类型
            });
            console.log('ContestPermissionHandler: 直接查询结果:', contest ? '找到' : '未找到');
        } catch (error) {
            console.log('ContestPermissionHandler: 直接查询失败:', error);
        }
        
        // 方式2: 如果直接查询失败，尝试字符串匹配
        if (!contest) {
            try {
                const allContests = await documentColl.find({ docType: 30 }).toArray();
                console.log('ContestPermissionHandler: 总共有', allContests.length, '个比赛文档');
                
                // 尝试字符串匹配
                contest = allContests.find(c => {
                    const match = c._id.toString() === contestId.toString();
                    if (match) {
                        console.log('ContestPermissionHandler: 字符串匹配成功，找到比赛:', c.title);
                    }
                    return match;
                }) || null;
                
                if (!contest) {
                    console.log('ContestPermissionHandler: 字符串匹配未找到，列出前5个比赛:');
                    allContests.slice(0, 5).forEach((c, index) => {
                        console.log(`  ${index}: _id=${c._id} (${typeof c._id}) title=${c.title}`);
                    });
                }
            } catch (error) {
                console.log('ContestPermissionHandler: 字符串匹配查询失败:', error);
            }
        }
        
        if (!contest) {
            throw new NotFoundError('比赛不存在');
        }

        console.log('ContestPermissionHandler: 找到比赛:', contest.title);

        // 获取所有学校组和用户组
        const { schools } = await userBindModel.getSchoolGroups(1, 1000);
        const { userGroups } = await userBindModel.getUserGroupsList(1, 1000);

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
            
            // 尝试多种查询方式
            try {
                // 方式1: 直接查询
                contest = await documentColl.findOne({ 
                    _id: contestId,
                    docType: 30 // 比赛文档类型
                });
            } catch (error) {
                console.log('ContestPermissionHandler.post: 直接查询失败:', error);
            }
            
            // 方式2: 如果直接查询失败，尝试字符串匹配
            if (!contest) {
                try {
                    const allContests = await documentColl.find({ docType: 30 }).toArray();
                    contest = allContests.find(c => c._id.toString() === contestId.toString()) || null;
                    console.log('ContestPermissionHandler.post: 字符串匹配结果:', contest ? '找到' : '未找到');
                } catch (error) {
                    console.log('ContestPermissionHandler.post: 字符串匹配查询失败:', error);
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
        
        console.log('SchoolGroupDetailHandler.get: schoolId参数:', schoolId);
        
        if (!schoolId) {
            throw new NotFoundError('学校组ID无效');
        }
        
        const school = await userBindModel.getSchoolGroupById(schoolId);
        console.log('SchoolGroupDetailHandler.get: 查找到的学校:', school);
        
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
        const { name, parentSchoolId, studentsData } = this.request.body;
        
        if (!name || !parentSchoolId) {
            const { schools } = await userBindModel.getSchoolGroups(1, 1000);
            this.response.template = 'user_group_create.html';
            this.response.body = { 
                error: '请输入用户组名称并选择学校', 
                name, 
                parentSchoolId, 
                studentsData,
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
            const userGroupId = await userBindModel.createUserGroup(name, parentSchoolId, this.user._id, students);
            const bindToken = await userBindModel.createUserGroupBindToken(userGroupId, this.user._id);
            
            this.response.template = 'user_group_created.html';
            this.response.body = {
                userGroup: { _id: userGroupId, name },
                bindToken,
                bindUrl: `/bind/${bindToken}`,
                studentsCount: students.length
            };
        } catch (error: any) {
            const { schools } = await userBindModel.getSchoolGroups(1, 1000);
            this.response.template = 'user_group_create.html';
            this.response.body = { 
                error: error.message, 
                name, 
                parentSchoolId, 
                studentsData,
                schools 
            };
        }
    }
}

// 绑定界面 - 处理令牌绑定
class BindHandler extends Handler {
    async get() {
        console.log('BindHandler.get: 收到请求');
        console.log('BindHandler.get: request.params:', this.request.params);
        console.log('BindHandler.get: request.path:', this.request.path);
        console.log('BindHandler.get: 用户ID:', this.user._id);
        
        const { token } = this.request.params;
        console.log('BindHandler.get: 从params获取的token:', token);
        
        if (!token) {
            console.log('BindHandler.get: 令牌参数缺失');
            throw new NotFoundError('绑定链接格式错误');
        }
        
        if (!this.user._id) {
            console.log('BindHandler.get: 用户未登录，重定向到登录页');
            this.response.redirect = `/login?redirect=${encodeURIComponent(this.request.path)}`;
            return;
        }

        const bindInfo = await userBindModel.getBindInfo(token);
        console.log('BindHandler.get: 获取的绑定信息:', bindInfo);
        
        if (!bindInfo) {
            console.log('BindHandler.get: 绑定信息不存在，抛出NotFoundError');
            throw new NotFoundError('绑定链接无效或已过期');
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

            console.log('BindHandler.get: 学校组匹配检查:', {
                userSchools: userSchools.map(s => ({ id: s._id.toString(), name: s.name })),
                targetGroupSchoolId: targetGroup.parentSchoolId.toString(),
                hasMatchingSchool
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
        console.log('BindHandler.post: token:', token);
        
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

            console.log('BindHandler.post: 开始绑定，类型:', bindInfo.type);
            
            if (bindInfo.type === 'user_group') {
                await userBindModel.bindUserToGroup(this.user._id, token, studentId, realName);
            } else {
                await userBindModel.bindUserToSchoolGroup(this.user._id, token, studentId, realName);
            }

            console.log('BindHandler.post: 绑定成功');
            this.response.template = 'bind_success.html';
            this.response.body = { 
                studentId,
                realName,
                groupName: bindInfo.target.name
            };
        } catch (error: any) {
            console.log('BindHandler.post: 绑定失败，错误:', error.message);
            const bindInfo = await userBindModel.getBindInfo(token);
            this.response.template = 'bind_form.html';
            this.response.body = { 
                error: error.message,
                bindInfo,
                token,
                studentId,
                realName
            };
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
    // 添加用户设置项
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('setting_info', 'nickname', '', 'text', '昵称', '自定义显示昵称', 0)
        );
    });

    // 监听用户设置更新事件，同步昵称到用户名
    ctx.on('handler/after/UserSettings#post', async (h) => {
        if (h.request.body && h.request.body.nickname !== undefined) {
            console.log('====== 用户昵称更新 ======');
            console.log('用户ID:', h.user._id);
            console.log('新昵称:', h.request.body.nickname);
            
            try {
                const userColl = db.collection('user');
                const nickname = h.request.body.nickname.trim();
                
                if (nickname) {
                    // 检查昵称是否已被其他用户使用
                    const existingUser = await userColl.findOne({ 
                        uname: nickname, 
                        _id: { $ne: h.user._id } 
                    });
                    
                    if (existingUser) {
                        console.log('昵称已被其他用户使用:', nickname);
                        return;
                    }
                    
                    // 如果昵称不为空，将昵称同步到uname和unameLower字段
                    await userColl.updateOne(
                        { _id: h.user._id },
                        { 
                            $set: { 
                                uname: nickname,
                                unameLower: nickname.toLowerCase()
                            }
                        }
                    );
                    console.log('昵称已同步到用户名:', nickname);
                } else {
                    console.log('昵称为空，不更新用户名');
                }
            } catch (error) {
                console.error('昵称同步失败:', error);
            }
            console.log('====== 用户昵称更新结束 ======');
        }
    });

    // 通用的用户设置更新监听（适配不同的设置页面）
    ctx.on('handler/after', async (h) => {
        // 检查是否是用户设置相关的POST请求
        if (h.request.method === 'POST' && 
            (h.request.path.includes('/user/') || h.request.path.includes('/settings') || h.request.path.includes('/preference')) &&
            h.request.body && h.request.body.nickname !== undefined && h.user && h.user._id) {
            
            console.log('====== 通用用户昵称更新 ======');
            console.log('用户ID:', h.user._id);
            console.log('请求路径:', h.request.path);
            console.log('新昵称:', h.request.body.nickname);
            console.log('完整请求体:', JSON.stringify(h.request.body, null, 2));
            
            try {
                const userColl = db.collection('user');
                const nickname = h.request.body.nickname ? h.request.body.nickname.trim() : '';
                
                if (nickname) {
                    // 检查昵称是否已被其他用户使用
                    const existingUser = await userColl.findOne({ 
                        uname: nickname, 
                        _id: { $ne: h.user._id } 
                    });
                    
                    if (existingUser) {
                        console.log('昵称已被其他用户使用:', nickname);
                        return;
                    }
                    
                    // 将昵称同步到uname和unameLower字段
                    const updateResult = await userColl.updateOne(
                        { _id: h.user._id },
                        { 
                            $set: { 
                                uname: nickname,
                                unameLower: nickname.toLowerCase()
                            }
                        }
                    );
                    console.log('昵称已同步到用户名:', nickname);
                    console.log('数据库更新结果:', updateResult);
                } else {
                    console.log('昵称为空，不更新用户名');
                }
            } catch (error) {
                console.error('通用昵称同步失败:', error);
            }
            console.log('====== 通用用户昵称更新结束 ======');
        }
    });

    // 注册路由
    ctx.Route('school_group_manage', '/school-group/manage', SchoolGroupManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('school_group_detail', '/school-group/detail/:schoolId', SchoolGroupDetailHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('school_group_create', '/school-group/create', SchoolGroupCreateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_manage', '/user-group/manage', UserGroupManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_detail', '/user-group/detail/:groupId', UserGroupDetailHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_group_create', '/user-group/create', UserGroupCreateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('contest_permission', '/contest/:contestId/permission', ContestPermissionHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('bind', '/bind/:token', BindHandler);
    
    // 调试路由 - 检查绑定令牌
    ctx.Route('debug_tokens', '/debug/tokens', class extends Handler {
        async get() {
            this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
            
            const allTokens = await bindTokensColl.find().toArray();
            const allSchools = await schoolGroupsColl.find().toArray();
            const allUserGroups = await userGroupsColl.find().toArray();
            
            this.response.body = {
                bindTokens: allTokens,
                schoolGroups: allSchools,
                userGroups: allUserGroups,
                collectionsInfo: {
                    bindTokensCount: allTokens.length,
                    schoolGroupsCount: allSchools.length,
                    userGroupsCount: allUserGroups.length
                }
            };
            this.response.type = 'application/json';
        }
    }, PRIV.PRIV_EDIT_SYSTEM);

    // 调试路由 - 检查比赛查询
    ctx.Route('debug_contest', '/debug/contest/:contestId', class extends Handler {
        async get() {
            this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
            const { contestId } = this.request.params;
            
            const documentColl = db.collection('document');
            
            // 尝试多种查询方式
            let directQuery, stringQuery, allContests;
            
            try {
                // 直接查询
                directQuery = await documentColl.findOne({ 
                    _id: contestId,
                    docType: 30 
                });
            } catch (error) {
                directQuery = { error: error.message };
            }
            
            try {
                // 字符串转ObjectId查询
                const { ObjectId } = require('mongodb');
                const objectId = new ObjectId(contestId);
                stringQuery = await documentColl.findOne({ 
                    _id: objectId,
                    docType: 30 
                });
            } catch (error) {
                stringQuery = { error: error.message };
            }
            
            try {
                // 获取所有比赛文档
                allContests = await documentColl.find({ docType: 30 }).limit(10).toArray();
            } catch (error) {
                allContests = { error: error.message };
            }
            
            this.response.body = {
                contestId: contestId,
                contestIdType: typeof contestId,
                directQuery: directQuery,
                stringQuery: stringQuery,
                allContests: allContests,
                timestamp: new Date().toISOString()
            };
            this.response.type = 'application/json';
        }
    }, PRIV.PRIV_EDIT_SYSTEM);
    
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
                return;
            }
            
            // 定义需要学校组权限的路径
            const schoolGroupRequiredPaths = [
                '/training',
                '/homework',
                '/contest',
                '/p'
            ];
            
            // 需要排除的路径（不进行任何检查）
            const excludePaths = [
                '/bind',
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
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.user._id);
            const isBound = await userBindModel.isUserBound(h.user._id);
            
            // 检查是否访问需要学校组权限的路径
            const isSchoolGroupRequiredPath = schoolGroupRequiredPaths.some(path => 
                currentPath === path || currentPath.startsWith(path + '/')
            );
            
            if (isSchoolGroupRequiredPath) {
                // 非学校组成员禁止访问
                if (!isInSchool) {
                    console.log(`访问控制 - 用户 ${user.uname} 试图访问学校组专用路径: ${currentPath}`);
                    throw new ForbiddenError('此功能仅限学校组成员使用，请联系管理员');
                }
                
                // 学校组成员但未绑定，重定向到首页
                if (!isBound) {
                    console.log(`绑定检查 - 学校组成员 ${user.uname} 未绑定，重定向到首页`);
                    h.response.redirect = '/';
                    return;
                }
                
                console.log(`访问允许 - 学校组成员 ${user.uname} 访问路径: ${currentPath}`);
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
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.user._id);
            // 只有学校组成员才需要强制绑定
            if (isInSchool && !await userBindModel.isUserBound(h.user._id)) {
                // 这里可以添加提示信息，但不强制重定向
                console.log(`登录提示 - 学校组成员 ${user.uname} 尚未完成身份绑定`);
            }
        } catch (error) {
            console.error('登录后绑定检查失败:', error);
        }
    });

    // 在用户详情页面添加绑定信息显示
    ctx.on('handler/after/UserDetail#get', async (h) => {
        if (h.response.body.udoc) {
            console.log('====== 用户详情页面 - 绑定信息检查 ======');
            console.log('用户ID:', h.response.body.udoc._id);
            console.log('用户名:', h.response.body.udoc.uname);
            console.log('用户数据中的字段:', {
                studentId: h.response.body.udoc.studentId,
                realName: h.response.body.udoc.realName,
                parentSchoolId: h.response.body.udoc.parentSchoolId,
                parentUserGroupId: h.response.body.udoc.parentUserGroupId
            });
            
            // 检查用户是否属于学校组
            const isInSchool = await userBindModel.isUserInSchool(h.response.body.udoc._id);
            console.log('用户是否属于学校组:', isInSchool);
            
            if (isInSchool) {
                // 从数据库重新获取用户信息，确保数据完整
                const userColl = db.collection('user');
                const dbUser = await userColl.findOne({ _id: h.response.body.udoc._id });
                console.log('数据库中的用户信息:', {
                    _id: dbUser?._id,
                    uname: dbUser?.uname,
                    studentId: dbUser?.studentId,
                    realName: dbUser?.realName,
                    parentSchoolId: dbUser?.parentSchoolId,
                    parentUserGroupId: dbUser?.parentUserGroupId
                });
                
                h.response.body.showBindInfo = true;
                h.response.body.bindInfo = {
                    studentId: (dbUser?.studentId || h.response.body.udoc.studentId) || '未绑定',
                    realName: (dbUser?.realName || h.response.body.udoc.realName) || '未绑定',
                    isBound: !!((dbUser?.studentId || h.response.body.udoc.studentId) && (dbUser?.realName || h.response.body.udoc.realName))
                };
                
                console.log('最终绑定信息:', h.response.body.bindInfo);
                
                // 获取用户所属的学校组和用户组信息
                const userSchools = await userBindModel.getUserSchoolGroups(h.response.body.udoc._id);
                const userGroups = await userBindModel.getUserGroups(h.response.body.udoc._id);
                console.log('用户所属学校组:', userSchools);
                console.log('用户所属用户组:', userGroups);
                
                h.response.body.bindInfo.schools = userSchools;
                h.response.body.bindInfo.userGroups = userGroups;
            }
            console.log('====== 用户详情页面 - 绑定信息检查结束 ======');
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

    // 为训练排行榜添加处理
    ctx.on('handler/after/TrainingScoreboard#get', async (h) => {
        if (h.user && h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const rows = h.response.body.rows || [];
            const userColl = db.collection('user');
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (i === 0) {
                    // 处理表头，在用户名列后添加学号姓名列
                    if (row.length > 1) {
                        row.splice(2, 0, '学号姓名'); // 在第2个位置（用户名后）插入
                    }
                } else {
                    // 处理数据行
                    if (row[1] && row[1]._id) {
                        let studentInfo = '';
                        const isInSchool = await userBindModel.isUserInSchool(row[1]._id);
                        if (isInSchool) {
                            const dbUser = await userColl.findOne({ _id: row[1]._id });
                            if (dbUser?.realName && dbUser?.studentId) {
                                studentInfo = `${dbUser.studentId} ${dbUser.realName}`;
                            }
                        }
                        // 在用户名列后插入学号姓名
                        row.splice(2, 0, studentInfo);
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
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (i === 0) {
                    // 处理表头，在用户名列后添加学号姓名列
                    if (row.length > 1) {
                        row.splice(2, 0, '学号姓名'); // 在第2个位置（用户名后）插入
                    }
                } else {
                    // 处理数据行
                    if (row[1] && row[1]._id) {
                        let studentInfo = '';
                        const isInSchool = await userBindModel.isUserInSchool(row[1]._id);
                        if (isInSchool) {
                            const dbUser = await userColl.findOne({ _id: row[1]._id });
                            if (dbUser?.realName && dbUser?.studentId) {
                                studentInfo = `${dbUser.studentId} ${dbUser.realName}`;
                            }
                        }
                        // 在用户名列后插入学号姓名
                        row.splice(2, 0, studentInfo);
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
                    const isInSchool = await userBindModel.isUserInSchool(user._id);
                    if (isInSchool) {
                        const dbUser = await userColl.findOne({ _id: user._id });
                        if (dbUser?.realName && dbUser?.studentId) {
                            user.displayName = `${dbUser.studentId} ${dbUser.realName}(${user.uname})`;
                        }
                    }
                }
            }
        }
    });

    // 比赛参赛权限检查
    ctx.on('handler/before/ContestDetail#get', async (h) => {
        console.log('===== 比赛页面访问权限检查 =====');
        console.log('ContestDetail#get hook: 用户:', h.user?._id, '路径:', h.request.path);
        
        if (!h.user || !h.user._id) {
            console.log('ContestDetail#get hook: 用户未登录，跳过检查');
            return;
        }

        try {
            const contestId = h.request.params.tid || h.request.params.contestId;
            console.log('ContestDetail#get hook: 比赛ID:', contestId);
            
            if (!contestId) {
                console.log('ContestDetail#get hook: 没有比赛ID，跳过检查');
                return;
            }

            // 超级管理员跳过权限检查
            if (h.user._id === 2 || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
                console.log('ContestDetail#get hook: 超级管理员，跳过权限检查');
                return;
            }

            console.log('ContestDetail#get hook: 开始权限检查...');
            const permissionCheck = await userBindModel.checkContestPermission(h.user._id, contestId);
            console.log('ContestDetail#get hook: 权限检查结果:', permissionCheck);
            
            if (!permissionCheck.allowed) {
                console.log('ContestDetail#get hook: 权限不足，抛出ForbiddenError');
                throw new ForbiddenError(permissionCheck.reason || '您无权访问此比赛');
            }
            
            console.log('ContestDetail#get hook: 权限检查通过');
        } catch (error) {
            if (error instanceof ForbiddenError) {
                console.log('ContestDetail#get hook: 抛出权限错误:', error.message);
                throw error;
            }
            console.error('ContestDetail#get hook: 权限检查失败:', error);
        } finally {
            console.log('===== 比赛页面访问权限检查结束 =====');
        }
    });

    // 比赛报名权限检查
    ctx.on('handler/before/ContestDetail#post', async (h) => {
        console.log('===== 比赛报名/操作权限检查 =====');
        console.log('ContestDetail#post hook: 用户:', h.user?._id, '路径:', h.request.path);
        
        if (!h.user || !h.user._id) {
            console.log('ContestDetail#post hook: 用户未登录，跳过检查');
            return;
        }

        try {
            const contestId = h.request.params.tid || h.request.params.contestId;
            console.log('ContestDetail#post hook: 比赛ID:', contestId);
            
            if (!contestId) {
                console.log('ContestDetail#post hook: 没有比赛ID，跳过检查');
                return;
            }

            // 超级管理员跳过权限检查
            if (h.user._id === 2 || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
                console.log('ContestDetail#post hook: 超级管理员，跳过权限检查');
                return;
            }

            const action = h.request.body.operation || h.request.body.action;
            console.log('ContestDetail#post hook: 操作类型:', action);
            console.log('ContestDetail#post hook: 请求体:', JSON.stringify(h.request.body, null, 2));
            
            // 只对报名操作进行权限检查
            if (action === 'attend' || action === 'register') {
                console.log('ContestDetail#post hook: 检查', action, '操作权限...');
                const permissionCheck = await userBindModel.checkContestPermission(h.user._id, contestId);
                console.log('ContestDetail#post hook: 权限检查结果:', permissionCheck);
                
                if (!permissionCheck.allowed) {
                    console.log('ContestDetail#post hook: 权限不足，抛出ForbiddenError');
                    throw new ForbiddenError(permissionCheck.reason || '您无权参加此比赛');
                }
                
                console.log('ContestDetail#post hook: 权限检查通过');
            } else {
                console.log('ContestDetail#post hook: 非报名操作，跳过权限检查');
            }
        } catch (error) {
            if (error instanceof ForbiddenError) {
                console.log('ContestDetail#post hook: 抛出权限错误:', error.message);
                throw error;
            }
            console.error('ContestDetail#post hook: 权限检查失败:', error);
        } finally {
            console.log('===== 比赛报名/操作权限检查结束 =====');
        }
    });

    // 为排名页面添加处理，所有人都能看到真实姓名
    ctx.on('handler/after/DomainRank#get', async (h) => {
        console.log('====== 排名页面Hook开始 ======');
        console.log('DomainRank hook triggered, user:', h.user?._id);
        console.log('DomainRank hook - response body keys:', Object.keys(h.response.body || {}));
        
        const udocs = h.response.body.udocs || [];
        const userColl = db.collection('user');
        console.log('DomainRank hook - Processing', udocs.length, 'users in ranking');
        console.log('DomainRank hook - Sample udoc structure:', udocs.length > 0 ? {
            keys: Object.keys(udocs[0]),
            _id: udocs[0]._id,
            uname: udocs[0].uname,
            rp: udocs[0].rp
        } : 'No udocs');
        
        // 处理当前用户的学号姓名信息
        if (h.user && h.user._id) {
            console.log('DomainRank hook - Processing current user:', h.user._id);
            const isCurrentUserInSchool = await userBindModel.isUserInSchool(h.user._id);
            console.log('DomainRank hook - Current user isInSchool:', isCurrentUserInSchool);
            
            if (isCurrentUserInSchool) {
                const currentDbUser = await userColl.findOne({ _id: h.user._id });
                console.log('DomainRank hook - Current user DB data:', {
                    _id: currentDbUser?._id,
                    uname: currentDbUser?.uname,
                    realName: currentDbUser?.realName,
                    studentId: currentDbUser?.studentId,
                    parentSchoolId: currentDbUser?.parentSchoolId
                });
                
                if (currentDbUser?.realName && currentDbUser?.studentId) {
                    h.user.studentInfo = `${currentDbUser.studentId} ${currentDbUser.realName}`;
                    console.log('DomainRank hook - Set studentInfo for current user', h.user._id, 'to', h.user.studentInfo);
                } else {
                    console.log('DomainRank hook - Current user missing realName or studentId:', {
                        realName: currentDbUser?.realName,
                        studentId: currentDbUser?.studentId
                    });
                }
            } else {
                console.log('DomainRank hook - Current user not in school, checking user data...');
                const currentDbUser = await userColl.findOne({ _id: h.user._id });
                console.log('DomainRank hook - Current user full data:', {
                    _id: currentDbUser?._id,
                    uname: currentDbUser?.uname,
                    parentSchoolId: currentDbUser?.parentSchoolId,
                    parentUserGroupId: currentDbUser?.parentUserGroupId
                });
            }
        }
        
        // 处理排名列表中的用户 - 所有人都能看到学号姓名
        console.log('DomainRank hook - Processing ranking list users...');
        let processedCount = 0;
        let foundStudentInfoCount = 0;
        
        for (const udoc of udocs) {
            processedCount++;
            console.log(`DomainRank hook - Processing user ${processedCount}/${udocs.length}:`, {
                _id: udoc._id,
                uname: udoc.uname,
                rank: udoc.rank
            });
            
            if (udoc._id) {
                const isInSchool = await userBindModel.isUserInSchool(udoc._id);
                console.log(`DomainRank hook - User ${udoc._id} (${udoc.uname}) isInSchool:`, isInSchool);
                
                if (isInSchool) {
                    const dbUser = await userColl.findOne({ _id: udoc._id });
                    console.log(`DomainRank hook - User ${udoc._id} DB data:`, {
                        found: !!dbUser,
                        _id: dbUser?._id,
                        uname: dbUser?.uname,
                        realName: dbUser?.realName,
                        studentId: dbUser?.studentId,
                        parentSchoolId: dbUser?.parentSchoolId,
                        parentUserGroupId: dbUser?.parentUserGroupId
                    });
                    
                    if (dbUser?.realName && dbUser?.studentId) {
                        // 添加学号姓名信息，而不是修改用户名
                        udoc.studentInfo = `${dbUser.studentId} ${dbUser.realName}`;
                        foundStudentInfoCount++;
                        console.log(`DomainRank hook - ✓ Set studentInfo for user ${udoc._id} (${udoc.uname}) to:`, udoc.studentInfo);
                    } else {
                        console.log(`DomainRank hook - ✗ User ${udoc._id} (${udoc.uname}) missing student info:`, {
                            hasRealName: !!dbUser?.realName,
                            hasStudentId: !!dbUser?.studentId,
                            realName: dbUser?.realName,
                            studentId: dbUser?.studentId
                        });
                    }
                } else {
                    console.log(`DomainRank hook - User ${udoc._id} (${udoc.uname}) not in school, checking user data...`);
                    const dbUser = await userColl.findOne({ _id: udoc._id });
                    console.log(`DomainRank hook - Non-school user ${udoc._id} data:`, {
                        found: !!dbUser,
                        uname: dbUser?.uname,
                        parentSchoolId: dbUser?.parentSchoolId,
                        parentUserGroupId: dbUser?.parentUserGroupId
                    });
                }
            } else {
                console.log(`DomainRank hook - User entry ${processedCount} has no _id:`, udoc);
            }
        }
        
        console.log(`DomainRank hook - Summary: Processed ${processedCount} users, found student info for ${foundStudentInfoCount} users`);
        console.log('====== 排名页面Hook结束 ======');
    });

}
