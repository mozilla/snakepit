const Sequelize = require('sequelize')

const config = require('../config.js')

module.exports = new Sequelize('snakepit', 'postgres', '', {
  host: 'localhost',
  dialect: 'postgres',
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  operatorsAliases: false
})
