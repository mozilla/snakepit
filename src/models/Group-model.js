const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Group = sequelize.define('group', {
    id:         { type: Sequelize.STRING, allowNull: false, primaryKey: true },
    title:      { type: Sequelize.STRING, allowNull: true }
})

const groupPrefix = '/data/groups/'

Group.afterCreate(async group => {
    let groupDir = groupPrefix + group.id
    if (!(await fs.pathExists(groupDir))) {
        await fs.mkdirp(groupDir)
    }
})

Group.afterDestroy(async group => {
    let groupDir = groupPrefix + group.id
    if (await fs.pathExists(groupDir)) {
        await fs.remove(groupDir)
    }
})

Group.getGroupDir = (groupId) => groupPrefix + groupId
Group.prototype.getGroupDir = () => Group.getGroupDir(this.id)

module.exports = Group
