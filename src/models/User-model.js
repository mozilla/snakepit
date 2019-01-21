const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')

const fs = require('fs-extra')

var User = sequelize.define('user', {
    id:           { type: Sequelize.STRING,  allowNull: false, primaryKey: true },
    password:     { type: Sequelize.STRING,  allowNull: false },
    admin:        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    fullname:     { type: Sequelize.STRING,  allowNull: true },
    email:        { type: Sequelize.STRING,  allowNull: true }
})

var UserGroup = User.UserGroup = sequelize.define('usergroup')
User.belongsToMany(Group, { through: UserGroup })
Group.belongsToMany(User, { through: UserGroup })

var AutoShare = User.AutoShare = sequelize.define('autoshare')
User.belongsToMany(Group, { as: 'autoshare', through: AutoShare })
Group.belongsToMany(User, { as: 'autoshare', through: AutoShare })

const userPrefix = '/data/home/'

User.prototype.isMemberOf = async group => {
    group = Group.findByPk(group)
    return group && this.hasGroup(group)
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
        await fs.remove(userDir)
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
