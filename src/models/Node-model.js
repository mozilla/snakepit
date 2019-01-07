const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')

var Node = sequelize.define('node', {
    nodename: {
        type: Sequelize.STRING,
        allowNull: false
    },
    endpoint: {
        type: Sequelize.STRING,
        allowNull: false
    }
})

Node.hasMany(Resource)

module.exports = Node
