const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Utilization = sequelize.define('utilization', {
    type:       { type: Sequelize.STRING,  allowNull: false },
    current:    { type: Sequelize.DOUBLE,  allowNull: false },
    aggregated: { type: Sequelize.DOUBLE,  allowNull: false },
    numsamples: { type: Sequelize.INTEGER, allowNull: false }
})

module.exports = Utilization
