const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const config = require('../config.js')
const Group = require('./Group-model.js')

const fs = require('fs-extra')
const { v4: uuidv4 } = require('uuid')
const path = require('path')

var User = sequelize.define('user', {
    id:           { type: Sequelize.STRING,  allowNull: false, primaryKey: true },
    password:     { type: Sequelize.STRING,  allowNull: false },
    admin:        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    fullname:     { type: Sequelize.STRING,  allowNull: true },
    email:        { type: Sequelize.STRING,  allowNull: true }
})

var UserGroup = User.UserGroup = sequelize.define('usergroup', {
    userId:       { type: Sequelize.STRING, unique: 'pk' },
    groupId:      { type: Sequelize.STRING, unique: 'pk' }
})
User.hasMany(UserGroup, { onDelete: 'cascade' })
Group.hasMany(UserGroup, { onDelete: 'cascade' })
UserGroup.belongsTo(User)
UserGroup.belongsTo(Group)

var AutoShare = User.AutoShare = sequelize.define('autoshare', {
    userId:       { type: Sequelize.STRING, unique: 'pk' },
    groupId:      { type: Sequelize.STRING, unique: 'pk' }
})
User.hasMany(AutoShare, { onDelete: 'cascade' })
Group.hasMany(AutoShare, { onDelete: 'cascade' })
AutoShare.belongsTo(User)
AutoShare.belongsTo(Group)

User.prototype.setAutoShares = async function (autoShares) {
    let autoShareGroups = await User.AutoShare.findAll({ where: { userId: this.id } })
    let autoShareIds = autoShares.reduce((map, asId) => { map[asId] = true; return map }, {})
    for (let asg of autoShareGroups) {
        if (!(asg.id in autoShareIds)) {
            await asg.destroy()
        }
    }
    autoShareIds = autoShareGroups.reduce((map, asg) => { map[asg.id] = true; return map }, {})
    for(let asgId of autoShares) {
        if (!(asgId in autoShareIds)) {
            await User.AutoShare.create({ userId: this.id, groupId: asgId })
        }
    }
}

const userPrefix = '/data/home/'

User.prototype.isMemberOf = async function (group) {
    return group && await User.UserGroup.findOne({ where: { userId: this.id, groupId: group.id } })
}

User.afterCreate(async user => {
    let userDir = userPrefix + user.id
    if (!(await fs.pathExists(userDir))) {
        await fs.mkdirp(userDir)
    }
})

User.afterDestroy(async user => {
    let userDir = userPrefix + user.id
    if (await fs.pathExists(userDir)) {
        await fs.move(userDir, '/data/trash/' + uuidv4())
    }
})

User.getDir = (userId) => userPrefix + userId
User.prototype.getDir = function () {
    return User.getDir(this.id)
}

User.getDirExternal = (userId) => path.join(config.mountRoot, 'home', userId + '')
User.prototype.getDirExternal = function () {
    return User.getDirExternal(this.id)
}

module.exports = User
