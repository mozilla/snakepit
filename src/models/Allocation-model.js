const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')
const Utilization = require('./Utilization-model.js')

var Allocation = sequelize.define('allocation', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true }
})

Allocation.belongsTo(Resource)

Allocation.hasMany(Utilization)

module.exports = Allocation
