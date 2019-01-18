const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var State = sequelize.define('state', {
    id:           { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    state:        { type: Sequelize.INTEGER, allowNull: false },
    since:        { type: Sequelize.DATE,    allowNull: false },
    reason:       { type: Sequelize.STRING,  allowNull: true }
})

module.exports = State
