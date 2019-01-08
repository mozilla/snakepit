const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Allocation = require('./Allocation-model.js')

var Process = sequelize.define('process', {
    index:      { type: Sequelize.INTEGER, allowNull: true },
    statuscode: { type: Sequelize.INTEGER, allowNull: false },
    result:     { type: Sequelize.STRING,  allowNull: false }
})

Process.hasMany(Allocation)

module.exports = Process
