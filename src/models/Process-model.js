const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Allocation = require('./Allocation-model.js')
const Node = require('./Node-model.js')

var Process = sequelize.define('process', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    index:        { type: Sequelize.INTEGER, allowNull: true },
    statuscode:   { type: Sequelize.INTEGER, allowNull: true },
    result:       { type: Sequelize.STRING,  allowNull: true }
})

Process.hasMany(Allocation, { onDelete: 'cascade' })
Allocation.belongsTo(Process)

Process.belongsTo(Node)

module.exports = Process
