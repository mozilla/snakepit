const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Process = require('./Process-model.js')

var ProcessGroup = sequelize.define('processgroup', {
    index:      { type: Sequelize.INTEGER, allowNull: false }
})

ProcessGroup.hasMany(Process)

module.exports = ProcessGroup
