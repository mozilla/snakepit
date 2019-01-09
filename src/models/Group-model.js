const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Group = sequelize.define('group', {
    id:         { type: Sequelize.STRING, allowNull: false, primaryKey: true },
    title:      { type: Sequelize.STRING, allowNull: true }
})

Group.prototype.getGroupDir = () => '/data/groups/' + this.groupname

module.exports = Group
