const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var State = sequelize.define('state', {
    state:      { type: Sequelize.INTEGER, allowNull: false },
    since:      { type: Sequelize.DATE,    allowNull: false },
    reason:     { type: Sequelize.STRING,  allowNull: true }
})

module.exports = State
