const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')

const fs = require('fs-extra')

const homePrefix = '/data/home/'

var User = sequelize.define('user', {
    id:         { type: Sequelize.STRING,  primaryKey: true },
    password:   { type: Sequelize.STRING,  allowNull: false },
    admin:      { type: Sequelize.BOOLEAN, allowNull: false },
    fullname:   { type: Sequelize.STRING,  allowNull: true },
    email:      { type: Sequelize.STRING,  allowNull: true }
})

User.belongsToMany(Group, { through: 'UserGroup' })
Group.belongsToMany(User, { through: 'UserGroup' })

User.beforeCreate(async user => {
    let homeDir = homePrefix + user.id
    if (!(await fs.pathExists(homeDir))) {
        await fs.mkdirp(homeDir)
    }
})

User.afterDestroy(async user => {
    let homeDir = homePrefix + user.id
    if (await fs.pathExists(homeDir)) {
        await fs.remove(homeDir)
    }
})

User.prototype.isMemberOf = async group => {
    group = Group.findById(group)
    return group && this.hasGroup(group)
}

User.prototype.getHomeDir = () => homePrefix + this.id

module.exports = User
