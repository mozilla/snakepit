const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Group = sequelize.define('group', {
    groupname: {
        type: Sequelize.STRING,
        allowNull: false
    },
    description: {
        type: Sequelize.STRING,
        allowNull: true
    }
})

module.exports = Group
