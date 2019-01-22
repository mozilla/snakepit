const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')

var Allocation = sequelize.define('allocation', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    cmemory:      { type: Sequelize.DOUBLE,  allowNull: true },
    amemory:      { type: Sequelize.DOUBLE,  allowNull: true },
    ccompute:     { type: Sequelize.DOUBLE,  allowNull: true },
    acompute:     { type: Sequelize.DOUBLE,  allowNull: true },
    samples:      { type: Sequelize.INTEGER, defaultValue: 0 }
})

Allocation.belongsTo(Resource)

module.exports = Allocation
