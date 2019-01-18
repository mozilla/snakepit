const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Allocation = require('./Allocation-model.js')

var Process = sequelize.define('process', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    index:        { type: Sequelize.INTEGER, allowNull: true },
    statuscode:   { type: Sequelize.INTEGER, allowNull: false },
    result:       { type: Sequelize.STRING,  allowNull: false }
})

Process.hasMany(Allocation)

module.exports = Process
