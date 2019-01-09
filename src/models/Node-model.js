const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')

var Node = sequelize.define('node', {
    id:         { type: Sequelize.STRING,  primaryKey: true },
    endpoint:   { type: Sequelize.STRING,  allowNull: false },
    online:     { type: Sequelize.BOOLEAN, allowNull: false },
    since:      { type: Sequelize.DATE,    allowNull: false }
})

Node.hasMany(Resource)

Node.startup = () => {
    Node.update({ online: false, since: Date.now() })
}

module.exports = Node
