const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Group = sequelize.define('group', {
    groupname:  { type: Sequelize.STRING, allowNull: false },
    title:      { type: Sequelize.STRING, allowNull: true }
})

Group.prototype.getGroupDir = () => '/data/groups/' + this.groupname

module.exports = Group
