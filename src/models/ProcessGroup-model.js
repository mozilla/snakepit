const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Process = require('./Process-model.js')

var ProcessGroup = sequelize.define('processgroup', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    index:        { type: Sequelize.INTEGER, allowNull: false }
})

ProcessGroup.hasMany(Process)
Process.belongsTo(ProcessGroup)

module.exports = ProcessGroup
