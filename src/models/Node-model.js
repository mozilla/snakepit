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

Node.initDb = function() {
    if (!db.nodes) {
        db.nodes = {}
    }
    for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
        node.state = nodeStates.OFFLINE
        if (node.since) {
            delete node.since
        }
    }
}

module.exports = Node
