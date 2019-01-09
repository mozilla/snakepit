const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')

const fs = require('fs-extra')

var User = sequelize.define('user', {
    id:         { type: Sequelize.STRING,  primaryKey: true },
    password:   { type: Sequelize.STRING,  allowNull: false },
    admin:      { type: Sequelize.BOOLEAN, allowNull: false },
    fullname:   { type: Sequelize.STRING,  allowNull: true },
    email:      { type: Sequelize.STRING,  allowNull: true }
})

User.belongsToMany(Group, { through: 'UserGroup' })
Group.belongsToMany(User, { through: 'UserGroup' })

const userPrefix = '/data/home/'

User.prototype.isMemberOf = async group => {
    group = Group.findById(group)
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

User.getUserDir = (userId) => userPrefix + userId
User.prototype.getUserDir = () => User.getUserDir(this.id)

module.exports = User
